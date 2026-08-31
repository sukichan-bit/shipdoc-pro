const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Firebase Admin — verify Google ID tokens ──────────────────────────────────
// Requires env vars: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// Set these in Railway: Dashboard → your service → Variables
let firebaseReady = false;
try {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Railway stores the private key with literal \n — convert back to newlines
      privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
  firebaseReady = true;
  console.log('Firebase Admin ready, auth enabled');
} catch (e) {
  console.warn('Firebase Admin not configured — API is UNPROTECTED:', e.message);
}

// Allowed email domain(s) — only @prenetics.com accounts may access the API
const ALLOWED_DOMAIN = 'prenetics.com';

// Auth middleware — verify Bearer token from Google Sign-In
async function requireAuth(req, res, next) {
  if (!firebaseReady) return next(); // graceful degradation while setting up

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    // Restrict to company domain
    if (!decoded.email || !decoded.email.endsWith('@' + ALLOWED_DOMAIN)) {
      return res.status(403).json({ error: 'Access restricted to @' + ALLOWED_DOMAIN + ' accounts' });
    }
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session — please sign in again' });
  }
}

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      shipment_ref TEXT NOT NULL,
      user_email TEXT NOT NULL,
      user_name TEXT,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_activity_ref ON activity_log(shipment_ref, created_at DESC)`);
  console.log('Database ready');
}

app.use(express.text({ limit: '10mb' }));

// Serve only index.html explicitly — do NOT expose server.js or package.json
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── API routes (all protected) ────────────────────────────────────────────────

// GET all store values
app.get('/api/store', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM store');
    const data = {};
    result.rows.forEach(row => { data[row.key] = row.value; });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST (upsert) a single store value
app.post('/api/store/:key', requireAuth, async (req, res) => {
  try {
    const { key } = req.params;
    const value = req.body;
    await pool.query(
      `INSERT INTO store (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a single store value
app.delete('/api/store/:key', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM store WHERE key = $1', [req.params.key]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Activity log routes ───────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// GET activity for a shipment
app.get('/api/activity/:ref', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM activity_log WHERE shipment_ref = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.ref]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST a new activity entry
app.post('/api/activity', requireAuth, async (req, res) => {
  try {
    const { shipmentRef, action, details } = req.body;
    const userEmail = req.user.email;
    const userName = req.user.name || req.user.email.split('@')[0];
    await pool.query(
      `INSERT INTO activity_log (shipment_ref, user_email, user_name, action, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [shipmentRef, userEmail, userName, action, details || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
