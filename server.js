const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const MONGODB_URI = process.env.MONGODB_URI;

const AppStateSchema = new mongoose.Schema({
  key: { type: String, default: 'main_state', unique: true },
  users: { type: Array, default: [] },
  orders: { type: Array, default: [] },
  ocrCosts: { type: Array, default: [] }
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
      if (doc) return { users: doc.users || [], orders: doc.orders || [], ocrCosts: doc.ocrCosts || [] };
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
        { users: data.users, orders: data.orders, ocrCosts: data.ocrCosts },
        { upsert: true }
      );
    } catch (err) {
      console.error('Error saving DB:', err);
    }
  }
}

// دالة حساب التكلفة الفعلية
function getExactCost(usage) {
  if (!usage) {
    return { inTokens: 0, outTokens: 0, totalTokens: 0, costUSD: 0, costJOD: 0 };
  }
  const inTokens = usage.prompt_tokens || 0;
  const outTokens = usage.completion_tokens || 0;
  const totalTokens = usage.total_tokens || (inTokens + outTokens);
  const costUSD = (inTokens * 0.0000025) + (outTokens * 0.00001);
  const costJOD = costUSD * 0.709;

  return {
    inTokens,
    outTokens,
    totalTokens,
    costUSD: parseFloat(costUSD.toFixed(5)),
    costJOD: parseFloat(costJOD.toFixed(5))
  };
}

// خوارزمية التصويت بالأغلبية
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

// كود لوحة التكاليف المحقونة
const costUI = `
<!-- Cost Dashboard Injection -->
<div style="position:fixed; top:12px; right:16px; z-index:9999999;">
  <button id="btnAiCosts" onclick="openCostDashboardDirectly()" style="background:#0284c7; color:#ffffff; border:none; padding:8px 16px; border-radius:8px; font-weight:bold; font-size:14px; cursor:pointer; box-shadow:0 4px 12px rgba(0,0,0,0.3); font-family:sans-serif; display:flex; align-items:center; gap:8px;">
    <span>💳</span> AI Costs
  </button>
</div>

<div id="secretCostModal" style="display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.85); z-index:99999999; justify-content:center; align-items:center; font-family:sans-serif;" dir="ltr">
  <div style="background:#1e293b; color:#fff; width:92%; max-width:650px; border-radius:12px; padding:24px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.7); border:1px solid #334155;">
    <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #334155; padding-bottom:12px; margin-bottom:16px;">
      <h3 style="margin:0; font-size:18px; color:#38bdf8;">📊 AI Usage & Cost Dashboard</h3>
      <button onclick="document.getElementById('secretCostModal').style.display='none'" style="background:transparent; border:none; color:#94a3b8; font-size:24px; cursor:pointer;">&times;</button>
    </div>
    
    <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:12px; margin-bottom:20px;">
      <div style="background:#0f172a; padding:12px; border-radius:8px; text-align:center;">
        <div style="color:#94a3b8; font-size:12px;">Total (USD)</div>
        <div id="sumUSD" style="font-size:20px; font-weight:bold; color:#10b981; margin-top:4px;">$0.00</div>
      </div>
      <div style="background:#0f172a; padding:12px; border-radius:8px; text-align:center;">
        <div style="color:#94a3b8; font-size:12px;">Total (JOD)</div>
        <div id="sumJOD" style="font-size:20px; font-weight:bold; color:#38bdf8; margin-top:4px;">0.00 JOD</div>
      </div>
      <div style="background:#0f172a; padding:12px; border-radius:8px; text-align:center;">
        <div style="color:#94a3b8; font-size:12px;">Total Operations</div>
        <div id="sumOps" style="font-size:20px; font-weight:bold; color:#f59e0b; margin-top:4px;">0</div>
      </div>
    </div>

    <div style="max-height:260px; overflow-y:auto; border:1px solid #334155; border-radius:8px;">
      <table style="width:100%; border-collapse:collapse; font-size:13px; text-align:left;">
        <thead>
          <tr style="background:#0f172a; color:#94a3b8;">
            <th style="padding:10px;">Time</th>
            <th style="padding:10px;">B/L Number</th>
            <th style="padding:10px;">Cost ($)</th>
            <th style="padding:10px;">Cost (JOD)</th>
          </tr>
        </thead>
        <tbody id="costTableBody"></tbody>
      </table>
    </div>

    <div style="margin-top:16px; display:flex; justify-content:space-between; align-items:center;">
      <button onclick="clearCostHistory()" style="background:#ef4444; color:#fff; border:none; padding:8px 14px; border-radius:6px; font-size:12px; cursor:pointer;">Reset History</button>
      <span style="font-size:11px; color:#64748b;">Live data calculated per OCR operation</span>
    </div>
  </div>
</div>

<script>
  let currentPin = '';

  async function openCostDashboardDirectly() {
    const pin = prompt('Enter Admin PIN:');
    if (!pin) return;
    if (pin !== '1010') {
      alert('Incorrect PIN!');
      return;
    }
    currentPin = pin;

    try {
      const res = await fetch('/api/admin/costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: currentPin })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      document.getElementById('sumUSD').textContent = '$' + data.summary.totalUSD;
      document.getElementById('sumJOD').textContent = data.summary.totalJOD + ' JOD';
      document.getElementById('sumOps').textContent = data.summary.totalOps;

      const tbody = document.getElementById('costTableBody');
      tbody.innerHTML = '';
      data.history.forEach(item => {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid #334155';
        const time = new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        tr.innerHTML = \`
          <td style="padding:8px 10px; color:#94a3b8;">\${time}</td>
          <td style="padding:8px 10px; font-weight:bold; color:#e2e8f0;">\${item.blNumber}</td>
          <td style="padding:8px 10px; color:#10b981;">$\${item.costUSD}</td>
          <td style="padding:8px 10px; color:#38bdf8;">\${item.costJOD} JOD</td>
        \`;
        tbody.appendChild(tr);
      });

      document.getElementById('secretCostModal').style.display = 'flex';
    } catch (e) {
      alert(e.message);
    }
  }

  async function clearCostHistory() {
    if (!confirm('Are you sure you want to clear cost history?')) return;
    try {
      const res = await fetch('/api/admin/costs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: currentPin })
      });
      if (res.ok) {
        alert('Cost history cleared successfully');
        document.getElementById('secretCostModal').style.display = 'none';
      }
    } catch (e) {
      alert('Error clearing cost history');
    }
  }
</script>
`;

