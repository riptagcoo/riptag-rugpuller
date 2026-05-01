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
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const opts = { hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'x-api-key': '1010' } };
    mod.get(opts, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        fs.remove(dest).then(() => downloadFile(res.headers.location, dest).then(resolve).catch(reject));
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.remove(dest).then(() => reject(new Error(`HTTP ${res.statusCode} for ${url}`)));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

// Download a full-resolution Drive file via the dashboard's proxy.
// This replaces the old "use photo.thumb" approach which gave us 200px
// thumbnails (blurry on Depop).
async function downloadDriveFile(driveId, dest) {
  const url = `${DASHBOARD_URL}/api/drive/file/${driveId}`;
  await downloadFile(url, dest);
  return dest;
}

// Build the ORDERED list of local photo paths for one listing.
// Cache is keyed by driveId so each unique photo downloads once even if
// it's reused across listings. Each listing keeps its own cover ordering.
async function getListingLocalPhotos(listing, tmpDir, cache) {
  fs.ensureDirSync(tmpDir);
  const out = [];
  for (let j = 0; j < (listing.photos || []).length; j++) {
    const p = listing.photos[j];
    if (!p || !p.driveId) continue;
    let localPath = cache[p.driveId];
    if (!localPath) {
      // Preserve extension when we can — Depop's HEIC handling is finicky
      const ext = (p.name && p.name.match(/\.([a-zA-Z0-9]+)$/)?.[1]) || 'jpg';
      localPath = path.join(tmpDir, `${p.driveId}.${ext.toLowerCase()}`);
      try {
        await downloadDriveFile(p.driveId, localPath);
        cache[p.driveId] = localPath;
      } catch (e) {
        console.log(`  ⚠ photo ${j+1} (${p.name}) download failed: ${e.message}`);
        continue;
      }
    }
    if (fs.existsSync(localPath)) out.push(localPath);
  }
  return out;
}

// Click a combobox input and select option by index (1-based).
// Uses a JS click on the option (instead of Playwright's elementHandle.click)
// because Depop's dropdown options sit below the viewport on a tall form —
// the auto-visibility wait was timing out at 30s even though the option
// existed. scrollIntoView + .click() inside page.evaluate skips that wait.
async function selectComboOption(page, inputId, optionIndex) {
  const input = await page.$(`#${inputId}`);
  if (!input) { console.log(`  → Input #${inputId} not found`); return false; }

  // Make sure the input itself is visible before opening it
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click();
  await page.waitForTimeout(600);

  const menuId = inputId.replace('-input', '-menu');
  await page.waitForSelector(`#${menuId}`, { timeout: 3000 }).catch(() => {});

  const result = await page.evaluate(({ menuId, idx }) => {
    const menu = document.getElementById(menuId);
    if (!menu) return { ok: false, count: 0, reason: 'no menu' };
    const options = menu.querySelectorAll('[role="option"]');
    if (!options.length) return { ok: false, count: 0, reason: 'no options' };
    if (!options[idx]) return { ok: false, count: options.length, reason: 'idx out of range' };
    options[idx].scrollIntoView({ block: 'center' });
    options[idx].click();
    return { ok: true, count: options.length, picked: (options[idx].innerText || '').trim().slice(0, 40) };
  }, { menuId, idx: optionIndex - 1 });

  console.log(`  → Found ${result.count} options in #${menuId}` + (result.picked ? ` · picked "${result.picked}"` : ''));
  if (result.ok) {
    await page.waitForTimeout(400);
    return true;
  }
  console.log(`  → option click failed: ${result.reason}`);
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
  // Belt + suspenders. Some forms use a real <input type="file">, others
  // (like the edit page) use drag-and-drop only. We do BOTH so it works
  // regardless of which form Depop shows.
  try {
    const existing = localPhotos.filter(p => fs.existsSync(p));
    if (existing.length) {
      // Strategy 1 — every visible file input on the page
      const inputs = await page.$$('input[type="file"]');
      console.log(`  → ${inputs.length} file input(s) on page`);
      for (const inp of inputs) {
        try { await inp.setInputFiles(existing); } catch {}
      }

      // Strategy 2 — drag-drop with real File objects onto any plausible
      // dropzone target. Same File/DataTransfer trick refreshOneListing uses.
      const mimeFor = (p) => {
        const ext = (p.split('.').pop() || '').toLowerCase();
        return ({
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
          heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif'
        })[ext] || 'application/octet-stream';
      };
      const filesData = existing.map(p => ({
        name: path.basename(p),
        mimeType: mimeFor(p),
        data: fs.readFileSync(p).toString('base64')
      }));
      const droppedOnto = await page.evaluate((filesData) => {
        const files = filesData.map(f => {
          const bin = atob(f.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new File([bytes], f.name, { type: f.mimeType });
        });
        const dt = new DataTransfer();
        files.forEach(f => dt.items.add(f));
        // Plausible drop targets on the create form
        const sels = [
          '[class*="dropzone"]',
          '[class*="photoUpload"]', '[class*="photo-upload"]',
          '[class*="dndContainer"]', '[class*="upload"]',
          '[data-testid*="photo"]', '[data-testid*="upload"]',
          'label[for*="photo"]', 'label[for*="upload"]'
        ];
        const targets = [...new Set(sels.flatMap(s => [...document.querySelectorAll(s)]))];
        let count = 0;
        for (const target of targets) {
          try {
            ['dragenter', 'dragover', 'drop'].forEach(type => {
              const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
              target.dispatchEvent(evt);
            });
            count++;
          } catch {}
        }
        return count;
      }, filesData).catch(() => 0);
      console.log(`  → drag-drop fired on ${droppedOnto} target(s)`);

      await page.waitForTimeout(3500);
      console.log(`  → ${existing.length} photos sent`);
    }
  } catch (e) { console.log('  → Photo error:', e.message); }

  // ── DESCRIPTION ──
  try {
    const textarea = await page.$('textarea');
    if (textarea) {
      await textarea.scrollIntoViewIfNeeded().catch(() => {});
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
      await brandInput.scrollIntoViewIfNeeded().catch(() => {});
      await brandInput.click({ clickCount: 3 });
      await brandInput.type('otherr', { delay: 80 });
      await page.waitForTimeout(800);
      // JS click for the same visibility-timeout reason selectComboOption uses
      const r = await page.evaluate(() => {
        const menu = document.getElementById('brand-menu');
        if (!menu) return { ok: false, count: 0 };
        const opts = menu.querySelectorAll('[role="option"]');
        if (!opts[0]) return { ok: false, count: opts.length };
        opts[0].scrollIntoView({ block: 'center' });
        opts[0].click();
        return { ok: true, count: opts.length };
      });
      console.log(`  → Brand: ${r.count} options found` + (r.ok ? ' · 1st selected' : ''));
      await page.waitForTimeout(400);
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
  // scrollIntoViewIfNeeded before each click — without it, inputs that
  // sit below the fold time out at the visibility check, the field never
  // gets filled, and Depop's submit silently fails validation.
  try {
    const qtyInput = await page.$('input[name*="uantity"], input[id*="uantity"], input[placeholder*="Qty"]');
    if (qtyInput) {
      await qtyInput.scrollIntoViewIfNeeded().catch(() => {});
      await qtyInput.click({ clickCount: 3 });
      await qtyInput.fill('100');
      await page.waitForTimeout(300);
      console.log('  → Quantity: 100');
    } else {
      const allInputs = await page.$$('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]');
      for (const inp of allInputs) {
        const id = await inp.getAttribute('id') || '';
        const name = await inp.getAttribute('name') || '';
        if (!id.includes('rice') && !name.includes('rice')) {
          await inp.scrollIntoViewIfNeeded().catch(() => {});
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
      await priceInput.scrollIntoViewIfNeeded().catch(() => {});
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
  // Simple 5s wait before posting so photos have time to finish uploading.
  console.log('  → waiting 5s for photos to finish uploading…');
  await page.waitForTimeout(5000);

  // Depop's create form has the Post/List button at the very bottom of a
  // tall form. Without explicitly scrolling, the button matches the
  // selector but isn't in the viewport, so Playwright's visibility check
  // hangs for 30s. Scroll first, then pick the LAST matching button (the
  // real submit, not some inline form button), and use a JS click as a
  // fallback for elements with overlay handlers that intercept pointers.
  await page.waitForTimeout(800);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);

  const submitClicked = await page.evaluate(() => {
    const labels = ['post listing', 'list it', 'list item', 'publish', 'post', 'list', 'next'];
    const candidates = [...document.querySelectorAll('button, [role="button"]')];
    // Filter to visible, enabled buttons whose text matches a submit label
    const matches = candidates.filter(el => {
      if (el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const t = (el.innerText || el.textContent || '').trim().toLowerCase();
      return labels.some(l => t === l || t.startsWith(l));
    });
    // Prefer the bottom-most one (real submit) over any inline buttons
    matches.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const target = matches[0] || document.querySelector('button[type="submit"]:not(:disabled)');
    if (!target) return null;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return (target.innerText || target.textContent || 'submit').trim();
  });

  if (submitClicked) {
    console.log('  → clicked submit: "' + submitClicked + '"');
    await page.waitForTimeout(5000);
    const newUrl = page.url();
    console.log('  → Submitted, URL:', newUrl);
    const successEl = await page.$('text=Nice');
    const listedEl = await page.$('text=listed');
    if (successEl || listedEl || !newUrl.includes('create')) {
      return true;
    }
    // Stayed on the create page → form validation failed. Pull any visible
    // error messages off the page so we know which field Depop rejected.
    const errors = await page.evaluate(() => {
      const out = [];
      const sels = [
        '[role="alert"]',
        '[class*="error"]:not(input):not(button)',
        '[class*="errorMessage"]',
        '[class*="fieldError"]',
        '[id$="-error"]',
        '[aria-invalid="true"]'
      ];
      for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t && t.length < 200 && !out.includes(t)) out.push(t);
        }
      }
      return out;
    }).catch(() => []);
    if (errors.length) {
      console.log('  → ⚠ form errors:');
      for (const e of errors.slice(0, 8)) console.log('     · ' + e);
    } else {
      console.log('  → ⚠ no visible error message — submit was rejected silently. Check the browser.');
    }
    try {
      const shotPath = `./tmp/submit-fail-${Date.now()}.png`;
      fs.ensureDirSync('./tmp');
      await page.screenshot({ path: shotPath, fullPage: true });
      console.log(`  → screenshot saved: ${shotPath}`);
    } catch {}
    return false;
  }

  console.log('  → No submit button found');
  return false;
}


// ─── MASS EDIT DESCRIPTIONS ──────────────────────────────────
// Uses the Selling Hub (same pattern as Quick Refresh) to harvest
// owner-only /products/edit/ URLs, then navigates directly to each
// edit page and replaces the description. Avoids the fragile public-
// profile → click-Edit dance and uses a React-aware native setter so
// the form actually persists the new value on save.
async function editDescriptionOnEditPage(page, editUrl, newDescription) {
  await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const filled = await page.evaluate((value) => {
    const textareas = [...document.querySelectorAll('textarea')];
    if (!textareas.length) return { ok: false, reason: 'no textarea on page' };

    let target = textareas.find(t => {
      const hay = [
        t.name, t.id, t.placeholder,
        t.getAttribute('aria-label') || '',
        (t.labels && t.labels[0] && t.labels[0].textContent) || ''
      ].join(' ').toLowerCase();
      return /descri/.test(hay);
    }) || textareas[0];

    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value');
    const setter = desc && desc.set;
    if (setter) setter.call(target, value);
    else target.value = value;

    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, newDescription);
  if (!filled.ok) throw new Error('fill failed: ' + filled.reason);

  await page.waitForTimeout(600);

  const saved = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')];
    for (const el of els) {
      const t = (el.innerText || '').trim().toLowerCase();
      if (/^(save changes|save|update|publish|update listing|save listing)$/i.test(t) && !el.disabled) {
        el.click(); return true;
      }
    }
    const submit = document.querySelector('button[type="submit"]:not(:disabled)');
    if (submit) { submit.click(); return true; }
    return false;
  });
  if (!saved) throw new Error('no save button');
  await page.waitForTimeout(3500);
}

async function massEditDescriptions(set, newDescription) {
  const accounts = await apiGet('/api/accounts');
  const account = accounts.find(a => a.id === set.accountId);
  if (!account) { console.log('No account found for this set.'); return; }
  if (!account.cookies?.length) {
    console.log('Account has no cookies — reconnect via the Chrome extension.');
    return;
  }
  if (!newDescription || !newDescription.trim()) {
    console.log('No description supplied — nothing to do.');
    return;
  }

  console.log('\n══════════════════════════════════════════');
  console.log(` MASS EDIT DESCRIPTIONS — @${account.username}`);
  console.log('══════════════════════════════════════════');
  console.log(` New description (${newDescription.length} chars):`);
  console.log(` ${newDescription.slice(0, 140)}${newDescription.length > 140 ? '…' : ''}`);
  console.log('══════════════════════════════════════════');

  console.log(`\nOpening browser for @${account.username}...`);
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const clean = account.cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }));
  await context.addCookies(clean);
  const page = await context.newPage();

  try {
    const hubUrl = 'https://www.depop.com/sellinghub/selling/active/';
    console.log(`\nStep 1: loading ${hubUrl} ...`);
    const resp = await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

    const status = resp ? resp.status() : 0;
    const title = await page.title().catch(() => '');
    console.log(`   status ${status} · title "${title.slice(0, 60)}"`);
    if (status === 404 || /not found|page not found|404/i.test(title)) {
      console.log('\n❌ Selling Hub returned 404. Cookies may be expired — reconnect via the');
      console.log('   Chrome extension and try again.');
      await ask('\nPress ENTER to close browser...');
      return;
    }

    // Selling Hub paginates with a "Load more" button — scrolling alone
    // won't reveal listings past the first batch. Click Load More whenever
    // it's visible, scroll as a fallback for IntersectionObserver loaders,
    // and stop only once the edit-link count stays flat AND no button
    // remains.
    let prev = 0, same = 0;
    for (let i = 0; i < 120 && same < 3; i++) {
      const clicked = await page.evaluate(() => {
        const els = [...document.querySelectorAll('button, a, [role="button"]')];
        for (const el of els) {
          const t = (el.innerText || el.textContent || '').trim().toLowerCase();
          if (/^(load more|load more items|show more|see more|load next)$/i.test(t) && !el.disabled) {
            el.scrollIntoView({ block: 'center' });
            el.click();
            return true;
          }
        }
        return false;
      }).catch(() => false);
      if (clicked) await page.waitForTimeout(1800);

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);

      const c = await page.$$eval('a[href*="/products/edit/"]', as => as.length).catch(() => 0);
      if (c === prev && !clicked) same++;
      else { same = 0; prev = c; }
    }
    console.log(`   loaded ${prev} listings`);

    const editUrls = await page.$$eval('a[href*="/products/edit/"]', as => {
      const hrefs = as.map(a => a.getAttribute('href') || a.href || '').filter(Boolean);
      const cleaned = hrefs.map(h => {
        const abs = h.startsWith('http') ? h : 'https://www.depop.com' + h;
        try {
          const u = new URL(abs);
          return u.origin + u.pathname.replace(/\/$/, '') + '/';
        } catch { return abs; }
      });
      return [...new Set(cleaned)];
    }).catch(() => []);

    console.log(`\nFound ${editUrls.length} edit URLs on the Selling Hub.`);
    if (!editUrls.length) {
      console.log('No edit links visible. Possible causes:');
      console.log('  · Cookies expired (reconnect via the Chrome extension)');
      console.log('  · Account has no active listings');
      console.log('  · Depop changed the markup');
      await ask('\nPress ENTER to close browser...');
      return;
    }

    console.log(`\n▶ TEST: updating description on 1 listing first`);
    console.log(`   ${editUrls[0]}`);
    let ok = 0;
    try {
      await editDescriptionOnEditPage(page, editUrls[0], newDescription);
      console.log('   ✓ TEST PASSED');
      ok++;
    } catch (e) {
      console.log(`   ✗ TEST FAILED: ${e.message}`);
      console.log('   Check the browser window to see what went wrong.');
      await ask('\nPress ENTER to close browser...');
      return;
    }

    if (editUrls.length > 1) {
      const doAll = await ask(`\nTest passed. Update remaining ${editUrls.length - 1} listings? (y/n): `);
      if (doAll.toLowerCase() === 'y') {
        for (let i = 1; i < editUrls.length; i++) {
          const short = editUrls[i].split('/').slice(-2).join('/');
          process.stdout.write(`[${i+1}/${editUrls.length}] ${short} ... `);
          try {
            await editDescriptionOnEditPage(page, editUrls[i], newDescription);
            ok++;
            process.stdout.write('✓\n');
          } catch (e) {
            process.stdout.write(`✗ ${e.message.slice(0, 60)}\n`);
          }
          await page.waitForTimeout(jitter(1500, 3500));
        }
      }
    }

    console.log(`\n✅ Mass edit complete — updated ${ok}/${editUrls.length} descriptions on @${account.username}`);
  } finally {
    await browser.close();
  }
}

