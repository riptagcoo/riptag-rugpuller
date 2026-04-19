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
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '1010';

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
    CREATE TABLE IF NOT EXISTS schedule_log (
      id TEXT PRIMARY KEY,
      set_id TEXT,
      fired_at TIMESTAMPTZ DEFAULT NOW(),
      status TEXT
    );
  `);
  console.log('✅ Database ready');
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: true, cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// AUTH
function requireAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey && apiKey === DASHBOARD_PASSWORD) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/') || req.path.startsWith('/uploads/') || req.path === '/login' || req.path === '/logout' || req.path.includes('.')) return next();
  if (req.session.authed) return next();
  return res.redirect('/login');
}

app.get('/login', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Riptag Login</title><style>*{box-sizing:border-box;margin:0;padding:0;}body{background:#09090f;color:#eeeef5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;}.box{background:#141420;border:1px solid rgba(255,255,255,0.07);border-radius:14px;padding:40px;width:320px;text-align:center;}.logo{font-size:40px;margin-bottom:12px;}h2{font-size:18px;font-weight:700;margin-bottom:6px;}p{font-size:13px;color:#7a7a92;margin-bottom:24px;}input{width:100%;padding:10px 14px;background:#0f0f18;border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#eeeef5;font-size:18px;outline:none;margin-bottom:12px;text-align:center;letter-spacing:4px;}button{width:100%;padding:11px;background:#1ec8a0;color:#082820;font-size:14px;font-weight:700;border:none;border-radius:8px;cursor:pointer;}.err{color:#ff5c5c;font-size:12px;margin-top:10px;}</style></head><body><div class="box"><div class="logo">🏄</div><h2>Riptag Rugpuller</h2><p>Enter your access code</p><form method="POST" action="/login"><input type="password" name="password" placeholder="••••" autofocus/><button type="submit">Access Dashboard</button>${req.query.err ? '<div class="err">Incorrect code</div>' : ''}</form></div></body></html>`);
});

app.post('/login', express.urlencoded({ extended: true }), (req, res) => {
  if (req.body.password === DASHBOARD_PASSWORD) { req.session.authed = true; res.redirect('/'); }
  else res.redirect('/login?err=1');
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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
  const url = getOAuth2Client().generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/drive.readonly'], prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await getOAuth2Client().getToken(req.query.code);
    req.session.googleTokens = tokens;
    res.redirect('/?connected=drive');
  } catch { res.redirect('/?error=auth'); }
});

app.get('/api/drive/status', (req, res) => res.json({ connected: !!req.session.googleTokens }));

