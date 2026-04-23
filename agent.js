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
