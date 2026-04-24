/**
 * RIPTAG RUGPULLER — REPLIER BOT
 *
 * Watches all enabled Depop accounts' DMs, generates Claude replies,
 * and sends them. Runs 24/7 as long as this process is alive.
 *
 * Run:  node replier.js
 * Or:   double-click REPLIER.bat
 */

const { chromium } = require('playwright');
const https = require('https');
const http = require('http');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://riptag-rugpuller-production.up.railway.app';
const API_KEY = process.env.DASHBOARD_PASSWORD || '1010';

// ─── Speed profiles ─────────────────────────────────────────
// Each mode controls BOTH the sweep cadence AND the within-thread behavior
// (typing speed, pre/post-send pauses, per-thread gap). stealth = looks like
// a distracted human. fast = plausibly a very quick human. We always type
// character-by-character so the keystroke stream is real — Depop can detect
// instant `value` writes.
const SPEED_PROFILES = {
  stealth:  {
    sweep:      { min: 60000, max: 120000 },
    perThread:  { min: 5000,  max: 10000 },
    preType:    { min: 800,   max: 1800 },
    charDelay:  { min: 90,    max: 220 },
    postType:   { min: 600,   max: 1400 },
    postSend:   { min: 3000,  max: 5000 }
  },
  balanced: {
    sweep:      { min: 15000, max: 30000 },
    perThread:  { min: 2000,  max: 4500 },
    preType:    { min: 400,   max: 900 },
    charDelay:  { min: 40,    max: 100 },
    postType:   { min: 300,   max: 800 },
    postSend:   { min: 1800,  max: 3200 }
  },
  fast: {
    sweep:      { min: 3000,  max: 6000 },
    perThread:  { min: 500,   max: 1500 },
    preType:    { min: 150,   max: 400 },
    charDelay:  { min: 15,    max: 45 },
    postType:   { min: 100,   max: 300 },
    postSend:   { min: 1200,  max: 2000 }
  }
};
function profileFor(speed) { return SPEED_PROFILES[speed] || SPEED_PROFILES.balanced; }

// ─── Small helpers ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(min, max) { return min + Math.floor(Math.random() * (max - min)); }
function log(...args) { console.log(new Date().toLocaleTimeString(), '·', ...args); }

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = new URL(DASHBOARD_URL + endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    const options = { hostname: url.hostname, path: url.pathname + url.search, headers: { 'x-api-key': API_KEY } };
    mod.get(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const url = new URL(DASHBOARD_URL + endpoint);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': API_KEY }
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Heartbeat (flips the "Replier active" pill green) ────────
function sendHeartbeat() {
  apiPost('/api/replier/heartbeat', {}).catch(() => {});
}

// ─── Dashboard helpers ────────────────────────────────────────
async function fetchAccounts() {
  try { const res = await apiGet('/api/accounts'); return res.accounts || res || []; }
  catch (e) { log('⚠ could not fetch accounts:', e.message); return []; }
}

async function fetchSpeed() {
  try { const res = await apiGet('/api/replier/speed'); return res.speed || 'balanced'; }
  catch { return 'balanced'; }
}

async function fetchConversations(accountId) {
  try { const res = await apiGet('/api/replier/conversations/' + accountId); return res.conversations || []; }
  catch { return []; }
}

// Ask the server to generate a reply with Claude
async function generateReply(accountId, message, history) {
  try {
    const res = await apiPost('/api/replier/generate', { accountId, message, history });
    if (res.error) { log('⚠ Claude error:', res.error); return null; }
    return res.reply;
  } catch (e) { log('⚠ generate failed:', e.message); return null; }
}

// Record a conversation line back to the dashboard
async function recordMessage(accountId, senderId, senderUsername, direction, message, reply) {
  return apiPost('/api/replier/conversations/' + accountId, {
    senderId, senderUsername, message, reply, direction
  }).catch(() => {});
}

// ─── Playwright: clean cookies into something addCookies accepts ──
function cleanCookies(cookies) {
  return (cookies || []).map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }));
}

