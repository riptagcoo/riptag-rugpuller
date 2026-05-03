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
    CREATE TABLE IF NOT EXISTS description_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS thumb_cache (
      drive_id TEXT PRIMARY KEY,
      content_type TEXT,
      data BYTEA NOT NULL,
      cached_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS agent_queue (
      id TEXT PRIMARY KEY,
      command TEXT NOT NULL,
      payload JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS agent_queue_pending_idx ON agent_queue(status, created_at);
  `);
  console.log('✅ Database ready');
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
// Dashboard + Drive session lasts 90 days and rolls — every request
// refreshes the expiration, so as long as you use the dashboard at least
// once every 90 days you stay logged in (and Drive stays connected).
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  rolling: true,
  cookie: { maxAge: 90 * 24 * 60 * 60 * 1000 }
}));

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
    // Also persist tokens so non-session callers (agent.js with x-api-key) can use them
    try {
      const exists = await pool.query("SELECT id FROM sets WHERE id='__google_tokens__'");
      if (exists.rows.length) await pool.query("UPDATE sets SET data=$1 WHERE id='__google_tokens__'", [JSON.stringify(tokens)]);
      else await pool.query("INSERT INTO sets (id, data) VALUES ('__google_tokens__', $1)", [JSON.stringify(tokens)]);
    } catch (e) { console.error('failed to persist google tokens:', e.message); }
    res.redirect('/?connected=drive');
  } catch { res.redirect('/?error=auth'); }
});

// Pull stored Google tokens (session first, DB fallback for agent.js)
async function getGoogleTokens(req) {
  if (req && req.session && req.session.googleTokens) return req.session.googleTokens;
  try {
    const r = await pool.query("SELECT data FROM sets WHERE id='__google_tokens__'");
    if (r.rows.length) return r.rows[0].data;
  } catch {}
  return null;
}

// Quick diagnostic — lets you tell from the dashboard whether the
// persisted Drive tokens are available for agent.js use.
app.get('/api/drive/check-tokens', async (req, res) => {
  const sessionTokens = !!(req.session && req.session.googleTokens);
  let dbTokens = false;
  try {
    const r = await pool.query("SELECT id FROM sets WHERE id='__google_tokens__'");
    dbTokens = r.rows.length > 0;
  } catch {}
  res.json({
    sessionTokens,
    dbTokens,
    readyForAgent: dbTokens,
    hint: dbTokens ? 'agent.js can download full-res photos' :
          sessionTokens ? 'RECONNECT Drive — your current tokens are in the browser session only, not in the DB. Click Connect Drive again to persist them.' :
          'Drive not connected at all — click Connect Drive in the dashboard.'
  });
});

// Cached thumbnail endpoint — dashboard uses this for listing previews.
// Reads from thumb_cache (a Postgres BYTEA column) so once an image is
// cached, it survives Drive disconnects and Railway restarts. On a cache
// miss, falls back to fetching the small thumbnailLink from Drive (using
// the persisted DB tokens, not the session) and writes it to the cache
// before serving.
async function fetchAndCacheThumb(driveId, tokens) {
  if (!tokens) return null;
  const drive = google.drive({ version: 'v3', auth: getOAuth2Client(tokens) });
  let meta;
  try {
    meta = await drive.files.get({ fileId: driveId, fields: 'mimeType, thumbnailLink' });
  } catch { return null; }
  let buf = null;
  let ct = 'image/jpeg';
  // Prefer the small thumbnailLink (no auth needed, ~20KB) over fetching
  // the full file media — that keeps DB rows small.
  if (meta.data.thumbnailLink) {
    try {
      const tr = await fetch(meta.data.thumbnailLink);
      if (tr.ok) {
        buf = Buffer.from(await tr.arrayBuffer());
        ct = tr.headers.get('content-type') || 'image/jpeg';
      }
    } catch {}
  }
  if (!buf) {
    // Fallback to media stream (full-res, but at least we get something)
    try {
      const dr = await drive.files.get(
        { fileId: driveId, alt: 'media' },
        { responseType: 'arraybuffer' }
      );
      buf = Buffer.from(dr.data);
      ct = meta.data.mimeType || 'image/jpeg';
    } catch { return null; }
  }
  try {
    await pool.query(
      `INSERT INTO thumb_cache (drive_id, content_type, data)
         VALUES ($1, $2, $3)
       ON CONFLICT (drive_id) DO UPDATE
         SET data = EXCLUDED.data, content_type = EXCLUDED.content_type, cached_at = NOW()`,
      [driveId, ct, buf]
    );
  } catch (e) { console.error('thumb cache write failed:', e.message); }
  return { contentType: ct, data: buf };
}

app.get('/api/thumb/:id', async (req, res) => {
  try {
    const cached = await pool.query(
      'SELECT content_type, data FROM thumb_cache WHERE drive_id=$1',
      [req.params.id]
    );
    if (cached.rows.length) {
      res.setHeader('Content-Type', cached.rows[0].content_type || 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(cached.rows[0].data);
    }
    const tokens = await getGoogleTokens(req);
    const fetched = await fetchAndCacheThumb(req.params.id, tokens);
    if (!fetched) {
      // Last resort — let the browser try Google's signed thumbnailLink
      // (caller would have to pass ?fallback=...). Otherwise 404.
      return res.status(404).json({ error: 'Not cached and Drive not available' });
    }
    res.setHeader('Content-Type', fetched.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.end(fetched.data);
  } catch (err) {
    console.error('GET /api/thumb failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Proxy a full-resolution Drive file download. agent.js uses this so listings
// get sharp images instead of 200px thumbnails.
app.get('/api/drive/file/:id', async (req, res) => {
  try {
    const tokens = await getGoogleTokens(req);
    if (!tokens) return res.status(401).json({
      error: 'Drive tokens not available for agent.js. Click "Connect Drive" in the dashboard to re-auth — this will persist the tokens to the database so agent.js can use them.',
      hint: 'Visit /api/drive/check-tokens in your browser to diagnose.'
    });
    const drive = google.drive({ version: 'v3', auth: getOAuth2Client(tokens) });
    const meta = await drive.files.get({ fileId: req.params.id, fields: 'mimeType, name, size' });
    const driveRes = await drive.files.get(
      { fileId: req.params.id, alt: 'media' },
      { responseType: 'stream' }
    );
    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${(meta.data.name || 'file').replace(/[^\w.-]/g, '_')}"`);
    if (meta.data.size) res.setHeader('Content-Length', meta.data.size);
    driveRes.data.on('error', err => { console.error('drive stream error:', err.message); try { res.end(); } catch {} });
    driveRes.data.pipe(res);
  } catch (err) {
    console.error('GET /api/drive/file failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drive/status', async (req, res) => {
  // Treat Drive as "connected" if we have tokens in EITHER the browser
  // session OR the DB. The DB copy has a refresh_token so it stays valid
  // indefinitely — the access_token inside auto-refreshes on each call
  // via googleapis' built-in OAuth2Client.
  let connected = !!req.session.googleTokens;
  let source = connected ? 'session' : null;

  if (!connected) {
    try {
      const r = await pool.query("SELECT data FROM sets WHERE id='__google_tokens__'");
      if (r.rows.length) {
        connected = true;
        source = 'db';
        // Warm the session from DB so future calls are fast and the user
        // feels "logged in" to Drive again without re-auth
        req.session.googleTokens = r.rows[0].data;
      }
    } catch {}
  } else {
    // Session has tokens — also mirror to DB so agent.js works
    try {
      const tokensJson = JSON.stringify(req.session.googleTokens);
      const exists = await pool.query("SELECT id FROM sets WHERE id='__google_tokens__'");
      if (exists.rows.length) {
        await pool.query("UPDATE sets SET data=$1 WHERE id='__google_tokens__'", [tokensJson]);
      } else {
        await pool.query("INSERT INTO sets (id, data) VALUES ('__google_tokens__', $1)", [tokensJson]);
      }
    } catch { /* non-fatal */ }
  }
  res.json({ connected, source });
});

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
  // Skip system rows (id starts with __) — those are config blobs, not user sets.
  const r = await pool.query(
    "SELECT data FROM sets WHERE id NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY created_at DESC"
  );
  res.json(r.rows.map(row => row.data).filter(d => d && typeof d === 'object'));
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
  const prev = r.rows[0].data || {};
  const updated = { ...prev, ...req.body, id: req.params.id };

  // Propagate set-level field changes down to existing listings so the
  // dashboard "Edit Set" actually affects the per-listing copies. Each
  // listing snapshots `description`/`price` at build time; without this
  // they'd stay frozen on the old values. Only updates fields the caller
  // explicitly sent (req.body), and only writes the inherited defaults —
  // never overrides listing-level customDescription/customPrice.
  if (Array.isArray(updated.listings) && updated.listings.length) {
    const propagate = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'description') && req.body.description !== prev.description) {
      propagate.description = req.body.description;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'price') && String(req.body.price) !== String(prev.price)) {
      propagate.price = req.body.price;
    }
    if (Object.keys(propagate).length) {
      updated.listings = updated.listings.map(l => ({ ...l, ...propagate }));
    }
  }

  await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(updated), req.params.id]);
  res.json(updated);
});

