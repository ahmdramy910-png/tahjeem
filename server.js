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

// مسارات المستخدمين
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

// إحصائيات اليوم والإجمالي لكل موظف
app.get('/api/stats', async (req, res) => {
  const db = await loadDB();
  const stats = {};
  const todayStr = new Date().toISOString().slice(0, 10);

  (db.users || []).forEach(u => {
    stats[u.name] = { 
      role: u.role === 'cs' ? 'Customer Service' : 'Warehouse', 
      todayBLs: 0, 
      todayCars: 0, 
      totalBLs: 0, 
      totalCars: 0 
    };
  });

  (db.orders || []).forEach(order => {
    const blCount = (order.bls || []).length;
    if (!blCount) return;

    const isToday = (order.createdAt || '').slice(0, 10) === todayStr;

    if (order.createdBy) {
      if (!stats[order.createdBy]) {
        stats[order.createdBy] = { role: 'CS', todayBLs: 0, todayCars: 0, totalBLs: 0, totalCars: 0 };
      }
      stats[order.createdBy].totalBLs += blCount;
      stats[order.createdBy].totalCars += 1;
      if (isToday) {
        stats[order.createdBy].todayBLs += blCount;
        stats[order.createdBy].todayCars += 1;
      }
    }

    if (order.measuredBy && order.measuredBy !== order.createdBy && order.status === 'تم التحجيم') {
      if (!stats[order.measuredBy]) {
        stats[order.measuredBy] = { role: 'Warehouse', todayBLs: 0, todayCars: 0, totalBLs: 0, totalCars: 0 };
      }
      stats[order.measuredBy].totalBLs += blCount;
      stats[order.measuredBy].totalCars += 1;
      if (isToday) {
        stats[order.measuredBy].todayBLs += blCount;
        stats[order.measuredBy].todayCars += 1;
      }
    }
  });

  res.json(stats);
});

// نقطة فحص الـ OCR مع تهجئة الكلمات والمطابقة الصارمة
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY variable is missing in Render Environment' });
    }

    const base64Data = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const prompt = `Perform ultra-detailed logistics OCR from this Sage CRM screen.
Instructions to ensure 100% character precision:
1. In 'bl_spelled': spell out the B/L number separating EVERY SINGLE letter and digit with a space (e.g. "M 2 6 E X L 2 4 0 5 2 J O A Q B").
2. In 'serial_spelled': spell out the complete serial number separating EVERY SINGLE letter and digit with a space (e.g. "A L V 1 5 0 8 2 0 2 6").
3. In 'company_spelled': spell out the clearance company name separating each character with a space, using '|' between separate words (e.g. "A R A B | A M I R A N"). STRICTLY OMIT ANY TELEPHONE/MOBILE/FAX DIGITS.
4. In 'weight': extract the EXACT visible weight number string directly from the screen (e.g. "1.04", "0.4", "2.9", "400"). NEVER omit or leave blank if visible.
5. In 'qty': package count integer string.
6. In 'pallets': number of pallets string (e.g. "4", "0").
7. In 'location': warehouse bay/location code string (e.g. "M1").

If a field is genuinely missing from the image, set it to "".`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a precise forensic OCR engine. You examine text glyph-by-glyph and output strictly structured JSON."
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
          name: "precise_spelled_ocr",
          strict: true,
          schema: {
            type: "object",
            properties: {
              bl_spelled: { type: "string", description: "B/L characters separated by spaces" },
              serial_spelled: { type: "string", description: "Serial characters separated by spaces" },
              company_spelled: { type: "string", description: "Company name characters separated by spaces, words separated by |" },
              weight: { type: "string", description: "Raw weight numeric text as shown on screen" },
              qty: { type: "string", description: "Package quantity" },
              pallets: { type: "string", description: "Pallets quantity" },
              location: { type: "string", description: "Location code" }
            },
            required: ["bl_spelled", "serial_spelled", "company_spelled", "weight", "qty", "pallets", "location"],
            additionalProperties: false
          }
        }
      },
      temperature: 0.0
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // 1. إعادة تجميع السلاسل المتهجأة برمجياً
    const blNumber = (parsed.bl_spelled || '').replace(/\s+/g, '').trim();
    const alvSerial = (parsed.serial_spelled || '').replace(/\s+/g, '').trim();

    // إعادة تجميع اسم الشركة مع الحفاظ على المسافات بين الكلمات
    let cleanCompany = (parsed.company_spelled || '')
      .split('|')
      .map(word => word.replace(/\s+/g, '').trim())
      .filter(Boolean)
      .join(' ');

    // تنظيف إضافي لاسم الشركة لمنع أي أرقام هواتف
    cleanCompany = cleanCompany
      .replace(/(?:tel|phone|mob|fax|هاتف|تلفون|خلوي|فاكس)?[:\s]*\+?\d[\d\s\-\/]{6,}\d/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 2. معالجة الوزن بحماية تامة لمنع ضياع الرقم
    let finalWeight = '';
    if (parsed.weight) {
      // استخراج الرقم العشري أو الصحيح مهما كان محاطاً برموز أو كلمات
      const weightMatch = String(parsed.weight).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      if (weightMatch) {
        let numericVal = parseFloat(weightMatch[0]);
        if (!isNaN(numericVal) && numericVal > 0) {
          // إذا كان الوزن مكتوباً بالكيلوغرام (مثلاً 1040 كغم) نحوله لأطنان
          if (numericVal > 50) {
            numericVal = numericVal / 1000;
          }
          // التقريب للأعلى دائماً لأقرب 0.1
          const roundedWeight = Math.ceil(parseFloat(numericVal.toFixed(5)) * 10) / 10;
          finalWeight = roundedWeight.toFixed(1);
        } else {
          finalWeight = weightMatch[0];
        }
      }
    }

    // 3. تنظيف وتدقيق الأعداد
    let cleanQty = parsed.qty || '';
    if (cleanQty) {
      const q = parseInt(String(cleanQty).replace(/,/g, ''), 10);
      cleanQty = isNaN(q) ? cleanQty : String(q);
    }

    let cleanPallets = parsed.pallets || '';
    if (cleanPallets !== undefined && cleanPallets !== null && cleanPallets !== '') {
      const p = parseInt(String(cleanPallets).replace(/,/g, ''), 10);
      cleanPallets = isNaN(p) ? String(cleanPallets).trim() : String(p);
    }

    return res.json({
      blNumber: blNumber,
      alvSerial: alvSerial,
      qty: cleanQty,
      weight: finalWeight,
      pallets: cleanPallets,
      location: (parsed.location || '').trim(),
      clearanceCompany: cleanCompany
    });

  } catch (err) {
    console.error('OCR Endpoint Error:', err);
    return res.status(500).json({ error: 'Server Error: ' + err.message });
  }
});

// حفظ الطلبات
app.post('/api/orders', async (req, res) => {
  const db = await loadDB();
  const newOrder = {
    id: 'ORD-' + Math.floor(100000 + Math.random() * 900000),
    createdAt: new Date().toISOString(),
    createdBy: req.body.createdBy || 'Customer Service',
    status: req.body.isManual ? 'طباعة مباشرة' : 'بانتظار التحجيم',
    isManualPrint: !!req.body.isManual,
    bls: req.body.bls || [],
    totalWeight: req.body.totalWeight || 0,
    measurements: { length: '', width: '', height: '' },
    vehicleType: req.body.vehicleType || '',
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
app.listen(PORT, () => console.log(`Tahjeem server running on port ${PORT}`));
