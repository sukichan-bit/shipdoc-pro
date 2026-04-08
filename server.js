const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Create store table on startup
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

app.use(express.text({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// GET all store values
app.get('/api/store', async (req, res) => {
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
app.post('/api/store/:key', async (req, res) => {
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
app.delete('/api/store/:key', async (req, res) => {
  try {
    await pool.query('DELETE FROM store WHERE key = $1', [req.params.key]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to init DB:', err);
  process.exit(1);
});