app.get('/api/drive/folders', async (req, res) => {
  if (!req.session.googleTokens) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const drive = google.drive({ version: 'v3', auth: getOAuth2Client(req.session.googleTokens) });
    let allFolders = [];
    let pageToken = null;
    do {
      const params = {
        q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'nextPageToken, files(id,name)',
        pageSize: 1000,
        orderBy: 'name'
      };
      if (pageToken) params.pageToken = pageToken;
      const r = await drive.files.list(params);
      allFolders = allFolders.concat(r.data.files || []);
      pageToken = r.data.nextPageToken;
    } while (pageToken);
    res.json({ folders: allFolders });
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
    category: req.body.category || 'rugpull',
    description: req.body.description || '🌴 New Y2K & Vintage Drops 🌴\n\n⦾ Curated Bundles & Sick Pieces\n⦾ Promotional Post\n⦾ DM me for Bundle Info\n\n#vintage #y2k #thrift #streetwear',
    price: req.body.price || '20',
    sizes: req.body.sizes || ['S','M','L','XL'],
    groupSize: req.body.groupSize || 4,
    driveFolder: req.body.driveFolder || null,
    driveFolderName: req.body.driveFolderName || null,
    accountId: req.body.accountId || null,
    schedule: req.body.schedule || { enabled: false, days: [], time: '09:00' },
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

    const drive = google.drive({ version: 'v3', auth: getOAuth2Client(req.session.googleTokens) });

    // Get all photos in flat folder
    const allPhotos = [];
    let pageToken = null;
    do {
      const params = {
        q: `'${set.driveFolder}' in parents and mimeType contains 'image/' and trashed=false`,
        fields: 'nextPageToken, files(id,name,thumbnailLink)',
        orderBy: 'name', pageSize: 1000
      };
      if (pageToken) params.pageToken = pageToken;
      const pr = await drive.files.list(params);
      allPhotos.push(...(pr.data.files || []));
      pageToken = pr.data.nextPageToken;
    } while (pageToken);

    if (!allPhotos.length) return res.status(400).json({ error: 'No photos found in folder' });

    // Parse naming pattern: {prefix}-{group}.{position}
    // e.g. set2-1.1, set2-1.2, set3-2.4 etc.
    const photoMap = {}; // groupNum -> { posNum -> photo }
    const unparsed = [];

    for (const photo of allPhotos) {
      // Match pattern: anything-{number}.{number} (with any extension)
      const match = photo.name.match(/^.+-(\d+)\.(\d+)\./);
      if (match) {
        const groupNum = parseInt(match[1]);
        const posNum = parseInt(match[2]);
        if (!photoMap[groupNum]) photoMap[groupNum] = {};
        photoMap[groupNum][posNum] = photo;
      } else {
        unparsed.push(photo);
      }
    }

    const groupNums = Object.keys(photoMap).map(Number).sort((a,b) => a-b);
    
    if (!groupNums.length) {
      return res.status(400).json({ error: 'Could not parse photo names. Expected format: setname-{group}.{position}.ext (e.g. set2-1.1.heic)' });
    }

    // Size position mapping: pos 1=S, 2=M, 3=L, 4=XL, 5=XXL
    const sizePositions = { 'S': 1, 'M': 2, 'L': 3, 'XL': 4, 'XXL': 5 };
    const listings = [];

    for (let gi = 0; gi < groupNums.length; gi++) {
      const groupNum = groupNums[gi];
      const groupPhotos = photoMap[groupNum];
      const groupId = uuid();

      // Get all photos from OTHER groups for filler
      const otherPhotos = [];
      for (const otherGroup of groupNums) {
        if (otherGroup !== groupNum) {
          otherPhotos.push(...Object.values(photoMap[otherGroup]));
        }
      }
      // Shuffle other photos for randomness
      for (let i = otherPhotos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [otherPhotos[i], otherPhotos[j]] = [otherPhotos[j], otherPhotos[i]];
      }

      for (const size of set.sizes) {
        const pos = sizePositions[size] || 1;
        
        // Cover photo: use position for this size, fallback to pos 1, fallback to any group photo
        let coverPhoto = groupPhotos[pos] || groupPhotos[1] || Object.values(groupPhotos)[0];
        
        // Fill remaining 3 slots with random photos from other groups
        const fillerPhotos = otherPhotos.slice(0, 3);
        
        const listingPhotos = [coverPhoto, ...fillerPhotos]
          .filter(Boolean)
          .map(p => ({ driveId: p.id, name: p.name, thumb: p.thumbnailLink }));

        listings.push({
          id: uuid(), groupId, groupIndex: gi,
          title: set.name,
          description: set.description,
          price: set.price,
          size,
          photos: listingPhotos,
          customDescription: null, customPrice: null, posted: false
        });
      }
    }

    set.listings = listings;
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
    res.json({ 
      ok: true, 
      count: listings.length, 
      groups: groupNums.length,
      mode: 'flat-named',
      parsed: groupNums.length,
      unparsed: unparsed.length,
      total: allPhotos.length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
  const existing = await pool.query('SELECT id FROM accounts WHERE id=$1', [id]);
  const prev = existing.rows.length ? (await pool.query('SELECT data FROM accounts WHERE id=$1', [id])).rows[0].data : {};
  const account = { ...prev, id, username, cookies: cookies || [], connectedAt: new Date().toISOString() };
  if (existing.rows.length) await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), id]);
  else await pool.query('INSERT INTO accounts (id, data) VALUES ($1, $2)', [id, JSON.stringify(account)]);
  broadcast({ type: 'account', username, status: 'connected', id });
  res.json({ ok: true, id, username });
});

