# Testing Guide - ChatGPT Enhanced

## Quick Start: Test the Extension

### Method 1: Automated Testing with Playwright (Recommended)

```bash
cd x:\Personal\chatgpt-enhanced

# Full test suite with manual inspection
npm run test:full

# Then in the browser that opens:
# 1. Log in to ChatGPT
# 2. Click on a conversation to load the sidebar
# 3. Return to terminal and press ENTER
# 4. Tests will run automatically
```

### Method 2: Manual Chrome Installation

1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode" (top-right toggle)
3. Click "Load unpacked"
4. Select `x:\Personal\chatgpt-enhanced` folder
5. Go to https://chatgpt.com and log in
6. Click on a conversation to load the sidebar

## What to Check

### ✅ Checkboxes Feature

**Should work:**
- Open any conversation from the sidebar
- Hover your mouse over a conversation link
- A small checkbox should appear to the left of the conversation name
- Clicking the checkbox should select/deselect that conversation
- Multiple checkboxes can be selected

**If not working:**
1. Open DevTools (F12 → Console tab)
2. Look for messages starting with `[CGPT+]`
3. You should see:
   - `[CGPT+] Content script loaded at ...`
   - `[CGPT+] Settings loaded: {...}`
   - `[CGPT+] Checkboxes injected ... (bulkActions)`
   - `[CGPT+] Re-check: X checkboxes, icon-grid: ...`
4. If you see errors, share the console output

### ✅ Compact Sidebar Icons

**Should work:**
- Look at the top of the sidebar below "New chat"
- You should see small icon buttons (Images, Apps, Projects, Search, etc.)
- These should be compact and small
- Hovering over them should show labels
- The original text items should be hidden

**If not working:**
1. Check console for:
   - `[CGPT+] Compact sidebar initialized`
   - Or any error messages containing "setupCompactSidebar"
2. The icons should appear automatically

## Console Debugging

The extension now logs detailed information. To view:

1. **Open DevTools:** F12 or Ctrl+Shift+I
2. **Go to Console tab**
3. Look for `[CGPT+]` prefixed messages
4. Common messages:
   - `[CGPT+] Content script loaded` - Script is injected
   - `[CGPT+] Settings loaded` - Settings were read
   - `[CGPT+] Checkboxes injected N` - Checkboxes created
   - `[CGPT+] Compact sidebar initialized` - Icons setup
   - `[CGPT+] No checkboxes found, forcing re-injection` - Feature is retrying

## Troubleshooting

### Checkboxes not appearing on hover

**Check:**
1. Are you seeing `[CGPT+] Checkboxes injected` in console?
   - **No:** bulkActions might be disabled or selectors not matching
   - **Yes:** Continue to step 2
2. Hover over a conversation → Right-click → Inspect
3. In DevTools, look for:
   - Class `cgpt-bulk-item` on the link
   - An `<input type="checkbox" class="cgpt-cb">` element inside
4. If missing, features aren't initializing properly

### Compact sidebar icons not appearing

**Check:**
1. Are you seeing `[CGPT+] Compact sidebar initialized` in console?
   - **No:** setupCompactSidebar might be failing
   - **Yes:** Continue to step 2
2. Look at the sidebar top - do you see icon buttons?
3. If still not visible:
   - Refresh the page (Ctrl+R)
   - If still missing after 5 seconds, check console for errors

### Extension not loading at all

**Check:**
1. Do you see `[CGPT+] Content script loaded` in console?
   - **No:** Extension not injected - reinstall from chrome://extensions
   - **Yes:** Continue to step 2
2. In DevTools Console, run: `typeof CONFIG !== 'undefined'`
   - **true:** Extension loaded
   - **false:** Check extension loading errors

## Force Re-test

If features mysteriously stop working:

1. Press F12 to open DevTools
2. Run in Console:
   ```javascript
   injectCheckboxes();
   setupCompactSidebar();
   console.log('Features forced to re-initialize');
   ```
3. Observe sidebar for changes

## Test Files

- `tools/playwright-test-full.js` - Comprehensive automated test
- `tools/playwright-diagnostic.js` - Deep DOM inspection
- Both use Node.js + Playwright (no user interaction needed after login)

## Questions?

If features still don't work after these tests, please:
1. Take a screenshot of the sidebar (showing no checkboxes/icons)
2. Copy all console output from DevTools Console tab
3. Share both with detailed description of what you see vs expect
