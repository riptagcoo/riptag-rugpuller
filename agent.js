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
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': '1010' }
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

function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body || {});
    const urlObj = new URL(DASHBOARD_URL + endpoint);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': '1010' }
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
  
  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  
  for (const account of accounts) {
    process.stdout.write(`@${account.username}... `);
    try {
      const page = await browser.newPage();
      
      let httpStatus = 200;
      page.on('response', response => {
        if (response.url().includes('depop.com/' + account.username)) {
          httpStatus = response.status();
        }
      });

      await page.goto('https://www.depop.com/' + account.username + '/', { 
        waitUntil: 'domcontentloaded', 
        timeout: 15000 
      });
      await page.waitForTimeout(2000);

      const pageContent = await page.evaluate(() => {
        return {
          title: document.title,
          body: document.body?.innerText?.substring(0, 500) || '',
          url: window.location.href
        };
      });

      await page.close();

      const title = pageContent.title.toLowerCase();
      const body = pageContent.body.toLowerCase();

      const isBanned = httpStatus === 404
        || body.includes("that page doesn't exist")
        || body.includes("404 page not found")
        || body.includes("sorry, that page doesn't exist");

      const status = isBanned ? 'banned' : 'live';

      // Post result back to dashboard
      const https = require('https');
      await new Promise((resolve) => {
        const body = JSON.stringify({ status });
        const urlObj = new URL(DASHBOARD_URL + '/api/accounts/' + account.id + '/check-status');
        const mod = urlObj.protocol === 'https:' ? https : require('http');
        const req = mod.request({ hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': '1010' } }, () => resolve());
        req.on('error', resolve);
        req.write(body); req.end();
      });
      console.log(status === 'live' ? '✓ Live' : '✕ BANNED', '(HTTP ' + httpStatus + ')');

    } catch (err) {
      console.log('? Error - ' + err.message.substring(0, 50));
    }
    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();
  console.log('\n✓ Done. Dashboard updated with statuses.');
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
          const SIZES = ['S','M','L','XL','XXL'];
          const normalizeSize = (raw) => {
            if (!raw) return null;
            const t = String(raw).trim().toUpperCase();
            if (SIZES.includes(t)) return t;
            const m = t.match(/\b(XXL|XL|SMALL|MEDIUM|LARGE|\bS\b|\bM\b|\bL\b)\b/);
            if (!m) return null;
            return m[1].replace('SMALL','S').replace('MEDIUM','M').replace('LARGE','L');
          };

          const drawer = document.querySelector('aside[data-testid="simpleDrawer-visible"]') || document;

          // An order can contain multiple items (someone buys 2 packs).
          // Each item has its own <p data-testid="receipt-product-description">.
          // We find each one and look for the size nearby.
          const productEls = [...drawer.querySelectorAll('p[data-testid="receipt-product-description"]')];
          const items = [];

          for (const pEl of productEls) {
            const itemTitle = pEl.textContent?.trim() || 'Item';
            let size = null;

            // Walk up from the product title, scanning siblings/ancestors for a size.
            let walker = pEl.parentElement;
            let depth = 0;
            while (walker && walker !== drawer && depth < 6 && !size) {
              const ps = walker.querySelectorAll('p');
              for (const p of ps) {
                const candidate = normalizeSize(p.textContent);
                if (candidate) { size = candidate; break; }
              }
              walker = walker.parentElement;
              depth++;
            }

            // Fallback: try to pull from the item title itself
            if (!size) size = normalizeSize(itemTitle);

            items.push({ item: itemTitle, size: size || 'Unknown' });
          }

          // If we found 0 items via the specific selector, do the original
          // single-size fallback so old-style pages still work.
          if (!items.length) {
            let size = 'Unknown';
            const summaryEl = drawer.querySelector('div[class*="summary"]');
            if (summaryEl) {
              const boldPs = summaryEl.querySelectorAll('p[class*="bold"]');
              for (const p of boldPs) {
                const c = normalizeSize(p.textContent);
                if (c) { size = c; break; }
              }
            }
            if (size === 'Unknown') {
              for (const p of drawer.querySelectorAll('p')) {
                const c = normalizeSize(p.textContent);
                if (c) { size = c; break; }
              }
            }
            items.push({ item: 'Mystery Bundle', size });
          }

          // Decide the "grouping" size for this order:
          //   1 item  → that item's size (S/M/L/XL/XXL or Unknown)
          //   2+ items → '?' so the dashboard knows it's a multi-item order
          let groupSize, displayItem;
          if (items.length === 1) {
            groupSize = items[0].size;
            displayItem = items[0].item;
          } else {
            groupSize = '?';
            displayItem = `${items.length} items: ` + items.map(i => i.size).join(', ');
          }

          return { item: displayItem, size: groupSize, items };
        });

        allOrders.push({
          orderId: order.orderId,
          buyer: order.buyer,
          date: order.date,
          price: order.price,
          item: detail.item,
          size: detail.size,
          items: detail.items
        });
        if (detail.size === '?') {
          process.stdout.write(`? (${detail.items.length} items: ${detail.items.map(i => i.size).join(',')}) ✓\n`);
        } else {
          process.stdout.write(`${detail.size} ✓\n`);
        }
      } catch (e) {
        allOrders.push({ orderId: order.orderId, buyer: order.buyer, date: order.date, price: order.price, item: 'Mystery Bundle', size: 'Unknown', items: [] });
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

// ─── DOWNLOAD & MERGE SHIPPING LABELS ─────────────────────────
// Opens each order page, clicks "Download Label" (which pops to a
// Shippo-signed PDF URL), downloads the PDF, and merges them into one
// big PDF sorted by size. Output lands next to this file as
// labels-YYYY-MM-DD-{username}.pdf
async function runDownloadLabels() {
  const accounts = await apiGet('/api/accounts');
  console.log('\nSelect account to download labels from:');
  accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username} (${(a.orders||[]).length} orders)`));
  const choice = await ask('\nEnter account number: ');
  const account = accounts[parseInt(choice) - 1];
  if (!account) { console.log('Invalid.'); return; }

  const allOrders = account.orders || [];
  if (!allOrders.length) {
    console.log(`\nNo scraped orders for @${account.username}. Run option 4 first.`);
    return;
  }

  // Sort orders: S, M, L, XL, XXL, ?, Unknown
  const order = { 'S':0, 'M':1, 'L':2, 'XL':3, 'XXL':4, '?':5, 'Unknown':6 };
  const sorted = [...allOrders].sort((a, b) => {
    const oa = order[a.size] ?? 99;
    const ob = order[b.size] ?? 99;
    return oa - ob;
  });

  console.log(`\nWill fetch ${sorted.length} labels for @${account.username} in order:`);
  const breakdown = {};
  sorted.forEach(o => { breakdown[o.size] = (breakdown[o.size] || 0) + 1; });
  Object.entries(breakdown).forEach(([s, n]) => console.log(`  ${s}: ${n}`));

  // Fail fast with a clear message if pdf-lib isn't installed
  try { require('pdf-lib'); }
  catch {
    console.log('\n❌ pdf-lib is not installed. Run this first:');
    console.log('   npm install');
    console.log('Then retry this option.');
    return;
  }

  const go = await ask('\nContinue? (y/n): ');
  if (go.toLowerCase() !== 'y') { console.log('Cancelled.'); return; }

  // Prep tmp folder
  const tmpDir = path.join(__dirname, 'tmp', 'labels', account.username);
  fs.ensureDirSync(tmpDir);
  fs.emptyDirSync(tmpDir);

  // Replace Windows-illegal chars in the size (? in particular) for filenames
  const safeSize = s => s === '?' ? 'MULTI' : String(s || 'X').replace(/[^A-Z0-9]/gi, '_');

  console.log(`\nOpening browser for @${account.username}...`);
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({ acceptDownloads: true });

  if (account.cookies?.length) {
    const clean = account.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
      sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    }));
    await context.addCookies(clean);
  }

  const page = await context.newPage();
  const collected = []; // { order, pdfPath }

  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    const tag = `[${i+1}/${sorted.length}] ${o.size.padEnd(3)} ${o.orderId}`;
    process.stdout.write(`${tag} ... `);
    try {
      await page.goto(`https://www.depop.com/sellinghub/sold-items/${o.orderId}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Listen for the popup (Shippo PDF opens in new tab) BEFORE clicking
      const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);

      // Find and click the Download/Print Label button
      const clicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a')];
        for (const el of els) {
          const t = (el.innerText || '').toLowerCase().trim();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          if (/download.*label|print.*label|view.*label|^label$|dispatch|shipping.*label/i.test(t + ' ' + aria)) {
            // Prefer <a href> for direct URL extraction
            if (el.tagName === 'A' && el.href) {
              return { clicked: false, href: el.href };
            }
            el.click();
            return { clicked: true };
          }
        }
        return null;
      });

      if (!clicked) { process.stdout.write('no label button\n'); continue; }

      let pdfUrl = null;

      if (clicked.href && !clicked.clicked) {
        // Direct href — visit it (it'll redirect to the signed Shippo URL)
        const directPage = await context.newPage();
        await directPage.goto(clicked.href, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        pdfUrl = directPage.url();
        await directPage.close();
      } else {
        const popup = await popupPromise;
        if (!popup) { process.stdout.write('no popup\n'); continue; }
        await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        pdfUrl = popup.url();
        await popup.close().catch(() => {});
      }

      if (!pdfUrl || !pdfUrl.includes('.pdf')) {
        process.stdout.write(`no pdf url (got ${pdfUrl?.slice(0,60)})\n`);
        continue;
      }

      // Download the PDF using Node https (the URL is signed, no auth needed)
      const pdfBytes = await downloadUrlToBuffer(pdfUrl);
      const pdfPath = path.join(tmpDir, `${String(i+1).padStart(3,'0')}_${safeSize(o.size)}_${o.orderId}.pdf`);
      fs.writeFileSync(pdfPath, pdfBytes);
      collected.push({ order: o, pdfPath });
      process.stdout.write(`ok (${Math.round(pdfBytes.length/1024)}kb)\n`);
    } catch (e) {
      process.stdout.write(`error: ${e.message.slice(0,60)}\n`);
    }
    await page.waitForTimeout(600);
  }

  await browser.close();

  if (!collected.length) {
    console.log('\nNo labels were downloaded. Check that the button text matches what Depop shows.');
    return;
  }

  console.log(`\nMerging ${collected.length} labels into one PDF...`);
  const { PDFDocument } = require('pdf-lib');
  const merged = await PDFDocument.create();
  for (const { pdfPath } of collected) {
    try {
      const bytes = fs.readFileSync(pdfPath);
      const doc = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(pg => merged.addPage(pg));
    } catch (e) {
      console.log(`  skipped ${pdfPath}: ${e.message}`);
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const outPath = path.join(__dirname, `labels-${today}-${account.username}.pdf`);
  fs.writeFileSync(outPath, await merged.save());

  console.log(`\n✓ Done! Saved ${collected.length} labels to:`);
  console.log(`   ${outPath}`);
  console.log('\nOpen that PDF → Ctrl+P → pick your Polono printer → print.');
  console.log('Pages are sorted by size so you can pack in order as they come out.');
}

// Helper: download a URL to a Buffer (handles http + https + redirects)
function downloadUrlToBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    mod.get(url, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        return resolve(downloadUrlToBuffer(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
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
  // Send heartbeat to dashboard so it shows RUN.bat as active
  function sendRunHeartbeat() {
    const urlObj = new URL(DASHBOARD_URL + '/api/run/heartbeat');
    const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
    const req = mod.request({ hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2, 'x-api-key': '1010' } }, () => {});
    req.on('error', () => {});
    req.write('{}'); req.end();
  }
  sendRunHeartbeat();
  const _hbInterval = setInterval(sendRunHeartbeat, 30000);
  process.on('exit', () => clearInterval(_hbInterval));
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
  console.log('  5. Download & merge shipping labels (sorted by size)');
  const action = await ask('\nEnter choice (1/2/3/4/5): ');

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
  if (action === '5') {
    await runDownloadLabels();
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
