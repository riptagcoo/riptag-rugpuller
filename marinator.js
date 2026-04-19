/**
 * RIPTAG RUGPULLER — ACCOUNT MARINATOR
 *
 * Warms up a Depop account by mixing follows, likes, profile views,
 * and feed scrolling for ~2 hours, targeting ~1000 follows per session.
 *
 * Run:  node marinator.js
 * Or:   double-click MARINATOR.bat
 */

const { chromium } = require('playwright');
const https = require('https');
const http = require('http');
const readline = require('readline');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://riptag-rugpuller-production.up.railway.app';
const API_KEY = process.env.DASHBOARD_PASSWORD || '1010';

// ─── Config (tunable via env vars or just edit these) ──────────
const CONFIG = {
  followsTarget:        parseInt(process.env.FOLLOW_TARGET) || 1000,
  durationMinutes:      parseInt(process.env.DURATION_MIN)  || 120,
  followsBeforeBreak:   parseInt(process.env.FOLLOWS_PER_BATCH) || 40,
  longBreakMinSec:      120,
  longBreakMaxSec:      300,
  actionMinDelayMs:     3500,
  actionMaxDelayMs:     11000,
  // Action distribution (must sum to 1.0)
  weights: { follow: 0.65, like: 0.20, view: 0.10, scroll: 0.05 }
};

// ─── Helpers ───────────────────────────────────────────────────
const sleep   = (ms) => new Promise(r => setTimeout(r, ms));
const jitter  = (a, b) => a + Math.floor(Math.random() * (b - a));
const log     = (...a) => console.log(new Date().toLocaleTimeString(), '·', ...a);

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, ans => { rl.close(); r(ans); }));
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(DASHBOARD_URL + endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    mod.get({ hostname: url.hostname, path: url.pathname + url.search, headers: { 'x-api-key': API_KEY } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const url = new URL(DASHBOARD_URL + endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname, path: url.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': API_KEY }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function sendHeartbeat(accountId, stats) {
  apiPost('/api/marinator/heartbeat', { accountId, ...stats }).catch(() => {});
}

function cleanCookies(cookies) {
  return (cookies || []).map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }));
}

function pickAction(weights) {
  const r = Math.random();
  let acc = 0;
  for (const [name, w] of Object.entries(weights)) {
    acc += w;
    if (r <= acc) return name;
  }
  return 'follow';
}

// ─── Page helpers ──────────────────────────────────────────────

// Make sure we're on a content-rich page where we can find users to follow
async function ensureBrowsing(page) {
  const url = page.url();
  // If we're stuck on a non-content page, head to explore
  if (!url.includes('depop.com')
      || url.endsWith('depop.com/')
      || url.includes('/login')
      || url.includes('/signup')) {
    await page.goto('https://www.depop.com/explore/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2500);
    // Scroll a bit so React loads more product tiles
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await sleep(jitter(700, 1300));
    }
  }
}

// Open a random product, then navigate to its seller's profile.
// Returns true if we end up on a profile page.
async function jumpToRandomSellerProfile(page) {
  await ensureBrowsing(page);

  const productLinks = await page.$$eval('a[href*="/products/"]', as =>
    [...new Set(as.map(a => a.getAttribute('href')))].filter(Boolean).slice(0, 50)
  ).catch(() => []);
  if (!productLinks.length) return false;

  const href = productLinks[Math.floor(Math.random() * productLinks.length)];
  const productUrl = href.startsWith('http') ? href : 'https://www.depop.com' + href;

  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(jitter(1800, 3500));

  // Find a username link on the product page
  const profileHref = await page.$$eval('a[href^="/"]', as => {
    const banned = ['login','signup','explore','sell','products','messages','sellinghub','category','search','help','about','careers'];
    for (const a of as) {
      const h = (a.getAttribute('href') || '').replace(/^\//, '').replace(/\/.*/, '');
      if (h && !banned.includes(h.toLowerCase()) && /^[a-zA-Z0-9_]{2,30}$/.test(h)) {
        return '/' + h + '/';
      }
    }
    return null;
  }).catch(() => null);

  if (!profileHref) return false;

  await page.goto('https://www.depop.com' + profileHref, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(jitter(2000, 4000));
  return true;
}

// Click the Follow button if we're on a profile page that has one.
// Returns 'followed' / 'already' / 'no_button'
async function tryFollowOnProfile(page) {
  // Find a button whose text is exactly "Follow" (case-insensitive)
  const result = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, [role="button"]')];
    for (const b of buttons) {
      const t = (b.innerText || '').trim().toLowerCase();
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      if (t === 'follow' || aria === 'follow' || aria.startsWith('follow @')) {
        b.click();
        return 'followed';
      }
      if (t === 'following' || t === 'unfollow' || aria.startsWith('unfollow')) {
        return 'already';
      }
    }
    return 'no_button';
  }).catch(() => 'no_button');
  return result;
}

// Like one product on the current page
async function tryLikeOnPage(page) {
  return page.evaluate(() => {
    // Depop "like" buttons usually have aria-label containing "like" / "save"
    const buttons = [...document.querySelectorAll('button, [role="button"]')];
    const candidates = buttons.filter(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return /^(like|save)/.test(aria) && !/un(like|save)/.test(aria);
    });
    if (!candidates.length) return false;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    pick.click();
    return true;
  }).catch(() => false);
}

