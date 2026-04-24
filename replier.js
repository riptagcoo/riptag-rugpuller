/**
 * RIPTAG RUGPULLER — REPLIER BOT
 *
 * Watches all enabled Depop accounts' DMs, generates Claude replies,
 * and sends them. Runs 24/7 as long as this process is alive.
 *
 * Run:  node replier.js
 * Or:   double-click REPLIER.bat
 *
 * Restored from chat on 2026-04-24 after truncation in a parallel session.
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
const sleep  = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (a, b) => a + Math.floor(Math.random() * (b - a));
const log    = (...a) => console.log(new Date().toLocaleTimeString(), '·', ...a);

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

async function generateReply(accountId, message, history) {
  try {
    const res = await apiPost('/api/replier/generate', { accountId, message, history });
    if (res.error) { log('⚠ Claude error:', res.error); return null; }
    return res.reply;
  } catch (e) { log('⚠ generate failed:', e.message); return null; }
}

async function recordMessage(accountId, senderId, senderUsername, direction, message, reply) {
  return apiPost('/api/replier/conversations/' + accountId, {
    senderId, senderUsername, message, reply, direction
  }).catch(() => {});
}

function cleanCookies(cookies) {
  return (cookies || []).map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
    sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }));
}

// Selectors confirmed against Depop DOM (April 2026):
//   • Composer is a <textarea placeholder="Type your message...">
//   • No visible send button — Depop sends on Enter
//   • Conversation URLs look like /messages/{64-char-hex}/
const SELECTORS = {
  conversationLink:  'a[href*="/messages/"]',
  unreadIndicator:   '[data-testid*="unread"], .unread, [class*="nread"]',
  messageBubble:     'div[class*="message"]:not([class*="messageInput"]):not([class*="Input"])',
  messageInput:      'textarea[placeholder*="message" i], textarea[class*="messageInputTextArea"]',
  sendButton:        'button[aria-label*="end" i], button[class*="send" i]'
};

// Extract the conversation ID from a /messages/<id>/ URL
function convoIdFromUrl(url) {
  const m = String(url || '').match(/\/messages\/([^/?#]+)/);
  const id = m && m[1];
  if (!id || id === 'inbox' || id === '' || id === 'new') return null;
  return id;
}

async function checkAccount(account, page, pass = 1) {
  const username = account.username;
  log(`→ checking @${username}${pass > 1 ? ` (pass ${pass})` : ''}`);

  // Navigate directly to the Unread filter URL — Depop honors ?unread=true
  // so we skip having to click the Inbox tab or the filter dropdown.
  try {
    await page.goto('https://www.depop.com/messages/?unread=true', { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) { log(`  · could not open unread inbox: ${e.message}`); return; }

  await page.waitForTimeout(2500);

  // Belt & braces: if Depop still showed the Offers tab, click Inbox manually
  try {
    const clickedInbox = await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('button, a, [role="tab"]')];
      for (const el of candidates) {
        const t = (el.innerText || '').trim();
        if (/^inbox$/i.test(t)) { el.click(); return true; }
      }
      return false;
    });
    if (clickedInbox) {
      log('  · clicked Inbox tab as fallback');
      await page.waitForTimeout(1500);
    }
  } catch {}

  // Scroll the conversation list to lazy-load all entries
  try {
    let prevCount = -1, stable = 0;
    for (let i = 0; i < 20 && stable < 2; i++) {
      const links = await page.$$(SELECTORS.conversationLink);
      if (links.length === prevCount) stable++;
      else { stable = 0; prevCount = links.length; }
      if (links.length) {
        await links[links.length - 1].scrollIntoViewIfNeeded().catch(() => {});
      }
      await page.waitForTimeout(700);
    }
    if (prevCount > 0) log(`  · scrolled inbox, ${prevCount} conversations loaded`);
  } catch (e) { log(`  · scroll warning: ${e.message}`); }

  // Wait up to 20s for real conversation rows to render
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
      await page.waitForTimeout(2000);

      // Find visible message bubbles
      const bubbles = await page.$$(SELECTORS.messageBubble);
      if (!bubbles.length) { log('    · no message bubbles visible'); continue; }

      // Grab the text of the last ~10 visible bubbles. We'll figure out which
      // of those are NEW (haven't been processed yet) so the bot can respond
      // to the whole burst of messages instead of just the most recent one.
      const WINDOW = 10;
      const start = Math.max(0, bubbles.length - WINDOW);
      const bubbleTexts = [];
      for (let i = start; i < bubbles.length; i++) {
        const t = (await bubbles[i].innerText().catch(() => '')).trim();
        if (t) bubbleTexts.push(t);
      }
      if (!bubbleTexts.length) { log('    · no readable bubble text'); continue; }

      const lastText = bubbleTexts[bubbleTexts.length - 1];

      const senderUsername = (await page.$eval(
        'header h1, header h2, [data-testid*="conversation-header"] h1, [data-testid*="conversation-header"] h2',
        el => el.innerText.trim()
      ).catch(() => senderId)).replace(/^@/, '');

      // Figure out what's NEW: anything visible that we've never recorded
      // (neither an inbound we logged nor an outbound reply we sent). Use a
      // Set of every stored message/reply text for this sender.
      const storedMessages = known.find(c => c.senderId === senderId)?.messages || [];
      const seenTexts = new Set();
      for (const m of storedMessages) {
        const t = (m.message || m.reply || '').trim();
        if (t) seenTexts.add(t);
      }
      const newMessages = bubbleTexts.filter(t => !seenTexts.has(t));

      if (!newMessages.length) {
        log(`    · @${senderUsername}: nothing new since last sweep`);
        continue;
      }

      // Guard: if the ONLY "new" bubble is our own previous reply (e.g. we
      // just sent it and the dashboard record hasn't written yet), skip.
      const myLastReply = storedMessages.filter(m => m.direction === 'outbound').slice(-1)[0];
      if (newMessages.length === 1 && myLastReply && (myLastReply.reply || '').trim() === newMessages[0]) {
        log(`    · @${senderUsername}: last visible bubble is our own reply, no action`);
        continue;
      }

      // Combine the new messages into one piece of context. Claude gets the
      // full burst so "yo / what do you got / just bought a small" becomes
      // a single coherent situation to respond to instead of 3 disconnected lines.
      const combinedMessage = newMessages.length === 1
        ? newMessages[0]
        : newMessages.join('\n');

      if (newMessages.length > 1) {
        log(`    · NEW BURST from @${senderUsername} (${newMessages.length} messages):`);
        newMessages.forEach((m, i) => log(`       ${i+1}. ${m.slice(0, 80)}`));
      } else {
        log(`    · NEW from @${senderUsername}: "${combinedMessage.slice(0, 60)}"`);
      }

      // Record every new inbound bubble separately so the dashboard
      // conversation view shows each as its own message.
      for (const msg of newMessages) {
        await recordMessage(account.id, senderId, senderUsername, 'inbound', msg, null);
      }

      // Ask Claude for ONE reply that covers the whole burst of messages
      const reply = await generateReply(account.id, combinedMessage, storedMessages);
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
      // Record outbound tied to the combined burst (so dashboard shows what triggered the reply)
      await recordMessage(account.id, senderId, senderUsername, 'outbound', combinedMessage, reply);
      handled++;

      // Breathe before the next thread
      await page.waitForTimeout(jitter(2500, 5000));
    } catch (e) {
      log(`    ⚠ error on ${senderId}: ${e.message}`);
    }
  }

  log(`  · handled ${handled} new message(s) for @${username}`);

  // If we replied, a new unread may have arrived while we were typing.
  // Loop back and re-check (up to 3 passes total).
  if (handled > 0 && pass < 3) {
    log(`  · re-checking inbox for fresh unreads (pass ${pass + 1})`);
    await page.waitForTimeout(2000);
    await checkAccount(account, page, pass + 1);
  }
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