async function runMassEdit() {
  const sets = await apiGet('/api/sets');
  const accounts = await apiGet('/api/accounts');

  let templates = [];
  try {
    const raw = await apiGet('/api/description-templates');
    if (Array.isArray(raw)) {
      templates = raw;
    } else {
      console.log('⚠ Templates endpoint returned non-array:', JSON.stringify(raw).slice(0, 200));
    }
  } catch (e) {
    console.log('⚠ Could not load templates from dashboard:', e.message);
    console.log('  Make sure the Railway deploy has completed with the latest server.js.');
  }
  console.log(`(loaded ${templates.length} template(s) from dashboard)`);

  console.log('\nSelect account to mass edit:');
  accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username}${a.status ? ' ('+a.status+')' : ''}`));

  const acctChoice = await ask('\nEnter account number: ');
  const account = accounts[parseInt(acctChoice) - 1];
  if (!account) { console.log('Invalid.'); return; }

  const set = sets.find(s => s.accountId === account.id) || { accountId: account.id };

  console.log('\nPick a description to deploy:');
  if (Array.isArray(templates) && templates.length) {
    templates.forEach((t, i) => {
      const preview = (t.body || '').replace(/\s+/g, ' ').slice(0, 70);
      console.log(`  ${i+1}. ${t.name} — ${preview}${(t.body || '').length > 70 ? '…' : ''}`);
    });
  } else {
    console.log('  (no templates yet — add them in the dashboard → Descriptions)');
  }
  if (set.evergreenDescription) console.log('  E. Use this set\'s evergreen description');
  console.log('  C. Type a custom description');

  const pick = (await ask('\nChoice: ')).trim();
  let description = null;

  if (pick.toLowerCase() === 'e') {
    if (!set.evergreenDescription) { console.log('No evergreen description on this account\'s set.'); return; }
    description = set.evergreenDescription;
  } else if (pick.toLowerCase() === 'c') {
    description = (await ask('\nType description (one line):\n> ')).trim();
    if (!description) { console.log('Empty. Cancelled.'); return; }
  } else {
    const idx = parseInt(pick) - 1;
    const t = templates[idx];
    if (!t) { console.log('Invalid choice.'); return; }
    description = t.body;
    console.log(`\nUsing template: "${t.name}"`);
  }

  await massEditDescriptions({ ...set, accountId: account.id }, description);
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

// ─── PHOTO REFRESH ────────────────────────────────────────────
// For each posted listing in a set, opens its Depop edit page,
// removes the existing photos, and uploads fresh full-res ones.
// Description, price, size, etc. are NOT touched. Likes/views/follows
// stay intact because we're editing the same listing, not re-creating.

// Refresh one listing. Returns true on success.
// `listing.depopUrl` may be EITHER a public product URL (legacy) or an
// edit URL (/products/edit/{slug}/). If public, we click Edit to navigate;
// if it's already an edit URL, we skip that step.
async function refreshOneListing(page, listing, localPhotos) {
  await page.goto(listing.depopUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const onEditPage = /\/products\/edit\//.test(page.url());
  if (!onEditPage) {
    // Click the Edit button on the public listing page (owner only sees this)
    const editClicked = await page.evaluate(() => {
      const els = [...document.querySelectorAll('button, a')];
      for (const el of els) {
        const t = (el.innerText || '').trim().toLowerCase();
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (/^edit$/.test(t) || /^edit listing$/i.test(t) || /^edit$/.test(aria)) {
          el.click(); return true;
        }
      }
      return false;
    });
    if (!editClicked) throw new Error('no edit button');
    await page.waitForTimeout(3500);
  }

  // Depop's edit form uses CSS-module class names:
  //   .styles_dndContainer__xxx  = photo tile (drag-drop container)
  //   .styles_delete__xxx        = delete button on each tile
  //   NO <input type="file"> — uploads go through drag-and-drop only.
  //
  // The dndContainer only exists when at least one photo is present — so
  // we DROP new photos first (using an existing tile's parent as anchor),
  // then delete the old ones. Order matters here; if we delete first, the
  // dropzone selector disappears.
  if (!localPhotos.length) throw new Error('no local photos to upload');

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1000);

  const mimeFor = (p) => {
    const ext = (p.split('.').pop() || '').toLowerCase();
    return ({
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      heic: 'image/heic', heif: 'image/heif', webp: 'image/webp', gif: 'image/gif'
    })[ext] || 'application/octet-stream';
  };
  const filesData = localPhotos.map(p => ({
    name: path.basename(p),
    mimeType: mimeFor(p),
    data: fs.readFileSync(p).toString('base64')
  }));

  // Step A: count existing tiles BEFORE the drop so we know how many to
  // delete after.
  const tilesBefore = await page.evaluate(() =>
    document.querySelectorAll('[class*="dndContainer"]').length
  );

  // Step B: Drop new photos onto the tile container (its parent is the
  // dropzone). Dispatches dragenter/dragover/drop with real File objects.
  const dropResult = await page.evaluate(async (filesData) => {
    const firstTile = document.querySelector('[class*="dndContainer"]');
    if (!firstTile) return { ok: false, reason: 'no photo tiles to anchor the drop' };
    const dropTarget = firstTile.parentElement || firstTile;

    const files = filesData.map(f => {
      const binary = atob(f.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], f.name, { type: f.mimeType });
    });

    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);

    // Fire events on both the dropTarget (container) and firstTile in case
    // the handler is attached to one specifically.
    const fire = (target, type) => {
      const evt = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(evt);
    };
    for (const target of [dropTarget, firstTile]) {
      fire(target, 'dragenter');
      fire(target, 'dragover');
      fire(target, 'drop');
    }
    return { ok: true, dropTargetClass: (dropTarget.className || '').slice(0, 100) };
  }, filesData);

  if (!dropResult.ok) {
    throw new Error('drop-simulate failed: ' + dropResult.reason);
  }

  // Wait for Depop to render the new tiles (upload + thumbnail processing).
  await page.waitForTimeout(8000);

  // Step C: verify that new tiles actually appeared.
  const tilesAfter = await page.evaluate(() =>
    document.querySelectorAll('[class*="dndContainer"]').length
  );

  if (tilesAfter <= tilesBefore) {
    throw new Error(`drop didn\'t add photos (${tilesBefore} before, ${tilesAfter} after — Depop may not have accepted the drop)`);
  }

  // Step D: delete the OLD tiles. We delete `tilesBefore` tiles from the
  // start of the list — assumes old photos are first, new are appended.
  let removed = 0;
  for (let i = 0; i < tilesBefore; i++) {
    const removedThis = await page.evaluate(() => {
      const deleteBtn = document.querySelector('button[class*="styles_delete"]');
      if (!deleteBtn) return false;
      deleteBtn.click();
      return true;
    });
    if (!removedThis) break;
    removed++;
    await page.waitForTimeout(700);
  }

  // Click Save. The recon showed <button type="submit">Save changes</button>
  const saved = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, [role="button"]')];
    for (const el of els) {
      const t = (el.innerText || '').trim().toLowerCase();
      if (/^(save changes|save|update|publish|update listing|save listing)$/i.test(t) && !el.disabled) {
        el.click(); return true;
      }
    }
    // Fallback: click any submit button
    const submit = document.querySelector('button[type="submit"]:not(:disabled)');
    if (submit) { submit.click(); return true; }
    return false;
  });
  if (!saved) throw new Error('no save button');
  await page.waitForTimeout(4000);
  return { removed };
}