async function scrollFeed(page) {
  await ensureBrowsing(page);
  for (let i = 0; i < jitter(3, 7); i++) {
    await page.evaluate(() => window.scrollBy(0, 800 + Math.random() * 800));
    await sleep(jitter(500, 1300));
  }
}

// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱 Riptag Account Marinator');
  console.log('   Warm-up routine: follows + likes + browsing\n');

  const accounts = await apiGet('/api/accounts').catch(() => []);
  if (!accounts.length) {
    console.log('No accounts found. Connect one via the Chrome extension first.');
    return;
  }

  console.log('Pick an account to marinate:');
  accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username}`));
  const choice = await ask('\nAccount number: ');
  const account = accounts[parseInt(choice) - 1];
  if (!account || !account.cookies?.length) {
    console.log('Invalid selection or account has no cookies.');
    return;
  }

  console.log(`\nTarget: ${CONFIG.followsTarget} follows over ~${CONFIG.durationMinutes} min`);
  console.log(`Action mix: ${Object.entries(CONFIG.weights).map(([k,v]) => `${k} ${(v*100).toFixed(0)}%`).join(', ')}`);
  console.log('Long break every ' + CONFIG.followsBeforeBreak + ' follows.');
  const go = await ask('\nStart? (y/n): ');
  if (go.toLowerCase() !== 'y') { console.log('Cancelled.'); return; }

  log(`Opening browser for @${account.username}...`);
  const browser = await chromium.launch({
    headless: false,
    slowMo: 25,
    args: ['--disable-blink-features=AutomationControlled']
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 850 }
  });
  await context.addCookies(cleanCookies(account.cookies));
  const page = await context.newPage();

  await page.goto('https://www.depop.com/explore/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(3000);

  // Stats
  const stats = { follows: 0, likes: 0, views: 0, scrolls: 0, errors: 0, alreadyFollowing: 0 };
  const startTime = Date.now();
  const endTime = startTime + CONFIG.durationMinutes * 60_000;

  // Heartbeat to the dashboard
  sendHeartbeat(account.id, stats);
  const hbInterval = setInterval(() => sendHeartbeat(account.id, stats), 30_000);

  log(`▶ Starting marination loop`);

  try {
    while (stats.follows < CONFIG.followsTarget && Date.now() < endTime) {
      const action = pickAction(CONFIG.weights);

      try {
        if (action === 'follow') {
          const onProfile = await jumpToRandomSellerProfile(page);
          if (!onProfile) { stats.errors++; await sleep(jitter(3000, 6000)); continue; }
          const result = await tryFollowOnProfile(page);
          if (result === 'followed') {
            stats.follows++;
            const username = page.url().split('depop.com/')[1]?.split('/')[0] || '?';
            log(`✓ followed @${username}  [${stats.follows}/${CONFIG.followsTarget}]`);
          } else if (result === 'already') {
            stats.alreadyFollowing++;
          } else {
            stats.errors++;
          }
        } else if (action === 'like') {
          await ensureBrowsing(page);
          const ok = await tryLikeOnPage(page);
          if (ok) { stats.likes++; log(`♥ liked a post  [likes ${stats.likes}]`); }
        } else if (action === 'view') {
          const onProfile = await jumpToRandomSellerProfile(page);
          if (onProfile) { stats.views++; log(`👁 viewed a profile  [views ${stats.views}]`); }
          // Linger on the profile a moment, scroll a bit
          for (let i = 0; i < jitter(2, 5); i++) {
            await page.evaluate(() => window.scrollBy(0, 600));
            await sleep(jitter(400, 900));
          }
        } else {
          await scrollFeed(page);
          stats.scrolls++;
        }
      } catch (e) {
        stats.errors++;
        log(`⚠ action error (${action}):`, e.message.slice(0, 80));
      }

      // Long break every N follows to look natural
      if (stats.follows > 0 && stats.follows % CONFIG.followsBeforeBreak === 0) {
        const breakSec = jitter(CONFIG.longBreakMinSec, CONFIG.longBreakMaxSec);
        log(`💤 long break ${breakSec}s after ${stats.follows} follows`);
        await sleep(breakSec * 1000);
      } else {
        await sleep(jitter(CONFIG.actionMinDelayMs, CONFIG.actionMaxDelayMs));
      }
    }
  } finally {
    clearInterval(hbInterval);
    sendHeartbeat(account.id, stats);
    await browser.close().catch(() => {});
  }

  const minsRun = Math.round((Date.now() - startTime) / 60000);
  console.log('\n══════════════════════════════════════════');
  console.log(` Marination complete for @${account.username}`);
  console.log(`   follows:           ${stats.follows}`);
  console.log(`   likes:             ${stats.likes}`);
  console.log(`   profile views:     ${stats.views}`);
  console.log(`   scrolls:           ${stats.scrolls}`);
  console.log(`   already-following: ${stats.alreadyFollowing}`);
  console.log(`   errors:            ${stats.errors}`);
  console.log(`   time elapsed:      ${minsRun} min`);
  console.log('══════════════════════════════════════════\n');
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
