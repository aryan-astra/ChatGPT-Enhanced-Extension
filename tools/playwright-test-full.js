const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const repoRoot = path.resolve(__dirname, '..');
  const extensionPath = repoRoot;
  const userDataDir = path.join(repoRoot, 'playwright-user-data-test');
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  console.log('🚀 Launching Chromium with extension for full testing...\n');

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();
  page.setViewportSize({ width: 1920, height: 1080 });

  console.log('✅ Browser launched.\n📍 Steps:');
  console.log('  1) Log in to ChatGPT (if not already).');
  console.log('  2) Wait for sidebar to load completely.');
  console.log('  3) Return here and press ENTER for automated tests.\n');

  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));

  console.log('🧪 Running comprehensive tests...\n');

  try {
    // Navigate to ChatGPT if not already there
    const currentUrl = page.url();
    if (!currentUrl.includes('chatgpt.com')) {
      console.log('📍 Navigating to ChatGPT...');
      await page.goto('https://chatgpt.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // Test 1: Check extension injection
    console.log('\n[TEST 1] Checking extension injection...');
    const injectionTest = await page.evaluate(() => {
      return {
        configExists: typeof CONFIG !== 'undefined',
        mutObsExists: typeof _mutObs !== 'undefined',
        deadFlag: typeof _dead !== 'undefined' ? _dead : 'undefined',
        settingsState: typeof _s !== 'undefined' ? _s : 'undefined',
      };
    });
    console.log('  ✓ Extension injection:', injectionTest);

    // Test 2: Check sidebar links
    console.log('\n[TEST 2] Checking sidebar conversation links...');
    const sidebarTest = await page.evaluate(() => {
      return {
        linkCount: document.querySelectorAll('a[href^="/c/"]').length,
        navLinks: document.querySelectorAll('nav a[href^="/c/"]').length,
        asideLinks: document.querySelectorAll('aside a[href^="/c/"]').length,
        plainLinks: document.querySelectorAll('a[href^="/c/"]').length,
      };
    });
    console.log('  ✓ Sidebar links:', sidebarTest);

    // Test 3: Check checkbox injection
    console.log('\n[TEST 3] Checking checkbox injection...');
    const checkboxTest = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a[href^="/c/"]')];
      if (links.length === 0) return { status: 'No links found' };
      
      const first = links[0];
      const hasCheckbox = !!first.querySelector('input[type="checkbox"]');
      const hasBulkClass = first.classList.contains('modus-bulk-item');
      const checkboxCount = document.querySelectorAll('input.modus-cb').length;
      
      return {
        totalLinks: links.length,
        firstLinkHasCheckbox: hasCheckbox,
        firstLinkHasBulkClass: hasBulkClass,
        checkboxCount: checkboxCount,
        firstLinkHTML: first.outerHTML.slice(0, 150),
      };
    });
    console.log('  ✓ Checkbox status:', checkboxTest);

    // Test 4: Check CSS injection for checkboxes
    console.log('\n[TEST 4] Checking CSS injection...');
    const cssTest = await page.evaluate(() => {
      const cssIds = ['modus-cb-css', 'modus-compact-css', 'modus-action-bar-css'];
      const injected = {};
      for (const id of cssIds) {
        injected[id] = !!document.getElementById(id);
      }
      return injected;
    });
    console.log('  ✓ CSS injection:', cssTest);

    // Test 5: Check compact sidebar
    console.log('\n[TEST 5] Checking compact sidebar...');
    const compactTest = await page.evaluate(() => {
      const grid = document.getElementById('modus-icon-grid');
      const sidebarTools = document.querySelectorAll('a[href="/images"], a[href="/apps"]');
      
      return {
        iconGridExists: !!grid,
        iconGridVisible: grid ? grid.offsetParent !== null : 'N/A',
        sidebarToolsCount: sidebarTools.length,
        gridChildCount: grid ? grid.children.length : 0,
      };
    });
    console.log('  ✓ Compact sidebar:', compactTest);

    // Test 6: Try to trigger injection manually
    console.log('\n[TEST 6] Testing manual trigger of injectCheckboxes...');
    const triggerTest = await page.evaluate(() => {
      try {
        if (typeof injectCheckboxes === 'function') {
          injectCheckboxes();
          return { triggered: true, result: 'injectCheckboxes called' };
        } else {
          return { triggered: false, result: 'injectCheckboxes not found' };
        }
      } catch (err) {
        return { triggered: false, result: err.message };
      }
    });
    console.log('  ✓ Trigger result:', triggerTest);

    // Test 7: Check after manual trigger
    console.log('\n[TEST 7] Checking checkboxes after manual trigger...');
    await page.waitForTimeout(500);
    const afterTriggerTest = await page.evaluate(() => {
      const checkboxCount = document.querySelectorAll('input.modus-cb').length;
      const bulkItems = document.querySelectorAll('a.modus-bulk-item').length;
      return { checkboxCount, bulkItems };
    });
    console.log('  ✓ After trigger:', afterTriggerTest);

    // Test 8: Try hovering on a link to check visibility
    console.log('\n[TEST 8] Testing checkbox visibility on hover...');
    const firstLink = await page.$('a[href^="/c/"]');
    if (firstLink) {
      await firstLink.hover();
      await page.waitForTimeout(300);
      
      const hoverTest = await page.evaluate(() => {
        const first = document.querySelector('a[href^="/c/"]');
        if (!first) return { error: 'Link disappeared' };
        
        const cb = first.querySelector('input.modus-cb');
        if (!cb) return { error: 'Checkbox not found' };
        
        const style = window.getComputedStyle(cb);
        return {
          checkboxFound: true,
          opacity: style.opacity,
          display: style.display,
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
        };
      });
      console.log('  ✓ Hover visibility:', hoverTest);
    } else {
      console.log('  ⚠ No link found to test hover');
    }

    console.log('\n✨ All tests complete!\n');
    console.log('💡 Results Summary:');
    console.log('  - Extension is', injectionTest.configExists ? '✓ INJECTED' : '✗ NOT injected');
    console.log('  - Checkboxes are', checkboxTest.checkboxCount > 0 ? '✓ PRESENT' : '✗ MISSING');
    console.log('  - Compact sidebar is', compactTest.iconGridExists ? '✓ PRESENT' : '✗ MISSING');
    console.log('\nKeep browser open to inspect. Open DevTools (F12) to check console.');
    console.log('\nPress ENTER to close.\n');

    await new Promise((resolve) => process.stdin.once('data', resolve));
  } catch (err) {
    console.error('❌ Test failed:', err.message);
  }

  await context.close();
  process.exit(0);
})();