// ─── The core check: open messages page, look for unread DMs ──
//
// NOTE TO FUTURE-ME / TO WHOEVER READS THIS:
//   Depop is a React SPA with no public DM API. We rely on DOM queries.
//   The selectors below are the fragile part. If replies stop working,
//   open Depop DMs manually, open DevTools, and figure out:
//     1. What element wraps each conversation in the inbox list?
//     2. How do you tell "unread" from "read"? (usually a bold/dot class)
//     3. What element is the message input? (usually textarea or div[contenteditable])
//     4. What's the send button?
//   Then update the three selector constants below.
//
const SELECTORS = {
  conversationLink:   'a[href*="/messages/"]',
  unreadIndicator:    '[data-testid*="unread"], .unread, [class*="nread"]',
  messageBubble:      '[class*="message"]',
  messageInput:       'textarea, div[contenteditable="true"]',
  sendButton:         'button[type="submit"], button[aria-label*="end" i]'
};

// Extract the conversation ID from a /messages/<id>/ URL.
// Depop's inbox has multiple sub-paths that are TABS, not conversations:
// /messages/offers, /messages/buying, /messages/selling, etc. Those show
// up in the DOM as `a[href*="/messages/"]` too, so without filtering them
// the bot was opening the Offers tab, not real threads.
const MESSAGE_TAB_SEGMENTS = new Set([
  'inbox', 'new', 'offers', 'buying', 'selling', 'sold', 'bought',
  'archive', 'archived', 'all', 'notifications', 'requests', 'settings',
  'filter', 'filters', 'unread', 'read', 'trash', 'spam', 'blocked'
]);
function convoIdFromUrl(url) {
  const m = String(url || '').match(/\/messages\/([^/?#]+)/);
  const id = m && m[1];
  if (!id) return null;
  if (MESSAGE_TAB_SEGMENTS.has(id.toLowerCase())) return null;
  // Tab-like: short all-lowercase-letters paths are never conversation IDs
  if (/^[a-z]+$/.test(id) && id.length <= 12) return null;
  return id;
}

// NEW FLOW:
//   1. Open /messages/?unread=true fresh
//   2. Pick the FIRST unread conversation
//   3. Reply to it
//   4. Navigate back to /messages/?unread=true — the one we just replied
//      to is now read and drops off the list
//   5. Repeat until no unread remain (or we hit MAX_PER_SWEEP safety cap)
//
// Why the loop-back: harvesting all URLs upfront fought against Depop's SPA
// (URLs went stale, filter state got lost). Re-entering the unread view each
// time guarantees we only ever touch conversations that are *actually* still
// unread right now, including any that arrive mid-sweep.
const UNREAD_URL = 'https://www.depop.com/messages/?unread=true';
const MAX_PER_SWEEP = 20;
const COOLDOWN_MINUTES = 3;

// Detect Depop's "you're sending messages too fast / reload / try again" banner
async function isRateLimited(page) {
  return await page.evaluate(() => {
    const text = (document.body && document.body.innerText || '').toLowerCase();
    return /(sending|sent).{0,20}too (quick|fast|many)|slow down|rate limit|please (try again|reload|refresh)|you can'?t send|message (failed|not sent)/.test(text);
  }).catch(() => false);
}

// Best-effort: click any "I'm not a robot" / "Verify" / Turnstile checkbox
// that's in the main DOM (iframes are out of reach from here — if a real
// hCaptcha/reCAPTCHA iframe is up, the checkbox is cross-origin and the
// user will need to solve it manually; we'll still cooldown so we don't
// spam around it).
async function tryClickCaptcha(page) {
  return await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('input[type="checkbox"], button, [role="checkbox"], [role="button"]')];
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const own = (el.getAttribute('aria-label') || el.innerText || el.textContent || '').toLowerCase();
      const parent = (el.closest('[class*="captcha"],[id*="captcha"],[class*="verify"],[class*="challenge"]') || {}).textContent || '';
      const context = (own + ' ' + String(parent).toLowerCase()).slice(0, 400);
      if (/verify|not a robot|i'?m human|i am human|captcha|challenge/.test(context)) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return context.trim().slice(0, 80);
      }
    }
    return null;
  }).catch(() => null);
}

