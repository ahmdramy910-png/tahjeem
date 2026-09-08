const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static('public'));

const MONGODB_URI = process.env.MONGODB_URI;

const AppStateSchema = new mongoose.Schema({
  key: { type: String, default: 'main_state', unique: true },
  users: { type: Array, default: [] },
  orders: { type: Array, default: [] }
}, { timestamps: true });

const AppState = mongoose.model('AppState', AppStateSchema);

let memoryState = { users: [], orders: [] };
let isConnectedToMongo = false;

if (MONGODB_URI) {
  mongoose.connect(MONGODB_URI)
    .then(async () => {
      isConnectedToMongo = true;
      console.log('✅ Connected to MongoDB Atlas');
      const doc = await AppState.findOne({ key: 'main_state' });
      if (!doc) await AppState.create({ key: 'main_state', users: [], orders: [] });
    })
    .catch(err => console.error('MongoDB error:', err.message));
}

async function loadDB() {
  if (isConnectedToMongo) {
    try {
      const doc = await AppState.findOne({ key: 'main_state' });
      if (doc) return { users: doc.users || [], orders: doc.orders || [] };
    } catch (err) {
      console.error('Error loading DB:', err);
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
      console.error('Error saving DB:', err);
    }
  }
}

// مسارات المستخدمين وتسجيل الدخول
app.get('/api/users/list', async (req, res) => {
  const db = await loadDB();
  res.json((db.users || []).map(u => ({ id: u.id, name: u.name, role: u.role })));
});

app.post('/api/login', async (req, res) => {
  const { userId, password } = req.body;
  const db = await loadDB();
  const user = db.users.find(u => u.id === userId);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: 'Invalid user or password' });
  }
  res.json({ success: true, user: { id: user.id, name: user.name, role: user.role } });
});

app.post('/api/users/register', async (req, res) => {
  const { name, role, password } = req.body;
  if (!name || !password || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const db = await loadDB();
  if (db.users.some(u => u.name.toLowerCase() === name.trim().toLowerCase())) {
    return res.status(400).json({ error: 'Employee already registered' });
  }
  const newUser = { id: 'u_' + Date.now(), name: name.trim(), role: role || 'cs', password: password.trim() };
  db.users.push(newUser);
  await saveDB(db);
  res.json({ success: true, user: { id: newUser.id, name: newUser.name, role: newUser.role } });
});

app.get('/api/data', async (req, res) => {
  const db = await loadDB();
  res.json({ orders: db.orders });
});

// مؤشرات الأداء والإنتاجية (KPIs)
app.get('/api/stats', async (req, res) => {
  const db = await loadDB();
  const stats = {};
  (db.users || []).forEach(u => {
    stats[u.name] = { role: u.role === 'cs' ? 'Customer Service' : 'Warehouse', totalBLs: 0, totalCars: 0 };
  });
  (db.orders || []).forEach(order => {
    const blCount = (order.bls || []).length;
    if (!blCount) return;
    if (order.createdBy) {
      if (!stats[order.createdBy]) stats[order.createdBy] = { role: 'CS', totalBLs: 0, totalCars: 0 };
      stats[order.createdBy].totalBLs += blCount;
      stats[order.createdBy].totalCars += 1;
    }
    if (order.measuredBy && order.measuredBy !== order.createdBy && order.status === 'تم التحجيم') {
      if (!stats[order.measuredBy]) stats[order.measuredBy] = { role: 'Warehouse', totalBLs: 0, totalCars: 0 };
      stats[order.measuredBy].totalBLs += blCount;
      stats[order.measuredBy].totalCars += 1;
    }
  });
  res.json(stats);
});

// نقطة فحص الـ OCR عبر gpt-4o-mini
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY variable is missing in Render Environment' });
    }

    const base64Data = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const prompt = `Logistics OCR task for Sage CRM window.
Extract all logistics values EXACTLY as printed on the screen without omitting, truncating, abbreviating, or modifying any character.

CRITICAL RULES:
1. B/L Number (blNumber): Copy the EXACT text verbatim, character-by-character, as displayed on the screen.
   - NEVER drop, shorten, or change any letter, symbol, or digit.
   - Do NOT assume any letter is a typo (e.g. "4052joaqb" must stay "4052joaqb" exactly as seen, never drop the 'o' or convert to "jaqb").
2. ALV Serial (alvSerial): Extract the exact serial number text as shown on screen.
3. Quantity (qty): Extract as integer string (e.g. "55").
4. Weight: Extract the EXACT raw weight number displayed in the image without rounding (e.g. "1.04", "1.611").
5. Clearance Company & Location: Transcribe clearance company and warehouse location code accurately.
If any field is missing from the image, set its value to an empty string "".`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are an ultra-precise OCR assistant for logistics screens. Transcribe strings exactly as visible without making assumptions, corrections, or abbreviations. Output strictly in valid JSON."
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } }
          ]
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "sage_crm_fields",
          strict: true,
          schema: {
            type: "object",
            properties: {
              blNumber: { type: "string", description: "Verbatim unabbreviated B/L number string" },
              alvSerial: { type: "string", description: "Verbatim ALV Serial number string" },
              qty: { type: "string", description: "Quantity of packages" },
              weight: { type: "string", description: "Raw exact weight string without rounding" },
              pallets: { type: "string", description: "Number of pallets" },
              location: { type: "string", description: "Warehouse location code" },
              clearanceCompany: { type: "string", description: "Clearance company name" }
            },
            required: ["blNumber", "alvSerial", "qty", "weight", "pallets", "location", "clearanceCompany"],
            additionalProperties: false
          }
        }
      },
      temperature: 0.0
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // 1. تنظيف الأعداد
    if (parsed.qty) {
      const cleanQty = parseInt(String(parsed.qty).replace(/,/g, ''), 10);
      parsed.qty = isNaN(cleanQty) ? parsed.qty : String(cleanQty);
    }
    if (parsed.pallets) {
      const cleanPallets = parseInt(String(parsed.pallets).replace(/,/g, ''), 10);
      parsed.pallets = isNaN(cleanPallets) ? parsed.pallets : String(cleanPallets);
    }

    // 2. التقريب الرياضي الصارم للوزن للأعلى دائماً لأقرب 0.1 (Round UP to nearest 0.1)
    if (parsed.weight) {
      const rawWeight = parseFloat(String(parsed.weight).replace(/,/g, ''));
      if (!isNaN(rawWeight) && rawWeight > 0) {
        const roundedWeight = Math.ceil(parseFloat(rawWeight.toFixed(5)) * 10) / 10;
        parsed.weight = roundedWeight.toFixed(1);
      }
    }

    return res.json(parsed);

  } catch (err) {
    console.error('OCR Endpoint Error:', err);
    return res.status(500).json({ error: 'Server Error: ' + err.message });
  }
});

// إدارة الطلبات والتحجيم
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

app.delete('/api/orders/clean', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const db = await loadDB();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  db.orders = db.orders.filter(o => new Date(o.createdAt) >= cutoff);
  await saveDB(db);
  res.json({ success: true, count: db.orders.length });
});

app.delete('/api/orders/clear-all', async (req, res) => {
  const db = await loadDB();
  db.orders = [];
  await saveDB(db);
  res.json({ success: true, message: 'Archive cleared' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Tahjeem ALV server running on port ${PORT}`));
