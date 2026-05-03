const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const extensionPath = repoRoot; // root contains manifest.json
  const userDataDir = path.join(repoRoot, 'playwright-user-data');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  console.log('Launching persistent Chromium with extension loaded...');
  console.log('Extension path:', extensionPath);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    viewport: null,
  });

  const page = await context.newPage();
  await page.goto('https://chatgpt.com/auth/login');

  console.log('\nBrowser launched. Steps:');
  console.log('  1) In the opened browser window you should see the extension loaded (it will appear in the toolbar).');
  console.log('  2) If necessary, open the extensions page in that browser and enable the unpacked extension (it should already be loaded).');
  console.log('  3) Log in to ChatGPT using your account in the opened browser tab.');
  console.log('\nWhen you are logged in and ready, press ENTER here to run automated smoke checks.');

  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));

  console.log('\nRunning smoke checks... (this will not modify your account)');
  try {
    // check for sidebar conversation link
    try {
      await page.waitForSelector('a[href^="/c/"]', { timeout: 15000 });
      console.log('[OK] Sidebar conversation link found');
    } catch (e) {
      console.warn('[WARN] Sidebar conversation link not found within timeout');
    }

    // check for model button
    try {
      await page.waitForSelector('button[aria-label*="current model"], button[aria-label*="model"]', { timeout: 15000 });
      console.log('[OK] Model button detected');
    } catch (e) {
      console.warn('[WARN] Model button not found within timeout');
    }

    // check for extension-injected elements (best-effort)
    try {
      await page.waitForSelector('#modus-model-badge, .modus-bulk-item, #modus-action-bar', { timeout: 10000 });
      console.log('[OK] Detected extension-injected UI (badge/action bar/checkboxes)');
    } catch (e) {
      console.warn('[WARN] Extension-injected UI not detected; ensure the extension is enabled in this browser profile');
    }

    console.log('\nSmoke checks complete. Inspect the opened browser window for behavior.');
  } catch (err) {
    console.error('Smoke checks failed with error:', err);
  }

  console.log('\nPress ENTER to close the browser and exit.');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  await context.close();
  process.exit(0);
})();

