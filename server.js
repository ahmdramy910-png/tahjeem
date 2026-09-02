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
  users: { type: Array, default: [] },
  orders: { type: Array, default: [] }
}, { timestamps: true });

const AppState = mongoose.model('AppState', AppStateSchema);

let memoryState = {
  users: [],
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
        await AppState.create({ key: 'main_state', users: [], orders: [] });
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
      if (doc) return { users: doc.users || [], orders: doc.orders || [] };
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

// 1. جلب قائمة الموظفين
app.get('/api/users/list', async (req, res) => {
  const db = await loadDB();
  const list = (db.users || []).map(u => ({
    id: u.id,
    name: u.name,
    role: u.role
  }));
  res.json(list);
});

// 2. تسجيل الدخول
app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) {
    return res.status(400).json({ error: 'Please select an employee and enter password' });
  }

  const db = await loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'Employee not found' });

  if (user.password !== password) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  res.json({
    success: true,
    user: { id: user.id, name: user.name, role: user.role }
  });
});

// 3. إنشاء حساب موظف جديد
app.post('/api/users/register', async (req, res) => {
  const { name, role, password } = req.body;
  if (!name || !password) {
    return res.status(400).json({ error: 'Name and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const db = await loadDB();
  const cleanName = name.trim();
  
  if (db.users.some(u => u.name.toLowerCase() === cleanName.toLowerCase())) {
    return res.status(400).json({ error: 'This employee name is already registered' });
  }

  const newId = 'u_' + Date.now();
  const newUser = {
    id: newId,
    name: cleanName,
    role: role || 'cs',
    password: password.trim()
  };

  db.users.push(newUser);
  await saveDB(db);

  res.json({
    success: true,
    user: { id: newUser.id, name: newUser.name, role: newUser.role }
  });
});

// 4. جلب الطلبات
app.get('/api/data', async (req, res) => {
  const db = await loadDB();
  res.json({ orders: db.orders });
});

// 5. إحصائيات إنتاجية الموظفين
app.get('/api/stats', async (req, res) => {
  const db = await loadDB();
  const stats = {};

  (db.users || []).forEach(u => {
    stats[u.name] = {
      role: u.role === 'cs' ? 'Customer Service' : 'Warehouse',
      totalBLs: 0,
      totalCars: 0
    };
  });

  (db.orders || []).forEach(order => {
    const blCount = (order.bls || []).length;
    if (blCount === 0) return;

    const creator = order.createdBy;
    if (creator) {
      if (!stats[creator]) {
        stats[creator] = { role: 'Employee', totalBLs: 0, totalCars: 0 };
      }
      stats[creator].totalBLs += blCount;
      stats[creator].totalCars += 1;
    }

    const measurer = order.measuredBy;
    if (measurer && measurer !== creator && order.status === 'تم التحجيم') {
      if (!stats[measurer]) {
        stats[measurer] = { role: 'Warehouse', totalBLs: 0, totalCars: 0 };
      }
      stats[measurer].totalBLs += blCount;
      stats[measurer].totalCars += 1;
    }
  });

  res.json(stats);
});

// 6. تحليل السكرين شوت بدقة فائقة ومعالجة شاملة للأخطاء
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) {
      return res.status(500).json({ error: 'GROQ_API_KEY is not defined in Render environment variables' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `Logistics OCR. Extract values from Sage CRM window into a JSON object.
Rules:
1. Digits '0' not letter 'O'.
2. Qty is whole integer only.
3. Weight in tons rounded UP to 0.1 ton.
4. Clearance company and Location code accurately transcribed.

JSON keys:
{"blNumber":"","alvSerial":"","qty":"","weight":"","pallets":"","location":"","clearanceCompany":""}`;

    let response = null;
    let data = null;

    // محاولة مع معالجة ذكية لضغط الـ Rate Limit
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'qwen/qwen3.6-27b',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }
          ],
          temperature: 0.0,
          max_tokens: 1024
        })
      });

      data = await response.json();

      if (response.ok) break;

      const errMsg = data.error?.message || '';
      if (errMsg.includes('Rate limit') && attempt === 0) {
        console.log('Rate limit reached, retrying in 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
        continue;
      } else {
        return res.status(response.status).json({ error: errMsg || 'Groq API request failed' });
      }
    }

    const rawContent = data.choices?.[0]?.message?.content || '';
    if (!rawContent) {
      return res.status(500).json({ error: 'Empty response received from OCR engine' });
    }

    const match = rawContent.match(/\{[\s\S]*?\}/);
    if (!match) {
      return res.status(500).json({ error: 'Could not parse logistics data. Raw output: ' + rawContent.slice(0, 100) });
    }

    const parsed = JSON.parse(match[0]);

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
    return res.status(500).json({ error: 'Internal Server Error: ' + err.message });
  }
});

// 7. إنشاء طلب جديد
app.post('/api/orders', async (req, res) => {
  const db = await loadDB();
  const newOrder = {
    id: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    createdAt: new Date().toISOString(),
    createdBy: req.body.createdBy || 'Customer Service',
    status: req.body.isManual ? 'طباعة يدوية' : 'بانتظار التحجيم',
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
  if (!order) return res.status(404).json({ error: 'Order not found' });

  order.measurements = req.body.measurements;
  order.vehicleType = req.body.vehicleType || '';
  order.shareefNotes = req.body.shareefNotes || '';
  order.measuredBy = req.body.measuredBy || 'Warehouse Staff';
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
  res.json({ success: true, message: 'Archive cleared completely' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
