const { chromium } = require('playwright');
const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const http = require('http');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '1049938897487-liap0llpr407fv458k71qqpnm9sg484l.apps.googleusercontent.com';
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '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';

async function downloadDrivePhoto(driveId, destPath, tokens) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: client });

  fs.ensureDirSync(path.dirname(destPath));
  const dest = fs.createWriteStream(destPath);

  const res = await drive.files.get({ fileId: driveId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });
}

async function postListing(page, listing, localPhotos) {
  await page.goto('https://www.depop.com/sell/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Upload photos
  try {
    const photoInput = await page.$('input[type="file"][accept*="image"]');
    if (photoInput && localPhotos.length > 0) {
      const existing = localPhotos.filter(p => fs.existsSync(p));
      if (existing.length) { await photoInput.setInputFiles(existing); await page.waitForTimeout(2500); }
    }
  } catch (e) { console.log('Photo upload error:', e.message); }

  // Description (title + body)
  const desc = listing.customDescription || listing.description || '';
  try {
    const descInput = await page.$('textarea[name="description"], textarea[placeholder*="escribe"], textarea[placeholder*="ell"]');
    if (descInput) { await descInput.click({ clickCount: 3 }); await descInput.type(desc); await page.waitForTimeout(300); }
  } catch {}

  // Price
  try {
    const priceInput = await page.$('input[name="price"], input[placeholder*="rice"]');
    if (priceInput) { await priceInput.click({ clickCount: 3 }); await priceInput.type(String(listing.customPrice || listing.price || '20')); await page.waitForTimeout(300); }
  } catch {}

  // Category Men > T-shirts
  try {
    const catBtn = await page.$('[data-testid="listing-category"], button[aria-label*="ategory"]');
    if (catBtn) {
      await catBtn.click(); await page.waitForTimeout(500);
      const men = await page.$('text=Men'); if (men) { await men.click(); await page.waitForTimeout(400); }
      const tee = await page.$('text=T-shirts'); if (tee) { await tee.click(); await page.waitForTimeout(400); }
    }
  } catch {}

  // Condition
  try {
    const condBtn = await page.$('[data-testid="listing-condition"]');
    if (condBtn) {
      await condBtn.click(); await page.waitForTimeout(400);
      const used = await page.$('text=Used - Excellent'); if (used) { await used.click(); await page.waitForTimeout(300); }
    }
  } catch {}

  // Size
  try {
    const sizeBtn = await page.$('[data-testid="listing-size"], button[aria-label*="ize"]');
    if (sizeBtn) {
      await sizeBtn.click(); await page.waitForTimeout(400);
      const sizeOpt = await page.$(`text="${listing.size}"`); if (sizeOpt) { await sizeOpt.click(); await page.waitForTimeout(300); }
    }
  } catch {}

  // Quantity 100
  try {
    const qtyInput = await page.$('input[name="quantity"]');
    if (qtyInput) { await qtyInput.click({ clickCount: 3 }); await qtyInput.type('100'); await page.waitForTimeout(300); }
  } catch {}

  // Package size extra small
  try {
    const pkgBtn = await page.$('[data-testid*="package"]');
    if (pkgBtn) {
      await pkgBtn.click(); await page.waitForTimeout(400);
      const xs = await page.$('text=Extra small'); if (xs) { await xs.click(); await page.waitForTimeout(300); }
    }
  } catch {}

  // Post
  const postBtn = await page.$('button[type="submit"], button:has-text("Post"), button:has-text("List")');
  if (postBtn) { await postBtn.click(); await page.waitForTimeout(3000); return true; }
  return false;
}

async function deploySet(set, account, onProgress) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  // Inject cookies
  if (account.cookies?.length) {
    await context.addCookies(account.cookies);
  }

  const page = await context.newPage();
  let successCount = 0;
  const tmpDir = `./tmp/${set.id}`;
  fs.ensureDirSync(tmpDir);

  try {
    // Verify logged in
    await page.goto('https://www.depop.com/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const pending = set.listings.filter(l => !l.posted);
    onProgress({ status: 'starting', message: `Starting deploy — ${pending.length} listings to post` });

    // Group listings by groupId to download photos once per group
    const photoCache = {};

    for (let i = 0; i < pending.length; i++) {
      const listing = pending[i];

      try {
        // Download photos for this group if not cached
        if (!photoCache[listing.groupId]) {
          const localPhotos = [];
          for (let j = 0; j < listing.photos.length; j++) {
            const photo = listing.photos[j];
            const ext = photo.name?.split('.').pop() || 'jpg';
            const localPath = path.join(tmpDir, `${listing.groupId}_${j}.${ext}`);
            try {
              await downloadDrivePhoto(photo.driveId, localPath, account.googleTokens || {});
              localPhotos.push(localPath);
            } catch (e) { console.log('Photo download failed:', e.message); }
          }
          photoCache[listing.groupId] = localPhotos;
        }

        onProgress({
          status: 'posting',
          message: `Posting ${i + 1}/${pending.length}: ${listing.size} — Group ${listing.groupIndex + 1}`,
          progress: Math.round(((i + 1) / pending.length) * 100),
          listingId: listing.id
        });

        const success = await postListing(page, listing, photoCache[listing.groupId] || []);

        if (success) {
          successCount++;
          onProgress({ status: 'posted', message: `✓ Posted: Size ${listing.size} Group ${listing.groupIndex + 1}`, listingId: listing.id });
        } else {
          onProgress({ status: 'error', message: `Failed: Size ${listing.size} Group ${listing.groupIndex + 1}`, listingId: listing.id });
        }

        // Human-like delay
        await page.waitForTimeout(3000 + Math.random() * 4000);

      } catch (err) {
        console.error('Listing error:', err.message);
        onProgress({ status: 'error', message: `Error on listing ${listing.id}: ${err.message}`, listingId: listing.id });
      }
    }

    onProgress({ status: 'done', message: `Deploy complete — ${successCount}/${pending.length} posted` });

  } catch (err) {
    onProgress({ status: 'error', message: err.message });
  } finally {
    await browser.close();
    // Cleanup tmp photos
    await fs.remove(tmpDir);
  }

  return successCount;
}

module.exports = { deploySet };