// For posted listings without depopUrl, scan the seller's shop page
// and try to match each product to a DB listing by size. Safe for
// single-group sets; warns the user for multi-group ones.
async function backfillDepopUrls(set, account, page) {
  const posted = (set.listings || []).filter(l => l.posted);
  const needsUrl = posted.filter(l => !l.depopUrl);
  if (!needsUrl.length) return { alreadyHave: posted.length, backfilled: 0 };

  const sizeCounts = {};
  for (const l of needsUrl) sizeCounts[l.size] = (sizeCounts[l.size] || 0) + 1;
  const ambiguousSizes = Object.entries(sizeCounts).filter(([,n]) => n > 1).map(([s]) => s);

  if (ambiguousSizes.length) {
    console.log(`\n⚠ This set has multiple listings per size (sizes: ${ambiguousSizes.join(', ')}).`);
    console.log('  Back-fill matches by size, so we can\'t tell which specific listing is which.');
    console.log('  If you proceed, some listings may get the wrong photos swapped in.');
    const go = await ask('  Proceed anyway? (y/n): ');
    if (go.toLowerCase() !== 'y') return { abort: true };
  }

  console.log(`\nScanning @${account.username}'s shop page for ${needsUrl.length} listings...`);
  await page.goto(`https://www.depop.com/${account.username}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Infinite-scroll until all products load
  let prev = 0, same = 0;
  for (let i = 0; i < 30 && same < 3; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);
    const c = await page.$$eval('a[href*="/products/"]', as => as.length).catch(() => 0);
    if (c === prev) same++; else { same = 0; prev = c; }
  }

  const productUrls = await page.$$eval('a[href*="/products/"]', as =>
    [...new Set(as.map(a => a.href).filter(h => /\/products\/[^/]+\/[^/?#]+/.test(h)))]
  ).catch(() => []);
  console.log(`  found ${productUrls.length} listings on the shop page`);

  const remaining = new Map(needsUrl.map(l => [l.id, l]));
  let backfilled = 0;

  for (const url of productUrls) {
    if (!remaining.size) break;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);

      // Extract size from the product page
      const size = await page.evaluate(() => {
        const SIZES = ['S','M','L','XL','XXL'];
        const candidates = [...document.querySelectorAll('p, span, div, li, button')];
        for (const el of candidates) {
          const t = (el.textContent || '').trim().toUpperCase();
          if (SIZES.includes(t)) return t;
        }
        return null;
      });
      if (!size) continue;

      // Grab the first unmatched DB listing with this size
      let match = null;
      for (const l of remaining.values()) {
        if (l.size === size) { match = l; break; }
      }
      if (!match) continue;

      await apiPut(`/api/sets/${set.id}/listings/${match.id}`, { depopUrl: url });
      match.depopUrl = url;
      remaining.delete(match.id);
      backfilled++;
      process.stdout.write(`  ✓ ${size} → ${url.split('/').slice(-2).join('/')}\n`);
    } catch { /* keep going */ }
  }

  console.log(`\nBack-fill complete. Matched ${backfilled}/${needsUrl.length} listings.`);
  if (remaining.size) {
    console.log(`  ${remaining.size} listings could not be matched. They'll be skipped in refresh.`);
  }
  return { alreadyHave: posted.length - needsUrl.length, backfilled };
}

