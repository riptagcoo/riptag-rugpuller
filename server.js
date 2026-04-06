const express = require('express');
const session = require('express-session');
const fs = require('fs-extra');
const path = require('path');
const { google } = require('googleapis');
const multer = require('multer');
const { v4: uuid } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3099;

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || 'YOUR_GOOGLE_CLIENT_SECRET';
const BASE_URL = process.env.BASE_URL || `https://riptag-crosslister-production.up.railway.app`;
const REDIRECT_URI = `${BASE_URL}/auth/google/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'riptag-secret-2024';

// Dirs
fs.ensureDirSync('./data/sets');
fs.ensureDirSync('./data/accounts');
fs.ensureDirSync('./uploads');

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// CORS for extension
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Multer for photo uploads
const upload = multer({ dest: './uploads/' });

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

// ─── GOOGLE AUTH ───────────────────────────────────────────────
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
  const { code } = req.query;
  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    req.session.googleTokens = tokens;
    res.redirect('/?connected=drive');
  } catch (err) {
    res.redirect('/?error=auth');
  }
});

app.get('/api/drive/status', (req, res) => {
  res.json({ connected: !!req.session.googleTokens });
});

// ─── DRIVE FOLDERS ─────────────────────────────────────────────
app.get('/api/drive/folders', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const client = getOAuth2Client(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const r = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id,name,parents)',
      pageSize: 100
    });
    res.json({ folders: r.data.files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/folder/:folderId/photos', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const client = getOAuth2Client(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const r = await drive.files.list({
      q: `'${req.params.folderId}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id,name,mimeType,thumbnailLink,webContentLink)',
      orderBy: 'name',
      pageSize: 200
    });
    res.json({ photos: r.data.files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SETS ──────────────────────────────────────────────────────
async function getSets() {
  const files = await fs.readdir('./data/sets').catch(() => []);
  const sets = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try { sets.push(await fs.readJson(`./data/sets/${f}`)); } catch {}
  }
  return sets.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

app.get('/api/sets', async (req, res) => {
  res.json(await getSets());
});

app.get('/api/sets/:id', async (req, res) => {
  try { res.json(await fs.readJson(`./data/sets/${req.params.id}.json`)); }
  catch { res.status(404).json({ error: 'Set not found' }); }
});

app.post('/api/sets', async (req, res) => {
  const id = uuid();
  const set = {
    id,
    name: req.body.name || `Set ${Date.now()}`,
    description: req.body.description || '🌴 New Y2K & Vintage Drops 🌴\n\n⦾ Curated Bundles & Sick Pieces\n⦾ Promotional Post\n⦾ DM me for Bundle Info\n\n#vintage #y2k #thrift #streetwear',
    price: req.body.price || '20',
    sizes: req.body.sizes || ['S', 'M', 'L', 'XL'],
    hashtags: req.body.hashtags || '#vintage #y2k #thrift',
    groupSize: req.body.groupSize || 4,
    driveFolder: req.body.driveFolder || null,
    driveFolderName: req.body.driveFolderName || null,
    accountId: req.body.accountId || null,
    listings: [],
    status: 'draft',
    createdAt: new Date().toISOString(),
    deployedAt: null
  };
  await fs.writeJson(`./data/sets/${id}.json`, set, { spaces: 2 });
  res.json(set);
});

app.put('/api/sets/:id', async (req, res) => {
  try {
    const set = await fs.readJson(`./data/sets/${req.params.id}.json`);
    const updated = { ...set, ...req.body, id: set.id, createdAt: set.createdAt };
    await fs.writeJson(`./data/sets/${req.params.id}.json`, updated, { spaces: 2 });
    res.json(updated);
  } catch { res.status(404).json({ error: 'Set not found' }); }
});

app.delete('/api/sets/:id', async (req, res) => {
  await fs.remove(`./data/sets/${req.params.id}.json`);
  res.json({ ok: true });
});

// ─── LISTINGS within a set ─────────────────────────────────────
// Build listings from Drive folder photos (auto-group by groupSize)
app.post('/api/sets/:id/build-listings', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated with Google' });
  try {
    const set = await fs.readJson(`./data/sets/${req.params.id}.json`);
    if (!set.driveFolder) return res.status(400).json({ error: 'No Drive folder selected' });

    const client = getOAuth2Client(req.session.googleTokens);
    const drive = google.drive({ version: 'v3', auth: client });
    const r = await drive.files.list({
      q: `'${set.driveFolder}' in parents and mimeType contains 'image/' and trashed=false`,
      fields: 'files(id,name,mimeType,thumbnailLink)',
      orderBy: 'name',
      pageSize: 200
    });

    const photos = r.data.files;
    const groupSize = set.groupSize || 4;
    const listings = [];

    // Group photos into chunks
    for (let i = 0; i < photos.length; i += groupSize) {
      const group = photos.slice(i, i + groupSize);
      const listingId = uuid();
      // Create one listing per size
      for (const size of set.sizes) {
        listings.push({
          id: uuid(),
          groupId: listingId,
          groupIndex: Math.floor(i / groupSize),
          title: set.name,
          description: set.description,
          price: set.price,
          size,
          photos: group.map(p => ({ driveId: p.id, name: p.name, thumb: p.thumbnailLink })),
          customDescription: null,
          customPrice: null,
          posted: false,
          postError: null
        });
      }
    }

    set.listings = listings;
    await fs.writeJson(`./data/sets/${set.id}.json`, set, { spaces: 2 });
    res.json({ ok: true, count: listings.length, groups: Math.floor(photos.length / groupSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update individual listing override
app.put('/api/sets/:setId/listings/:listingId', async (req, res) => {
  try {
    const set = await fs.readJson(`./data/sets/${req.params.setId}.json`);
    const idx = set.listings.findIndex(l => l.id === req.params.listingId);
    if (idx === -1) return res.status(404).json({ error: 'Listing not found' });
    set.listings[idx] = { ...set.listings[idx], ...req.body };
    await fs.writeJson(`./data/sets/${req.params.setId}.json`, set, { spaces: 2 });
    res.json(set.listings[idx]);
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ─── ACCOUNTS ──────────────────────────────────────────────────
app.get('/api/accounts', async (req, res) => {
  const files = await fs.readdir('./data/accounts').catch(() => []);
  const accounts = [];
  for (const f of files.filter(f => f.endsWith('.json'))) {
    try { accounts.push(await fs.readJson(`./data/accounts/${f}`)); } catch {}
  }
  res.json(accounts);
});

app.post('/api/accounts', async (req, res) => {
  const { username, cookies } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const account = { id: uuid(), username, cookies: cookies || [], connectedAt: new Date().toISOString() };
  await fs.writeJson(`./data/accounts/${account.id}.json`, account, { spaces: 2 });
  broadcast({ type: 'account', username, status: 'connected' });
  res.json(account);
});

// Extension connects account (backwards compat)
app.post('/api/save-cookies', async (req, res) => {
  const { username, cookies, accountId } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing username' });
  const id = accountId || uuid();
  const account = { id, username, cookies: cookies || [], connectedAt: new Date().toISOString() };
  await fs.writeJson(`./data/accounts/${id}.json`, account, { spaces: 2 });
  broadcast({ type: 'account', username, status: 'connected', id });
  res.json({ ok: true, id, username });
});

app.delete('/api/accounts/:id', async (req, res) => {
  await fs.remove(`./data/accounts/${req.params.id}.json`);
  res.json({ ok: true });
});

// ─── DEPLOY ────────────────────────────────────────────────────
app.post('/api/sets/:id/deploy', async (req, res) => {
  res.json({ ok: true, message: 'Deploy started' });

  try {
    const set = await fs.readJson(`./data/sets/${req.params.id}.json`);
    if (!set.accountId) { broadcast({ type: 'deploy', setId: set.id, status: 'error', message: 'No account assigned to this set' }); return; }

    const account = await fs.readJson(`./data/accounts/${set.accountId}.json`);
    const { deploySet } = require('./deployer');

    set.status = 'deploying';
    await fs.writeJson(`./data/sets/${set.id}.json`, set, { spaces: 2 });

    await deploySet(set, account, async (progress) => {
      broadcast({ type: 'deploy', setId: set.id, ...progress });
      // Update posted status
      if (progress.listingId && progress.status === 'posted') {
        const s = await fs.readJson(`./data/sets/${set.id}.json`);
        const idx = s.listings.findIndex(l => l.id === progress.listingId);
        if (idx !== -1) { s.listings[idx].posted = true; await fs.writeJson(`./data/sets/${s.id}.json`, s, { spaces: 2 }); }
      }
    });

    const finalSet = await fs.readJson(`./data/sets/${set.id}.json`);
    finalSet.status = 'deployed';
    finalSet.deployedAt = new Date().toISOString();
    await fs.writeJson(`./data/sets/${set.id}.json`, finalSet, { spaces: 2 });

  } catch (err) {
    broadcast({ type: 'deploy', status: 'error', message: err.message });
  }
});

// Ping
app.get('/api/ping', (req, res) => res.json({ ok: true, version: '2.0.0' }));

app.listen(PORT, () => {
  console.log(`\n🏄  Riptag Set Manager v2`);
  console.log(`    Dashboard: http://localhost:${PORT}\n`);
});
