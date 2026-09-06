const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();

const upload = multer({
  storage: multer.memoryStorage()
});

app.use(cors());

app.use(
  express.json({
    limit: '25mb'
  })
);

app.use(express.static('public'));

const MONGODB_URI = process.env.MONGODB_URI;

const AppStateSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'main_state',
      unique: true
    },

    users: {
      type: Array,
      default: []
    },

    orders: {
      type: Array,
      default: []
    }
  },
  {
    timestamps: true
  }
);

const AppState = mongoose.model(
  'AppState',
  AppStateSchema
);

let memoryState = {
  users: [],
  orders: []
};

let isConnectedToMongo = false;


/* =========================
   MONGODB CONNECTION
   ========================= */

if (MONGODB_URI) {
  mongoose
    .connect(MONGODB_URI)
    .then(async () => {
      isConnectedToMongo = true;

      console.log(
        'Connected to MongoDB Atlas'
      );

      const doc = await AppState.findOne({
        key: 'main_state'
      });

      if (!doc) {
        await AppState.create({
          key: 'main_state',
          users: [],
          orders: []
        });
      }
    })
    .catch(err => {
      console.error(
        'MongoDB error:',
        err.message
      );
    });
}


/* =========================
   DATABASE FUNCTIONS
   ========================= */

async function loadDB() {
  if (isConnectedToMongo) {
    try {
      const doc =
        await AppState.findOne({
          key: 'main_state'
        });

      if (doc) {
        return {
          users: doc.users || [],
          orders: doc.orders || []
        };
      }
    } catch (err) {
      console.error(
        'Error loading DB:',
        err
      );
    }
  }

  return memoryState;
}


async function saveDB(data) {
  memoryState = data;

  if (isConnectedToMongo) {
    try {
      await AppState.findOneAndUpdate(
        {
          key: 'main_state'
        },
        {
          users: data.users,
          orders: data.orders
        },
        {
          upsert: true
        }
      );
    } catch (err) {
      console.error(
        'Error saving DB:',
        err
      );
    }
  }
}


/* =========================
   USERS
   ========================= */

app.get(
  '/api/users/list',
  async (req, res) => {
    const db = await loadDB();

    res.json(
      (db.users || []).map(u => ({
        id: u.id,
        name: u.name,
        role: u.role
      }))
    );
  }
);


app.post(
  '/api/login',
  async (req, res) => {
    const {
      userId,
      password
    } = req.body;

    const db = await loadDB();

    const user = db.users.find(
      u => u.id === userId
    );

    if (
      !user ||
      user.password !== password
    ) {
      return res.status(401).json({
        error:
          'Invalid user or password'
      });
    }

    res.json({
      success: true,

      user: {
        id: user.id,
        name: user.name,
        role: user.role
      }
    });
  }
);


app.post(
  '/api/users/register',
  async (req, res) => {
    const {
      name,
      role,
      password
    } = req.body;

    if (
      !name ||
      !password ||
      password.length < 8
    ) {
      return res.status(400).json({
        error:
          'Password must be at least 8 characters'
      });
    }

    const db = await loadDB();

    if (
      db.users.some(
        u =>
          u.name.toLowerCase() ===
          name
            .trim()
            .toLowerCase()
      )
    ) {
      return res.status(400).json({
        error:
          'Employee already registered'
      });
    }

    const newUser = {
      id:
        'u_' +
        Date.now(),

      name:
        name.trim(),

      role:
        role || 'cs',

      password:
        password.trim()
    };

    db.users.push(newUser);

    await saveDB(db);

    res.json({
      success: true,

      user: {
        id: newUser.id,
        name: newUser.name,
        role: newUser.role
      }
    });
  }
);


/* =========================
   DATA
   ========================= */

app.get(
  '/api/data',
  async (req, res) => {
    const db = await loadDB();

    res.json({
      orders: db.orders
    });
  }
);


/* =========================
   STATISTICS
   ========================= */