async function runRefreshPhotos() {
  const sets = await apiGet('/api/sets');
  if (!sets.length) { console.log('No sets.'); return; }
  console.log('\nPick a set to refresh photos on:');
  sets.forEach((s, i) => {
    const posted = (s.listings || []).filter(l => l.posted).length;
    const withUrl = (s.listings || []).filter(l => l.posted && l.depopUrl).length;
    console.log(`  ${i+1}. ${s.name} — ${posted} posted (${withUrl} with URLs saved)`);
  });
  const choice = await ask('\nSet number: ');
  const set = sets[parseInt(choice) - 1];
  if (!set) { console.log('Invalid.'); return; }

  const accounts = await apiGet('/api/accounts');
  const account = accounts.find(a => a.id === set.accountId);
  if (!account || !account.cookies?.length) {
    console.log('Account for this set is missing or has no cookies.');
    return;
  }

  // Launch browser once — reuse for backfill + refresh
  console.log(`\nOpening browser for @${account.username}...`);
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

  try {
    // If any posted listings don't have a URL saved, offer to back-fill from the shop page
    const postedNoUrl = (set.listings || []).filter(l => l.posted && !l.depopUrl).length;
    if (postedNoUrl) {
      console.log(`\n${postedNoUrl} posted listings don't have saved Depop URLs.`);
      const doFill = await ask('Scan the shop page to find them? (y/n): ');
      if (doFill.toLowerCase() === 'y') {
        const res = await backfillDepopUrls(set, account, page);
        if (res.abort) { console.log('Aborted.'); await browser.close(); return; }
        // Refresh the set from DB now that URLs are saved
        const freshSets = await apiGet('/api/sets');
        const fresh = freshSets.find(s => s.id === set.id);
        if (fresh) set.listings = fresh.listings;
      }
    }

    const targets = (set.listings || []).filter(l => l.posted && l.depopUrl);
    if (!targets.length) {
      console.log('\nNo listings have a saved Depop URL. Either redeploy them via option 1,');
      console.log('or re-run this and say yes to the shop-page scan.');
      await browser.close();
      return;
    }

    const tmpDir = path.join(__dirname, 'tmp', 'refresh', set.id);
    fs.ensureDirSync(tmpDir);
    fs.emptyDirSync(tmpDir);
    const photoCache = {};

    // TEST on listing 1, ask to continue, then batch the rest
    const testListing = targets[0];
    console.log(`\n▶ TEST: refreshing 1 listing first (size ${testListing.size})...`);
    const testLocal = await getListingLocalPhotos(testListing, tmpDir, photoCache);
    for (const lp of testLocal) {
      try { console.log(`  · ${path.basename(lp)} — ${Math.round(fs.statSync(lp).size / 1024)} KB`); } catch {}
    }

    let ok = 0;
    try {
      const res = await refreshOneListing(page, testListing, testLocal);
      console.log(`\n  ✓ TEST PASSED (removed ${res.removed} old photos, uploaded ${testLocal.length} new)`);
      ok++;
    } catch (e) {
      console.log(`\n  ✗ TEST FAILED: ${e.message}`);
      console.log('  Check the browser window to see what went wrong.');
      await ask('\nPress ENTER to close browser...');
      await browser.close();
      return;
    }

    if (targets.length > 1) {
      const doAll = await ask(`\nTest passed. Refresh remaining ${targets.length - 1} listings? (y/n): `);
      if (doAll.toLowerCase() === 'y') {
        for (let i = 1; i < targets.length; i++) {
          const listing = targets[i];
          process.stdout.write(`[${i+1}/${targets.length}] ${listing.size} ... `);
          try {
            const local = await getListingLocalPhotos(listing, tmpDir, photoCache);
            await refreshOneListing(page, listing, local);
            ok++;
            process.stdout.write('✓\n');
          } catch (e) {
            process.stdout.write(`✗ ${e.message.slice(0, 60)}\n`);
          }
          await page.waitForTimeout(jitter(1500, 3500));
        }
      }
    }

    console.log(`\n✅ Refreshed ${ok}/${targets.length} listings`);
    await fs.remove(tmpDir).catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
}

// jitter is used in a few places — define once for runRefreshPhotos
function jitter(min, max) { return min + Math.floor(Math.random() * (max - min)); }

// ─── QUICK REFRESH (aka YOLO refresh) ─────────────────────────
// Scans the seller's shop page and replaces the photos on EVERY
// listing it finds with 4 random full-res photos drawn from the
// pool of a chosen set. Does NOT try to match listing → photo by
// size. Use when you just want to kill the blurry photos in one
// shot and don't care that the "size M" listing might end up with
// any of the photos from the set. Preserves likes/views/saves
// because we edit existing listings — we don't re-list.
// Non-interactive Quick Refresh — same flow as runQuickRefresh, no
// confirmations. Takes a photo-pool set + a target account. Used by the
// dashboard command queue.
async function quickRefreshSet(photoSet, account) {
  if (!account || !account.cookies?.length) {
    return { ok: false, message: 'Account missing or no cookies' };
  }
  const allPhotos = [];
  const seen = new Set();
  for (const l of (photoSet.listings || [])) {
    for (const p of (l.photos || [])) {
      if (p && p.driveId && !seen.has(p.driveId)) {
        seen.add(p.driveId);
        allPhotos.push(p);
      }
    }
  }
  if (!allPhotos.length) return { ok: false, message: 'Set has no photos' };

  const tmpDir = path.join(__dirname, 'tmp', 'quickrefresh', photoSet.id);
  fs.ensureDirSync(tmpDir);
  fs.emptyDirSync(tmpDir);
  const photoCache = {};

  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const clean = account.cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }));
  await context.addCookies(clean);
  const page = await context.newPage();

  try {
    const hubUrl = 'https://www.depop.com/sellinghub/selling/active/';
    const resp = await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);
    if ((resp ? resp.status() : 0) === 404) {
      return { ok: false, message: 'Selling Hub 404 — cookies likely expired' };
    }
    let prev = 0, same = 0;
    for (let i = 0; i < 60 && same < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
      const c = await page.$$eval('a[href*="/products/edit/"]', as => as.length).catch(() => 0);
      if (c === prev) same++; else { same = 0; prev = c; }
    }
    const editUrls = await page.$$eval('a[href*="/products/edit/"]', as => {
      const hrefs = as.map(a => a.getAttribute('href') || a.href || '').filter(Boolean);
      const cleaned = hrefs.map(h => {
        const abs = h.startsWith('http') ? h : 'https://www.depop.com' + h;
        try { const u = new URL(abs); return u.origin + u.pathname.replace(/\/$/, '') + '/'; }
        catch { return abs; }
      });
      return [...new Set(cleaned)];
    }).catch(() => []);
    if (!editUrls.length) return { ok: false, message: 'No edit URLs on Selling Hub' };

    const makeRandomListing = (url) => {
      const shuffled = [...allPhotos].sort(() => Math.random() - 0.5);
      return { id: 'quick-' + Math.random().toString(36).slice(2, 8), size: '?', depopUrl: url, photos: shuffled.slice(0, 4) };
    };

    let ok = 0;
    for (let i = 0; i < editUrls.length; i++) {
      const url = editUrls[i];
      const listing = makeRandomListing(url);
      try {
        const local = await getListingLocalPhotos(listing, tmpDir, photoCache);
        await refreshOneListing(page, listing, local);
        ok++;
      } catch (e) {
        console.log(`  ✗ ${url.split('/').slice(-2).join('/')}: ${e.message.slice(0, 60)}`);
      }
      await page.waitForTimeout(jitter(1500, 3500));
    }
    return { ok: true, message: `Refreshed ${ok}/${editUrls.length} listings on @${account.username}` };
  } finally {
    await browser.close().catch(() => {});
    await fs.remove(tmpDir).catch(() => {});
  }
}

