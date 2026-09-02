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

// 3. تحليل السكرين شوت بالذكاء الاصطناعي (مصحح ومجاني 100%)
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
    const mimeType = req.file.mimetype || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `Extract these exact fields from the logistics Sage CRM screenshot:
- B/L No. (blNumber)
- ALV Serial (alvSerial)
- QTY (qty)
- Weight(Ton) (weight: round UP to nearest 0.1 step, e.g. 1.611 becomes 1.7)
- ALV Pallet (pallets)
- Warehouse location code from bottom table (location)
- Clearance company name (clearanceCompany)

Output JSON only in this format:
{"blNumber":"","alvSerial":"","qty":"","weight":"","pallets":"","location":"","clearanceCompany":""}`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://tahjeem.onrender.com',
        'X-Title': 'Tahjeem Logistics'
      },
      body: JSON.stringify({
        model: 'minimax/minimax-m3:free',
        models: [
          'minimax/minimax-m3:free',
          'openrouter/free'
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          }
        ],
        temperature: 0.1
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter Error:', data);
      return res.status(500).json({ error: data.error?.message || 'خطأ من مزود الذكاء الاصطناعي' });
    }

    let raw = data.choices?.[0]?.message?.content || '{}';
    // استخراج الـ JSON بدقة حتى لو كتب الموديل أي كلام قبله أو بعده
    const match = raw.match(/\{[\s\S]*\}/);
    const jsonStr = match ? match[0] : '{}';
    const parsed = JSON.parse(jsonStr);

    return res.json(parsed);

  } catch (err) {
    console.error('OCR Endpoint Error:', err);
    return res.status(500).json({ error: 'تعذر قراءة الصورة: ' + err.message });
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

// 6. تنظيف الطلبات القديمة
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
