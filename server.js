const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const JWT_SECRET = process.env.JWT_SECRET || 'tahjeem_secure_jwt_secret_key_2026';

// Middlewares
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));

// الاتصال بقاعدة بيانات MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// 1. هياكل البيانات (Mongoose Schemas)

// هيكل المستخدمين وإدارة الأدوار
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['Admin', 'CustomerService', 'Warehouse'], default: 'Warehouse' },
  fullName: String,
  createdAt: { type: Date, default: Date.now }
});

// هيكل سجل التحجيم والشحنات
const ShipmentSchema = new mongoose.Schema({
  blNumber: { type: String, required: true, trim: true },
  voyageNumber: { type: String, trim: true },
  consignee: { type: String, trim: true },
  cargoDimensions: [{
    length: Number,
    width: Number,
    height: Number,
    pieces: { type: Number, default: 1 },
    cbm: Number
  }],
  totalCBM: { type: Number, required: true },
  totalPieces: { type: Number, default: 0 },
  extractedFromOCR: { type: Boolean, default: false },
  createdBy: { type: String, default: 'Warehouse User' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', UserSchema);
const Shipment = mongoose.model('Shipment', ShipmentSchema);

// 2. التحقق من التوكن وصلاحيات المستخدم (Auth Middleware)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'مطلوب تسجيل الدخول' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'جلسة الدخول غير صالحة' });
    req.user = user;
    next();
  });
};

// 3. مسارات المصادقة وتسجيل الدخول
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, role, fullName } = req.body;
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ success: false, message: 'اسم المستخدم مسجل مسبقاً' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, role, fullName });
    await user.save();
    res.status(201).json({ success: true, message: 'تم إنشاء الحساب بنجاح' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ success: false, message: 'بيانات الدخول غير صحيحة' });

    const token = jwt.sign({ id: user._id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token, user: { username: user.username, role: user.role, fullName: user.fullName } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. نقطة فحص OCR واستخراج بيانات شاشات Sage CRM عبر gpt-4o-mini
app.post('/api/ocr-extract', async (req, res) => {
  const { imageBase64 } = req.body;
  if (!imageBase64) return res.status(400).json({ success: false, message: 'الصورة مطلوبة (Base64)' });

  try {
    const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an expert OCR system specialized in extracting shipping logistics data from Sage CRM screenshots. Extract the B/L number, Voyage number, Consignee name, and Package Count accurately. Set missing text fields to empty strings and numeric fields to 0."
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Extract B/L number, Voyage, Consignee, and Package count accurately from this Sage CRM screenshot." },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "sage_crm_extraction",
          strict: true,
          schema: {
            type: "object",
            properties: {
              blNumber: { type: "string", description: "The Bill of Lading (B/L) number" },
              voyageNumber: { type: "string", description: "The Voyage number or vessel ID" },
              consignee: { type: "string", description: "The consignee or client company name" },
              packageCount: { type: "number", description: "Total number of packages or pieces" }
            },
            required: ["blNumber", "voyageNumber", "consignee", "packageCount"],
            additionalProperties: false
          }
        }
      }
    });

    const extractedData = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data: extractedData });
  } catch (error) {
    console.error('OCR Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 5. مسارات التحجيم والشحنات
app.post('/api/shipments', async (req, res) => {
  try {
    const { blNumber, voyageNumber, consignee, cargoDimensions, extractedFromOCR, createdBy } = req.body;

    if (!blNumber) return res.status(400).json({ success: false, message: 'رقم البوليصة مطلوب' });

    let calculatedTotalCBM = 0;
    let calculatedTotalPieces = 0;

    const dimensions = (cargoDimensions || []).map(dim => {
      const l = Number(dim.length) || 0;
      const w = Number(dim.width) || 0;
      const h = Number(dim.height) || 0;
      const pieces = Number(dim.pieces) || 1;
      const cbm = parseFloat(((l * w * h / 1000000) * pieces).toFixed(3));

      calculatedTotalCBM += cbm;
      calculatedTotalPieces += pieces;

      return { length: l, width: w, height: h, pieces, cbm };
    });

    const newShipment = new Shipment({
      blNumber,
      voyageNumber,
      consignee,
      cargoDimensions: dimensions,
      totalCBM: parseFloat(calculatedTotalCBM.toFixed(3)),
      totalPieces: calculatedTotalPieces,
      extractedFromOCR: !!extractedFromOCR,
      createdBy: createdBy || 'Warehouse User'
    });

    await newShipment.save();
    res.status(201).json({ success: true, data: newShipment });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/shipments', async (req, res) => {
  try {
    const { blNumber, voyageNumber, startDate, endDate } = req.query;
    let filter = {};

    if (blNumber) filter.blNumber = { $regex: blNumber, $options: 'i' };
    if (voyageNumber) filter.voyageNumber = { $regex: voyageNumber, $options: 'i' };
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) filter.createdAt.$lte = new Date(endDate);
    }

    const shipments = await Shipment.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, count: shipments.length, data: shipments });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 6. مسار تصدير السجلات إلى Excel
app.get('/api/shipments/export', async (req, res) => {
  try {
    const shipments = await Shipment.find().sort({ createdAt: -1 });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('سجل التحجيم');

    worksheet.columns = [
      { header: 'رقم البوليصة (B/L)', key: 'blNumber', width: 20 },
      { header: 'رقم الرحلة (Voyage)', key: 'voyageNumber', width: 15 },
      { header: 'العميل (Consignee)', key: 'consignee', width: 30 },
      { header: 'إجمالي القطع', key: 'totalPieces', width: 12 },
      { header: 'إجمالي الحجم (CBM)', key: 'totalCBM', width: 18 },
      { header: 'مستخرج بـ OCR', key: 'extractedFromOCR', width: 15 },
      { header: 'الموظف', key: 'createdBy', width: 20 },
      { header: 'تاريخ الإدخال', key: 'createdAt', width: 22 }
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0284C7' } };

    shipments.forEach(s => {
      worksheet.addRow({
        blNumber: s.blNumber,
        voyageNumber: s.voyageNumber || '-',
        consignee: s.consignee || '-',
        totalPieces: s.totalPieces,
        totalCBM: s.totalCBM,
        extractedFromOCR: s.extractedFromOCR ? 'نعم' : 'لا',
        createdBy: s.createdBy,
        createdAt: s.createdAt.toLocaleString('ar-JO')
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=Tahjeem_Shipments.xlsx');

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 7. مسار مؤشرات الأداء والإنتاجية (KPIs)
app.get('/api/kpi/summary', async (req, res) => {
  try {
    const totalShipments = await Shipment.countDocuments();
    const totalPiecesAgg = await Shipment.aggregate([{ $group: { _id: null, total: { $sum: '$totalPieces' }, totalCBM: { $sum: '$totalCBM' } } }]);
    
    // إحصائيات لكل موظف
    const userStats = await Shipment.aggregate([
      {
        $group: {
          _id: '$createdBy',
          shipmentsCount: { $sum: 1 },
          piecesCount: { $sum: '$totalPieces' },
          totalCBM: { $sum: '$totalCBM' }
        }
      },
      { $sort: { shipmentsCount: -1 } }
    ]);

    res.json({
      success: true,
      data: {
        totalShipments,
        totalPieces: totalPiecesAgg[0] ? totalPiecesAgg[0].total : 0,
        totalCBM: totalPiecesAgg[0] ? parseFloat(totalPiecesAgg[0].totalCBM.toFixed(3)) : 0,
        userPerformance: userStats
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Tahjeem server running on port ${PORT}`);
});
