/**
 * RIPTAG RUGPULLER — LOCAL DEPLOY AGENT v5
 * Run: node agent.js
 */

const { chromium } = require('playwright');
const https = require('https');
const http = require('http');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

const DASHBOARD_URL = 'https://riptag-rugpuller-production.up.railway.app';

// Heartbeat — lets dashboard know daemon is alive
function sendHeartbeat() {
  const urlObj = new URL(DASHBOARD_URL + '/api/daemon/heartbeat');
  const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
  const req = mod.request({ hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2, 'x-api-key': '1010' } }, () => {});
  req.on('error', () => {});
  req.write('{}'); req.end();
}

function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    const url = DASHBOARD_URL + endpoint;
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: { 'x-api-key': '1010' } };
    mod.get(url, options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function apiPut(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(DASHBOARD_URL + endpoint);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    fs.ensureDirSync(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.remove(dest).then(() => downloadFile(res.headers.location, dest).then(resolve).catch(reject));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// Click a combobox input and select option by index (1-based)
async function selectComboOption(page, inputId, optionIndex) {
  const input = await page.$(`#${inputId}`);
  if (!input) { console.log(`  → Input #${inputId} not found`); return false; }
  
  await input.click();
  await page.waitForTimeout(600);
  
  // Wait for menu to open
  const menuId = inputId.replace('-input', '-menu');
  await page.waitForSelector(`#${menuId}`, { timeout: 3000 }).catch(() => {});
  
  // Get all options in the menu
  const options = await page.$$(`#${menuId} [role="option"]`);
  console.log(`  → Found ${options.length} options in #${menuId}`);
  
  if (options[optionIndex - 1]) {
    await options[optionIndex - 1].click();
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

async function postListing(page, listing, localPhotos) {
  // Try clicking "List another item" if we're on the success page, else navigate
  const listAnotherBtn = await page.$('button:has-text("List another item"), a:has-text("List another item")');
  if (listAnotherBtn) {
    await listAnotherBtn.click();
    await page.waitForTimeout(2500);
    console.log('  → Clicked List another item');
  } else {
    await page.goto('https://www.depop.com/products/create/first/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2500);
  }

  // ── PHOTOS ──
  try {
    const photoInput = await page.$('input[type="file"]');
    if (photoInput && localPhotos.length > 0) {
      const existing = localPhotos.filter(p => fs.existsSync(p));
      if (existing.length) {
        await photoInput.setInputFiles(existing);
        await page.waitForTimeout(3500);
        console.log(`  → ${existing.length} photos uploaded`);
      }
    }
  } catch (e) { console.log('  → Photo error:', e.message); }

  // ── DESCRIPTION ──
  try {
    const textarea = await page.$('textarea');
    if (textarea) {
      await textarea.click({ clickCount: 3 });
      await textarea.fill(listing.customDescription || listing.description || '');
      await page.waitForTimeout(400);
      console.log('  → Description filled');
    }
  } catch (e) { console.log('  → Desc error:', e.message); }

  // ── CATEGORY: T-shirts = 1st option ──
  try {
    const ok = await selectComboOption(page, 'group-input', 1);
    console.log('  → Category:', ok ? 'selected' : 'failed');
  } catch (e) { console.log('  → Category error:', e.message); }

  // ── BRAND: type "otherr", select 1st option ──
  try {
    const brandInput = await page.$('#brand-input');
    if (brandInput) {
      await brandInput.click({ clickCount: 3 });
      await brandInput.type('otherr', { delay: 80 });
      await page.waitForTimeout(800);
      const menuOpts = await page.$$('#brand-menu [role="option"]');
      console.log(`  → Brand: ${menuOpts.length} options found`);
      if (menuOpts[0]) { await menuOpts[0].click(); await page.waitForTimeout(400); console.log('  → Brand: 1st option selected'); }
    }
  } catch (e) { console.log('  → Brand error:', e.message); }

  // ── CONDITION: 3rd option ──
  try {
    const ok = await selectComboOption(page, 'condition-input', 3);
    console.log('  → Condition:', ok ? '3rd option selected' : 'failed');
  } catch (e) { console.log('  → Condition error:', e.message); }

  // ── SIZE: S=5, M=6, L=7, XL=8, XXL=9 ──
  const sizeIndexMap = { 'S': 5, 'M': 6, 'L': 7, 'XL': 8, 'XXL': 9 };
  const sizeIndex = sizeIndexMap[listing.size] || 5;
  try {
    const ok = await selectComboOption(page, 'variants-input', sizeIndex);
    console.log(`  → Size ${listing.size}:`, ok ? 'selected' : 'failed');
  } catch (e) { console.log('  → Size error:', e.message); }

  // ── QUANTITY: 100 ──
  try {
    // Quantity input is next to size - find by looking for number input near size
    const qtyInput = await page.$('input[name*="uantity"], input[id*="uantity"], input[placeholder*="Qty"]');
    if (qtyInput) {
      await qtyInput.click({ clickCount: 3 });
      await qtyInput.fill('100');
      await page.waitForTimeout(300);
      console.log('  → Quantity: 100');
    } else {
      // Find all number inputs and pick one that's not price
      const allInputs = await page.$$('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]');
      for (const inp of allInputs) {
        const id = await inp.getAttribute('id') || '';
        const name = await inp.getAttribute('name') || '';
        if (!id.includes('rice') && !name.includes('rice')) {
          await inp.click({ clickCount: 3 });
          await inp.fill('100');
          await page.waitForTimeout(300);
          console.log('  → Quantity: 100 (found by type)');
          break;
        }
      }
    }
  } catch (e) { console.log('  → Quantity error:', e.message); }

  // ── PRICE ──
  try {
    const price = String(listing.customPrice || listing.price || '20');
    const priceInput = await page.$('input[name*="rice"], input[id*="rice"], input[placeholder*="rice"]');
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await priceInput.fill(price);
      await page.waitForTimeout(300);
      console.log('  → Price:', price);
    }
  } catch (e) { console.log('  → Price error:', e.message); }

  // ── PACKAGE SIZE: 2nd option ──
  try {
    const ok = await selectComboOption(page, 'shippingMethods-input', 2);
    console.log('  → Package size:', ok ? '2nd option selected' : 'failed');
  } catch (e) { console.log('  → Package error:', e.message); }

  // ── SUBMIT ──
  await page.waitForTimeout(800);
  for (const sel of ['button[type="submit"]', 'button:has-text("Post")', 'button:has-text("List")', 'button:has-text("Publish")', 'button:has-text("Next")']) {
    const btn = await page.$(sel);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(5000);
      const newUrl = page.url();
      console.log('  → Submitted, URL:', newUrl);
      // Check for success - "Nice! It's listed" page or moved away from create
      const successEl = await page.$('text=Nice');
      const listedEl = await page.$('text=listed');
      if (successEl || listedEl || !newUrl.includes('create')) {
        return true;
      }
      return false;
    }
  }

  console.log('  → No submit button found');
  return false;
}


// ─── MASS EDIT DESCRIPTIONS ──────────────────────────────────
async function massEditDescriptions(set, newDescription) {
  const accounts = await apiGet('/api/accounts');
  const account = accounts.find(a => a.id === set.accountId);
  if (!account) { console.log('No account found for this set.'); return; }

  console.log(`\nOpening browser for @${account.username}...`);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();

  if (account.cookies?.length) {
    const clean = account.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
      sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    }));
    await context.addCookies(clean);
  }

  const page = await context.newPage();
  await page.goto('https://www.depop.com/' + account.username + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Get all listing links
  let prevCount = 0, sameCount = 0;
  while (sameCount < 3) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const items = await page.$$('a[href*="/products/"]');
    if (items.length === prevCount) sameCount++;
    else sameCount = 0;
    prevCount = items.length;
  }

  const listingLinks = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href*="/products/"]')];
    return [...new Set(anchors.map(a => a.href))].filter(u => u.includes('/products/'));
  });

  console.log(`Found ${listingLinks.length} listings to update...`);

  for (let i = 0; i < listingLinks.length; i++) {
    process.stdout.write(`[${i+1}/${listingLinks.length}] Updating... `);
    try {
      await page.goto(listingLinks[i], { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1000);

      // Click Edit button
      const editBtn = await page.$('a:has-text("Edit"), button:has-text("Edit")');
      if (editBtn) {
        await editBtn.click();
        await page.waitForTimeout(1500);

        // Find description textarea and update
        const textarea = await page.$('textarea');
        if (textarea) {
          await textarea.click({ clickCount: 3 });
          await textarea.fill(newDescription);
          await page.waitForTimeout(300);

          // Save
          const saveBtn = await page.$('button[type="submit"], button:has-text("Save"), button:has-text("Update")');
          if (saveBtn) { await saveBtn.click(); await page.waitForTimeout(2000); process.stdout.write('✓\n'); }
          else { process.stdout.write('✗ No save btn\n'); }
        }
      } else { process.stdout.write('✗ No edit btn\n'); }
    } catch (err) { process.stdout.write('✗ ' + err.message.substring(0, 40) + '\n'); }
    await page.waitForTimeout(1500 + Math.random() * 1500);
  }

  await browser.close();
  console.log('\n✅ Mass edit complete');
}

