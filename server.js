const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      employees: ['كستمر سيرفس 1', 'شريف (المستودع)'],
      orders: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
    return initialData;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. جلب البيانات
app.get('/api/data', (req, res) => {
  res.json(loadDB());
});

// 2. إضافة موظف
app.post('/api/employees', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
  const db = loadDB();
  if (!db.employees.includes(name)) {
    db.employees.push(name);
    saveDB(db);
  }
  res.json({ employees: db.employees });
});

// 3. تحليل السكرين شوت عبر OpenRouter (مجاني ومستقر)
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم استلام ملف صورة' });
    }

    const apiKey = process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح الـ API غير معرف في Render' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const dataUrl = `data:${mimeType};base64,${base64Image}`;

    const prompt = `
أنت نظام استخراج بيانات لشاشة Sage CRM لنظام LCL في شركة لوجستية.
استخرج الحقول التالية بدقة من الصورة وأرجع فقط كائن JSON صالح بالحقول التالية:
{
  "blNumber": "رقم البوليصة من خانة B/L No.",
  "alvSerial": "رقم ALV Serial",
  "qty": "العدد من خانة QTY كرقم صحيح",
  "weight": "الوزن من Weight(Ton) مقرباً للرقم الأعلى بمقدار 0.1 (مثال: إذا كان 1.611 اجعله 1.7)",
  "pallets": "عدد البلتات من خانة ALV Pallet كرقم",
  "location": "الموقع من جدول B\\L Location في الأسفل (الأكثر تكراراً)",
  "clearanceCompany": "اسم شركة التخليص من Company clearance"
}
إذا تعذر قراءة حقل معين، اتركه قيمة نصية فارغة "". أرجع الـ JSON فقط بدون markdown.
`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
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
        response_format: { type: 'json_object' }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('OpenRouter Error:', data);
      return res.status(500).json({ error: data.error?.message || 'خطأ في معالجة مزود الذكاء الاصطناعي' });
    }

    let rawContent = data.choices?.[0]?.message?.content || '{}';
    // تنظيف أي زوائد markdown إن وجدت
    rawContent = rawContent.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(rawContent);
    return res.json(parsed);

  } catch (err) {
    console.error('OCR Endpoint Error:', err);
    return res.status(500).json({ error: 'فشل معالجة الصورة: ' + err.message });
  }
});

// 4. إنشاء طلب جديد
app.post('/api/orders', (req, res) => {
  const db = loadDB();
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
  saveDB(db);
  res.json(newOrder);
});

// 5. حفظ واعتماد التحجيم من شريف
app.patch('/api/orders/:id/tahjeem', (req, res) => {
  const db = loadDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  order.measurements = req.body.measurements;
  order.vehicleType = req.body.vehicleType || '';
  order.shareefNotes = req.body.shareefNotes || '';
  order.status = 'تم التحجيم';
  order.completedAt = new Date().toISOString();

  saveDB(db);
  res.json(order);
});

// 6. حذف الطلبات القديمة (أسبوع فما فوق)
app.delete('/api/orders/old', (req, res) => {
  const db = loadDB();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  db.orders = db.orders.filter(o => new Date(o.createdAt) >= oneWeekAgo);
  saveDB(db);
  res.json({ success: true, count: db.orders.length });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