async function checkAccount(account, page, speed) {
  const username = account.username;
  const prof = profileFor(speed);
  log(`→ checking @${username} (speed=${speed})`);

  let handled = 0;
  let emptyInARow = 0;

  for (let round = 0; round < MAX_PER_SWEEP; round++) {
    // Step 1 — load the unread inbox fresh
    try {
      await page.goto(UNREAD_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e) {
      log(`  · could not open unread inbox: ${e.message}`);
      return;
    }

    // Verify Depop actually kept the filter (its SPA sometimes strips query args)
    const currentUrl = page.url();
    if (!/unread=true/.test(currentUrl)) {
      log(`  · WARNING: Depop redirected off the unread filter (now on ${currentUrl}). Continuing but will see all threads.`);
    }

    await page.waitForTimeout(2500);

    // Step 2 — grab the FIRST real conversation link on the page.
    // Log what we actually see so we can diagnose if the filter rejects
    // everything (usually means a selector/markup change on Depop's side).
    let firstHref = null;
    let allHrefs = [];
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !firstHref) {
      const hrefs = await page.$$eval(SELECTORS.conversationLink, links =>
        links.map(a => a.getAttribute('href') || a.href || '')
      ).catch(() => []);
      allHrefs = [...new Set(
        hrefs.map(h => h.startsWith('http') ? h : ('https://www.depop.com' + h))
      )];
      firstHref = allHrefs.find(h => convoIdFromUrl(h)) || null;
      if (!firstHref) await page.waitForTimeout(800);
    }

    if (!firstHref) {
      emptyInARow++;
      if (round === 0 && allHrefs.length) {
        // First iteration of the sweep and we saw links but none passed the
        // conversation filter — dump a sample so we can adjust the filter.
        log(`  · saw ${allHrefs.length} /messages/ link(s) but none look like conversations:`);
        for (const h of allHrefs.slice(0, 8)) log(`      ${h}`);
      }
      if (emptyInARow >= 2) {
        log(`  · inbox is clean — handled ${handled} reply(ies) this sweep`);
        return;
      }
      await page.waitForTimeout(2000);
      continue;
    }
    emptyInARow = 0;

    const senderId = convoIdFromUrl(firstHref);
    // Strip the inbox's query string when navigating to the thread.
    // The href came off an /messages/?unread=true page so Depop appended
    // ?scrollTop=0&unread=true — feeding that back causes the SPA to
    // detach the frame mid-load, killing the browser context.
    const threadUrl = (() => {
      try {
        const u = new URL(firstHref);
        return u.origin + u.pathname;
      } catch { return firstHref; }
    })();
    log(`  · opening unread thread: ${threadUrl} (id=${senderId})`);

    try {
      // Step 3 — open the thread
      await page.goto(threadUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      try {
        await page.waitForSelector(SELECTORS.messageInput, { timeout: 15000 });
      } catch {
        log('    · composer never appeared, skipping');
        continue;
      }
      await page.waitForTimeout(2000);

      // Grab every message-like element, keep only ones with actual text.
      // The raw selector matches composer wrappers, timestamps, empty
      // animation placeholders etc. — all of which can be "last" and
      // would make lastText empty. Filtering in-browser avoids that.
      const bubbleTexts = await page.$$eval(SELECTORS.messageBubble, els =>
        els
          .map(el => (el.innerText || el.textContent || '').trim())
          .filter(t => t.length >= 2)
      ).catch(() => []);
      if (!bubbleTexts.length) { log('    · no visible message text on this thread'); continue; }
      const lastText = bubbleTexts[bubbleTexts.length - 1];

      const senderUsername = (await page.$eval(
        'header h1, header h2, [data-testid*="conversation-header"] h1, [data-testid*="conversation-header"] h2',
        el => el.innerText.trim()
      ).catch(() => senderId)).replace(/^@/, '');

      log(`    · from @${senderUsername}: "${lastText.slice(0, 60)}"`);

      // Step 4 — generate reply
      const known = await fetchConversations(account.id);
      const history = known.find(c => c.senderId === senderId)?.messages || [];

      const reply = await generateReply(account.id, lastText, history);
      if (!reply) {
        log('    · Claude returned nothing — leaving thread unread not possible (Depop marks it read on open); moving on');
        await recordMessage(account.id, senderId, senderUsername, 'inbound', lastText, null);
        continue;
      }
      log(`    · Claude: "${reply.slice(0, 80)}"`);

      // Before typing: if a captcha showed up on the thread page, try to
      // click through it (best-effort, since real hCaptcha/reCAPTCHA runs
      // in a cross-origin iframe we can't reach).
      const captchaHit = await tryClickCaptcha(page);
      if (captchaHit) {
        log(`    · clicked captcha-looking element: "${captchaHit}"`);
        await page.waitForTimeout(2500);
      }

      // Step 5 — type + send (HUMAN-LIKE per the current speed profile)
      const input = await page.$(SELECTORS.messageInput);
      if (!input) { log('    · input gone before typing'); continue; }
      await input.click();
      await page.waitForTimeout(jitter(prof.preType.min, prof.preType.max));

      // Per-character typing, paced by profile. keyboard.type dispatches
      // real key events so React's onChange / contenteditable handlers fire.
      await page.keyboard.type(reply, { delay: jitter(prof.charDelay.min, prof.charDelay.max) });
      await page.waitForTimeout(jitter(prof.postType.min, prof.postType.max));

      const sendBtn = await page.$(SELECTORS.sendButton);
      if (sendBtn) {
        try { await sendBtn.click({ timeout: 3000 }); }
        catch { await page.keyboard.press('Enter'); }
      } else {
        await page.keyboard.press('Enter');
      }

      // Wait for the send round-trip, then check if Depop complained
      await page.waitForTimeout(jitter(prof.postSend.min, prof.postSend.max));

      if (await isRateLimited(page)) {
        log(`    ⛔ RATE LIMITED — putting @${username} on ${COOLDOWN_MINUTES}-min cooldown`);
        await apiPost('/api/replier/cooldown', {
          accountId: account.id, minutes: COOLDOWN_MINUTES
        }).catch(() => {});
        // Still record the inbound so the dashboard reflects what we saw
        await recordMessage(account.id, senderId, senderUsername, 'inbound', lastText, null);
        return;
      }

      log(`    ✓ reply sent`);
      await recordMessage(account.id, senderId, senderUsername, 'inbound', lastText, null);
      await recordMessage(account.id, senderId, senderUsername, 'outbound', lastText, reply);
      handled++;
    } catch (e) {
      log(`    ⚠ error on ${senderId}: ${e.message}`);
    }

    await page.waitForTimeout(jitter(prof.perThread.min, prof.perThread.max));
  }

  log(`  · hit MAX_PER_SWEEP (${MAX_PER_SWEEP}) for @${username} — handled ${handled}, will continue next sweep`);
}

// ─── Main loop ───────────────────────────────────────────────
async function main() {
  log('🤖 Riptag Replier starting…');
  log('Dashboard:', DASHBOARD_URL);

  // Fire a heartbeat right away and then every 30s
  sendHeartbeat();
  setInterval(sendHeartbeat, 30000);

  while (true) {
    try {
      const [accounts, speed] = await Promise.all([fetchAccounts(), fetchSpeed()]);
      const active = accounts.filter(a => (a.replierSettings?.enabled !== false) && a.cookies?.length);

      if (!active.length) {
        log('No enabled accounts with cookies. Connect one in the dashboard.');
        await sleep(20000);
        continue;
      }

      log(`⚙ mode: ${speed} · ${active.length} account(s) to check`);

      for (const account of active) {
        // Skip if in cooldown
        if (account.cooldownUntil && new Date(account.cooldownUntil) > new Date()) {
          log(`· @${account.username} is cooling down, skip`);
          continue;
        }

        let browser;
        try {
          browser = await chromium.launch({ headless: false });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
          });
          await context.addCookies(cleanCookies(account.cookies));
          const page = await context.newPage();
          await checkAccount(account, page, speed);
        } catch (e) {
          log(`⚠ @${account.username} crashed:`, e.message);
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      }

      const sweep = profileFor(speed).sweep;
      const waitMs = jitter(sweep.min, sweep.max);
      log(`💤 next sweep in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    } catch (e) {
      log('⚠ main loop error:', e.message);
      await sleep(10000);
    }
  }
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