app.get(
  '/api/stats',
  async (req, res) => {
    const db = await loadDB();

    const stats = {};

    (db.users || []).forEach(
      u => {
        stats[u.name] = {
          role:
            u.role === 'cs'
              ? 'Customer Service'
              : 'Warehouse',

          totalBLs: 0,

          totalCars: 0
        };
      }
    );

    (db.orders || []).forEach(
      order => {
        const blCount =
          (order.bls || []).length;

        if (!blCount) {
          return;
        }

        if (order.createdBy) {
          if (
            !stats[
              order.createdBy
            ]
          ) {
            stats[
              order.createdBy
            ] = {
              role: 'CS',
              totalBLs: 0,
              totalCars: 0
            };
          }

          stats[
            order.createdBy
          ].totalBLs += blCount;

          stats[
            order.createdBy
          ].totalCars += 1;
        }

        if (
          order.measuredBy &&
          order.measuredBy !==
            order.createdBy &&
          order.status ===
            'تم التحجيم'
        ) {
          if (
            !stats[
              order.measuredBy
            ]
          ) {
            stats[
              order.measuredBy
            ] = {
              role:
                'Warehouse',
              totalBLs: 0,
              totalCars: 0
            };
          }

          stats[
            order.measuredBy
          ].totalBLs += blCount;

          stats[
            order.measuredBy
          ].totalCars += 1;
        }
      }
    );

    res.json(stats);
  }
);


/* =========================
   OCR - OLLAMA
   ========================= */

app.post(
  '/api/ocr',
  upload.single('image'),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error:
            'No image provided'
        });
      }

      const base64Data =
        req.file.buffer.toString(
          'base64'
        );

      const prompt = `
You are a highly accurate OCR system for a logistics company.

Read the provided Sage CRM screenshot carefully.

Extract ONLY these fields:

{
  "blNumber": "",
  "alvSerial": "",
  "qty": "",
  "weight": "",
  "pallets": "",
  "location": "",
  "clearanceCompany": ""
}

Return ONLY a valid JSON object.

Do not write explanations.
Do not use markdown.
Do not add extra fields.

OCR RULES:

1. B/L NUMBER
Read the B/L number exactly as shown.

A numeric zero must always be written as:
0

Never replace digit 0 with letter O.

2. ALV SERIAL
Read the ALV serial exactly as shown.

A numeric zero must always be:
0

Never replace numeric 0 with letter O.

3. QTY
Return quantity as a pure integer.

Example:
55

Do not return:
55 pcs

4. WEIGHT
Read the weight in tons.

Round UP to the nearest 0.1 ton.

Examples:

1.611 -> 1.7
2.01 -> 2.1
3.20 -> 3.2

5. PALLETS
Return pallets as a pure integer.

6. LOCATION
Read the warehouse location code accurately.

7. CLEARANCE COMPANY
Transcribe the clearance company name accurately.

8. DO NOT GUESS
If a field cannot be read clearly, return an empty string.

9. PRESERVE VALUES
Do not invent, change, or normalize values unless the rules above specifically require it.

Return ONLY the JSON object.
`;

      /*
       * Ollama is running on the user's computer
       * and is exposed through the Cloudflare tunnel.
       */

      const ollamaUrl =
        'https://laboratories-spirituality-combo-smooth.trycloudflare.com/api/chat';

      const response =
        await fetch(
          ollamaUrl,
          {
            method: 'POST',

            headers: {
              'Content-Type':
                'application/json'
            },

            body: JSON.stringify({
              model:
                'qwen2.5vl:7b',

              messages: [
                {
                  role: 'user',

                  content:
                    prompt,

                  images: [
                    base64Data
                  ]
                }
              ],

              stream: false,

              format: 'json',

              options: {
                temperature: 0
              }
            })
          }
        );

      const data =
        await response.json();

      if (!response.ok) {
        console.error(
          'Ollama Error:',
          data
        );

        return res.status(500).json({
          error:
            data.error ||
            'Ollama OCR service error'
        });
      }

      const rawContent =
        data.message?.content ||
        '{}';

      let parsed;

      try {
        parsed =
          JSON.parse(
            rawContent
          );
      } catch (parseError) {
        console.error(
          'Invalid JSON returned by Ollama:',
          rawContent
        );

        return res.status(500).json({
          error:
            'OCR returned invalid JSON'
        });
      }

      const result = {
        blNumber:
          String(
            parsed.blNumber ||
              ''
          ).trim(),

        alvSerial:
          String(
            parsed.alvSerial ||
              ''
          ).trim(),

        qty:
          String(
            parsed.qty ||
              ''
          ).trim(),

        weight:
          String(
            parsed.weight ||
              ''
          ).trim(),

        pallets:
          String(
            parsed.pallets ||
              ''
          ).trim(),

        location:
          String(
            parsed.location ||
              ''
          ).trim(),

        clearanceCompany:
          String(
            parsed.clearanceCompany ||
              ''
          ).trim()
      };


      /* =========================
         QTY CLEANING
         ========================= */

      if (result.qty) {
        const cleanQty =
          parseInt(
            result.qty.replace(
              /,/g,
              ''
            ),
            10
          );

        if (!isNaN(cleanQty)) {
          result.qty =
            String(cleanQty);
        }
      }


      /* =========================
         PALLETS CLEANING
         ========================= */

      if (result.pallets) {
        const cleanPallets =
          parseInt(
            result.pallets.replace(
              /,/g,
              ''
            ),
            10
          );

        if (
          !isNaN(
            cleanPallets
          )
        ) {
          result.pallets =
            String(
              cleanPallets
            );
        }
      }


      return res.json(result);

    } catch (err) {
      console.error(
        'OCR Endpoint Error:',
        err
      );

      return res.status(500).json({
        error:
          'Server Error: ' +
          err.message
      });
    }
  }
);


