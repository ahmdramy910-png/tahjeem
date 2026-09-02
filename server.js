const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

// --- الاتصال بقاعدة البيانات السحابية MongoDB Atlas ---
const MONGODB_URI = process.env.MONGODB_URI;

// قائمة الموظفين الافتراضية
const defaultUsers = [
  { id: 'u1', name: 'أحمد رامي', role: 'cs', password: '' },
  { id: 'u2', name: 'كستمر سيرفس 1', role: 'cs', password: '' },
  { id: 'u3', name: 'كستمر سيرفس 2', role: 'cs', password: '' },
  { id: 'u4', name: 'موظف التحجيم 1', role: 'warehouse', password: '' },
  { id: 'u5', name: 'موظف التحجيم 2', role: 'warehouse', password: '' }
];

const AppStateSchema = new mongoose.Schema({
  key: { type: String, default: 'main_state', unique: true },
  users: { type: Array, default: defaultUsers },
  orders: { type: Array, default: [] }
}, { timestamps: true });

const AppState = mongoose.model('AppState', AppStateSchema);

let memoryState = {
  users: defaultUsers,
  orders: []
};

let isConnectedToMongo = false;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(async () => {
      isConnectedToMongo = true;
      console.log('✅ Connected permanently to MongoDB Atlas');
      const doc = await AppState.findOne({ key: 'main_state' });
      if (!doc) {
        await AppState.create({ key: 'main_state', ...memoryState });
      } else {
        if (!doc.users || doc.users.length === 0) {
          doc.users = defaultUsers;
          await doc.save();
        }
      }
    })
    .catch(err => {
      console.error('⚠️ MongoDB connection error, running in memory mode:', err.message);
    });
}

async function loadDB() {
  if (isConnectedToMongo) {
    try {
      const doc = await AppState.findOne({ key: 'main_state' });
      if (doc) return { users: doc.users || defaultUsers, orders: doc.orders || [] };
    } catch (err) {
      console.error('Error loading from DB:', err);
    }
  }
  return memoryState;
}

async function saveDB(data) {
  memoryState = data;
  if (isConnectedToMongo) {
    try {
      await AppState.findOneAndUpdate(
        { key: 'main_state' },
        { users: data.users, orders: data.orders },
        { upsert: true }
      );
    } catch (err) {
      console.error('Error saving to DB:', err);
    }
  }
}

// 1. جلب قائمة الموظفين لقائمة الاختيار
app.get('/api/users/list', async (req, res) => {
  const db = await loadDB();
  const list = db.users.map(u => ({
    id: u.id,
    name: u.name,
    role: u.role,
    hasPassword: !!u.password
  }));
  res.json(list);
});

// 2. تسجيل الدخول أو تعيين كلمة المرور (8 خانات)
app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) {
    return res.status(400).json({ error: 'يرجى اختيار الموظف وإدخال كلمة المرور' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'كلمة المرور يجب أن تتكون من 8 خانات على الأقل' });
  }

  const db = await loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'الموظف غير مسجل' });

  if (!user.password) {
    user.password = password;
    await saveDB(db);
    return res.json({
      success: true,
      message: 'تم تعيين كلمة المرور بنجاح!',
      user: { id: user.id, name: user.name, role: user.role }
    });
  }

  if (user.password !== password) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة' });
  }

  res.json({
    success: true,
    user: { id: user.id, name: user.name, role: user.role }
  });
});

// 3. إضافة موظف جديد
app.post('/api/users/add', async (req, res) => {
  const { name, role } = req.body;
  if (!name) return res.status(400).json({ error: 'اسم الموظف مطلوب' });

  const db = await loadDB();
  const newId = 'u' + (db.users.length + 1) + '_' + Date.now().toString().slice(-4);
  db.users.push({
    id: newId,
    name: name.trim(),
    role: role || 'cs',
    password: ''
  });
  await saveDB(db);
  res.json({ success: true, id: newId, name });
});

// 4. جلب الطلبات
app.get('/api/data', async (req, res) => {
  const db = await loadDB();
  res.json({ orders: db.orders });
});

// 5. إحصائيات إنتاجية الموظفين (بوالص + سيارات فقط، الطلب الواحد = سيارة واحدة)
app.get('/api/stats', async (req, res) => {
  const db = await loadDB();
  const stats = {};

  db.users.forEach(u => {
    stats[u.name] = {
      role: u.role === 'cs' ? 'خدمة عملاء' : 'مستودع وتحجيم',
      totalBLs: 0,
      totalCars: 0
    };
  });

  db.orders.forEach(order => {
    const blCount = (order.bls || []).length;
    if (blCount === 0) return;

    // الموظف الذي أنشأ الطلب أو قام بالطباعة اليدوية
    const creator = order.createdBy;
    if (creator) {
      if (!stats[creator]) {
        stats[creator] = { role: 'موظف', totalBLs: 0, totalCars: 0 };
      }
      stats[creator].totalBLs += blCount;
      stats[creator].totalCars += 1; // كل طلب يمثل سيارة واحدة مباشرة
    }

    // إذا كان الطلب تم تحجيمه بواسطة موظف مستودع آخر
    const measurer = order.measuredBy;
    if (measurer && measurer !== creator && order.status === 'تم التحجيم') {
      if (!stats[measurer]) {
        stats[measurer] = { role: 'مستودع وتحجيم', totalBLs: 0, totalCars: 0 };
      }
      stats[measurer].totalBLs += blCount;
      stats[measurer].totalCars += 1;
    }
  });

  res.json(stats);
});