app.put('/api/accounts/:id', async (req, res) => {
  const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
  const updated = { ...r.rows[0].data, ...req.body, id: req.params.id };
  await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(updated), req.params.id]);
  res.json(updated);
});

app.delete('/api/accounts/:id', async (req, res) => {
  await pool.query('DELETE FROM accounts WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ─── SCHEDULE ─────────────────────────────────────────────────
// Agent polls this to know what to deploy
app.get('/api/schedule/due', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE data->>\'status\' != \'deploying\'');
    const sets = r.rows.map(row => row.data);
    const now = new Date();
    const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const currentDay = dayNames[now.getDay()];
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

    const due = [];
    for (const set of sets) {
      const sched = set.schedule;
      if (!sched?.enabled || !sched.days?.length) continue;
      if (!sched.days.includes(currentDay)) continue;
      if (sched.time !== currentTime) continue;
      // Check not already fired in last hour
      const recent = await pool.query('SELECT id FROM schedule_log WHERE set_id=$1 AND fired_at > NOW() - INTERVAL \'1 hour\'', [set.id]);
      if (recent.rows.length) continue;
      due.push(set);
    }

    res.json({ due });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Agent calls this after deploy to log it
app.post('/api/schedule/log', async (req, res) => {
  const { setId, status } = req.body;
  await pool.query('INSERT INTO schedule_log (id, set_id, status) VALUES ($1, $2, $3)', [uuid(), setId, status || 'done']);
  res.json({ ok: true });
});

// Agent posts deploy progress here
app.post('/api/deploy/progress', async (req, res) => {
  broadcast({ type: 'deploy', ...req.body });
  res.json({ ok: true });
});


// ─── ACTIVE ACCOUNTS ──────────────────────────────────────────
app.get('/api/active-this-week', async (req, res) => {
  try {
    const acctR = await pool.query('SELECT data FROM accounts ORDER BY created_at DESC');
    const accounts = acctR.rows.map(row => row.data);
    const setsR = await pool.query('SELECT data FROM sets ORDER BY created_at DESC');
    const sets = setsR.rows.map(row => row.data);
    const now = new Date();

    const active = accounts.map(account => {
      const accountSets = sets.filter(s => s.accountId === account.id);
      const latestSet = accountSets.sort((a,b) => new Date(b.deployedAt||b.createdAt) - new Date(a.deployedAt||a.createdAt))[0];
      const deployedAt = latestSet?.deployedAt || account.connectedAt;
      const hoursLive = deployedAt ? Math.floor((now - new Date(deployedAt)) / (1000 * 60 * 60)) : 0;
      const orders = account.orders || [];
      return {
        accountId: account.id,
        username: account.username,
        accountStatus: account.status || 'unknown',
        connectedAt: account.connectedAt,
        proxy: account.proxy || null,
        setId: latestSet?.id || null,
        setName: latestSet?.name || 'No set assigned',
        category: latestSet?.category || null,
        deployedAt: deployedAt || null,
        hoursLive,
        soldCount: account.soldCount !== undefined ? account.soldCount : orders.length,
        orders,
        launchDescription: latestSet?.launchDescription || latestSet?.description || '',
        evergreenDescription: latestSet?.evergreenDescription || latestSet?.description || '',
        listings: latestSet?.listings?.length || 0,
        posted: latestSet?.listings?.filter(l => l.posted).length || 0
      };
    });

    res.json({ active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DESCRIPTION MANAGEMENT ─────────────────────────────────── ───────────────────────────────────

// Update set descriptions (launch + evergreen)
app.put('/api/sets/:id/descriptions', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const set = r.rows[0].data;
    const { launchDescription, evergreenDescription } = req.body;
    if (launchDescription !== undefined) set.launchDescription = launchDescription;
    if (evergreenDescription !== undefined) set.evergreenDescription = evergreenDescription;
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mass edit - trigger agent to update all descriptions on an account
app.post('/api/accounts/:id/mass-edit', async (req, res) => {
  const { description, setId } = req.body;
  res.json({ ok: true, message: 'Mass edit queued' });
  broadcast({ type: 'mass-edit', accountId: req.params.id, setId, description, status: 'queued', message: `Mass edit queued for account` });
});

// Update account status (live/banned/unknown)
app.put('/api/accounts/:id/status', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    account.status = req.body.status;
    account.statusCheckedAt = new Date().toISOString();
    if (req.body.soldCount !== undefined) account.soldCount = req.body.soldCount;
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), req.params.id]);
    broadcast({ type: 'account-status', accountId: req.params.id, status: req.body.status });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get active deployments this week
app.get('/api/active-this-week', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets ORDER BY created_at DESC');
    const sets = r.rows.map(row => row.data);
    const acctR = await pool.query('SELECT data FROM accounts ORDER BY created_at DESC');
    const accounts = acctR.rows.map(row => row.data);
    
    const now = new Date();
    
    // Show ALL sets that have been deployed (no time limit)
    const active = sets
      .filter(s => s.deployedAt && s.accountId)
      .map(s => {
        const account = accounts.find(a => a.id === s.accountId);
        const deployedAt = new Date(s.deployedAt);
        const hoursLive = Math.floor((now - deployedAt) / (1000 * 60 * 60));
        const descriptionPhase = hoursLive < 24 ? 'launch' : 'evergreen';
        return {
          setId: s.id, setName: s.name, category: s.category,
          accountId: s.accountId, username: account?.username || 'unknown',
          accountStatus: account?.status || 'unknown',
          deployedAt: s.deployedAt, hoursLive,
          descriptionPhase,
          launchDescription: s.launchDescription || s.description,
          evergreenDescription: s.evergreenDescription || s.description,
          listings: s.listings?.length || 0,
          posted: s.listings?.filter(l => l.posted).length || 0
        };
      });
    
    res.json({ active });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check due description switches (launch -> evergreen at 24hrs)
app.get('/api/description-switches/due', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets ORDER BY created_at DESC');
    const sets = r.rows.map(row => row.data);
    const now = new Date();
    const due = sets.filter(s => {
      if (!s.deployedAt || !s.evergreenDescription) return false;
      if (s.descriptionSwitched) return false;
      const hoursLive = (now - new Date(s.deployedAt)) / (1000 * 60 * 60);
      return hoursLive >= 24;
    });
    res.json({ due });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark description as switched
app.post('/api/sets/:id/mark-switched', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const set = r.rows[0].data;
    set.descriptionSwitched = true;
    set.descriptionSwitchedAt = new Date().toISOString();
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── STATUS CHECK (agent-based) ──────────────────────────────
// Dashboard queues a check, agent picks it up and posts result back
let statusCheckQueue = [];
app.post('/api/accounts/check-queue', (req, res) => {
  const pending = statusCheckQueue.splice(0);
  res.json({ pending });
});
app.post('/api/accounts/:id/check-status', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    const { status } = req.body;
    account.status = status;
    account.statusCheckedAt = new Date().toISOString();
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), account.id]);
    broadcast({ type: 'account-status', accountId: account.id, username: account.username, status });
    res.json({ ok: true, status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Dashboard calls this to queue a check - agent.js does the actual Playwright check
app.get('/api/accounts/:id/check-status', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    statusCheckQueue.push({ accountId: account.id, username: account.username });
    broadcast({ type: 'check-queued', accountId: account.id, username: account.username });
    res.json({ queued: true, username: account.username });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ORDERS / LABELS ──────────────────────────────────────────

// Store scraped orders
app.post('/api/accounts/:id/orders', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    account.orders = req.body.orders || [];
    account.ordersScrapedAt = new Date().toISOString();
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), req.params.id]);
    res.json({ ok: true, count: account.orders.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get orders for an account
app.get('/api/accounts/:id/orders', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ orders: r.rows[0].data.orders || [], scrapedAt: r.rows[0].data.ordersScrapedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── RUGPULL TRACKER ──────────────────────────────────────────
// All tracker operations read from / write to the same `accounts` table
// that the Chrome extension also writes to, so extension-connected
// accounts and manually-added ones show up in the same list.
app.get('/api/tracker', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts ORDER BY created_at DESC');
    const accounts = r.rows.map(row => row.data);
    res.json({ accounts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tracker', async (req, res) => {
  try {
    const { v4: uuid } = require('uuid');
    const id = uuid();
    const body = req.body || {};
    // Auto-calculate payout date (banned + 30 days) if not provided
    if (body.bannedAt && !body.payoutDate) {
      const d = new Date(body.bannedAt);
      d.setDate(d.getDate() + 30);
      body.payoutDate = d.toISOString().split('T')[0];
    }
    const account = {
      id,
      username: (body.username || '').replace(/^@/, ''),
      email: body.email || '',
      password: body.password || '',
      authId: body.authId || '',
      earnings: body.earnings || '0',
      bannedAt: body.bannedAt || null,
      payoutDate: body.payoutDate || null,
      notes: body.notes || '',
      status: body.status || 'unknown',
      connectedAt: new Date().toISOString(),
      cookies: []
    };
    await pool.query('INSERT INTO accounts (id, data) VALUES ($1, $2)', [id, JSON.stringify(account)]);
    broadcast({ type: 'account', action: 'created', id });
    res.json({ ok: true, id, account });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/tracker/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const body = req.body || {};
    const account = { ...r.rows[0].data, ...body, id: req.params.id };
    if (body.username) account.username = String(body.username).replace(/^@/, '');
    // Auto-calculate payout date (banned + 30 days) if banned was just set
    if (body.bannedAt) {
      const banned = new Date(body.bannedAt);
      banned.setDate(banned.getDate() + 30);
      account.payoutDate = banned.toISOString().split('T')[0];
    }
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), req.params.id]);
    broadcast({ type: 'account', action: 'updated', id: req.params.id });
    res.json(account);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tracker/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM accounts WHERE id=$1', [req.params.id]);
    broadcast({ type: 'account', action: 'deleted', id: req.params.id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Multi-account deploy - get accounts for a set
app.post('/api/sets/:id/deploy-to', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const set = r.rows[0].data;
    set.deployAccounts = req.body.accountIds || [];
    set.lastDeployedAt = new Date().toISOString();
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), set.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── REPLIER SYSTEM ───────────────────────────────────────────

// Speed setting
let replierSpeed = 'balanced';
app.get('/api/replier/speed', (req, res) => res.json({ speed: replierSpeed }));
app.post('/api/replier/speed', (req, res) => {
  replierSpeed = req.body.speed || 'balanced';
  broadcast({ type: 'replier-speed', speed: replierSpeed });
  res.json({ ok: true, speed: replierSpeed });
});

// Cooldown tracking
app.post('/api/replier/cooldown', async (req, res) => {
  try {
    const { accountId, until, reason } = req.body;
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [accountId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    account.cooldownUntil = until;
    account.cooldownReason = reason;
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), accountId]);
    broadcast({ type: 'replier-cooldown', accountId, until, reason });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Store conversations per account
app.post('/api/replier/conversations/:accountId', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.accountId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    if (!account.conversations) account.conversations = {};
    const { senderId, senderUsername, message, reply, direction } = req.body;
    if (!account.conversations[senderId]) {
      account.conversations[senderId] = { senderId, senderUsername, messages: [], unread: 0 };
    }
    account.conversations[senderId].messages.push({
      direction, message, reply, timestamp: new Date().toISOString()
    });
    if (direction === 'inbound') account.conversations[senderId].unread++;
    else account.conversations[senderId].unread = 0;
    account.conversations[senderId].lastMessage = new Date().toISOString();
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), req.params.accountId]);
    broadcast({ type: 'new-message', accountId: req.params.accountId, senderId, senderUsername, message, reply, direction });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/replier/conversations/:accountId', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.accountId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const convos = r.rows[0].data.conversations || {};
    const list = Object.values(convos).sort((a,b) => new Date(b.lastMessage) - new Date(a.lastMessage));
    res.json({ conversations: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Replier settings per account
app.put('/api/replier/settings/:accountId', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM accounts WHERE id=$1', [req.params.accountId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const account = r.rows[0].data;
    account.replierSettings = { ...account.replierSettings, ...req.body };
    await pool.query('UPDATE accounts SET data=$1 WHERE id=$2', [JSON.stringify(account), req.params.accountId]);
    broadcast({ type: 'replier-settings', accountId: req.params.accountId, settings: account.replierSettings });
    res.json({ ok: true, settings: account.replierSettings });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Global replier prompts
app.get('/api/replier/prompts', async (req, res) => {
  try {
    const r = await pool.query("SELECT data FROM sets WHERE id='__replier_prompts__'");
    if (!r.rows.length) {
      const defaults = {
        rugpull: `you are a depop seller responding to dms. your vibe is super chill, casual, lowercase only. you're a yes man - everything they ask, the answer is yes. create urgency without being pushy. never use periods at the end. key rules: always say yes to availability. if they ask about sizes say "yeah got all sizes check my page". if they ask about shipping say "we ship quick fr". if they ask about brands or bundles say yes and hype it up. keep running low on stock as a theme. sound like a real person, not a bot. vary your responses each time. examples: "yeah bro still got some left, going fast tho", "yooo yes we got that, check the page for sizes", "fr we ship same day or next day", "yeah running low but u can grab it rn"`,
        riptag: `you are a rep for riptag.co responding to depop dms. chill lowercase vibes. your only job is to funnel them to riptag.co. you're a yes man for everything but always bring it back to the site. rules: first letter never capitalized. say yes to everything - bundles, sizes, availability. always drop riptag.co naturally in the response. sound genuine not salesy. vary responses. examples: "yo yeah we got all that at riptag.co bro", "yeah all sizes available, easiest to just grab it at riptag.co", "yoo we got crazy bundles rn check riptag.co", "yeah dm works but honestly just hit riptag.co its all there"`
      };
      return res.json({ prompts: defaults });
    }
    res.json({ prompts: r.rows[0].data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/replier/prompts', async (req, res) => {
  try {
    const existing = await pool.query("SELECT id FROM sets WHERE id='__replier_prompts__'");
    if (existing.rows.length) {
      await pool.query("UPDATE sets SET data=$1 WHERE id='__replier_prompts__'", [JSON.stringify(req.body)]);
    } else {
      await pool.query("INSERT INTO sets (id, data) VALUES ('__replier_prompts__', $1)", [JSON.stringify(req.body)]);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CLAUDE AI REPLY GENERATION ───────────────────────────────
// Loads ANTHROPIC_API_KEY from Railway env vars. Falls back to null if missing.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || null;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// Status check — lets the UI show whether the AI is wired up
app.get('/api/replier/ai-status', (req, res) => {
  res.json({
    configured: !!ANTHROPIC_API_KEY,
    model: ANTHROPIC_API_KEY ? ANTHROPIC_MODEL : null
  });
});

// Build a messages[] array for the Anthropic API from conversation history
function buildClaudeMessages(message, history) {
  const msgs = [];
  if (Array.isArray(history)) {
    for (const h of history) {
      if (!h || !h.direction) continue;
      const role = h.direction === 'inbound' ? 'user' : 'assistant';
      const text = (h.message || h.reply || '').trim();
      if (text) msgs.push({ role, content: text });
    }
  }
  msgs.push({ role: 'user', content: String(message || '').trim() });
  return msgs;
}

// Generate a reply using Claude. Body: { accountId?, message, style?, history?, systemOverride? }
app.post('/api/replier/generate', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not set. Add it in Railway → Variables, then redeploy.' });
    }

    const { accountId, message, style, history, systemOverride } = req.body || {};
    if (!message || !String(message).trim()) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Pick the system prompt. Priority: explicit override → account's category → style arg → rugpull default.
    let systemPrompt = systemOverride && String(systemOverride).trim();
    if (!systemPrompt) {
      const pr = await pool.query("SELECT data FROM sets WHERE id='__replier_prompts__'");
      const prompts = pr.rows.length ? pr.rows[0].data : {};
      let chosenStyle = style;
      if (!chosenStyle && accountId) {
        const ar = await pool.query('SELECT data FROM accounts WHERE id=$1', [accountId]);
        if (ar.rows.length) chosenStyle = ar.rows[0].data.category;
      }
      chosenStyle = chosenStyle || 'rugpull';
      systemPrompt = prompts[chosenStyle] || prompts.rugpull || 'you are a chill depop seller responding to dms in lowercase, casual, say yes to everything, keep it short';
    }

    const messages = buildClaudeMessages(message, history);

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages
      })
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return res.status(502).json({ error: 'Claude API error: ' + anthropicRes.status + ' ' + errText.slice(0, 500) });
    }

    const data = await anthropicRes.json();
    const reply = (data.content && data.content[0] && data.content[0].text || '').trim();
    if (!reply) return res.status(502).json({ error: 'Empty reply from Claude', raw: data });

    res.json({
      reply,
      model: data.model || ANTHROPIC_MODEL,
      usage: data.usage || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MARINATOR HEARTBEAT + STATS ──────────────────────────────
// In-memory map of accountId -> latest stats.  Lives only as long as
// the server process, which is fine for a status indicator.
const marinatorState = {};
app.post('/api/marinator/heartbeat', (req, res) => {
  const { accountId, ...stats } = req.body || {};
  if (accountId) {
    marinatorState[accountId] = { ...stats, lastSeen: new Date().toISOString() };
    broadcast({ type: 'marinator-heartbeat', accountId, stats: marinatorState[accountId] });
  }
  res.json({ ok: true });
});
app.get('/api/marinator/status', (req, res) => {
  // Mark accounts as alive if their last heartbeat was within 90s
  const now = Date.now();
  const out = {};
  for (const [id, s] of Object.entries(marinatorState)) {
    out[id] = { ...s, alive: s.lastSeen && (now - new Date(s.lastSeen).getTime()) < 90000 };
  }
  res.json({ accounts: out });
});

// Replier heartbeat
let lastReplierHeartbeat = null;
app.post('/api/replier/heartbeat', (req, res) => {
  lastReplierHeartbeat = new Date().toISOString();
  broadcast({ type: 'replier-alive' });
  res.json({ ok: true });
});
app.get('/api/replier/status', (req, res) => {
  const alive = lastReplierHeartbeat && (Date.now() - new Date(lastReplierHeartbeat).getTime()) < 90000;
  res.json({ alive, lastSeen: lastReplierHeartbeat });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, version: '2.2.0' }));

// Daemon heartbeat
let lastHeartbeat = null;
app.post('/api/daemon/heartbeat', (req, res) => {
  lastHeartbeat = new Date().toISOString();
  broadcast({ type: 'daemon', status: 'alive', lastSeen: lastHeartbeat });
  res.json({ ok: true });
});

let lastRunHeartbeat = null;
app.post('/api/run/heartbeat', (req, res) => {
  lastRunHeartbeat = new Date().toISOString();
  res.json({ ok: true });
});
app.get('/api/daemon/status', (req, res) => {
  const alive = lastHeartbeat && (Date.now() - new Date(lastHeartbeat).getTime()) < 60000;
  const runAlive = lastRunHeartbeat && (Date.now() - new Date(lastRunHeartbeat).getTime()) < 60000;
  res.json({ alive, lastSeen: lastHeartbeat, runAlive, runLastSeen: lastRunHeartbeat });
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`\n🏄  Riptag Set Manager v2.2\n    http://localhost:${PORT}\n`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