async function runMassEdit() {
  const sets = await apiGet('/api/sets');
  const accounts = await apiGet('/api/accounts');
  
  console.log('\nSelect account to mass edit:');
  accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username}${a.status ? ' ('+a.status+')' : ''}`));
  
  const acctChoice = await ask('\nEnter account number: ');
  const account = accounts[parseInt(acctChoice) - 1];
  if (!account) { console.log('Invalid.'); return; }

  const desc = await ask('\nEnter new description (or press Enter to use set evergreen description):\n> ');
  
  if (!desc.trim()) {
    // Find the set for this account
    const set = sets.find(s => s.accountId === account.id);
    if (!set?.evergreenDescription) { console.log('No evergreen description found. Please type one.'); return; }
    await massEditDescriptions({ ...set, accountId: account.id }, set.evergreenDescription);
  } else {
    const set = sets.find(s => s.accountId === account.id) || { accountId: account.id };
    await massEditDescriptions(set, desc.trim());
  }
}

async function runStatusCheck() {
  const accounts = await apiGet('/api/accounts');
  const { chromium } = require('playwright');
  
  console.log('\nChecking account statuses...\n');
  
  for (const account of accounts) {
    process.stdout.write(`@${account.username}... `);
    try {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const r = await page.goto('https://www.depop.com/' + account.username + '/', { waitUntil: 'networkidle', timeout: 10000 });
      const title = await page.title();
      const isBanned = title.toLowerCase().includes('not found') || title.toLowerCase().includes('404') || r.status() === 404;
      const status = isBanned ? 'banned' : 'live';
      await browser.close();
      
      await apiPost('/api/accounts/' + account.id + '/status', { status });
      console.log(status === 'live' ? '✓ Live' : '✕ BANNED');
    } catch (err) {
      console.log('? Could not check - ' + err.message.substring(0, 40));
    }
  }
  console.log('\nDone. Check dashboard for updated statuses.');
}

async function runScrapeOrders() {
  const accounts = await apiGet('/api/accounts');
  console.log('\nSelect account to scrape orders from:');
  accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username}`));
  const choice = await ask('\nEnter account number: ');
  const account = accounts[parseInt(choice) - 1];
  if (!account) { console.log('Invalid.'); return; }

  console.log(`\nOpening browser for @${account.username}...`);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();

  if (account.cookies?.length) {
    const clean = account.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
      sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    }));
    await context.addCookies(clean);
  }

  const page = await context.newPage();
  const allOrders = [];

  try {
    // Navigate to sold items first to establish session
    console.log('Establishing session...');
    await page.goto('https://www.depop.com/sellinghub/sold-items/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Scrape UI directly using confirmed selectors
    console.log('Loading sold items page...');
    await page.goto('https://www.depop.com/sellinghub/sold-items/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Scroll to load all orders via infinite scroll
    console.log('Scrolling to load all orders...');
    let prevCount = 0, sameCount = 0;
    while (sameCount < 4) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1800);
      const rows = await page.$$('li.styles_receiptsListWrapper__bdK1V');
      console.log(`  Loaded ${rows.length} orders...`);
      if (rows.length === prevCount) sameCount++;
      else sameCount = 0;
      prevCount = rows.length;
    }

    // Extract basic order info from list page
    const orderLinks = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('li.styles_receiptsListWrapper__bdK1V')];
      return rows.map(row => {
        const link = row.querySelector('a[aria-label^="View receipt"]');
        const ariaLabel = link?.getAttribute('aria-label') || '';
        const orderIdMatch = ariaLabel.match(/receipt (\d+)/i);
        const orderId = orderIdMatch ? orderIdMatch[1] : '';
        const buyerSpans = row.querySelectorAll('div[class*="wrapper__qw03f"] span[class*="bold"]');
        const buyer = buyerSpans[1]?.textContent?.trim().replace('@','') || 'Unknown';
        const dateSpan = row.querySelector('span[class*="soldOnText"] + span, span.styles_soldOnText__LXzWM ~ span');
        const date = dateSpan?.textContent?.trim() || new Date().toLocaleDateString();
        const price = row.querySelector('div[class*="wrapper__y_j2_"] p[class*="bold"]')?.textContent?.trim() || '';
        const href = link?.getAttribute('href') || '';
        return { orderId, buyer, date, price, href };
      }).filter(o => o.orderId);
    });

    console.log(`\nFound ${orderLinks.length} orders. Fetching sizes from detail pages...`);

    for (let i = 0; i < orderLinks.length; i++) {
      const order = orderLinks[i];
      process.stdout.write(`[${i+1}/${orderLinks.length}] Order ${order.orderId}... `);
      try {
        await page.goto(`https://www.depop.com/sellinghub/sold-items/${order.orderId}/`, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(1200);

        const detail = await page.evaluate(() => {
          const drawer = document.querySelector('aside[data-testid="simpleDrawer-visible"]') || document;
          
          // Item title
          const titleEl = drawer.querySelector('p[data-testid="receipt-product-description"]');
          const item = titleEl?.textContent?.trim() || 'Mystery Bundle';

          // Size - look in summary div first
          const summaryEl = drawer.querySelector('div[class*="summary"]');
          let size = 'Unknown';
          if (summaryEl) {
            const boldPs = summaryEl.querySelectorAll('p[class*="bold"]');
            for (const p of boldPs) {
              const t = p.textContent?.trim().toUpperCase();
              if (['S','M','L','XL','XXL'].includes(t)) { size = t; break; }
            }
          }
          // Fallback: scan all p tags for size
          if (size === 'Unknown') {
            const allP = [...drawer.querySelectorAll('p')];
            for (const p of allP) {
              const t = p.textContent?.trim().toUpperCase();
              if (['S','M','L','XL','XXL'].includes(t)) { size = t; break; }
            }
          }
          // Last resort: extract from item title
          if (size === 'Unknown' && item) {
            const m = item.match(/\b(XXL|XL|Small|Medium|Large|\bS\b|\bM\b|\bL\b)\b/i);
            if (m) size = m[1].toUpperCase().replace('SMALL','S').replace('MEDIUM','M').replace('LARGE','L');
          }

          return { item, size };
        });

        allOrders.push({
          orderId: order.orderId,
          buyer: order.buyer,
          date: order.date,
          price: order.price,
          item: detail.item,
          size: detail.size
        });
        process.stdout.write(`${detail.size} ✓\n`);
      } catch (e) {
        allOrders.push({ orderId: order.orderId, buyer: order.buyer, date: order.date, price: order.price, item: 'Mystery Bundle', size: 'Unknown' });
        process.stdout.write(`error\n`);
      }
      await page.waitForTimeout(600);
    }

    console.log(`\n✓ Total orders found: ${allOrders.length}`);
    if (allOrders.length > 0) {
      await apiPost('/api/accounts/' + account.id + '/orders', { orders: allOrders });
      console.log('✓ Saved to dashboard');
      
      // Show size breakdown
      const sizes = {};
      allOrders.forEach(o => { sizes[o.size] = (sizes[o.size]||0)+1; });
      console.log('\nSize breakdown:');
      Object.entries(sizes).sort().forEach(([s,n]) => console.log(`  ${s}: ${n}`));
    } else {
      console.log('No orders found.');
    }

  } catch (err) {
    console.log('Error:', err.message);
  }

  await browser.close();
  console.log('\nDone. Check Sold & Labels tab on dashboard.');
}