app.delete('/api/sets/:id', async (req, res) => {
  try {
    const id = req.params.id;
    // Also clean up corrupt/ghost entries with the same broken id across the table
    const r = await pool.query(
      "DELETE FROM sets WHERE id=$1 OR id IS NULL OR id='' OR id='undefined' OR id='null' RETURNING id",
      [id]
    );
    // Always report success so the UI can always remove the row locally.
    // If nothing was deleted, the set was already gone — same effect as success.
    broadcast({ type: 'set', action: 'deleted', id });
    res.json({ ok: true, deletedId: id, rowsAffected: r.rowCount });
  } catch (err) {
    console.error('DELETE /api/sets failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// One-shot cleanup: remove sets with invalid IDs or missing data
app.post('/api/sets/cleanup', async (req, res) => {
  try {
    const r = await pool.query(
      "DELETE FROM sets WHERE id IS NULL OR id='' OR id='undefined' OR id='null' OR data IS NULL RETURNING id"
    );
    // System rows (id starts with __) are config blobs — Google tokens,
    // replier prompts, replier speed, etc. They have no `name` and no
    // `listings`, so without this guard the cleanup nukes them every page
    // load and Drive disconnects. NEVER touch them here.
    const all = await pool.query("SELECT id, data FROM sets WHERE id NOT LIKE '\\_\\_%' ESCAPE '\\'");
    let mismatches = 0;
    for (const row of all.rows) {
      const d = row.data;
      const isObject = d && typeof d === 'object';
      const hasListings = isObject && Array.isArray(d.listings) && d.listings.length > 0;
      const hasName = isObject && d.name && String(d.name).trim();
      // Self-heal: if the data has listings but id drifted, write row.id back
      if (isObject && hasListings && d.id !== row.id) {
        d.id = row.id;
        await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(d), row.id]);
        continue;
      }
      // Only delete truly empty / corrupt non-system rows
      if (!isObject || (!hasName && !hasListings)) {
        await pool.query('DELETE FROM sets WHERE id=$1', [row.id]);
        mismatches++;
      }
    }
    broadcast({ type: 'set', action: 'cleanup' });
    res.json({ ok: true, deletedBadIds: r.rowCount, deletedMismatches: mismatches });
  } catch (err) {
    console.error('POST /api/sets/cleanup failed:', err);
    res.status(500).json({ error: err.message });
  }
});

// Reset a set's posted state so it can be redeployed to another account
app.post('/api/sets/:id/reset', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Set not found' });
    const set = r.rows[0].data;
    // Mark every listing as un-posted, clear deployedAt, reset status
    if (Array.isArray(set.listings)) {
      set.listings = set.listings.map(l => ({
        ...l,
        posted: false,
        postedAt: null,
        postedToListingId: null
      }));
    }
    set.deployedAt = null;
    set.status = 'ready';
    await pool.query('UPDATE sets SET data=$1 WHERE id=$2', [JSON.stringify(set), req.params.id]);
    broadcast({ type: 'set', action: 'reset', id: req.params.id });
    res.json({ ok: true, listings: (set.listings || []).length });
  } catch (err) {
    console.error('POST /api/sets/:id/reset failed:', err);
    res.status(500).json({ error: err.message });
  }
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

    // Warm the thumbnail cache in the background so the dashboard previews
    // keep working even if Drive disconnects later. Fires off, doesn't block
    // the response.
    (async () => {
      const seen = new Set();
      for (const p of allPhotos) {
        if (!p || !p.id || seen.has(p.id)) continue;
        seen.add(p.id);
      }
      const ids = [...seen];
      const tokens = await getGoogleTokens(req);
      if (!tokens) return;
      // Process in batches of 6 so we don't hammer Drive
      for (let i = 0; i < ids.length; i += 6) {
        const batch = ids.slice(i, i + 6);
        await Promise.all(batch.map(id =>
          fetchAndCacheThumb(id, tokens).catch(() => null)
        ));
      }
      console.log(`✅ thumb cache warmed for ${ids.length} photo(s) in set ${set.id}`);
    })().catch(err => console.error('thumb cache warm failed:', err.message));
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

// Re-warm the thumbnail cache for an existing set without rebuilding listings.
// Useful when previews were broken because Drive tokens rotated mid-build, or
// the cache was wiped. Pulls every unique driveId from set.listings.photos and
// re-fetches it. Doesn't touch listings, photos, or any deploy state.
app.post('/api/sets/:id/warm-thumbs', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Set not found' });
    const set = r.rows[0].data;
    const ids = new Set();
    for (const l of (set.listings || [])) {
      for (const p of (l.photos || [])) if (p && p.driveId) ids.add(p.driveId);
    }
    if (!ids.size) return res.json({ ok: true, warmed: 0, note: 'no driveIds on listings — run Build Listings first' });
    const tokens = await getGoogleTokens(req);
    if (!tokens) return res.status(401).json({ error: 'Drive not connected — click Connect Drive then try again' });
    const idArr = [...ids];
    let warmed = 0, failed = 0;
    for (let i = 0; i < idArr.length; i += 6) {
      const batch = idArr.slice(i, i + 6);
      const results = await Promise.all(batch.map(id =>
        fetchAndCacheThumb(id, tokens).then(r => r ? 'ok' : 'fail').catch(() => 'fail')
      ));
      warmed += results.filter(x => x === 'ok').length;
      failed += results.filter(x => x === 'fail').length;
    }
    res.json({ ok: true, warmed, failed, total: idArr.length });
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

// ─── DESCRIPTION TEMPLATES ────────────────────────────────────
// Named description presets the user creates in the dashboard.
// Agent fetches them at `runMassEdit` time so the cmd prompt shows
// a numbered picker instead of a raw text-entry prompt.
app.get('/api/description-templates', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, body, created_at, updated_at FROM description_templates ORDER BY updated_at DESC'
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/description-templates', async (req, res) => {
  try {
    const { name, body } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
    if (!body || !String(body).trim()) return res.status(400).json({ error: 'body required' });
    const id = uuid();
    await pool.query(
      'INSERT INTO description_templates (id, name, body) VALUES ($1, $2, $3)',
      [id, String(name).trim(), String(body)]
    );
    res.json({ id, name: String(name).trim(), body: String(body) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/description-templates/:id', async (req, res) => {
  try {
    const { name, body } = req.body || {};
    const r = await pool.query(
      `UPDATE description_templates
         SET name = COALESCE($1, name),
             body = COALESCE($2, body),
             updated_at = NOW()
       WHERE id = $3
       RETURNING id, name, body, updated_at`,
      [name != null ? String(name).trim() : null, body != null ? String(body) : null, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/description-templates/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM description_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ─── AGENT COMMAND QUEUE ──────────────────────────────────────
// Dashboard pushes commands here (deploy, check-statuses, mass-edit,
// quick-refresh). The DAEMON.bat process polls /next every 15s, claims
// one command at a time, executes it locally, and reports completion.
// This is what makes dashboard buttons actually do things instead of
// just saying "run agent.js".

app.post('/api/agent/queue', async (req, res) => {
  try {
    const { command, payload } = req.body || {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'command required' });
    }
    const id = uuid();
    await pool.query(
      'INSERT INTO agent_queue (id, command, payload) VALUES ($1, $2, $3)',
      [id, command, JSON.stringify(payload || {})]
    );
    broadcast({ type: 'agent-queue', action: 'queued', id, command, payload });
    res.json({ ok: true, id, command, status: 'pending' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/queue/next', async (req, res) => {
  try {
    const r = await pool.query(`
      UPDATE agent_queue
         SET status = 'running', started_at = NOW()
       WHERE id = (
         SELECT id FROM agent_queue
          WHERE status = 'pending'
          ORDER BY created_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, command, payload
    `);
    if (!r.rows.length) return res.json({ command: null });
    const row = r.rows[0];
    broadcast({ type: 'agent-queue', action: 'started', id: row.id, command: row.command });
    res.json({ id: row.id, command: row.command, payload: row.payload || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agent/queue/:id/done', async (req, res) => {
  try {
    const { ok, result } = req.body || {};
    const status = ok ? 'done' : 'failed';
    await pool.query(
      `UPDATE agent_queue
         SET status = $1, result = $2, finished_at = NOW()
       WHERE id = $3`,
      [status, String(result || '').slice(0, 500), req.params.id]
    );
    broadcast({ type: 'agent-queue', action: 'finished', id: req.params.id, status, result });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agent/queue/recent', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, command, payload, status, result, created_at, started_at, finished_at
        FROM agent_queue
       ORDER BY created_at DESC
       LIMIT 30
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
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
    let chosenStyle = 'override';
    let promptSource = 'override';
    if (!systemPrompt) {
      const pr = await pool.query("SELECT data FROM sets WHERE id='__replier_prompts__'");
      const savedPrompts = pr.rows.length ? pr.rows[0].data : null;
      chosenStyle = style;
      if (!chosenStyle && accountId) {
        const ar = await pool.query('SELECT data FROM accounts WHERE id=$1', [accountId]);
        if (ar.rows.length) chosenStyle = ar.rows[0].data.category;
      }
      chosenStyle = chosenStyle || 'rugpull';
      // Only use the saved prompt if it's non-empty; fall back otherwise.
      const saved = savedPrompts && typeof savedPrompts === 'object' ? savedPrompts[chosenStyle] : null;
      if (saved && String(saved).trim()) {
        systemPrompt = String(saved).trim();
        promptSource = 'saved-' + chosenStyle;
      } else if (savedPrompts && savedPrompts.rugpull && String(savedPrompts.rugpull).trim()) {
        systemPrompt = String(savedPrompts.rugpull).trim();
        promptSource = 'saved-rugpull-fallback';
      } else {
        systemPrompt = 'you are a chill depop seller responding to dms in lowercase, casual, say yes to everything, keep it short';
        promptSource = 'inline-fallback';
      }
    }
    // ── Anti-repetition layer ─────────────────────────────────
    // Extract every reply we've already sent in this thread. Append them to
    // the system prompt with explicit instructions so Claude can see its own
    // past phrases and vary them instead of saying the same things again.
    const priorReplies = (Array.isArray(history) ? history : [])
      .filter(h => h && h.direction === 'outbound')
      .map(h => (h.reply || h.message || '').trim())
      .filter(Boolean);

    if (priorReplies.length > 0) {
      const recent = priorReplies.slice(-6);
      const priorBlock = recent.map((r, i) => `  ${i + 1}. "${r}"`).join('\n');
      systemPrompt += `

---
CONTEXT: this is an ONGOING conversation, not a fresh one. You have already replied ${priorReplies.length} time${priorReplies.length === 1 ? '' : 's'} in this thread. Your most recent replies were:
${priorBlock}

RULES FOR THIS REPLY:
• Do NOT repeat verbatim phrases you just used (price quotes, "don't sleep on it", "running low", "check the page", "all sizes", greetings, taglines, etc).
• Do NOT re-explain what the bundle is if you already described it above.
• Do NOT re-greet the person ("yo", "yooo", "hey bro") if you already greeted them.
• This reply should feel like a natural continuation — as if you remember everything you said. Add something NEW or just acknowledge/confirm what they said.
• If their message is short and casual (e.g. "aight", "cool", "thx"), respond short and casual back — don't turn it into another sales pitch.
• Keep it tight. One or two sentences max unless they asked something specific.`;
    }

    // Log to Railway so you can confirm from server logs
    console.log(`[replier/generate] style=${chosenStyle} source=${promptSource} priorReplies=${priorReplies.length} promptLen=${systemPrompt.length} msg="${String(message).slice(0,60)}"`);

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
      usage: data.usage || null,
      // Diagnostic info so you can verify the bot is using your saved prompts:
      prompt: {
        style: chosenStyle,
        source: promptSource,         // "saved-rugpull" / "saved-riptag" / "inline-fallback" / "override"
        length: systemPrompt.length,
        preview: systemPrompt.slice(0, 120) + (systemPrompt.length > 120 ? '…' : '')
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MARINATOR HEARTBEAT + STATS ──────────────────────────────
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
  const now = Date.now();
  const out = {};
  for (const [id, s] of Object.entries(marinatorState)) {
    out[id] = { ...s, alive: !!(s.lastSeen && (now - new Date(s.lastSeen).getTime()) < 90000) };
  }
  res.json({ accounts: out });
});

// ─── REPLIER HEARTBEAT ────────────────────────────────────────
let lastReplierHeartbeat = null;
app.post('/api/replier/heartbeat', (req, res) => {
  lastReplierHeartbeat = new Date().toISOString();
  broadcast({ type: 'replier-alive' });
  res.json({ ok: true });
});
app.get('/api/replier/status', (req, res) => {
  const alive = !!(lastReplierHeartbeat && (Date.now() - new Date(lastReplierHeartbeat).getTime()) < 90000);
  res.json({ alive, lastSeen: lastReplierHeartbeat });
});

app.get('/api/ping', (req, res) => res.json({ ok: true, version: '2.3.0' }));

// ─── DAEMON HEARTBEAT ─────────────────────────────────────────
let lastDaemonHeartbeat = null;
let lastRunHeartbeat = null;
app.post('/api/daemon/heartbeat', (req, res) => {
  lastDaemonHeartbeat = new Date().toISOString();
  broadcast({ type: 'daemon', status: 'alive', lastSeen: lastDaemonHeartbeat });
  res.json({ ok: true });
});
app.get('/api/daemon/status', (req, res) => {
  const now = Date.now();
  const alive = !!(lastDaemonHeartbeat && (now - new Date(lastDaemonHeartbeat).getTime()) < 120000);
  const runAlive = !!(lastRunHeartbeat && (now - new Date(lastRunHeartbeat).getTime()) < 90000);
  res.json({ alive, lastSeen: lastDaemonHeartbeat, runAlive });
});
app.post('/api/run/heartbeat', (req, res) => {
  lastRunHeartbeat = new Date().toISOString();
  res.json({ ok: true });
});

// ─── EVERGREEN DESCRIPTION SWITCHES DUE ───────────────────────
app.get('/api/description-switches/due', async (req, res) => {
  try {
    const r = await pool.query('SELECT data FROM sets');
    const today = new Date().toISOString().split('T')[0];
    const due = r.rows.map(row => row.data).filter(s =>
      s && s.descriptionSwitchDate && s.descriptionSwitchDate <= today && !s.descriptionSwitched
    );
    res.json({ due });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── START THE SERVER ─────────────────────────────────────────
// (PORT is declared at the top of the file)
app.listen(PORT, () => console.log('🏄 Riptag Rugpuller server on port ' + PORT));