/* =========================
   CREATE ORDER
   ========================= */

app.post(
  '/api/orders',
  async (req, res) => {
    const db = await loadDB();

    const newOrder = {
      id:
        'ORD-' +
        Math.floor(
          100000 +
            Math.random() *
              900000
        ),

      createdAt:
        new Date().toISOString(),

      createdBy:
        req.body.createdBy ||
        'Customer Service',

      status:
        req.body.isManual
          ? 'طباعة يدوية'
          : 'بانتظار التحجيم',

      isManualPrint:
        !!req.body.isManual,

      bls:
        req.body.bls || [],

      totalWeight:
        req.body.totalWeight ||
        0,

      measurements: {
        length: '',
        width: '',
        height: ''
      },

      vehicleType: '',

      shareefNotes:
        req.body.shareefNotes ||
        '',

      measuredBy:
        null,

      completedAt:
        req.body.isManual
          ? new Date().toISOString()
          : null
    };

    db.orders.unshift(
      newOrder
    );

    await saveDB(db);

    res.json(
      newOrder
    );
  }
);


/* =========================
   TAHJEEM ORDER
   ========================= */

app.patch(
  '/api/orders/:id/tahjeem',
  async (req, res) => {
    const db = await loadDB();

    const order =
      db.orders.find(
        o =>
          o.id ===
          req.params.id
      );

    if (!order) {
      return res.status(404).json({
        error:
          'Order not found'
      });
    }

    order.measurements =
      req.body.measurements;

    order.vehicleType =
      req.body.vehicleType ||
      '';

    order.shareefNotes =
      req.body.shareefNotes ||
      '';

    order.measuredBy =
      req.body.measuredBy ||
      'Warehouse Staff';

    order.status =
      'تم التحجيم';

    order.completedAt =
      new Date().toISOString();

    await saveDB(db);

    res.json(order);
  }
);


/* =========================
   CLEAN OLD ORDERS
   ========================= */

app.delete(
  '/api/orders/clean',
  async (req, res) => {
    const days =
      parseInt(
        req.query.days
      ) || 7;

    const db =
      await loadDB();

    const cutoff =
      new Date(
        Date.now() -
          days *
            24 *
            60 *
            60 *
            1000
      );

    db.orders =
      db.orders.filter(
        o =>
          new Date(
            o.createdAt
          ) >= cutoff
      );

    await saveDB(db);

    res.json({
      success: true,
      count:
        db.orders.length
    });
  }
);


/* =========================
   CLEAR ALL ORDERS
   ========================= */

app.delete(
  '/api/orders/clear-all',
  async (req, res) => {
    const db =
      await loadDB();

    db.orders = [];

    await saveDB(db);

    res.json({
      success: true,
      message:
        'Archive cleared'
    });
  }
);


/* =========================
   START SERVER
   ========================= */

const PORT =
  process.env.PORT ||
  10000;

app.listen(
  PORT,
  () => {
    console.log(
      `Server running on port ${PORT}`
    );
  }
);