function extractSize(text) {
  if (!text) return null;
  const m = text.match(/\b(XXL|XL|Small|Medium|Large|\bS\b|\bM\b|\bL\b)\b/i);
  return m ? m[1] : null;
}

function normalizeSize(s) {
  if (!s) return 'Unknown';
  const map = { 'small':'S','medium':'M','large':'L','x-large':'XL','xlarge':'XL','xx-large':'XXL','2xl':'XXL','xxlarge':'XXL' };
  const lower = s.toLowerCase().trim();
  return map[lower] || s.toUpperCase().trim();
}

function browser_close_placeholder() { return Promise.resolve(); }

async function main() {
  console.log('\n🏄  Riptag Rugpuller — Local Deploy Agent v5');
  console.log(`    Dashboard: ${DASHBOARD_URL}\n`);

  const sets = await apiGet('/api/sets');
  if (!sets.length) { console.log('No sets found.'); return; }

  // Check for pending description switches first
  try {
    const switchR = await apiGet('/api/description-switches/due');
    if (switchR.due?.length) {
      console.log(`\n📝 ${switchR.due.length} set(s) ready to switch to evergreen description!`);
      for (const set of switchR.due) {
        const doSwitch = await ask(`Switch "${set.name}" to evergreen description now? (y/n): `);
        if (doSwitch.toLowerCase() === 'y') {
          console.log('Running mass edit with evergreen description...');
          await massEditDescriptions(set, set.evergreenDescription || set.description);
          await apiPost('/api/sets/' + set.id + '/mark-switched', {});
          console.log('✓ Switched to evergreen description');
        }
      }
    }
  } catch {}

  console.log('\nWhat do you want to do?');
  console.log('  1. Deploy a set');
  console.log('  2. Mass edit descriptions on an account');
  console.log('  3. Check account statuses');
  console.log('  4. Scrape orders (for labels)');
  const action = await ask('\nEnter choice (1/2/3/4): ');

  if (action === '2') {
    await runMassEdit();
    await browser_close_placeholder();
    return;
  }
  if (action === '3') {
    await runStatusCheck();
    return;
  }
  if (action === '4') {
    await runScrapeOrders();
    return;
  }

  console.log('\nAvailable sets:');
  sets.forEach((s, i) => {
    const pending = (s.listings || []).filter(l => !l.posted).length;
    console.log(`  ${i + 1}. ${s.name} — ${pending} pending`);
  });

  const choice = await ask('\nEnter set number: ');
  const set = sets[parseInt(choice) - 1];
  if (!set) { console.log('Invalid.'); return; }

  const accounts = await apiGet('/api/accounts');
  const account = accounts.find(a => a.id === set.accountId);
  if (!account) { console.log('No account assigned.'); return; }

  const pending = (set.listings || []).filter(l => !l.posted);
  if (!pending.length) { console.log('No pending listings.'); return; }

  console.log(`\n→ "${set.name}" → @${account.username} — ${pending.length} listings\n`);
  await ask('Press ENTER to start (DO NOT touch the browser)...');

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();

  if (account.cookies?.length) {
    const clean = account.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
      sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    }));
    await context.addCookies(clean);
  }

  const page = await context.newPage();
  const tmpDir = `./tmp/${set.id}`;
  fs.ensureDirSync(tmpDir);

  await page.goto('https://www.depop.com/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const photoCache = {};
  let successCount = 0;

  // Test 1 listing first
  console.log('Testing with 1 listing first...\n');
  const testListing = pending[0];

  if (!photoCache[testListing.groupId]) {
    const localPhotos = [];
    for (let j = 0; j < (testListing.photos || []).length; j++) {
      const photo = testListing.photos[j];
      if (photo.thumb) {
        const localPath = path.join(tmpDir, `${testListing.groupId}_${j}.jpg`);
        try { await downloadFile(photo.thumb, localPath); localPhotos.push(localPath); console.log(`Photo ${j+1} downloaded`); }
        catch (e) { console.log(`Photo ${j+1} failed: ${e.message}`); }
      }
    }
    photoCache[testListing.groupId] = localPhotos;
  }

  try {
    const success = await postListing(page, testListing, photoCache[testListing.groupId] || []);
    if (success) {
      successCount++;
      console.log('\n  ✓ TEST PASSED');
      await apiPut(`/api/sets/${set.id}/listings/${testListing.id}`, { posted: true });
    } else {
      console.log('\n  ✗ TEST FAILED - check browser window');
    }
  } catch (err) { console.log('\n  ✗ Error:', err.message); }

  if (successCount > 0 && pending.length > 1) {
    const doAll = await ask(`\nDeploy remaining ${pending.length - 1} listings? (y/n): `);
    if (doAll.toLowerCase() === 'y') {
      for (let i = 1; i < pending.length; i++) {
        const listing = pending[i];
        process.stdout.write(`[${i+1}/${pending.length}] ${listing.size} G${listing.groupIndex+1}... `);

        if (!photoCache[listing.groupId]) {
          const localPhotos = [];
          for (let j = 0; j < (listing.photos || []).length; j++) {
            const photo = listing.photos[j];
            if (photo.thumb) {
              const localPath = path.join(tmpDir, `${listing.groupId}_${j}.jpg`);
              try { await downloadFile(photo.thumb, localPath); localPhotos.push(localPath); } catch {}
            }
          }
          photoCache[listing.groupId] = localPhotos;
        }

        try {
          const success = await postListing(page, listing, photoCache[listing.groupId] || []);
          if (success) {
            successCount++;
            process.stdout.write('✓\n');
            await apiPut(`/api/sets/${set.id}/listings/${listing.id}`, { posted: true });
          } else { process.stdout.write('✗\n'); }
        } catch (err) { process.stdout.write(`✗ ${err.message}\n`); }

        await page.waitForTimeout(2000 + Math.random() * 3000);
      }
    }
  } else if (successCount === 0) {
    await ask('\nPress ENTER to close browser...');
  }

  await browser.close();
  await fs.remove(tmpDir);
  console.log(`\n✅ Done — ${successCount}/${pending.length} posted\n`);
}

