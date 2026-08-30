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

// 3. تحليل السكرين شوت مع نظام التبديل التلقائي عند الضغط
app.post('/api/ocr', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'لم يتم استلام أي ملف صورة' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'مفتاح GEMINI_API_KEY غير موجود في إعدادات Render' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';

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
إذا تعذر قراءة حقل معين، اتركه قيمة نصية فارغة "". لا تكتب أي نصوص خارج الـ JSON.
`;

    // قائمة بالموديلات للتبديل التلقائي في حال انشغال أي منها
    const candidateModels = [
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3-flash',
      'gemini-2.0-flash'
    ];

    let extractedData = null;
    let lastErrorMessage = '';

    for (const model of candidateModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inline_data: {
                      mime_type: mimeType,
                      data: base64Image
                    }
                  }
                ]
              }
            ],
            generationConfig: {
              response_mime_type: "application/json"
            }
          })
        });

        const data = await response.json();

        if (response.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          const rawText = data.candidates[0].content.parts[0].text;
          extractedData = JSON.parse(rawText);
          break; // نجاح العملية، إنهاء المحاولات
        } else {
          lastErrorMessage = data.error?.message || 'خطأ غير معروف في الاستجابة';
          console.warn(`فشل الموديل ${model}، جاري المحاولة مع الموديل التالي... الخطأ:`, lastErrorMessage);
        }
      } catch (err) {
        lastErrorMessage = err.message;
        console.warn(`استثناء في الموديل ${model}:`, err.message);
      }
    }

    if (extractedData) {
      return res.json(extractedData);
    } else {
      return res.status(500).json({ error: 'تعذر معالجة الصورة حالياً بسبب ضغط الخدمة. تفاصيل: ' + lastErrorMessage });
    }

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

// 5. اعتماد التحجيم من شريف
app.patch('/api/orders/:id/tahjeem', (req, res) => {
  const db = loadDB();
  const order = db.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

  order.measurements = req.body.measurements;
  order.vehicleType = req.body.vehicleType;
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
