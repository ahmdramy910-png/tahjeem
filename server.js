const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'db.json');

// تهيئة قاعدة البيانات المحلية
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

// ================= API Endpoints =================

// 1. جلب الموظفين والطلبات
app.get('/api/data', (req, res) => {
  const db = loadDB();
  res.json(db);
});

// 2. إضافة موظف جديد
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

// 3. تحليل سكرين شوت نظام الـ CRM واستخراج البيانات
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'لم يتم رفع صورة' });

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    // استدعاء Gemini Vision أو أي Vision API
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح الـ API غير مضبوط في السيرفر' });
    }

    const prompt = `
أنت خبير إدخال بيانات لوجستية. المطلوب استخراج البيانات من شاشة نظام Sage CRM (LCL Container Detail) وإرجاعها فقط بصيغة JSON بدون أي كلام إضافي أو علامات markdown:
{
  "blNumber": "رقم البوليصة من B/L No.",
  "alvSerial": "رقم ALV Serial",
  "qty": "العدد من حقل QTY كرقم صحيح",
  "weight": "الوزن من Weight(Ton) مقرباً للرقم الأعلى بمقدار 0.1 (مثال: 1.611 تصبح 1.7)",
  "pallets": "عدد البلتات من ALV Pallet كرقم",
  "location": "الموقع الأكثر تكراراً من جدول B\\L Location في الأسفل",
  "clearanceCompany": "اسم شركة التخليص من حقل Company clearance"
}
    `;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType, data: base64Image } }
          ]
        }]
      })
    });

    const result = await response.json();
    const textOutput = result.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleanedJson = textOutput.replace(/```json|```/g, '').trim();
    const parsedData = JSON.parse(cleanedJson);

    res.json(parsedData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'فشل استخراج البيانات من الصورة: ' + err.message });
  }
});

// 4. إنشاء طلب تحجيم جديد
app.post('/api/orders', (req, res) => {
  const db = loadDB();
  const newOrder = {
    id: 'ORD-' + Date.now().toString().slice(-6),
    createdAt: new Date().toISOString(),
    createdBy: req.body.createdBy || 'غير محدد',
    status: 'بانتظار التحجيم',
    bls: req.body.bls || [], // مصفوفة لغاية 3 بوالص
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

// 5. تحديث التحجيم من قبل شريف
app.patch('/api/orders/:id/tahjeem', (req, res) => {
  const db = loadDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  order.measurements = req.body.measurements;
  order.vehicleType = req.body.vehicleType; // بنقو، ديانا، LB، سنقل، تريلا
  order.shareefNotes = req.body.shareefNotes || '';
  order.status = 'تم التحجيم';
  order.completedAt = new Date().toISOString();

  saveDB(db);
  res.json(order);
});

// 6. حذف الطلبات الأقدم من أسبوع
app.delete('/api/orders/old', (req, res) => {
  const db = loadDB();
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  db.orders = db.orders.filter(o => new Date(o.createdAt) >= oneWeekAgo);
  saveDB(db);
  res.json({ success: true, count: db.orders.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));