if (!process.argv.includes('--daemon')) {
  main().catch(console.error);
}


// ─── DAEMON MODE ─────────────────────────────────────────────────
// Run: node agent.js --daemon
// Checks schedule every minute, auto-deploys due sets

if (process.argv.includes('--daemon')) {
  const https = require('https');
  const http = require('http');

  function apiGet(endpoint) {
    return new Promise((resolve, reject) => {
      const url = DASHBOARD_URL + endpoint;
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { headers: { 'x-api-key': '1010' } }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
      }).on('error', reject);
    });
  }

  function postProgress(data) {
    return new Promise((resolve) => {
      const body = JSON.stringify(data);
      const urlObj = new URL(DASHBOARD_URL + '/api/deploy/progress');
      const mod = urlObj.protocol === 'https:' ? https : http;
      const req = mod.request({ hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': '1010' } }, () => resolve());
      req.on('error', () => resolve());
      req.write(body); req.end();
    });
  }

  async function checkDescriptionSwitches() {
    try {
      const r = await apiGet('/api/description-switches/due');
      if (!r.due?.length) return;
      console.log(`\n📝 Auto-switching ${r.due.length} set(s) to evergreen description...`);
      for (const set of r.due) {
        if (!set.evergreenDescription) continue;
        console.log(`Switching: ${set.name}`);
        await massEditDescriptions(set, set.evergreenDescription);
        await apiPost('/api/sets/' + set.id + '/mark-switched', {});
        await postProgress({ type: 'deploy', setId: set.id, status: 'info', message: `✓ Switched ${set.name} to evergreen description` });
      }
    } catch (err) { console.error('Description switch error:', err.message); }
  }

  async function checkAndDeploy() {
    try {
      const { due } = await apiGet('/api/schedule/due');
      if (!due?.length) return;

      for (const set of due) {
        console.log(`\n📅 Scheduled deploy: ${set.name}`);
        const accounts = await apiGet('/api/accounts');
        const account = accounts.find(a => a.id === set.accountId);
        if (!account) { console.log('No account assigned, skipping.'); continue; }

        const pending = (set.listings || []).filter(l => !l.posted);
        if (!pending.length) { console.log('No pending listings.'); continue; }

        await postProgress({ type: 'deploy', setId: set.id, status: 'starting', message: `📅 Scheduled deploy: ${set.name} — ${pending.length} listings` });

        // Run deploy inline
        const { chromium } = require('playwright');
        const browser = await chromium.launch({ headless: false, slowMo: 50 });
        const context = await browser.newContext();

        // Proxy
        if (account.proxy) {
          console.log(`Using proxy: ${account.proxy}`);
        }

        if (account.cookies?.length) {
          const clean = account.cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path||'/', secure: c.secure||false, httpOnly: c.httpOnly||false, sameSite: ['Strict','Lax','None'].includes(c.sameSite)?c.sameSite:'Lax' }));
          await context.addCookies(clean);
        }

        const page = await context.newPage();
        await page.goto('https://www.depop.com/', { waitUntil: 'networkidle' });

        const fs = require('fs-extra');
        const path = require('path');
        const tmpDir = `./tmp/${set.id}`;
        fs.ensureDirSync(tmpDir);
        const photoCache = {};
        let successCount = 0;

        for (let i = 0; i < pending.length; i++) {
          const listing = pending[i];
          if (!photoCache[listing.groupId]) {
            const localPhotos = [];
            for (let j = 0; j < (listing.photos||[]).length; j++) {
              const photo = listing.photos[j];
              if (photo.thumb) {
                const localPath = path.join(tmpDir, `${listing.groupId}_${j}.jpg`);
                try { await downloadFile(photo.thumb, localPath); localPhotos.push(localPath); } catch {}
              }
            }
            photoCache[listing.groupId] = localPhotos;
          }

          await postProgress({ type: 'deploy', setId: set.id, status: 'posting', message: `Posting ${i+1}/${pending.length}: Size ${listing.size}`, progress: Math.round(((i+1)/pending.length)*100) });

          try {
            const success = await postListing(page, listing, photoCache[listing.groupId]||[]);
            if (success) {
              successCount++;
              await apiPut(`/api/sets/${set.id}/listings/${listing.id}`, { posted: true });
              await postProgress({ type: 'deploy', setId: set.id, status: 'posted', message: `✓ Posted: ${listing.size}`, listingId: listing.id });
            }
          } catch (err) { await postProgress({ type: 'deploy', setId: set.id, status: 'error', message: err.message }); }

          await page.waitForTimeout(2000 + Math.random() * 3000);
        }

        await browser.close();
        fs.remove(tmpDir);
        await postProgress({ type: 'deploy', setId: set.id, status: 'done', message: `Done: ${successCount}/${pending.length} posted`, progress: 100 });

        // Log to server
        const logBody = JSON.stringify({ setId: set.id, status: 'done' });
        const logUrl = new URL(DASHBOARD_URL + '/api/schedule/log');
        const logMod = logUrl.protocol === 'https:' ? require('https') : require('http');
        const logReq = logMod.request({ hostname: logUrl.hostname, path: logUrl.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(logBody), 'x-api-key': '1010' } }, () => {});
        logReq.write(logBody); logReq.end();
      }
    } catch (err) { console.error('Schedule check error:', err.message); }
  }

  console.log('\n🏄  Riptag Rugpuller — Scheduler Daemon');
  console.log(`    Dashboard: ${DASHBOARD_URL}`);
  console.log('    Checking schedule every minute...\n');
  sendHeartbeat();
  setInterval(sendHeartbeat, 30000);
  checkAndDeploy();
  setInterval(checkAndDeploy, 60000);
  // Check for description switches every 30 minutes
  checkDescriptionSwitches();
  setInterval(checkDescriptionSwitches, 30 * 60 * 1000);
}
