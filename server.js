const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
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

// خوارزمية التصويت بالأغلبية لحسم أي حرف مختلف في البوليصة
function resolveByMajority(candidates) {
  const valid = candidates.map(c => (c || '').trim()).filter(Boolean);
  if (!valid.length) return '';
  if (valid.length === 1) return valid[0];

  const maxLen = Math.max(...valid.map(s => s.length));
  let result = '';

  for (let i = 0; i < maxLen; i++) {
    const charVotes = {};
    for (const str of valid) {
      if (i < str.length) {
        const ch = str[i];
        charVotes[ch] = (charVotes[ch] || 0) + 1;
      }
    }
    let winnerChar = '';
    let maxVotes = -1;
    for (const [ch, count] of Object.entries(charVotes)) {
      if (count > maxVotes) {
        maxVotes = count;
        winnerChar = ch;
      }
    }
    if (winnerChar) result += winnerChar;
  }
  return result;
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

// إحصائيات الموظفين
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

// محرك الـ OCR عالي الدقة مع التدقيق الصارم على اللوكيشن والبوليصة
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image provided' });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'OPENAI_API_KEY variable is missing in Render Environment' });
    }

    const base64Data = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;

    const prompt = `Perform OCR on this Sage CRM logistics screen with extreme character-level accuracy:

1. blCandidates: Extract ALL occurrences of the B/L number found on screen:
   - The string next to 'B\\L No:' at the top.
   - Each row's value in the first column ('B\\L') of the bottom table 'B\\L Location'.
2. alvSerial: The text below 'ALV Serial:' preserving original spaces.
3. pallets: The integer under 'ALV Pallet:'.
4. qty: The quantity under 'QTY:'.
5. weight: Raw weight number under 'Weight(Ton):'.
6. clearanceCompany: Company name next to 'Company clearance:' (ignore phone numbers).
7. locations: Look at the bottom table 'B\\L Location'. Check the 'Location' and 'locname' columns for every row.
   - Extract the COMPLETE code without omitting ANY letters, numbers, hyphens, or spaces (e.g., if it is 'M1', write 'M1'; if 'M1-A', transcribe all characters faithfully).
   - Return all location entries found across all rows as an array of strings.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: "You are a professional logistics OCR system. Double-check all location codes character-by-character from the B\\L Location table and output strictly valid JSON."
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
          name: "crm_shipment_data",
          strict: true,
          schema: {
            type: "object",
            properties: {
              blCandidates: {
                type: "array",
                items: { type: "string" },
                description: "List of all B/L numbers from top header and bottom table rows"
              },
              alvSerial: { type: "string" },
              pallets: { type: "string" },
              qty: { type: "string" },
              weight: { type: "string" },
              clearanceCompany: { type: "string" },
              locations: {
                type: "array",
                items: { type: "string" },
                description: "Full location strings from Location and locname columns without missing characters"
              }
            },
            required: ["blCandidates", "alvSerial", "pallets", "qty", "weight", "clearanceCompany", "locations"],
            additionalProperties: false
          }
        }
      },
      temperature: 0.0
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    // 1. استخراج رقم البوليصة عبر المقارنة والتصويت بين كل مواضع الظهور
    const finalBlNumber = resolveByMajority(parsed.blCandidates || []);

    // 2. تنظيف الأعداد
    let cleanQty = parsed.qty ? String(parseInt(String(parsed.qty).replace(/,/g, ''), 10) || parsed.qty) : '';
    let cleanPallets = (parsed.pallets !== undefined && parsed.pallets !== null && parsed.pallets !== '')
      ? String(parseInt(String(parsed.pallets).replace(/,/g, ''), 10) || parsed.pallets)
      : '';

    // 3. تصفية أرقام الهواتف من اسم الشركة
    let cleanCompany = (parsed.clearanceCompany || '')
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\u260E|\u2706|\u2121/g, '')
      .replace(/(?:tel|phone|mob|fax|هاتف|تلفون|خلوي|فاكس)?[:\s]*\+?\d[\d\s\-\/]{4,}\d/gi, '')
      .replace(/\s+\d{4,}\b.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // 4. تقريب الوزن للأعلى دائماً لأقرب 0.1 طن
    let finalWeight = '';
    if (parsed.weight) {
      const match = String(parsed.weight).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
      if (match) {
        let num = parseFloat(match[0]);
        if (!isNaN(num) && num > 0) {
          if (num > 50) num = num / 1000;
          finalWeight = (Math.ceil(parseFloat(num.toFixed(5)) * 10) / 10).toFixed(1);
        } else {
          finalWeight = match[0];
        }
      }
    }

    // 5. دمج المواقع المتعددة بعلامة + ومنع تكرار نفس الموقع مع الحفاظ على كامل الحروف
    let finalLocation = '';
    if (Array.isArray(parsed.locations) && parsed.locations.length > 0) {
      const uniqueLocs = [...new Set(parsed.locations.map(l => String(l).trim()).filter(Boolean))];
      finalLocation = uniqueLocs.join(' + ');
    }

    return res.json({
      blNumber: finalBlNumber,
      alvSerial: (parsed.alvSerial || '').trim(),
      qty: cleanQty,
      weight: finalWeight,
      pallets: cleanPallets,
      location: finalLocation,
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
