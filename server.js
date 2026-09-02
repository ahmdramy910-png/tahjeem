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

const AppStateSchema = new mongoose.Schema({
  key: { type: String, default: 'main_state', unique: true },
  employees: { type: [String], default: ['كستمر سيرفس 1', 'موظف التحجيم 1'] },
  orders: { type: Array, default: [] }
}, { timestamps: true });

const AppState = mongoose.model('AppState', AppStateSchema);

let memoryState = {
  employees: ['كستمر سيرفس 1', 'موظف التحجيم 1'],
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
      if (doc) return { employees: doc.employees, orders: doc.orders };
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
        { employees: data.employees, orders: data.orders },
        { upsert: true }
      );
    } catch (err) {
      console.error('Error saving to DB:', err);
    }
  }
}

// 1. جلب البيانات
app.get('/api/data', async (req, res) => {
  const data = await loadDB();
  res.json(data);
});

// 2. إضافة موظف
app.post('/api/employees', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
  const db = await loadDB();
  if (!db.employees.includes(name)) {
    db.employees.push(name);
    await saveDB(db);
  }
  res.json({ employees: db.employees });
});

// 3. تحليل السكرين شوت بدقة فائقة وإزالة الأصفار العشرية للعدد
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
5. QUANTITY (qty): MUST be a whole integer ONLY. If the CRM shows trailing decimals like "55.000" or "12.0", strip the decimal completely and return only the integer (e.g. 55, 12).

FIELDS TO EXTRACT:
- blNumber: Full B/L No. exactly as shown.
- alvSerial: Full ALV Serial exactly as shown.
- qty: Whole integer quantity (e.g., 55 instead of 55.000).
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

    // تنظيف برمجي إضافي للعدد لضمان إزالة أي أصفار عشرية
    if (parsed.qty) {
      const cleanQty = parseInt(String(parsed.qty).replace(/,/g, ''), 10);
      parsed.qty = isNaN(cleanQty) ? parsed.qty : String(cleanQty);
    }

    // تنظيف لعدد البلتات أيضاً كعدد صحيح
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

// 4. إنشاء طلب جديد
app.post('/api/orders', async (req, res) => {
  const db = await loadDB();
  const newOrder = {
    id: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    createdAt: new Date().toISOString(),
    createdBy: req.body.createdBy || 'خدمة العملاء',
    status: 'بانتظار التحجيم',
    bls: req.body.bls || [],
    totalWeight: req.body.totalWeight || 0,
    measurements: { length: '', width: '', height: '' },
    vehicleType: '',
    shareefNotes: '',
    completedAt: null
  };
  db.orders.unshift(newOrder);
  await saveDB(db);
  res.json(newOrder);
});

// 5. حفظ واعتماد التحجيم
app.patch('/api/orders/:id/tahjeem', async (req, res) => {
  const db = await loadDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  order.measurements = req.body.measurements;
  order.vehicleType = req.body.vehicleType || '';
  order.shareefNotes = req.body.shareefNotes || '';
  order.status = 'تم التحجيم';
  order.completedAt = new Date().toISOString();

  await saveDB(db);
  res.json(order);
});

// 6. حذف الطلبات القديمة
app.delete('/api/orders/clean', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const db = await loadDB();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  db.orders = db.orders.filter(o => new Date(o.createdAt) >= cutoff);
  await saveDB(db);
  res.json({ success: true, count: db.orders.length });
});

// 7. تفريغ كامل الأرشيف
app.delete('/api/orders/clear-all', async (req, res) => {
  const db = await loadDB();
  db.orders = [];
  await saveDB(db);
  res.json({ success: true, message: 'تم تفريغ الأرشيف بالكامل' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