async function runQuickRefresh() {
  const sets = await apiGet('/api/sets');
  if (!sets.length) { console.log('No sets.'); return; }
  console.log('\nPick a set to pull photos from (the "photo pool"):');
  sets.forEach((s, i) => {
    const photoCount = (s.listings || []).reduce((a, l) => a + (l.photos?.length || 0), 0);
    console.log(`  ${i+1}. ${s.name} — ${(s.listings||[]).length} listings, ${photoCount} photos in pool`);
  });
  const choice = await ask('\nSet number: ');
  const set = sets[parseInt(choice) - 1];
  if (!set) { console.log('Invalid.'); return; }

  // Pool: every UNIQUE photo across all listings in the set
  const allPhotos = [];
  const seen = new Set();
  for (const l of (set.listings || [])) {
    for (const p of (l.photos || [])) {
      if (p && p.driveId && !seen.has(p.driveId)) {
        seen.add(p.driveId);
        allPhotos.push(p);
      }
    }
  }
  if (!allPhotos.length) {
    console.log('This set has no photos. Build listings first (via the dashboard), then retry.');
    return;
  }
  console.log(`\nPhoto pool: ${allPhotos.length} unique photos from set "${set.name}"`);

  // Which account's shop to refresh (default to the set's account, but allow override)
  const accounts = await apiGet('/api/accounts');
  let account = accounts.find(a => a.id === set.accountId);
  if (!account) {
    console.log('\nSet has no assigned account. Pick an account:');
    accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username}`));
    const ac = await ask('\nAccount number: ');
    account = accounts[parseInt(ac) - 1];
  } else {
    const useThis = await ask(`Target shop: @${account.username}. Use this account? (y/n): `);
    if (useThis.toLowerCase() !== 'y') {
      console.log('\nPick an account:');
      accounts.forEach((a, i) => console.log(`  ${i+1}. @${a.username}`));
      const ac = await ask('\nAccount number: ');
      account = accounts[parseInt(ac) - 1];
    }
  }
  if (!account || !account.cookies?.length) {
    console.log('Account missing or has no cookies.');
    return;
  }

  const shopUrl = `https://www.depop.com/${account.username}/`;
  console.log('\n══════════════════════════════════════════');
  console.log(` QUICK REFRESH — @${account.username}`);
  console.log('══════════════════════════════════════════');
  console.log(` Target shop URL: ${shopUrl}`);
  console.log('');
  console.log(' !! IMPORTANT !! Open this URL in a browser BEFORE continuing.');
  console.log(' Make sure it\'s YOUR shop (listings you recognize, logged-in view).');
  console.log(' If this takes you to a stranger\'s shop, your account\'s username in');
  console.log(' the dashboard is wrong — cancel and fix it under the Accounts tab.');
  console.log('');
  console.log(' What this does:');
  console.log('   1. Opens each listing on that shop');
  console.log('   2. Clicks Edit');
  console.log('   3. Removes the existing (blurry) photos');
  console.log('   4. Uploads 4 RANDOM full-res photos from the set\'s pool');
  console.log('   5. Saves');
  console.log(' Description, price, size are NOT touched.');
  console.log(' Likes/views/saves stay because we\'re editing, not re-listing.');
  console.log(' Photos go on listings randomly — size M listing may get any photo.');
  console.log('══════════════════════════════════════════');

  const confirmShop = await ask(`\nType the username shown on your actual Depop shop (without the @) to confirm: `);
  if (confirmShop.trim().replace(/^@/, '').toLowerCase() !== account.username.toLowerCase()) {
    console.log(`\n❌ Mismatch. You typed "${confirmShop}" but dashboard has "${account.username}".`);
    console.log('   If "' + account.username + '" is not your actual Depop shop, cancel and fix the');
    console.log('   username under the Accounts tab in the dashboard.');
    return;
  }

  const go = await ask('\nContinue? (y/n): ');
  if (go.toLowerCase() !== 'y') { console.log('Cancelled.'); return; }

  const tmpDir = path.join(__dirname, 'tmp', 'quickrefresh', set.id);
  fs.ensureDirSync(tmpDir);
  fs.emptyDirSync(tmpDir);
  const photoCache = {};

  console.log(`\nOpening browser for @${account.username}...`);
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext();
  const clean = account.cookies.map(c => ({
    name: c.name, value: c.value, domain: c.domain,
    path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
    sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
  }));
  await context.addCookies(clean);
  const page = await context.newPage();

  try {
    // Owner view — listings with edit buttons are on the Selling Hub's
    // Active listings page. This avoids 404s from the public profile.
    const hubUrl = 'https://www.depop.com/sellinghub/selling/active/';
    console.log(`\nStep 1: loading ${hubUrl} ...`);
    const resp = await page.goto(hubUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

    const status = resp ? resp.status() : 0;
    const title = await page.title().catch(() => '');
    console.log(`   status ${status} · title "${title.slice(0, 60)}"`);
    if (status === 404 || /not found|page not found|404/i.test(title)) {
      console.log('\n❌ Selling Hub returned 404. Cookies may be expired — reconnect via the');
      console.log('   Chrome extension and try again.');
      await ask('\nPress ENTER to close browser...');
      await browser.close();
      return;
    }

    // Scroll to lazy-load all rows. The hub uses class "listingRow" based
    // on the DOM recon; count edit-anchor hrefs instead (more reliable).
    let prev = 0, same = 0;
    for (let i = 0; i < 60 && same < 3; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200);
      const c = await page.$$eval('a[href*="/products/edit/"]', as => as.length).catch(() => 0);
      if (c === prev) same++; else { same = 0; prev = c; }
    }

    // Harvest edit URLs directly from the hub page (anchors like
    // /products/edit/{slug}/?redirect=/sellinghub/selling/active/)
    const editUrls = await page.$$eval('a[href*="/products/edit/"]', as => {
      const hrefs = as.map(a => a.getAttribute('href') || a.href || '').filter(Boolean);
      // Strip the ?redirect= query so we just get /products/edit/{slug}/
      const clean = hrefs.map(h => {
        const abs = h.startsWith('http') ? h : 'https://www.depop.com' + h;
        try {
          const u = new URL(abs);
          return u.origin + u.pathname.replace(/\/$/, '') + '/';
        } catch { return abs; }
      });
      return [...new Set(clean)];
    }).catch(() => []);

    console.log(`\nFound ${editUrls.length} edit URLs on the Selling Hub.`);
    if (!editUrls.length) {
      console.log('The hub loaded but no edit links were visible. Possible causes:');
      console.log('  · Cookies expired (reconnect via the Chrome extension)');
      console.log('  · Account has no active listings');
      console.log('  · Depop changed the markup (send me a fresh DOM recon)');
      await ask('\nPress ENTER to close browser...');
      await browser.close();
      return;
    }

    // Use the edit URLs as our "product URLs" — the refresh flow will
    // navigate straight to them.
    const productUrls = editUrls;

    // Build a "synthetic listing" with 4 random photos for a given URL
    const makeRandomListing = (url) => {
      const shuffled = [...allPhotos].sort(() => Math.random() - 0.5);
      return { id: 'quick-' + Math.random().toString(36).slice(2, 8), size: '?', depopUrl: url, photos: shuffled.slice(0, 4) };
    };

    // ── TEST on listing 1 first ──
    const testUrl = productUrls[0];
    const testListing = makeRandomListing(testUrl);
    console.log(`\n▶ TEST: refreshing 1 listing first`);
    console.log(`   ${testUrl}`);
    const testLocal = await getListingLocalPhotos(testListing, tmpDir, photoCache);
    for (const lp of testLocal) {
      try { console.log(`   · ${path.basename(lp)} — ${Math.round(fs.statSync(lp).size / 1024)} KB`); } catch {}
    }

    let ok = 0;
    try {
      const res = await refreshOneListing(page, testListing, testLocal);
      console.log(`\n   ✓ TEST PASSED (removed ${res.removed} old, uploaded ${testLocal.length} new)`);
      ok++;
    } catch (e) {
      console.log(`\n   ✗ TEST FAILED: ${e.message}`);
      console.log('   Check the browser window to see what went wrong.');
      await ask('\nPress ENTER to close browser...');
      await browser.close();
      return;
    }

    if (productUrls.length > 1) {
      const doAll = await ask(`\nTest passed. Refresh remaining ${productUrls.length - 1} listings? (y/n): `);
      if (doAll.toLowerCase() === 'y') {
        for (let i = 1; i < productUrls.length; i++) {
          const url = productUrls[i];
          const listing = makeRandomListing(url);
          const short = url.split('/').slice(-2).join('/');
          process.stdout.write(`[${i+1}/${productUrls.length}] ${short} ... `);
          try {
            const local = await getListingLocalPhotos(listing, tmpDir, photoCache);
            await refreshOneListing(page, listing, local);
            ok++;
            process.stdout.write('✓\n');
          } catch (e) {
            process.stdout.write(`✗ ${e.message.slice(0, 60)}\n`);
          }
          await page.waitForTimeout(jitter(1500, 3500));
        }
      }
    }

    console.log(`\n✅ Quick-refreshed ${ok}/${productUrls.length} listings on @${account.username}`);
  } finally {
    await browser.close().catch(() => {});
    await fs.remove(tmpDir).catch(() => {});
  }
}

