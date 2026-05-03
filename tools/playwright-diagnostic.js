const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const extensionPath = repoRoot;
  const userDataDir = path.join(repoRoot, 'playwright-user-data');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  console.log('🔧 Launching Chromium with extension for deep diagnostics...\n');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    viewport: null,
  });

  const page = await context.newPage();
  await page.goto('https://chatgpt.com/auth/login', { waitUntil: 'domcontentloaded' });

  console.log('✅ Browser launched with extension loaded.');
  console.log('📍 Steps:');
  console.log('  1) Enable the extension in the toolbar if needed.');
  console.log('  2) Log in to ChatGPT.');
  console.log('  3) Open a conversation (click a chat in the sidebar).');
  console.log('  4) Return here and press ENTER to run diagnostics.\n');

  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));

  console.log('🔍 Running comprehensive diagnostics...\n');

  try {
    // 1. Check if extension is injected by looking for extension markers
    const hasExtensionMarkers = await page.evaluate(() => {
      return {
        hasConsoleLog: !!window.__cgptExtensionLoaded,
        hasGlobalVariable: typeof window._dead !== 'undefined',
        hasConfig: typeof CONFIG !== 'undefined',
      };
    });
    console.log('📌 Extension Global Markers:', hasExtensionMarkers);

    // 2. Check for CSS injection
    const cssInjected = await page.evaluate(() => {
      const styles = [...document.styleSheets].map(s => {
        try {
          return s.href || s.title;
        } catch (e) {
          return 'unknown';
        }
      });
      const injectedIds = ['cgpt-model-badge', 'cgpt-ctx-bar', 'cgpt-cb-css', 'cgpt-compact-css', 'cgpt-dg-css', 'cgpt-lock-css', 'cgpt-vault-css', 'cgpt-action-bar-css'];
      const found = {};
      for (const id of injectedIds) {
        found[id] = !!document.getElementById(id);
      }
      return found;
    });
    console.log('📌 Injected CSS Elements:', cssInjected);

    // 3. Check for sidebar links
    const sidebarLinks = await page.evaluate(() => {
      const links = {
        byNavA: document.querySelectorAll('nav a[href^="/c/"]').length,
        byAsideA: document.querySelectorAll('aside a[href^="/c/"]').length,
        byPlainA: document.querySelectorAll('a[href^="/c/"]').length,
      };
      return links;
    });
    console.log('📌 Sidebar Links Found:', sidebarLinks);

    // 4. Check for checkboxes on a specific link
    const checkboxStatus = await page.evaluate(() => {
      const link = document.querySelector('a[href^="/c/"]');
      if (!link) return { found: false, reason: 'No sidebar link found' };
      return {
        found: true,
        hasCheckbox: !!link.querySelector('input[type="checkbox"]'),
        hasClass: link.classList.contains('cgpt-bulk-item'),
        linkHTML: link.outerHTML.slice(0, 200),
        checkboxHTML: link.querySelector('input[type="checkbox"]')?.outerHTML || 'none',
      };
    });
    console.log('📌 Checkbox Status on First Link:', checkboxStatus);

    // 5. Check for action bar
    const actionBarStatus = await page.evaluate(() => {
      const bar = document.getElementById('cgpt-action-bar');
      if (!bar) return { found: false, reason: 'Action bar not in DOM' };
      return {
        found: true,
        visible: bar.offsetParent !== null,
        html: bar.outerHTML.slice(0, 200),
      };
    });
    console.log('📌 Action Bar Status:', actionBarStatus);

    // 6. Check for compact sidebar icon grid
    const compactSidebarStatus = await page.evaluate(() => {
      const grid = document.getElementById('cgpt-icon-grid');
      if (!grid) return { found: false, reason: 'Icon grid not in DOM' };
      return {
        found: true,
        visible: grid.offsetParent !== null,
        childCount: grid.children.length,
        html: grid.outerHTML.slice(0, 200),
      };
    });
    console.log('📌 Compact Sidebar Icon Grid:', compactSidebarStatus);

    // 7. Check browser console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.waitForTimeout(2000); // Wait briefly for any errors to be logged
    console.log('📌 Recent Console Errors:', consoleErrors.length > 0 ? consoleErrors : 'None');

    // 8. Check extension settings
    const settings = await page.evaluate(async () => {
      try {
        return typeof chrome !== 'undefined' ? 'chrome API available' : 'chrome API NOT available';
      } catch (e) {
        return 'Error accessing chrome API';
      }
    });
    console.log('📌 Chrome API Access:', settings);

    // 9. Check mutation observer
    const mutObsStatus = await page.evaluate(() => {
      if (typeof _mutObs === 'undefined') return 'MutationObserver not found';
      return 'MutationObserver is active';
    });
    console.log('📌 Mutation Observer:', mutObsStatus);

    console.log('\n✨ Diagnostics complete. Keep browser open to inspect.');
    console.log('💡 Next steps:');
    console.log('  - Check the sidebar: hover over a conversation link.');
    console.log('  - Look for checkboxes appearing on hover.');
    console.log('  - Check top-right icons in sidebar: should be compact/small.');
    console.log('  - Open browser DevTools (F12) → Console tab to see any errors.');
    console.log('\nPress ENTER to close browser and exit.\n');

    await new Promise((resolve) => process.stdin.once('data', resolve));
  } catch (err) {
    console.error('❌ Diagnostics failed:', err.message);
  }

  await context.close();
  process.exit(0);
})();