// 6. تحليل السكرين شوت بدقة فائقة
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم استلام ملف صورة' });
    }

    const openrouterKey = process.env.OPENROUTER_API_KEY;
    if (!openrouterKey) {
      return res.status(500).json({ error: 'مفتاح OPENROUTER_API_KEY غير معرف في Render' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `You are a precision OCR engine for Sage CRM logistics windows.
Transcribe text with 100% exact alphanumeric accuracy without omitting any characters.

STRICT CHARACTER & FORMAT RULES:
1. '0' vs 'O': Serial numbers, ALV numbers, and B/L identifiers contain the DIGIT '0', NOT the letter 'O'.
2. '6' vs 'G': Closed curved loops in serials are digit '6'.
3. '1' vs 'I'/'l': Pure numeric segments use digit '1'.
4. COMPLETE TEXT: Do not drop, skip, or shorten any characters from B/L No. or ALV Serial.
5. QUANTITY (qty): MUST be a whole integer ONLY. Strip trailing decimals like "55.000" to "55".

FIELDS TO EXTRACT:
- blNumber: Full B/L No. exactly as shown.
- alvSerial: Full ALV Serial exactly as shown.
- qty: Whole integer quantity.
- weight: Weight in tons rounded UP to the nearest 0.1 ton (e.g., 1.611 becomes 1.7).
- pallets: ALV Pallet count as integer.
- location: Primary storage location code from the bottom table.
- clearanceCompany: Full clearance company name.

Return valid JSON ONLY in this format:
{"blNumber":"","alvSerial":"","qty":"","weight":"","pallets":"","location":"","clearanceCompany":""}`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tahjeem.onrender.com',
        'X-Title': 'Tahjeem Logistics System'
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.0
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter Error:', data);
      return res.status(500).json({ error: data.error?.message || 'خطأ من مزود OpenRouter' });
    }

    let rawContent = data.choices?.[0]?.message?.content || '{}';
    const match = rawContent.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : '{}';
    const parsed = JSON.parse(jsonStr);

    if (parsed.qty) {
      const cleanQty = parseInt(String(parsed.qty).replace(/,/g, ''), 10);
      parsed.qty = isNaN(cleanQty) ? parsed.qty : String(cleanQty);
    }
    if (parsed.pallets) {
      const cleanPallets = parseInt(String(parsed.pallets).replace(/,/g, ''), 10);
      parsed.pallets = isNaN(cleanPallets) ? parsed.pallets : String(cleanPallets);
    }

    return res.json(parsed);

  } catch (err) {
    console.error('OCR Endpoint Error:', err);
    return res.status(500).json({ error: 'فشل معالجة الصورة: ' + err.message });
  }
});

// 7. إنشاء طلب جديد (الطلب = سيارة)
app.post('/api/orders', async (req, res) => {
  const db = await loadDB();
  const newOrder = {
    id: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    createdAt: new Date().toISOString(),
    createdBy: req.body.createdBy || 'خدمة العملاء',
    status: req.body.isManual ? 'طباعة يدوية (احتياطية)' : 'بانتظار التحجيم',
    isManualPrint: !!req.body.isManual,
    bls: req.body.bls || [],
    totalWeight: req.body.totalWeight || 0,
    measurements: { length: '', width: '', height: '' },
    vehicleType: '',
    shareefNotes: req.body.shareefNotes || '',
    measuredBy: null,
    completedAt: req.body.isManual ? new Date().toISOString() : null
  };
  db.orders.unshift(newOrder);
  await saveDB(db);
  res.json(newOrder);
});

// 8. حفظ واعتماد التحجيم
app.patch('/api/orders/:id/tahjeem', async (req, res) => {
  const db = await loadDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  order.measurements = req.body.measurements;
  order.vehicleType = req.body.vehicleType || '';
  order.shareefNotes = req.body.shareefNotes || '';
  order.measuredBy = req.body.measuredBy || 'موظف المستودع';
  order.status = 'تم التحجيم';
  order.completedAt = new Date().toISOString();

  await saveDB(db);
  res.json(order);
});

// 9. تنظيف وحذف الطلبات القديمة
app.delete('/api/orders/clean', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const db = await loadDB();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  db.orders = db.orders.filter(o => new Date(o.createdAt) >= cutoff);
  await saveDB(db);
  res.json({ success: true, count: db.orders.length });
});

// 10. تفريغ كامل الأرشيف
app.delete('/api/orders/clear-all', async (req, res) => {
  const db = await loadDB();
  db.orders = [];
  await saveDB(db);
  res.json({ success: true, message: 'تم تفريغ الأرشيف بالكامل' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
