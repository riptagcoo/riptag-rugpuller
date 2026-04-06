const express = require('express');
const session = require('express-session');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');
const { v4: uuid } = require('uuid');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3099;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL = process.env.BASE_URL || 'https://riptag-rugpuller-production.up.railway.app';
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'riptag-secret-2024';
const DATABASE_URL = process.env.DATABASE_URL;

// Postgres
const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sets (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialized');
}

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.static(path.join(__dirname, 'public')));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── AUTH ─────────────────────────────────────────────────────
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '1010';

function requireAuth(req, res, next) {
  // Always allow API routes, static files, auth routes
  if (req.path.startsWith('/api/') ||
      req.path.startsWith('/auth/') ||
      req.path.startsWith('/uploads/') ||
      req.path === '/login' ||
      req.path === '/logout' ||
      req.path.includes('.')) return next();
  // Only protect the main dashboard HTML
  if (req.session.authed) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head><title>Riptag Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#09090f;color:#eeeef5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}
  .box{background:#141420;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:40px;width:320px;text-align:center;}
  .logo{font-size:40px;margin-bottom:12px;}
  h2{font-size:18px;font-weight:700;margin-bottom:6px;}
  p{font-size:13px;color:#7a7a92;margin-bottom:24px;}
  input{width:100%;padding:10px 14px;background:#0f0f18;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#eeeef5;font-size:14px;outline:none;margin-bottom:12px;text-align:center;letter-spacing:4px;font-size:18px;}
  button{width:100%;padding:11px;background:#1ec8a0;color:#082820;font-size:14px;font-weight:700;border:none;border-radius:8px;cursor:pointer;}
  .err{color:#ff5c5c;font-size:12px;margin-top:10px;}
</style>
</head>
<body>
<div class="box">
  <div class="logo">🏄</div>
  <h2>Riptag Rugpuller</h2>
  <p>Enter your access code</p>
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="••••" autofocus/>
    <button type="submit">Access Dashboard</button>
    ${req.query.err ? '<div class="err">Incorrect code</div>' : ''}
  </form>
</div>
</body>
</html>`);
});

app.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) {
    req.session.authed = true;
    res.redirect('/');
  } else {
    res.redirect('/login?err=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});


app.use(requireAuth);

// SSE
let sseClients = [];
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(r => { try { r.write(msg); } catch {} });
}

app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients = sseClients.filter(c => c !== res); });
});

// ─── GOOGLE AUTH ──────────────────────────────────────────────
function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (tokens) client.setCredentials(tokens);
  return client;
}

app.get('/auth/google', (req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/?connected=drive');
  } catch { res.redirect('/?error=auth'); }
});

app.get('/api/drive/status', (req, res) => res.json({ connected: !!req.session.googleTokens }));

// ─── DRIVE ────────────────────────────────────────────────────
app.get('/api/drive/folders', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const client = getOAuth2Client(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const r = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id,name)', pageSize: 100
    });
    res.json({ folders: r.data.files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/drive/folder/:folderId/photos', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const client = getOAuth2Client(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const r = await drive.files.list({
      q: `'${req.params.folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id,name,mimeType,thumbnailLink)',
      orderBy: 'name', pageSize: 200
    });
    res.json({ photos: r.data.files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SETS ─────────────────────────────────────────────────────
app.get('/api/sets', async (req, res) => {
  const r = await pool.query('SELECT data FROM sets ORDER BY created_at DESC');
  res.json(r.rows.map(row => row.data));
});

app.get('/api/sets/:id', async (req, res) => {
  const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(r.rows[0].data);
});

app.post('/api/sets', async (req, res) => {
  const id = uuid();
  const set = {
    id, name: req.body.name || 'New Set',
    description: req.body.description || '🌴 New Y2K & Vintage Drops 🌴\n\n⦾ Curated Bundles & Sick Pieces\n⦾ Promotional Post\n⦾ DM me for Bundle Info\n\n#vintage #y2k #thrift #streetwear',
    price: req.body.price || '20',
    sizes: req.body.sizes || ['S','M','L','XL'],
    groupSize: req.body.groupSize || 4,
    driveFolder: req.body.driveFolder || null,
    driveFolderName: req.body.driveFolderName || null,
    accountId: req.body.accountId || null,
    listings: [], status: 'draft',
    createdAt: new Date().toISOString(), deployedAt: null
  };
  await pool.query('INSERT INTO sets (id, data) VALUES ($1, $2)', [id, JSON.stringify(set)]);
  res.json(set);
});

app.put('/api/sets/:id', async (req, res) => {
  const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const updated = { ...r.rows[0].data, ...req.body, id: req.params.id };
  await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(updated), req.params.id]);
  res.json(updated);
});

app.delete('/api/sets/:id', async (req, res) => {
  await pool.query('DELETE FROM sets WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ─── BUILD LISTINGS ───────────────────────────────────────────
app.post('/api/sets/:id/build-listings', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Set not found' });
    const set = r.rows[0].data;
    if (!set.driveFolder) return res.status(400).json({ error: 'No Drive folder selected' });

    const client = getOAuth2Client(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const photos = await drive.files.list({
      q: `'${set.driveFolder}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id,name,mimeType,thumbnailLink)', orderBy: 'name', pageSize: 200
    });

    const groupSize = set.groupSize || 4;
    const listings = [];
    const files = photos.data.files;

    for (let i = 0; i < files.length; i += groupSize) {
      const group = files.slice(i, i + groupSize);
      const groupId = uuid();
      for (const size of set.sizes) {
        listings.push({
          id: uuid(), groupId, groupIndex: Math.floor(i / groupSize),
          title: set.name, description: set.description, price: set.price, size,
          photos: group.map(p => ({ driveId: p.id, name: p.name, thumb: p.thumbnailLink })),
          customDescription: null, customPrice: null, posted: false
        });
      }
    }

    set.listings = listings;
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
    res.json({ ok: true, count: listings.length, groups: Math.floor(files.length / groupSize) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update individual listing
app.put('/api/sets/:setId/listings/:listingId', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.setId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const set = r.rows[0].data;
    const idx = set.listings.findIndex(l => l.id === req.params.listingId);
    if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
    set.listings[idx] = { ...set.listings[idx], ...req.body };
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
    res.json(set.listings[idx]);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── ACCOUNTS ─────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  const r = await pool.query('SELECT data FROM accounts ORDER BY created_at DESC');
  res.json(r.rows.map(row => row.data));
});

app.post('/api/save-cookies', async (req, res) => {
  const { username, cookies, accountId } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const id = accountId || uuid();
  // Check if account exists
  const existing = await pool.query('SELECT id FROM accounts WHERE id=$1', [id]);
  const account = { id, username, cookies: cookies || [], connectedAt: new Date().toISOString() };
  if (existing.rows.length) {
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), id]);
  } else {
    await pool.query('INSERT INTO accounts (id, data) VALUES ($1, $2)', [id, JSON.stringify(account)]);
  }
  broadcast({ type: 'account', username, status: 'connected', id });
  res.json({ ok: true, id, username });
});

app.delete('/api/accounts/:id', async (req, res) => {
  await pool.query('DELETE FROM accounts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ─── DEPLOY ───────────────────────────────────────────────────
app.post('/api/sets/:id/deploy', async (req, res) => {
  res.json({ ok: true });
  // Deploy runs locally via agent.js - this just marks status
  const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return;
  const set = r.rows[0].data;
  set.status = 'deploying';
  await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
  broadcast({ type: 'deploy', setId: set.id, status: 'info', message: 'Use the local agent.js to deploy this set.' });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, version: '2.1.0' }));

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🏄  Riptag Set Manager v2.1 (Postgres)`);
    console.log(`    Dashboard: http://localhost:${PORT}\n`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
