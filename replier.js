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

// ─── Poll interval per speed mode (ms) ────────────────────────
const SPEED_INTERVALS = {
  stealth:  { min: 60000, max: 120000 },  // 1–2 min per check
  balanced: { min: 15000, max: 30000 },   // 15–30 s
  fast:     { min: 3000,  max: 6000 }     // 3–6 s
};

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

// Extract the conversation ID from a /messages/<id>/ URL
function convoIdFromUrl(url) {
  const m = String(url || '').match(/\/messages\/([^/?#]+)/);
  const id = m && m[1];
  if (!id || id === 'inbox' || id === '' || id === 'new') return null;
  return id;
}

async function checkAccount(account, page) {
  const username = account.username;
  log(`→ checking @${username}`);

  // Navigate to the messages inbox
  try {
    await page.goto('https://www.depop.com/messages/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { log(`  · could not open inbox: ${e.message}`); return; }

  // Wait up to 20s for real conversation rows to render (React is slow)
  let convoHrefs = [];
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    convoHrefs = await page.$$eval(SELECTORS.conversationLink, links => {
      const out = [];
      for (const a of links) {
        const h = a.getAttribute('href') || a.href || '';
        out.push(h);
      }
      return out;
    }).catch(() => []);
    // Keep only real conversation URLs (not the base /messages/ or /messages/new)
    convoHrefs = [...new Set(convoHrefs)]
      .map(h => h.startsWith('http') ? h : ('https://www.depop.com' + h))
      .filter(h => convoIdFromUrl(h));
    if (convoHrefs.length) break;
    await page.waitForTimeout(1000);
  }

  if (!convoHrefs.length) {
    log(`  · no conversations appeared after 20s — inbox may be empty or selector wrong`);
    return;
  }

  log(`  · found ${convoHrefs.length} conversation URL(s)`);

  // Pull what we already recorded so we don't re-reply to the same message
  const known = await fetchConversations(account.id);
  const knownLast = new Map();
  for (const c of known) {
    const last = c.messages?.[c.messages.length - 1];
    if (last) knownLast.set(c.senderId, (last.message || last.reply || '').trim());
  }

  const MAX_CHECK = 10;
  let handled = 0;

  for (const href of convoHrefs.slice(0, MAX_CHECK)) {
    const senderId = convoIdFromUrl(href);
    log(`  · opening ${senderId}`);

    try {
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // Wait for the message composer to appear — proof the thread actually loaded
      try {
        await page.waitForSelector(SELECTORS.messageInput, { timeout: 15000 });
      } catch {
        log('    · composer never appeared, skipping this thread');
        continue;
      }
      // Let message list finish rendering
      await page.waitForTimeout(2000);

      // Find visible message bubbles
      const bubbles = await page.$$(SELECTORS.messageBubble);
      if (!bubbles.length) { log('    · no message bubbles visible'); continue; }

      // Last visible message on the page
      const lastText = (await bubbles[bubbles.length - 1].innerText().catch(() => '')).trim();
      if (!lastText) { log('    · last bubble has no text'); continue; }

      // Try to grab the other user's display name from the header
      const senderUsername = (await page.$eval(
        'header h1, header h2, [data-testid*="conversation-header"] h1, [data-testid*="conversation-header"] h2',
        el => el.innerText.trim()
      ).catch(() => senderId)).replace(/^@/, '');

      // Dedupe: have we already seen exactly this last message?
      const prev = knownLast.get(senderId);
      if (prev && prev === lastText) {
        log(`    · @${senderUsername}: already handled this message`);
        continue;
      }

      // Simple check: if the last bubble's text looks like one we sent, skip.
      // (Outbound bubbles are usually right-aligned, but without a reliable
      //  class name we compare against the most recent outbound we recorded.)
      const myLastReply = known.find(c => c.senderId === senderId)?.messages
        ?.filter(m => m.direction === 'outbound').slice(-1)[0];
      if (myLastReply && (myLastReply.reply || '').trim() === lastText) {
        log(`    · @${senderUsername}: last message is our own reply, no action`);
        continue;
      }

      log(`    · NEW from @${senderUsername}: "${lastText.slice(0, 60)}"`);

      // Record inbound immediately so the dashboard reflects it
      await recordMessage(account.id, senderId, senderUsername, 'inbound', lastText, null);

      // Ask Claude for a reply (include history if we have it)
      const history = known.find(c => c.senderId === senderId)?.messages || [];
      const reply = await generateReply(account.id, lastText, history);
      if (!reply) { log('    · Claude did not return a reply'); continue; }

      log(`    · Claude: "${reply.slice(0, 80)}"`);

      // Focus the input
      const input = await page.$(SELECTORS.messageInput);
      if (!input) { log('    · input disappeared before we could type'); continue; }
      await input.click();
      await page.waitForTimeout(jitter(200, 500));

      // Type human-like
      for (const ch of reply) {
        await page.keyboard.type(ch, { delay: jitter(35, 110) });
      }
      await page.waitForTimeout(jitter(500, 1200));

      // Send: prefer the send button if present, otherwise press Enter
      const sendBtn = await page.$(SELECTORS.sendButton);
      if (sendBtn) {
        try { await sendBtn.click({ timeout: 3000 }); }
        catch { await page.keyboard.press('Enter'); }
      } else {
        await page.keyboard.press('Enter');
      }

      log(`    ✓ reply sent`);
      await recordMessage(account.id, senderId, senderUsername, 'outbound', lastText, reply);
      handled++;

      // Breathe before the next thread
      await page.waitForTimeout(jitter(2500, 5000));
    } catch (e) {
      log(`    ⚠ error on ${senderId}: ${e.message}`);
    }
  }

  log(`  · handled ${handled} new message(s) for @${username}`);
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
          browser = await chromium.launch({ headless: false, slowMo: 30 });
          const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
          });
          await context.addCookies(cleanCookies(account.cookies));
          const page = await context.newPage();
          await checkAccount(account, page);
        } catch (e) {
          log(`⚠ @${account.username} crashed:`, e.message);
        } finally {
          if (browser) await browser.close().catch(() => {});
        }
      }

      const interval = SPEED_INTERVALS[speed] || SPEED_INTERVALS.balanced;
      const waitMs = jitter(interval.min, interval.max);
      log(`💤 next sweep in ${Math.round(waitMs / 1000)}s`);
      await sleep(waitMs);
    } catch (e) {
      log('⚠ main loop error:', e.message);
      await sleep(10000);
    }
  }
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
