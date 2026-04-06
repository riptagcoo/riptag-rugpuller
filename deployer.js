const { chromium } = require('playwright');
const { google } = require('googleapis');
const fs = require('fs-extra');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

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

async function postListing(page, listing, localPhotos, onProgress) {
  onProgress({ status: 'info', message: `  → Navigating to sell page...` });
  await page.goto('https://www.depop.com/sell/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Take screenshot of current page state for debugging
  const pageTitle = await page.title();
  const pageUrl = page.url();
  onProgress({ status: 'info', message: `  → Page: ${pageTitle} | URL: ${pageUrl}` });

  // Check if we're on the right page
  if (!pageUrl.includes('sell') && !pageUrl.includes('upload')) {
    onProgress({ status: 'info', message: `  → Not on sell page, trying to find sell button...` });
    const sellBtn = await page.$('a[href*="sell"], button:has-text("Sell")');
    if (sellBtn) { await sellBtn.click(); await page.waitForTimeout(2000); }
  }

  // Upload photos
  try {
    const photoInput = await page.$('input[type="file"]');
    if (photoInput && localPhotos.length > 0) {
      const existing = localPhotos.filter(p => fs.existsSync(p));
      onProgress({ status: 'info', message: `  → Uploading ${existing.length} photos...` });
      if (existing.length) { await photoInput.setInputFiles(existing); await page.waitForTimeout(3000); }
    } else {
      onProgress({ status: 'info', message: `  → No photo input found or no photos` });
    }
  } catch (e) { onProgress({ status: 'info', message: `  → Photo error: ${e.message}` }); }

  // Description
  try {
    const descSelectors = [
      'textarea[name="description"]',
      'textarea[placeholder*="escribe"]',
      'textarea[placeholder*="ell people"]',
      'textarea[placeholder*="Add a description"]',
      '[data-testid="listing-description"] textarea',
      'textarea'
    ];
    let descInput = null;
    for (const sel of descSelectors) {
      descInput = await page.$(sel);
      if (descInput) { onProgress({ status: 'info', message: `  → Found desc with: ${sel}` }); break; }
    }
    if (descInput) {
      await descInput.click({ clickCount: 3 });
      await descInput.type(listing.customDescription || listing.description || '');
      await page.waitForTimeout(300);
    } else {
      onProgress({ status: 'info', message: `  → No description field found` });
    }
  } catch (e) { onProgress({ status: 'info', message: `  → Desc error: ${e.message}` }); }

  // Price
  try {
    const priceSelectors = [
      'input[name="price"]',
      'input[placeholder*="rice"]',
      'input[placeholder*="0.00"]',
      '[data-testid*="price"] input',
    ];
    let priceInput = null;
    for (const sel of priceSelectors) {
      priceInput = await page.$(sel);
      if (priceInput) { onProgress({ status: 'info', message: `  → Found price with: ${sel}` }); break; }
    }
    if (priceInput) {
      await priceInput.click({ clickCount: 3 });
      await priceInput.type(String(listing.customPrice || listing.price || '20'));
      await page.waitForTimeout(300);
    } else {
      onProgress({ status: 'info', message: `  → No price field found` });
    }
  } catch (e) { onProgress({ status: 'info', message: `  → Price error: ${e.message}` }); }

  // Find and click Post button
  const postSelectors = [
    'button[type="submit"]',
    'button:has-text("Post")',
    'button:has-text("List")',
    'button:has-text("Upload")',
    'button:has-text("Publish")',
  ];
  let postBtn = null;
  for (const sel of postSelectors) {
    postBtn = await page.$(sel);
    if (postBtn) { onProgress({ status: 'info', message: `  → Found post btn with: ${sel}` }); break; }
  }

  if (postBtn) {
    await postBtn.click();
    await page.waitForTimeout(3000);
    onProgress({ status: 'info', message: `  → Clicked post, new URL: ${page.url()}` });
    return true;
  }

  onProgress({ status: 'info', message: `  → No post button found. Page HTML snippet: ${(await page.content()).substring(0, 300)}` });
  return false;
}

async function deploySet(set, account, onProgress) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();

  if (account.cookies?.length) {
    const cleanCookies = account.cookies.map(c => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false,
      sameSite: ['Strict','Lax','None'].includes(c.sameSite) ? c.sameSite : 'Lax'
    }));
    await context.addCookies(cleanCookies);
  }

  const page = await context.newPage();
  let successCount = 0;
  const tmpDir = `./tmp/${set.id}`;
  fs.ensureDirSync(tmpDir);

  try {
    onProgress({ status: 'info', message: `Checking login status...` });
    await page.goto('https://www.depop.com/', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const url = page.url();
    const title = await page.title();
    onProgress({ status: 'info', message: `Home page: ${title} | ${url}` });

    const pending = set.listings.filter(l => !l.posted);
    onProgress({ status: 'starting', message: `Starting deploy — ${pending.length} listings to post` });

    const photoCache = {};

    // Only do first listing for now to debug
    const testListings = pending.slice(0, 1);

    for (let i = 0; i < testListings.length; i++) {
      const listing = testListings[i];
      try {
        if (!photoCache[listing.groupId]) {
          const localPhotos = [];
          for (let j = 0; j < listing.photos.length; j++) {
            const photo = listing.photos[j];
            const ext = photo.name?.split('.').pop() || 'jpg';
            const localPath = path.join(tmpDir, `${listing.groupId}_${j}.${ext}`);
            try {
              await downloadDrivePhoto(photo.driveId, localPath, account.googleTokens || {});
              localPhotos.push(localPath);
              onProgress({ status: 'info', message: `  → Downloaded photo ${j+1}` });
            } catch (e) { onProgress({ status: 'info', message: `  → Photo ${j+1} failed: ${e.message}` }); }
          }
          photoCache[listing.groupId] = localPhotos;
        }

        onProgress({ status: 'posting', message: `Testing post: ${listing.size} Group ${listing.groupIndex + 1}`, listingId: listing.id });
        const success = await postListing(page, listing, photoCache[listing.groupId] || [], onProgress);

        if (success) {
          successCount++;
          onProgress({ status: 'posted', message: `✓ Posted: Size ${listing.size}`, listingId: listing.id });
        } else {
          onProgress({ status: 'error', message: `Failed: Size ${listing.size}`, listingId: listing.id });
        }

      } catch (err) {
        onProgress({ status: 'error', message: `Error: ${err.message}`, listingId: listing.id });
      }
    }

    onProgress({ status: 'done', message: `Debug run complete — ${successCount} posted` });

  } catch (err) {
    onProgress({ status: 'error', message: err.message });
  } finally {
    await browser.close();
    await fs.remove(tmpDir);
  }

  return successCount;
}

module.exports = { deploySet };