// ─── PHOTO RESOLUTION TEST ────────────────────────────────────
// Downloads one photo via the new full-res endpoint and reports the
// file size. If you see something tiny (< 30 KB) the blur fix isn't
// active. Real full-res photos from a phone are usually 500 KB - 5 MB.
async function runPhotoResolutionTest() {
  const sets = await apiGet('/api/sets');
  if (!sets.length) { console.log('No sets to test.'); return; }
  console.log('\nPick a set to test:');
  sets.forEach((s, i) => console.log(`  ${i+1}. ${s.name} (${(s.listings||[]).length} listings)`));
  const choice = await ask('\nSet number: ');
  const set = sets[parseInt(choice) - 1];
  if (!set || !(set.listings || []).length) { console.log('Invalid.'); return; }

  const listing = set.listings[0];
  if (!listing.photos?.length) { console.log('First listing has no photos.'); return; }

  const photo = listing.photos[0];
  console.log(`\nTesting download of: ${photo.name}  (driveId: ${photo.driveId})`);
  console.log(`Old (blurry) URL would be: ${photo.thumb || '(none)'}`);
  console.log(`New (full-res) URL:        ${DASHBOARD_URL}/api/drive/file/${photo.driveId}\n`);

  const tmpDir = path.join(__dirname, 'tmp', 'res-test');
  fs.ensureDirSync(tmpDir);
  fs.emptyDirSync(tmpDir);

  // Old way (thumbnail) — for comparison
  if (photo.thumb) {
    const oldPath = path.join(tmpDir, 'OLD-thumb.jpg');
    try {
      await downloadFile(photo.thumb, oldPath);
      const oldKb = Math.round(fs.statSync(oldPath).size / 1024);
      console.log(`OLD (thumbnail):  ${oldKb} KB  →  ${oldPath}`);
    } catch (e) { console.log(`OLD thumbnail: download failed (${e.message})`); }
  }

  // New way (full res)
  const newPath = path.join(tmpDir, `NEW-fullres-${photo.driveId}.${(photo.name?.split('.').pop() || 'jpg').toLowerCase()}`);
  try {
    await downloadDriveFile(photo.driveId, newPath);
    const newKb = Math.round(fs.statSync(newPath).size / 1024);
    console.log(`NEW (full res):   ${newKb} KB  →  ${newPath}`);
    console.log('');
    if (newKb < 30) {
      console.log('⚠ Still tiny. The /api/drive/file endpoint may not be deployed yet,');
      console.log('  or your Google Drive isn\'t connected. Reconnect in the dashboard.');
    } else if (newKb < 100) {
      console.log('🤔 Bigger than a thumbnail but smaller than a normal phone photo.');
      console.log('  Photo might just be small. Open it to check sharpness.');
    } else {
      console.log(`✓ Looks like full resolution (${newKb} KB). Open it to confirm sharpness:`);
      console.log(`  ${newPath}`);
    }
  } catch (e) {
    console.log(`NEW full-res download FAILED: ${e.message}`);
    console.log('Most likely: server not redeployed yet, or Google Drive not connected.');
  }
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

  // Group the downloaded labels by size, then save one PDF per size group
  const { PDFDocument } = require('pdf-lib');
  const bySize = {};
  for (const item of collected) {
    const s = item.order.size || 'Unknown';
    (bySize[s] = bySize[s] || []).push(item);
  }

  const today = new Date().toISOString().split('T')[0];
  const sizeOrder = ['S', 'M', 'L', 'XL', 'XXL', '?', 'Unknown'];
  const outputs = [];

  console.log(`\nMerging ${collected.length} labels into ${Object.keys(bySize).length} size-grouped PDFs...`);

  for (const size of sizeOrder) {
    const group = bySize[size];
    if (!group?.length) continue;

    const merged = await PDFDocument.create();
    for (const { pdfPath } of group) {
      try {
        const bytes = fs.readFileSync(pdfPath);
        const doc = await PDFDocument.load(bytes);
        const pages = await merged.copyPages(doc, doc.getPageIndices());
        pages.forEach(pg => merged.addPage(pg));
      } catch (e) {
        console.log(`  skipped ${pdfPath}: ${e.message}`);
      }
    }

    const tag = size === '?' ? 'MULTI' : size;
    const outPath = path.join(__dirname, `labels-${today}-${account.username}-${tag}.pdf`);
    fs.writeFileSync(outPath, await merged.save());
    outputs.push({ size: tag, count: group.length, path: outPath });
  }

  console.log(`\n✓ Done! Saved ${outputs.length} PDF${outputs.length===1?'':'s'}:\n`);
  for (const o of outputs) {
    console.log(`   ${o.size.padEnd(6)} (${o.count} label${o.count===1?'':'s'}) → ${o.path}`);
  }
  console.log('\nOpen each PDF → Ctrl+P → pick your Polono printer → print.');
  console.log('Each file is one size group — pack that batch, move to the next file.');
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
  console.log('  6. Refresh photos on a deployed set (match by size)');
  console.log('  7. TEST: download one photo at full res (verify blur fix)');
  console.log('  8. Quick Refresh: replace blurry photos on EVERY listing in shop (random)');
  const action = await ask('\nEnter choice (1-8): ');

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
  if (action === '6') {
    await runRefreshPhotos();
    return;
  }
  if (action === '7') {
    await runPhotoResolutionTest();
    return;
  }
  if (action === '8') {
    await runQuickRefresh();
    return;
  }

  // Filter out junk rows (sets with no name — usually leftovers from a
  // half-created set). They show up as "1. undefined — 0 pending" otherwise.
  const validSets = sets.filter(s => s && s.name && String(s.name).trim());
  if (!validSets.length) { console.log('No valid sets found.'); return; }

  console.log('\nAvailable sets:');
  validSets.forEach((s, i) => {
    const pending = (s.listings || []).filter(l => !l.posted).length;
    console.log(`  ${i + 1}. ${s.name} — ${pending} pending`);
  });

  const choice = await ask('\nEnter set number: ');
  const set = validSets[parseInt(choice) - 1];
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

  // Cache keyed by driveId (one entry per unique photo file). Each listing
  // builds its own ORDERED array so different sizes get their own covers.
  const photoCache = {};
  let successCount = 0;

  // Test 1 listing first
  console.log('Testing with 1 listing first...\n');
  const testListing = pending[0];

  console.log(`Downloading ${(testListing.photos || []).length} photos at full resolution...`);
  const testLocalPhotos = await getListingLocalPhotos(testListing, tmpDir, photoCache);
  for (const lp of testLocalPhotos) {
    try { console.log(`  · ${path.basename(lp)} — ${Math.round(fs.statSync(lp).size / 1024)} KB`); } catch {}
  }

  try {
    const success = await postListing(page, testListing, testLocalPhotos);
    if (success) {
      successCount++;
      console.log('\n  ✓ TEST PASSED');
      const depopUrl = page.url();
      const looksLikeProduct = /depop\.com\/[^/]+\/[^/?#]+/.test(depopUrl);
      await apiPut(`/api/sets/${set.id}/listings/${testListing.id}`, {
        posted: true, postedAt: new Date().toISOString(),
        depopUrl: looksLikeProduct ? depopUrl : null
      });
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

        const localPhotos = await getListingLocalPhotos(listing, tmpDir, photoCache);

        try {
          const success = await postListing(page, listing, localPhotos);
          if (success) {
            successCount++;
            const depopUrl = page.url();
            const looksLikeProduct = /depop\.com\/[^/]+\/[^/?#]+/.test(depopUrl);
            await apiPut(`/api/sets/${set.id}/listings/${listing.id}`, {
              posted: true, postedAt: new Date().toISOString(),
              depopUrl: looksLikeProduct ? depopUrl : null
            });
            process.stdout.write('✓\n');
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

  // Deploy a single set. Used by both the schedule check and the
  // agent_queue dispatcher. Returns { ok, message }.
  async function deployOneSet(set, label = '📅 Scheduled') {
    try {
      const accounts = await apiGet('/api/accounts');
      const account = accounts.find(a => a.id === set.accountId);
      if (!account) return { ok: false, message: 'No account assigned' };
      const pending = (set.listings || []).filter(l => !l.posted);
      if (!pending.length) return { ok: false, message: 'No pending listings' };

      await postProgress({ type: 'deploy', setId: set.id, status: 'starting', message: `${label}: ${set.name} — ${pending.length} listings` });

      const { chromium } = require('playwright');
      const browser = await chromium.launch({ headless: false, slowMo: 50 });
      const context = await browser.newContext();
      if (account.cookies?.length) {
        const clean = account.cookies.map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path||'/', secure: c.secure||false, httpOnly: c.httpOnly||false, sameSite: ['Strict','Lax','None'].includes(c.sameSite)?c.sameSite:'Lax' }));
        await context.addCookies(clean);
      }
      const page = await context.newPage();
      await page.goto('https://www.depop.com/', { waitUntil: 'networkidle' });

      const fs = require('fs-extra');
      const tmpDir = `./tmp/${set.id}`;
      fs.ensureDirSync(tmpDir);
      const photoCache = {};
      let successCount = 0;

      for (let i = 0; i < pending.length; i++) {
        const listing = pending[i];
        const localPhotos = await getListingLocalPhotos(listing, tmpDir, photoCache);
        await postProgress({ type: 'deploy', setId: set.id, status: 'posting', message: `Posting ${i+1}/${pending.length}: Size ${listing.size}`, progress: Math.round(((i+1)/pending.length)*100) });
        try {
          const success = await postListing(page, listing, localPhotos);
          if (success) {
            successCount++;
            const depopUrl = page.url();
            const looksLikeProduct = /depop\.com\/[^/]+\/[^/?#]+/.test(depopUrl);
            await apiPut(`/api/sets/${set.id}/listings/${listing.id}`, {
              posted: true, postedAt: new Date().toISOString(),
              depopUrl: looksLikeProduct ? depopUrl : null
            });
            await postProgress({ type: 'deploy', setId: set.id, status: 'posted', message: `✓ Posted: ${listing.size}`, listingId: listing.id });
          }
        } catch (err) { await postProgress({ type: 'deploy', setId: set.id, status: 'error', message: err.message }); }
        await page.waitForTimeout(2000 + Math.random() * 3000);
      }

      await browser.close();
      fs.remove(tmpDir);
      await postProgress({ type: 'deploy', setId: set.id, status: 'done', message: `Done: ${successCount}/${pending.length} posted`, progress: 100 });

      // Schedule log
      try {
        const logBody = JSON.stringify({ setId: set.id, status: 'done' });
        const logUrl = new URL(DASHBOARD_URL + '/api/schedule/log');
        const logMod = logUrl.protocol === 'https:' ? require('https') : require('http');
        const logReq = logMod.request({ hostname: logUrl.hostname, path: logUrl.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(logBody), 'x-api-key': '1010' } }, () => {});
        logReq.write(logBody); logReq.end();
      } catch {}

      return { ok: true, message: `Posted ${successCount}/${pending.length}` };
    } catch (err) {
      console.error('deployOneSet failed:', err.message);
      return { ok: false, message: err.message };
    }
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
          const localPhotos = await getListingLocalPhotos(listing, tmpDir, photoCache);

          await postProgress({ type: 'deploy', setId: set.id, status: 'posting', message: `Posting ${i+1}/${pending.length}: Size ${listing.size}`, progress: Math.round(((i+1)/pending.length)*100) });

          try {
            const success = await postListing(page, listing, localPhotos);
            if (success) {
              successCount++;
              const depopUrl = page.url();
              const looksLikeProduct = /depop\.com\/[^/]+\/[^/?#]+/.test(depopUrl);
              await apiPut(`/api/sets/${set.id}/listings/${listing.id}`, {
                posted: true, postedAt: new Date().toISOString(),
                depopUrl: looksLikeProduct ? depopUrl : null
              });
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

  // ─── DASHBOARD COMMAND QUEUE ─────────────────────────────────
  // The dashboard's Deploy / Check Statuses / Mass Edit / Quick Refresh
  // buttons push commands to /api/agent/queue. We poll for one command
  // at a time, run it, and report completion. One in-flight at a time
  // (busy flag) so two clicks don't open two browsers.
  let queueBusy = false;

  function postJson(endpoint, body) {
    return new Promise((resolve) => {
      const data = JSON.stringify(body || {});
      const urlObj = new URL(DASHBOARD_URL + endpoint);
      const mod = urlObj.protocol === 'https:' ? require('https') : require('http');
      const req = mod.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'x-api-key': '1010' }
      }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(d)); });
      req.on('error', () => resolve(null));
      req.write(data); req.end();
    });
  }

  async function processQueue() {
    if (queueBusy) return;
    let claim;
    try {
      claim = await apiGet('/api/agent/queue/next');
    } catch { return; }
    if (!claim || !claim.command) return;
    queueBusy = true;
    const cmdId = claim.id;
    const command = claim.command;
    const payload = claim.payload || {};
    console.log(`\n📨 Queue: claimed "${command}" (${cmdId})`);
    let ok = false;
    let result = '';
    try {
      if (command === 'deploy') {
        const sets = await apiGet('/api/sets');
        const set = sets.find(s => s.id === payload.setId);
        if (!set) { result = 'Set not found'; }
        else {
          const r = await deployOneSet(set, '🖱 Dashboard');
          ok = r.ok; result = r.message;
        }
      } else if (command === 'check-statuses') {
        await runStatusCheck();
        ok = true; result = 'Status check complete';
      } else if (command === 'mass-edit') {
        const sets = await apiGet('/api/sets');
        const set = sets.find(s => s.id === payload.setId);
        if (!set) { result = 'Set not found'; }
        else {
          const desc = payload.description || set.evergreenDescription || set.description;
          if (!desc) { result = 'No description provided'; }
          else { await massEditDescriptions(set, desc); ok = true; result = 'Mass edit complete'; }
        }
      } else if (command === 'quick-refresh') {
        const sets = await apiGet('/api/sets');
        const accounts = await apiGet('/api/accounts');
        const photoSet = sets.find(s => s.id === payload.photoSetId || s.id === payload.setId);
        const account = accounts.find(a => a.id === payload.accountId);
        if (!photoSet) { result = 'Photo-pool set not found'; }
        else if (!account) { result = 'Account not found'; }
        else {
          const r = await quickRefreshSet(photoSet, account);
          ok = r.ok; result = r.message;
        }
      } else {
        result = 'Unknown command: ' + command;
      }
    } catch (e) {
      result = 'Error: ' + e.message;
    } finally {
      try {
        await postJson('/api/agent/queue/' + cmdId + '/done', { ok, result });
      } catch {}
      console.log(`📨 Queue: "${command}" → ${ok ? '✓' : '✗'} ${result}`);
      queueBusy = false;
    }
  }

  console.log('\n🏄  Riptag Rugpuller — Scheduler Daemon');
  console.log(`    Dashboard: ${DASHBOARD_URL}`);
  console.log('    Checking schedule every minute, queue every 15s...\n');
  sendHeartbeat();
  setInterval(sendHeartbeat, 30000);
  checkAndDeploy();
  setInterval(checkAndDeploy, 60000);
  checkDescriptionSwitches();
  setInterval(checkDescriptionSwitches, 30 * 60 * 1000);
  // Dashboard command queue
  processQueue();
  setInterval(processQueue, 15000);
}