// مسار الصفحة الرئيسية المعدلة إجبارياً
app.get(['/', '/index.html'], (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    let html = fs.readFileSync(indexPath, 'utf8');
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${costUI}</body>`);
    } else {
      html = html + costUI;
    }
    return res.send(html);
  }
  res.send(`<h1>Tahjeem App Running</h1>${costUI}`);
});

// خدمة بقية الملفات (CSS, JS, إلخ)
app.use(express.static('public'));

// مسار التحقق من الرمز السري 1010
app.post('/api/admin/costs', async (req, res) => {
  const { pin } = req.body;
  if (pin !== '1010') {
    return res.status(403).json({ error: 'Invalid PIN!' });
  }

  const db = await loadDB();
  const costs = db.ocrCosts || [];
  
  const totalUSD = costs.reduce((sum, item) => sum + (item.costUSD || 0), 0);
  const totalJOD = costs.reduce((sum, item) => sum + (item.costJOD || 0), 0);
  const totalTokens = costs.reduce((sum, item) => sum + (item.totalTokens || 0), 0);

  res.json({
    success: true,
    summary: {
      totalOps: costs.length,
      totalUSD: parseFloat(totalUSD.toFixed(4)),
      totalJOD: parseFloat(totalJOD.toFixed(4)),
      totalTokens
    },
    history: costs.slice(-50).reverse()
  });
});

app.post('/api/admin/costs/clear', async (req, res) => {
  const { pin } = req.body;
  if (pin !== '1010') return res.status(403).json({ error: 'Unauthorized' });

  const db = await loadDB();
  db.ocrCosts = [];
  await saveDB(db);
  res.json({ success: true, message: 'Cost history cleared' });
});

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

// نقطة فحص الـ OCR وتوثيق التكلفة
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
   - Extract the COMPLETE code without omitting ANY letters, numbers, hyphens, or spaces.
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

    // حساب التكلفة وحفظها
    const costData = getExactCost(completion.usage);
    const finalBlNumber = resolveByMajority(parsed.blCandidates || []);

    const db = await loadDB();
    if (!db.ocrCosts) db.ocrCosts = [];
    db.ocrCosts.push({
      timestamp: new Date().toISOString(),
      blNumber: finalBlNumber || 'N/A',
      costUSD: costData.costUSD,
      costJOD: costData.costJOD,
      totalTokens: costData.totalTokens
    });
    await saveDB(db);

    // تنظيف الأعداد
    let cleanQty = parsed.qty ? String(parseInt(String(parsed.qty).replace(/,/g, ''), 10) || parsed.qty) : '';
    let cleanPallets = (parsed.pallets !== undefined && parsed.pallets !== null && parsed.pallets !== '')
      ? String(parseInt(String(parsed.pallets).replace(/,/g, ''), 10) || parsed.pallets)
      : '';

    // تصفية أرقام الهواتف من اسم الشركة
    let cleanCompany = (parsed.clearanceCompany || '')
      .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|\u260E|\u2706|\u2121/g, '')
      .replace(/(?:tel|phone|mob|fax|هاتف|تلفون|خلوي|فاكس)?[:\s]*\+?\d[\d\s\-\/]{4,}\d/gi, '')
      .replace(/\s+\d{4,}\b.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // تقريب الوزن للأعلى دائماً لأقرب 0.1 طن
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

    // دمج المواقع المتعددة بعلامة + ومنع التكرار
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
