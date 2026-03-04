# ChatGPT Enhanced — Complete Developer Documentation & Update Log

> **Current Version:** `3.4.3`
> **Last Updated:** March 4, 2026
> **Type:** Chrome Extension (Manifest V3)
> **Target:** `chatgpt.com` only

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Directory Structure](#2-directory-structure)
3. [File-by-File Deep Dive](#3-file-by-file-deep-dive)
   - [manifest.json](#31-manifestjson)
   - [background.js](#32-backgroundjs)
   - [content.js](#33-contentjs)
   - [popup.html](#34-popuphtml)
   - [popup.js](#35-popupjs)
   - [popup.css](#36-popupcss)
   - [styles.css](#37-stylescss)
   - [package.json](#38-packagejson)
   - [assets/](#39-assets)
4. [Feature Inventory](#4-feature-inventory)
   - [Feature 1 — Typing Lag Fix](#feature-1--typing-lag-fix-content-visibility-virtualization)
   - [Feature 2 — Bulk Checkbox Injection](#feature-2--bulk-checkbox-injection)
   - [Feature 3 — Compact Sidebar](#feature-3--compact-sidebar)
   - [Feature 4 — Model Badge](#feature-4--model-badge)
   - [Feature 7 — Context Bar](#feature-7--context-bar--context-warning)
   - [Feature 8 — Sidebar Date Groups](#feature-8--sidebar-date-groups)
   - [Feature 9 — Chat Vault (PIN Lock)](#feature-9--chat-vault-pin-lock)
   - [Feature 10 — Export Selected Chats](#feature-10--export-selected-chats)
   - [Feature 11 — Vault Encryption (Base64)](#feature-11--vault-encryption-base64-channel)
5. [Settings System](#5-settings-system)
6. [Architecture & Key Patterns](#6-architecture--key-patterns)
   - [Extension Context Invalidation Handling](#extension-context-invalidation-handling)
   - [MutationObserver Strategy](#mutationobserver-strategy)
   - [SPA Navigation Handling](#spa-navigation-handling)
   - [Header Capture via background.js](#header-capture-via-backgroundjs)
   - [Performance Philosophy](#performance-philosophy)
7. [Version History & Changes](#7-version-history--changes)
8. [Known Gotchas & Developer Notes](#8-known-gotchas--developer-notes)

---

## 1. Project Overview

**ChatGPT Enhanced** is a Chrome browser extension (Manifest V3) that injects into `chatgpt.com` and adds functionality that the native ChatGPT UI does not provide:

- **Performance**: Eliminates the typing lag that occurs in long conversations by virtualizing off-screen messages using the CSS `content-visibility` API.
- **Bulk Sidebar Management**: Exposes checkboxes on every conversation in the left sidebar so you can select many at once and archive or delete them via the ChatGPT REST API.
- **Chat Vault**: Hide and optionally encrypt specific chats behind a 4-digit PIN so that casual observers (e.g. screen sharing) can't see them.
- **Context Intelligence**: Shows a real-time token-usage bar so you know how close you are to the model's context window limit.
- **Model Badge**: Displays the active AI model name directly in the chat header.
- **Compact Sidebar**: Collapses the sidebar's shortcut links into a single icon strip.
- **Date Groups**: Groups sidebar conversations by date bucket (Today, Yesterday, Last 7 Days, etc.) with collapsible headings.
- **Export**: Export selected conversations to Markdown, plain text, or PDF.

The extension works entirely client-side. No data is ever sent anywhere except back to `chatgpt.com`'s own APIs using the auth headers that ChatGPT itself uses.

---

## 2. Directory Structure

```
chatgpt-enhanced/
├── manifest.json          ← Extension manifest (MV3)
├── background.js          ← Service worker: captures API headers + writes defaults
├── content.js             ← Main entry point injected into chatgpt.com (2290 lines)
├── popup.html             ← Settings popup HTML
├── popup.js               ← Settings popup logic (toggle/save)
├── popup.css              ← Settings popup styling (dark theme)
├── styles.css             ← Injected CSS for sidebar checkboxes, action bar, etc.
├── package.json           ← Playwright test dependency
├── assets/
│   ├── chatgpt-enhanced-1024_logo.png
│   ├── chatgpt-enhanced-128_logo.png
│   ├── chatgpt-enhanced-48_logo.png
│   ├── chatgpt-enhanced-full_logo.png
│   └── Chatgpt-enhanced-logo.png
└── tests/                 ← (empty — Playwright test dir, reserved for future use)
```

---

## 3. File-by-File Deep Dive

---

### 3.1 `manifest.json`

**Role:** Defines the extension's identity, permissions, injection rules, and entry points for Chrome.

**Key fields:**

| Field | Value | Why |
|---|---|---|
| `manifest_version` | `3` | Required for all new Chrome extensions. MV3 replaces background pages with service workers and restricts `webRequest` blocking. |
| `name` | `ChatGPT Enhanced` | Display name in the Chrome Extensions store and toolbar. |
| `version` | `3.4.3` | Semantic version. Shown dynamically in the popup via `chrome.runtime.getManifest().version`. |
| `permissions` | `activeTab`, `scripting`, `webRequest`, `storage`, `tabs` | `webRequest` is needed to intercept outgoing HTTP headers (Authorization). `storage` is used for settings and locked chat IDs. `tabs` is needed to message the active tab when settings change. |
| `host_permissions` | `*://chatgpt.com/*`, `*://*.chatgpt.com/*` | Grants access to all ChatGPT pages including subdomains. Required for both content script injection and `webRequest` listening. |
| `background.service_worker` | `background.js` | The MV3 service worker. Lives in the background, not as a persistent page. |
| `action.default_popup` | `popup.html` | The UI shown when the user clicks the extension icon in the toolbar. |
| `content_scripts[0].js` | `["content.js"]` | Injected into every matching ChatGPT page. |
| `content_scripts[0].css` | `["styles.css"]` | Injected stylesheet for sidebar checkboxes and action bar base styles. |
| `content_scripts[0].run_at` | `document_idle` | Waits until the DOM is fully ready before injecting, avoiding race conditions. |

**No `background.persistent`** — MV3 service workers are event-driven; the background script wakes up for `webRequest` events and then goes idle.

---

### 3.2 `background.js`

**Role:** The MV3 service worker. Performs three jobs:

#### Job 1 — Capture outgoing API headers

ChatGPT authenticates its backend API calls using a set of HTTP headers (`Authorization`, `oai-device-id`, `oai-language`, `oai-client-build-number`, `oai-client-version`). The content script needs these headers to make its own API calls (bulk archive/delete, date groups, export, context bar).

However, content scripts cannot read these headers from `fetch()`. The service worker uses the `webRequest.onSendHeaders` listener (with `"extraHeaders"` flag — required to see the `Authorization` header, which Chrome normally hides) to capture them and write them into `chrome.storage.local` under the key `chatgpt_headers`.

```js
// TARGET_URLS = ["https://chatgpt.com/backend-api/*"]
// TARGET_HEADERS = ["authorization", "oai-device-id", "oai-language", ...]
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    // gather relevant headers, merge with any previously stored, save
    chrome.storage.local.set({ chatgpt_headers: merged });
  },
  { urls: TARGET_URLS },
  ["requestHeaders", "extraHeaders"]   // extraHeaders = critical for Authorization
);
```

The content script reads these headers via `getHeaders()` / `_storeGet(['chatgpt_headers'])` whenever it needs to call the ChatGPT API.

#### Job 3 — Scope action icon to ChatGPT tabs only

`chrome.action.disable()` is called once at service-worker startup, globally disabling the popup icon. Two listeners then selectively enable it per tab:

- **`tabs.onActivated`** — when you switch to a tab, reads the tab URL via `chrome.tabs.get()` and enables or disables the action for that specific `tabId`.
- **`tabs.onUpdated`** — when a tab navigates to a new URL, re-evaluates based on the new URL.

URL check (`_isChatGPTUrl`): `hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')`.

The result: the extension icon is greyed out and non-clickable on every non-ChatGPT site. Content scripts are already restricted by `matches` in the manifest; this closes the remaining popup vector.

#### Job 2 — Write default settings on install

On `chrome.runtime.onInstalled`, writes factory-default values for all 7 feature toggles into `chrome.storage.sync` **only if they don't already exist** (uses `Object.keys(DEFAULTS)` to check). This ensures a fresh install has all toggles in the correct default state without overwriting user preferences on extension update.

**Default settings:**

| Key | Default | Description |
|---|---|---|
| `lagFix` | `true` | Typing lag virtualization |
| `compactSidebar` | `true` | Compact icon strip |
| `bulkActions` | `true` | Checkbox + bulk archive/delete |
| `modelBadge` | `true` | Model name badge in header |
| `contextBar` | `false` | Context % usage bar |
| `contextWarning` | `false` | Context full toast warning |
| `dateGroups` | `false` | Date-bucketed sidebar headings |
| `alphaMode` | `false` | Alpha Mode (experimental / unreleased features) |

> **v3.4.2 note:** `alphaMode` key added in v3.4.1; `onInstalled` defaults handler automatically writes the new key for existing users on extension update. The `onInstalled` handler correctly skips keys that already exist in storage, so updating from v3.3.0 preserves all user preferences.

---

### 3.3 `content.js`

**Role:** The heart of the extension. A 2233-line self-contained IIFE injected at `document_idle` into every `chatgpt.com` page. Implements all 8 active features, the global MutationObserver, SPA navigation handling, settings sync, and context invalidation protection.

#### Module-level Constants

```js
const CONFIG = {
  sel: {
    sidebarLink: 'nav a[href^="/c/"]',           // conversation links in sidebar
    msgBlock:    'main article[data-testid], div[data-message-author-role]',  // chat messages
    modelBtn:    'button[aria-label*="current model"]',  // model switcher button
    banner:      '[role="banner"]',               // top header bar
  },
  api: {
    conversations:    'https://chatgpt.com/backend-api/conversations',
    conversationBase: 'https://chatgpt.com/backend-api/conversation/',
  },
};
```

These selectors may break if ChatGPT changes their DOM. They are the first thing to verify when diagnosing a broken feature.

#### Safety Utilities

The extension runs many async operations. Chrome MV3 throws `"Extension context invalidated"` at the resumption point of any `await` when the service worker or content script is unloaded mid-operation. Four interlocking mechanisms prevent crashes:

| Utility | Purpose |
|---|---|
| `_dead` flag | Global boolean; set `true` the moment context invalidation is detected. All loops check this. |
| `_extCtxOk()` | Tries `chrome.runtime.id`; sets `_dead` and returns `false` if it throws. |
| `_isCtxErr(e)` | Checks if an error's message contains `"invalidat"` or `"extension context"`. |
| `_killScript()` | Sets `_dead = true` and disconnects all MutationObservers immediately. |

Wrapper functions `_storeGet(keys)`, `_storeSet(obj)`, and `_syncGet(defaults)` silently return empty results when the context is dead, so no try/catch is needed at every call site.

---

### 3.4 `popup.html`

**Role:** The HTML structure rendered inside the extension's toolbar popup. It is a pure static HTML file — no framework, no build step.

**Structure:**

```
┌──────────────────────────────────┐
│ ⚡ ChatGPT Enhanced        v3.4.2 │
├──────────────────────────────────┤
│ PERFORMANCE                      │
│  Typing Lag Fix          [toggle]│
│  Compact Sidebar         [toggle]│
├──────────────────────────────────┤
│ PRODUCTIVITY                     │
│  Bulk Archive / Delete   [toggle]│
│  Organize by Date NEW    [toggle]│
├──────────────────────────────────┤
│ HEADER TOOLS                     │
│  Model Badge             [toggle]│
├──────────────────────────────────┤
│ CONTEXT INTELLIGENCE NEW         │
│  Context % Bar           [toggle]│
│  Context Limit Warning   [toggle]│
├──────────────────────────────────┤
│ ALPHA MODE  ⚗                    │
│  Alpha Mode              [toggle]│
└──────────────────────────────────┘
```

**Key implementation details:**
- Each toggle row is a `<div class="toggle-row" data-key="SETTING_KEY">` where `data-key` matches exactly the key in `chrome.storage.sync`.
- `popup.js` reads all `data-key` attributes at runtime — no hardcoded keys in JS.
- The version number (`v3.4.0`) is rendered dynamically by `popup.js` from `chrome.runtime.getManifest().version`, so it never needs to be manually updated in HTML.
- The `badge-new` span is a visual-only indicator styled in `popup.css`.
- **v3.4.1**: Alpha Mode section added at the bottom — collapsible `<details>` block with its own toggle row, neutral white-opacity tint background, and ⚗ icon. Displayed only as a gated experimental section.
- **v3.4.0**: The "Coming soon" section and its divider were removed from the bottom of the popup. The corresponding `.coming-soon`, `.coming-soon-title`, `.coming-soon-list` CSS rules were also deleted from `popup.css`.

---

### 3.5 `popup.js`

**Role:** Wires up the popup's toggle switches to `chrome.storage.sync` and pushes setting changes to the active ChatGPT tab.

**Flow:**

1. **`DOMContentLoaded`** — calls `getSettings(cb)` which reads all 7 keys from `chrome.storage.sync` using the `DEFAULTS` object as the fallback.
2. For each `.toggle-row[data-key]` element, reads the current setting value, sets `checkbox.checked`, and attaches a `change` listener.
3. On toggle change: calls `saveAndNotify(settings)` which:
   - Saves the full settings object back to `chrome.storage.sync`.
   - Queries the active tab; if it's on `chatgpt.com`, sends a `CGPT_SETTINGS_UPDATE` message to the content script so features apply instantly without a page reload.
4. **`renderVersion()`** — writes the version string from the manifest into `#ext-version`.

**Why send a message instead of relying on `storage.onChanged`?**
Both actually happen. The `storage.onChanged` listener in `content.js` is the primary mechanism, but sending the explicit `CGPT_SETTINGS_UPDATE` message is a belt-and-suspenders fallback that guarantees the content script receives the update even if the storage event fires slightly out of order.

---

### 3.6 `popup.css`

**Role:** Styles the extension popup. Dark theme by design (matches ChatGPT's default dark UI). Width is fixed at 340px — the popup does not scroll.

**Design system (v3.4.2):**
- Background: `#1a1a1a` (near black)
- **All green/amber accents removed** — replaced throughout with black/white
- Primary accent (toggle ON track): `#ffffff`; toggle knob: `#000000`
- Text: `#ececec` (light grey)
- Secondary text: `rgba(255,255,255,0.35)`
- Toggle switch: custom iOS-style switch using a hidden `<input type="checkbox">` + `<span class="slider">`, no JavaScript required for animation (pure CSS transitions).

**Notable components:**
- `.badge-new` — small white/neutral pill label for `NEW` features (was green `#10a37f`).
- `.alpha-section` — collapsible Alpha Mode block with `rgba(255,255,255,0.04)` tint background.
- `.toggle-row` — flex row with left info block and right toggle switch.
- `.switch` / `.slider` — CSS-only animated toggle switch (38×22px).
- All sizes use `px` (not `rem`) because popup width is fixed and there is no need for responsive scaling.
- **v3.4.2**: All `#10a37f` (green) and amber (`#d97706`, amber rgba) colour values replaced with black/white equivalents. Delete button retains red.
- **v3.4.0**: `.coming-soon`, `.coming-soon-title`, `.coming-soon-list`, `.coming-soon-list li`, and `.coming-soon-list li::before` rules removed.

---

### 3.7 `styles.css`

**Role:** Injected as a content-script CSS file into every ChatGPT page. Provides the base styling for sidebar checkboxes, the action bar, and keyboard shortcut badge hiders.

**Why a separate CSS file (vs inline `<style>` tags in content.js)?**
Chrome injects content-script CSS before the page's own CSS, with lower specificity than `!important`. Using a separate file ensures styles load synchronously on page start rather than waiting for JavaScript to execute and inject a `<style>` tag. This avoids a flash of unstyled content for the checkbox area.

**Key rules:**

```css
/* Makes sidebar link the checkbox positioning context */
a.cgpt-bulk-item {
  position: relative !important;
  overflow: visible !important;    /* prevents checkbox clipping */
  transition: padding-left 0.12s;
}

/* Reveal checkbox on hover or when checked */
a.cgpt-bulk-item:hover { padding-left: 28px !important; }
a.cgpt-bulk-item:has(.cgpt-cb:checked) { padding-left: 28px !important; }

.cgpt-cb {
  position: absolute;
  left: 5px; top: 50%; transform: translateY(-50%);
  opacity: 0; pointer-events: none;   /* hidden by default */
  accent-color: #10a37f;              /* ChatGPT green checkbox */
}

/* Hide keyboard shortcut badges (Ctrl+K etc.) injected by ChatGPT's own UI */
[role="complementary"] *:has(> [aria-label="Control"]) {
  display: none !important;
}
```

**v3.4.2 checkbox override (injected by content.js):**
The `styles.css` base rule sets `accent-color: #ffffff` for checkbox colouring, but the real painted look is controlled by CSS injected into a `<style>` tag by `content.js` at boot:
- **Light theme, checked**: `background: transparent; border-color: rgba(0,0,0,.7)` + black 2.5px-stroke tick (`border-color: #000`)
- **Dark theme, checked**: same transparent background + white 2.5px-stroke tick (`.dark .cgpt-cb:checked::after { border-color: #fff }`)
- Tick geometry: 5×9 px, 2.5px stroke, no focus glow (`outline: none; box-shadow: none`)

This completely replaces the old green `#10a37f` / `#19c37d` fill that was hard-coded in the injected CSS.

Note: `:has()` is used here — Chrome 105+ only. This is fine since the extension targets Chrome users.

---

### 3.8 `package.json`

**Role:** Defines Node.js dependencies for the test suite. Not used for the extension itself (no build step, no bundler).

```json
{
  "dependencies":    { "playwright": "^1.58.2" },
  "devDependencies": { "@playwright/test": "^1.58.2" }
}
```

The `tests/` directory is currently empty. Playwright is installed ready for end-to-end tests that would automate a headless browser session on ChatGPT to verify extension behaviour. No tests have been written yet.

---

### 3.9 `assets/`

Contains logo images in multiple sizes for the extension icon:

| File | Size | Usage |
|---|---|---|
| `chatgpt-enhanced-128_logo.png` | 128×128 | Chrome Extensions page, high-DPI toolbar |
| `chatgpt-enhanced-48_logo.png` | 48×48 | Standard toolbar icon |
| `chatgpt-enhanced-1024_logo.png` | 1024×1024 | Chrome Web Store listing |
| `chatgpt-enhanced-full_logo.png` | Full width | Marketing / store banner |
| `Chatgpt-enhanced-logo.png` | Original source | Original design asset |

Note: Icon paths are not currently declared in `manifest.json`'s `icons` field — they exist in the repo but are not wired into the manifest. This is a known gap; adding them requires a `"icons"` key in the manifest.

---

## 4. Feature Inventory

All features live in `content.js`. Each has a setup function, a teardown function, and a setting key that enables/disables it at runtime.

---

### Feature 1 — Typing Lag Fix (Content-Visibility Virtualization)

**Setting key:** `lagFix` (default: `true`)

**Problem being solved:**  
Long ChatGPT conversations (50+ messages) cause severe browser lag when typing, because all message DOM nodes are rendered and layout-computed simultaneously. Scrolling through hundreds of large messages keeps Chrome's render engine pinned at high CPU.

**Solution — CSS `content-visibility: auto`:**  
Chrome's `content-visibility: auto` tells the browser it can skip rendering any element that is off-screen. Combined with `contain-intrinsic-block-size` (a reserved space hint so the scroll bar doesn't jump), this achieves near-zero CPU for off-screen messages.

**Implementation:**

```
IntersectionObserver (rootMargin: 200px)
       │
       ├─ element exits viewport → push to _vHideQ
       └─ element enters viewport → push to _vShowQ

queueMicrotask → _vFlush()
       │
       ├─ READ pass: measure height of new hides (getBoundingClientRect)
       └─ requestAnimationFrame → WRITE pass:
              ├─ hides: set contentVisibility='auto', containIntrinsicBlockSize=Npx
              └─ shows: clear both properties
```

**Why two frames?**  
Measuring `getBoundingClientRect` during layout causes a forced reflow if a write has just occurred in the same frame. The code separates reads (third frame) and writes (second frame) to avoid this "layout thrash" anti-pattern.

**Key variables:**

| Variable | Type | Purpose |
|---|---|---|
| `_msgObs` | `IntersectionObserver` | Watches all `[data-message-author-role]` elements |
| `_msgH` | `WeakMap<Element, number>` | Caches each element's measured height |
| `_vHideQ` / `_vShowQ` | `Array<Element>` | Batches pending hide/show operations |
| `_vTick` | `boolean` | De-duplicates microtask scheduling |

**Teardown:** `teardownVirtualization()` disconnects the observer and strips `contentVisibility`/`containIntrinsicBlockSize` from all elements.

---

### Feature 2 — Bulk Checkbox Injection

**Setting key:** `bulkActions` (default: `true`)

**What it does:**  
Injects a `<input type="checkbox">` into every `<a href="/c/UUID">` sidebar link. The checkbox is invisible until hover, then visible on hover or check. Multi-select with Shift+click is supported. Checked items are tracked in `_selectedIds` (a `Set`).

When any chat is selected, a floating **Action Bar** appears at the bottom-left of the sidebar with buttons:

| Button | Action |
|---|---|
| All | Fetches all conversation IDs from the API and selects them |
| None | Clears selection |
| Lock | Opens vault mode modal (see Feature 9) |
| Archive | PATCHes each selected chat with `{is_archived: true}` |
| Delete | PATCHes each selected chat with `{is_visible: false}` |
| Export | Opens export format picker (see Feature 10) |

**API calls for archive/delete:**

```
PATCH https://chatgpt.com/backend-api/conversation/{id}
Content-Type: application/json
Authorization: Bearer ...  (captured by background.js)

Body: { "is_archived": true }   // for Archive
Body: { "is_visible": false }   // for Delete
```

**Rate limiting:** A 200ms sleep between each API call. On HTTP 429, exponential backoff (300ms → 600ms → 1200ms). The browser is yielded every 10 items via `scheduler.yield()` (if available) to keep the tab responsive.

**Hover delegation:**  
Instead of attaching `mouseenter`/`mouseleave` per link (O(n) listeners), a single `mouseover`/`mouseout` delegated listener is attached to the `<nav>` element (O(1)). The handler uses `closest('.cgpt-bulk-item')` to find the relevant link.

**Lock icon:**  
Each sidebar link also receives a `<span class="cgpt-lock-icon">` (SVG padlock). It's hidden by default (`opacity: 0`) and becomes visible (amber = hidden, blue = encrypted) when the chat is locked via the vault.

---

### Feature 3 — Compact Sidebar

**Setting key:** `compactSidebar` (default: `true`)

**What it does:**  
ChatGPT's sidebar contains several navigation links (Search chats, Images, Apps, Codex, Projects) that take up vertical space. This feature hides those native links and replaces them with a compact horizontal icon strip — each button is a 30×30px clickable icon that triggers the same click as the original link.

**How links are found:**
- `findByHref(href)` — finds by `<a href="…">` attribute (for `/images`, `/apps`, `/codex`).
- `findByText(text)` — uses a `TreeWalker` on TEXT nodes only (faster than `querySelectorAll` on all elements) to find `"Search chats"` and `"Projects"` links which don't have fixed hrefs.

**Icon grid:**  
Created as a `<div id="cgpt-icon-grid">` with CSS flex row. Each button shows a 18×18 clone of the original link's SVG icon. On hover, a tooltip appears below the button with the original link's label text.

**Retry logic:**  
If fewer than 5 items are found (e.g. ChatGPT is slow to render the sidebar), a single retry is scheduled 500ms later with a module-level `_cgptGridRetried` boolean guard to prevent infinite loops.

> **v3.4.0 fix:** `_cgptGridRetried` was previously stored on `window` (`window._cgptGridRetried`), leaking to the global scope. It is now a module-level `let` inside the IIFE.

**Cleanup on disable:**  
Removes `#cgpt-icon-grid`, strips injected CSS, restores `display` on all hidden native links.

---

### Feature 4 — Model Badge

**Setting key:** `modelBadge` (default: `true`)

**What it does:**  
Reads the current AI model from the header button (`button[aria-label*="current model"]`) and injects a small styled badge next to the chat title displaying the model name (e.g. `o3-mini`, `gpt-4o`).

**Model downgrade detection:**  
Maintains `_maxRank` — the highest-ranked model seen in the current session. If the current model has a lower rank, the badge turns amber with a warning tooltip `"⚠️ Model was downgraded this session"`.

Model rank order (lowest to highest):
```
o1-mini → 4o-mini → gpt-4o-mini → 4o → gpt-4o → chatgpt-4o → 5.2 → o1 → o3-mini → o3 → o3-pro
```

**Observer approach:**  
- `MutationObserver` on the model button's `aria-label` attribute — ChatGPT already updates this natively when the model changes, so no polling timer is needed.
- A second `MutationObserver` on the header banner watches for badge removal (ChatGPT sometimes re-renders the header) and rebuilds the badge.

**Integration with Context Bar:**  
When the model changes, `_readModel()` also calls `_getCtxWindow(name)` to update the context window size used by Feature 7.

---

### Feature 7 — Context Bar & Context Warning

**Setting keys:** `contextBar`, `contextWarning` (both default: `false`)

**What it does:**  
Shows a live mini progress bar in the chat header indicating how full the model's context window is:
- Green fill → under 70%
- Orange fill → 70-89%
- Red fill → 90%+

Also shows absolute token counts (e.g. `14k / 128k`), a file-attachment count, and a click-to-open popover with detailed stats.

**Context Window Sizes:** (token limits per model)

| Model | Context |
|---|---|
| o3, o3-mini, o3-pro, o4, o4-mini, gpt-5 | 200,000 |
| o1, gpt-4o, gpt-4-turbo, gpt-4 | 128,000 |
| o1-mini, o1-preview | 128,000 |
| gpt-3.5 | 16,000 |

**Token data sources (in priority order):**

1. **SSE stream parsing** (`_parseSSE`): The service-worker fetch interceptor tees the ChatGPT conversation POST response body. The SSE stream contains `message.metadata.usage` fields with `prompt_tokens` and `completion_tokens`. These are read in real-time (throttled to 1 update/500ms during streaming, then a final render at `[DONE]`).

2. **Conversation API fetch** (`_fetchCtxData`): Fetches the full conversation JSON from `backend-api/conversation/{id}` and sums up usage fields across all messages. Used as a fallback when SSE data is unavailable, and also as a post-message refresh (debounced 2.5s via `_setupCtxRefreshObserver`).

> **v3.4.0 fix — content parts format:** ChatGPT's API previously returned `content.parts` as an array of plain strings. Newer models return objects: `[{type:"text", text:"..."}]`. The character-counting loop now handles both formats, so the char-based token estimate (`Math.round(chars / 4)`) is no longer stuck at 0 for new models.

**Context Warning Toast:**  
When `finish_details.type === "max_tokens"` appears in the SSE stream, a red toast appears at the bottom of the screen with a "Start a new chat" link. Auto-dismisses after 14 seconds.

**Context Popover:**  
Clicking the context bar pill opens a floating popover showing:
- Context usage with progress bar and percentage
- Current model name
- File attachment count with its own progress bar and status message
- Close-on-outside-click handler

**Why is `contextBar` off by default?**  
The SSE tee and conversation API fetch add minor overhead. Users who want it must opt in.

---

### Feature 8 — Sidebar Date Groups

**Setting key:** `dateGroups` (default: `false`)

**What it does:**  
Groups all sidebar conversations into time buckets with collapsible headings:

| Bucket | Criteria |
|---|---|
| Today | Same calendar day as now |
| Yesterday | Previous calendar day |
| Last 7 Days | Between 1 and 7 days ago |
| Last 30 Days | Between 7 and 30 days ago |
| Month Year | E.g. `February 2026`, `November 2025` |
| Older | Anything with no timestamp or very old |

**How it works:**
1. Fetches up to 500 conversations (5 pages × 100 per page) from `backend-api/conversations` with `offset` + `limit` pagination.
2. Maps each conversation `id` → bucket string using `_bucket(update_time)`.
3. Walks the sidebar DOM and inserts `<button class="cgpt-dg-hdr">` heading elements before the first link of each new bucket.
4. Headings are clickable — toggling `cgpt-dg-col` class and hiding/showing matching links via `cgpt-dg-hidden`.

**Timestamp handling:**  
The API can return `update_time` as either a Unix timestamp float (seconds) or an ISO-8601 string. The `_bucket()` function handles both:
```js
const msg = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
if (isNaN(msg.getTime())) return 'Older';
```

---

### Feature 9 — Chat Vault (PIN Lock)

**Setting key:** Enabled implicitly when `bulkActions` is `true` (vault header is always rendered if locked chats exist)

**What it does:**  
Allows users to select chats in the sidebar and lock them behind a 4-digit PIN. Locked chats are hidden from the sidebar (`display: none`) until the vault is unlocked.

**Locking modes (chosen via modal before first lock):**

| Mode | What happens |
|---|---|
| Hide only | Chat disappears from sidebar, hidden by PIN. Messages stored normally on ChatGPT's servers. |
| Encrypt + Hide | Every outgoing message is Base64-encoded before reaching ChatGPT. On any other device, chat shows only gibberish. Extension decodes it transparently. |

**PIN security:**  
- PIN is hashed with SHA-256 via `crypto.subtle.digest('SHA-256', ...)` and stored only as a hex hash in `chrome.storage.local` (key: `cgpt_pin_hash`).
- The raw PIN is never stored anywhere.
- On verification, the entered PIN is hashed and compared to `cgpt_pin_hash`.

**Vault Header:**  
A `<button id="cgpt-vault-hdr">` is injected into the sidebar nav. Displays count, encrypted count, and current open/closed state. Clicking it calls `_openVault()`.

**Auto-relock:**  
When the vault is opened, a 3-minute timer (`_vaultTimer`) is started. If the user doesn't close it explicitly, the vault relocks automatically.

**Persistence:**  
Locked and encrypted chat ID sets are saved to `chrome.storage.local` (`cgpt_locked_ids`, `cgpt_encrypted_ids`) so they survive page reloads and browser restarts.

---

### Feature 10 — Export Selected Chats

**Triggered via:** Export button in the bulk action bar

**What it does:**  
Fetches the full message history of each selected conversation and downloads it as:

- **Markdown (`.md`)** — Level-1 title heading, metadata block (model, date, message count), then `## USER` / `## ASSISTANT` sections. Pure string concatenation — no template literals. Null-guarded throughout.
- **Plain Text (`.txt`)** — `TITLE` line, metadata block, `[USER]` / `[ASSISTANT]` transcript labels, 80-char readable format. Same null guards.
- **PDF** — Minimal Tech Whitepaper aesthetic. Opens a new browser window with A4/1-inch-margin print HTML and triggers `window.print()`. Entirely black-and-white: system fonts (`-apple-system, 'Segoe UI'`), `#f5f5f5` code blocks, `1px solid #000` dividers, uppercase `USER`/`ASSISTANT` labels. No external font CDN dependency. A `<div class="footer">ChatGPT Enhanced</div>` is used instead of CSS `@page` margin boxes (which caused parse errors in Chrome's strict mode).

**Filename format:** `ChatTitle_YYYY-MM-DD.ext` (underscores, ISO date suffix)

**Export modal:** Black-and-white design — white background with black text (dark theme) or black background with white text (light theme). Format selector highlights use black/white borders only, no green.

**Message walk algorithm (`_walkMessages`):**  
ChatGPT stores conversations as a linked-list tree (mapping of node IDs). The active branch is traced from `data.current_node` upward via `.parent` links, collecting user and assistant messages in reverse order, then reversing to get chronological order. Handles both plain-string and `{type:"text", text:"..."}` object formats in `content.parts`.

**Template literal constraint:**  
All three builder functions (`_buildMd`, `_buildTxt`, `_buildPdfHtml`) use **zero template literals** — pure `+` string concatenation throughout. This is required because Chrome's strict mode JS parser rejects octal-like escape sequences (e.g. `\2014`, `\s`) that appear inside template literals at parse time, even when properly escaped. The `fmtBody()` regex that strips Markdown triple-backtick code fences is built via `RegExp(BT+BT+BT, 'g')` where `BT = String.fromCharCode(96)` to avoid literal backtick characters entirely.

**Export size:**  
Currently limited by fetch rate — 120ms between each conversation fetch. For 50 selected chats, expect ~6 seconds of fetching.

---

### Feature 11 — Vault Encryption (Base64 Channel)

**Enabled automatically when:** a chat is locked with "Encrypt + Hide" mode

**Architecture constraint — isolated JavaScript world:**  
Chrome MV3 content scripts run in an isolated JS context. `window.fetch` patching in a content script only intercepts the extension's OWN fetch calls, not ChatGPT's page requests. Therefore, outgoing message encoding cannot be done at the network layer.

**Solution — DOM-level send interceptor:**

1. Capture-phase `click` listener on the send button (`[data-testid="send-button"]`).
2. Capture-phase `keydown` listener for `Enter` key in the textarea.
3. On intercept: reads the raw text from `#prompt-textarea`, Base64-encodes it with `_encOutgoing()`, replaces the textarea content using `document.execCommand('insertText')` (which triggers React's internal state update), then re-fires the original event.

**First-message primer:**  
The very first message in an encrypted chat includes a system preamble telling the model:
- All incoming messages are Base64-encoded — decode before reading
- Reply ONLY with a single Base64 string (no surrounding text)
- Confirm by echoing a specific Base64 string back

**Decryption — incoming messages:**  
A `MutationObserver` on `<main>` watches for new `div[data-message-author-role="assistant"]` elements. When found, `_decryptMsgEl()` takes the raw `innerText`, attempts to Base64-decode it, and if successful, overlays the decoded plain text on top of the hidden encoded text.

**Decryption — user messages:**  
Sent user messages appear in the DOM as encoded Base64. `_restoreUserDisplay()` finds these DOM nodes and overlays the original readable text.

**UTF-8 safe encoding:**
```js
function _b64Enc(str) {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch { return btoa(str); }
}
```
Plain `btoa()` fails on non-ASCII characters. The `encodeURIComponent → unescape` dance converts to a byte-safe representation first.

---

## 5. Settings System

Settings flow through two Chrome storage areas:

```
chrome.storage.sync    ← 7 boolean feature flags (shared across devices)
chrome.storage.local   ← chatgpt_headers, cgpt_pin_hash, cgpt_locked_ids, cgpt_encrypted_ids
```

**Read path (content.js boot):**
```
_syncGet(DEFAULT_SETTINGS)
  → resolves with merged {defaults + stored values}
  → _s = merged
  → setupXxx() calls for each enabled feature
```

**Write path (popup.js):**
```
User toggles checkbox
  → saveAndNotify(settings)
      ├─ chrome.storage.sync.set(settings)
      └─ chrome.tabs.sendMessage → CGPT_SETTINGS_UPDATE
```

**Apply path (content.js):**
```
chrome.storage.onChanged (area='sync')
  OR
chrome.runtime.onMessage (type='CGPT_SETTINGS_UPDATE')
  → _apply(key)      ← per-key instant teardown/setup
```

The `_apply(key)` function handles each key individually with precise teardown so that disabling a feature removes all its DOM nodes and listeners without a page reload.

---

## 6. Architecture & Key Patterns

---

### Extension Context Invalidation Handling

MV3 service workers can be terminated by Chrome at any time. When this happens during an `await` in the content script, Chrome throws `"Extension context invalidated"` at the exact resumption point. 

Every `await` in an async function is wrapped in its own `try { ... } catch (e) { if (_isCtxErr(e)) { _killScript(); return; } }` so the script shuts down cleanly rather than crashing.

Additionally, at the module level:
```js
window.addEventListener('unhandledrejection', ev => {
  if (_isCtxErr(ev.reason)) { ev.preventDefault(); _killScript(); }
});
window.addEventListener('error', ev => {
  if (_isCtxErr(ev.error || ev.message)) { ev.preventDefault(); _killScript(); }
});
```
These catch any invalidation errors that slip through individual try/catch blocks.

---

### MutationObserver Strategy

The entire extension uses **one** top-level `MutationObserver` (`_mutObs`) on `document.body` with `{ childList: true, subtree: true }`. This observer:

1. **Fast-path attribute checks first (O(1))**: Reads `node.getAttribute('href')`, `node.hasAttribute('data-message-author-role')`, and `node.getAttribute('aria-label')` — these don't touch the DOM tree.
2. **Slow-path `querySelector` only if needed**: Entered only when the fast-path doesn't match AND the feature is enabled AND the mutation hasn't been scheduled yet.
3. **Schedules via `requestAnimationFrame`** with dedup flags (`_riInject`, `_riObserve`, `_riBadge`, `_riSidebar`): Multiple mutations in the same frame result in only one setup call.

This design avoids the O(n²) complexity of attaching separate observers per feature and prevents redundant DOM traversals.

---

### SPA Navigation Handling

ChatGPT is a single-page application. URL changes happen via `history.pushState` (navigating to a new chat) and `history.replaceState` (URL param changes like `?model=`).

The extension monkey-patches both:

```js
history.pushState = function (...a) {
  _origPush(...a);
  _onNav();  // full teardown + re-setup of all active features
};

history.replaceState = function (...a) {
  _origReplace(...a);
  // only refresh context bar, not full re-setup
  if (_s.contextBar || _s.contextWarning) { _fetchCtxData(chatId); }
};
```

`_onNav()` resets all per-chat state (token counts, model, sidebar bg cache), removes old context bar/warn/popover, and re-runs all active feature setups for the new page.

`popstate` (browser back/forward) is also handled: `window.addEventListener('popstate', _onNav, { passive: true })`.

---

### Header Capture via background.js

The flow for making authenticated API calls:

```
1. User sends a message in ChatGPT (or any API call is made)
2. background.js webRequest.onSendHeaders fires
3. Headers are written to chrome.storage.local['chatgpt_headers']
4. content.js getHeaders() reads from storage (with in-memory cache _hdrCache)
5. content.js uses headers in fetch() calls
```

The cache (`_hdrCache`) prevents re-reading storage on every API call. It is populated on first successful read and reused for the session.

> **v3.4.0 fix:** On a 401 response, `_fetchCtxData` now sets `_hdrCache = null` before retrying so that the next attempt re-reads fresh headers from storage rather than re-sending the same stale token.

> **v3.4.1 addition:** An 8-second watchdog timer and a `visibilitychange` listener were added so the model badge and context bar self-heal if ChatGPT re-renders the header or the tab is resumed from the background.

---

### Performance Philosophy

Every line of code in v3.4.2 is written with performance as the primary constraint:

| Anti-pattern avoided | What's done instead |
|---|---|
| `setInterval` polling | `MutationObserver` on specific attribute changes |
| `getComputedStyle` inside rAF write | Pre-computed and cached (`_sbBgCache`) |
| `getBoundingClientRect` in write frame | Measured in a dedicated READ frame |
| Multiple observers per feature | Single `_mutObs` on document.body |
| Per-link `mouseenter`/`mouseleave` listeners | Single delegated listener on `<nav>` |
| Rendering context bar on every SSE token | Throttled to 1 update / 500ms during streaming |
| Fetch interceptor on all navigation | Lazy-installed only when contextBar/contextWarning are enabled |
| `querySelectorAll` in MutationObserver hot path | Fast-path attribute checks first, `querySelector` only as fallback |

---

## 7. Version History & Changes

### v3.4.3 (current)

#### New behaviour — extension disabled on non-ChatGPT sites

`background.js` now calls `chrome.action.disable()` once at service-worker startup, globally greyining out the toolbar icon. Two event listeners then selectively re-enable it per tab:

- **`tabs.onActivated`** — fires when you switch to a tab; reads the URL via `chrome.tabs.get()` and enables or disables the action for that `tabId`.
- **`tabs.onUpdated`** — fires when a tab navigates; re-evaluates based on `changeInfo.url`.

URL check (`_isChatGPTUrl`): `hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com')`.

The popup is now completely inaccessible on non-ChatGPT pages — the icon is greyed out and clicking it does nothing. Content scripts and `host_permissions` were already scoped to `chatgpt.com`; this closes the remaining popup vector.

#### Version bump
- `manifest.json` `"version"` → `"3.4.3"`
- `console.log('[CGPT+] v3.4.3 ready')`

---

### v3.4.2

#### Bug fixes — Export template literal syntax errors

Chrome's strict-mode JS parser rejects escape sequences inside template literals that look like octal escapes (`\0`–`\7`), even when they are actually CSS property values or regex patterns encoded in a template string. This caused repeated `SyntaxError: Octal escape sequences are not allowed in template strings` on extension load.

Root causes found and fixed across multiple iterations:

1. **CSS inside template literal** — `_buildPdfHtml` originally built the entire `<style>` block as a template literal. CSS values like `\2014` (the `—` character code), font-family generic names, and selector strings with `\s` triggered the parser. Fix: moved all CSS into a `const cssLines = [...]` array of plain strings joined with `\n`. Zero template literals remain in the CSS block.
2. **`@page @bottom-center` margin box** — The `@page` at-rule with a `@bottom-center` content block inside a template literal was rejected. Fix: removed entirely; replaced with a `<div class="footer">ChatGPT Enhanced</div>` element in the HTML body.
3. **Stray extra `}` brace** — A spurious closing `}` appeared after the `_buildPdfHtml` function body, creating a syntax error that was misidentified as a template literal issue for several iterations.
4. **Backtick in regex pattern** — `fmtBody()` originally contained `` /```/g `` as a regex literal. Template literals cannot contain unescaped backticks. Fix: `const BT = String.fromCharCode(96)` + `RegExp(BT+BT+BT, 'g')` — no literal backtick characters anywhere in the source.
5. **`_buildMd` and `_buildTxt` template literals** — The heading lines (`` `# ${title}` ``, `` `## ${role}` ``, etc.) were replaced with string concatenation (`'# ' + title`, etc.).

All five fixes were validated with `node --check content.js` (clean parse) and a PowerShell scan confirming 0 backtick-containing lines in the export section (lines 1965–2085).

#### Version bump
- `manifest.json` `"version"` → `"3.4.2"`
- `console.log('[CGPT+] v3.4.2 ready')`

---

### v3.4.1

#### New features

- **Alpha Mode toggle** — New `alphaMode` setting (default `false`) added to `chrome.storage.sync`. Popup gains an "ALPHA MODE ⚗" section at the bottom with its own toggle. Background `onInstalled` defaults handler now writes `alphaMode: false` for existing users on update.

- **Compact popup redesign** — Popup layout made more compact. Tighter padding, smaller section gaps, condensed toggle rows.

#### Bug fixes — context bar & model badge self-healing

- **Watchdog timer** — An 8-second interval (`_watchdogTimer`) checks whether the model badge and context bar are still in the DOM. If either is missing and the feature is enabled, it re-runs setup. Prevents the bar vanishing silently after ChatGPT re-renders its header.
- **`visibilitychange` listener** — When the browser tab becomes visible again (`document.visibilityState === 'visible'`), the context data is re-fetched and the badge is rebuilt. Fixes the bar going stale after the tab is switched away and back.
- **`_onNav` teardown** — Navigation handler now explicitly disconnects `_bannerObs` and `_ctxRefreshObs` before re-setup, preventing observer leaks on SPA navigation.
- **`_bannerObs` subtree flag** — Banner MutationObserver now uses `{ subtree: true }` so that deep DOM mutations inside the banner (model button label changes) are still caught after ChatGPT updates.
- **Debounce reduction** — Context refresh debounce reduced from 2500 ms to 1200 ms for a faster visual update after a new message arrives.

#### Theme — full black/white

- **`popup.css`** — All `#10a37f` (ChatGPT green) and amber (`#d97706`, amber rgba) colour values replaced with black and white equivalents. Toggle ON track: `#ffffff`; knob: `#000000`. Alpha section uses neutral `rgba(255,255,255,0.04)` tint. Logo icon: `#ffffff`.
- **`styles.css`** — `accent-color: #10a37f` → `accent-color: #ffffff` for sidebar checkboxes.
- **Injected checkbox CSS** (`content.js`) — The `<style>` tag injected at boot replaced all green fill colours with transparent background + thick 2.5px-stroke pure black (light) / pure white (dark) tick marks.
- **Export modal** (`_showExportModal`) — Black/white modal, no green borders or highlights anywhere. Delete button retains red.

#### Version bump
- `manifest.json` `"version"` → `"3.4.1"`
- `console.log('[CGPT+] v3.4.1 ready')`

---

### v3.4.0

#### Bug fixes

- **Context bar insertion (DOM level):** `_getOrCreateCtxBar()` was inserting the bar as a sibling of the model badge inside a deeply nested header container that has `overflow:hidden` / `max-width` constraints. The 155px-wide bar was clipped invisibly. Fix: walk up from the anchor element to the banner's **direct child** level before inserting with `banner.insertBefore()`.

- **`_rebuildBadge` race condition:** Old code did `document.getElementById('cgpt-ctx-bar')?.remove()` inside a `requestAnimationFrame` then called `_getOrCreateCtxBar()` to recreate the bar — a race where `_onNav` might have already placed the bar correctly before the scheduled rAF ran and destroyed it. Fix: `_rebuildBadge` now repositions the existing bar using the same banner-level walk-up, never destroying it.

- **Context bar showing `— / 200k` (zero tokens):** Three sub-causes fixed:
  1. *API format change* — `content.parts` entries are now objects `{type:"text", text:"..."}` on newer ChatGPT models, not plain strings. The character-counting loop now handles both formats.
  2. *Stale auth cache on 401* — `_hdrCache` was never cleared on auth failure, so every retry reused the expired token. Fixed by setting `_hdrCache = null` before each retry.
  3. *Too few retries* — `_fetchCtxData` defaulted to `retries=2` (3 total, 3 s apart). If `background.js` hadn't captured headers yet at boot, the count exhausted before auth was available. Increased to `retries=5`; first retry after a no-headers 401 fires in 1.5 s instead of 3 s.

- **Boot retry for context bar:** `setupContextBar()` now checks `_ctxBarRetries` (max 6, 400 ms apart) and schedules a retry if `[role="banner"]` isn't in the DOM yet at boot time.

- **`_onNav` resets:** Navigation handler now resets `_ctxBarRetries = 0` and `_cgptGridRetried = false` so retries reset cleanly on every SPA navigation.

#### Scope / global cleanups (temp → permanent)

| Was | Now |
|---|---|
| `window._cgptGridRetried` | Module-level `let _cgptGridRetried = false` |
| `window._cgptFetchHooked` | Module-level `let _cgptFetchHooked = false` |
| `window._cgptSendHooked` | Module-level `let _cgptSendHooked = false` |
| `delete window._cgptGridWatcher` in teardown | Removed entirely (variable was never set anywhere in current codebase — dead reference from a prior version) |
| `delete window._cgptGridRetried` in teardown | Replaced with `_cgptGridRetried = false` (resets module var) |

#### UI cleanup

- Removed the "Coming soon" section (12-item list) from the bottom of `popup.html` and its accompanying divider.
- Removed `.coming-soon`, `.coming-soon-title`, `.coming-soon-list`, `.coming-soon-list li`, and `.coming-soon-list li::before` CSS rules from `popup.css`.

#### Version bump

- `manifest.json` `"version"` → `"3.4.0"`
- `content.js` file header comment → `v3.4.0`
- `console.log('[CGPT+] v3.4.0 ready')` updated

---

### v3.3.0
- **Feature 8 — Date Groups**: New feature. Groups sidebar into collapsible date buckets. Fetches up to 500 conversations from the API, maps each to a bucket, injects heading buttons above the first link of each bucket.
- **Feature 10 — Export**: New feature. Export selected chats as Markdown, plain text, or PDF. Full conversation walk via the linked-list `mapping` tree in the API response.
- **Feature 11 — Vault Encryption**: New feature. Base64-encode/decode channel for encrypted chats. DOM-level send interceptor using capture-phase listeners and `document.execCommand`. MutationObserver-based decrypt for incoming messages.
- **Vault Mode Picker Modal**: New modal before locking that lets users choose between "Hide only" and "Encrypt + Hide" protection levels.
- **Context Popover**: Clicking the context bar pill now opens a detailed stats panel (model, token usage, file count, file upload limit estimate).
- **Context file count**: `_ctxFiles` now tracks file attachment count from conversation API and SSE metadata. Shown in the popover with a separate progress bar.
- **`_ctxRefreshObs` / `_setupCtxRefreshObserver()`**: Replaced the broken SSE-tee approach for live context updates with a MutationObserver on `<main>` that debounces 2.5s after mutations and re-fetches conversation data. This actually works from an isolated content script world.
- **Action bar layout**: Two-row layout (count + Export button on top row, action buttons on bottom row).

### v3.2.x (prior)
- Context Bar feature introduced (Feature 7).
- SSE tee for real-time token updates (`_parseSSE`).
- `_installFetchInterceptor` — lazy fetch monkey-patch for SSE parsing.
- Model badge downgrade detection with rank table.
- Chat Vault with PIN (Feature 9) — hide-only mode.
- `_vaultPinModal` 4-digit dot PIN UI.
- SHA-256 PIN hash.
- Vault header button in sidebar.
- Auto-relock timer (3 min).

### v3.1.x (prior)
- Compact sidebar feature (Feature 3) with `TreeWalker`-based item discovery.
- Action bar redesign to fixed bottom overlay with background matching sidebar.
- Hover delegation moved from per-link to `<nav>`-level single listener.
- `_getSbBg()` with cached result (was re-running `getComputedStyle` on every `_renderActionBar` call).
- Settings toggle system: `_apply(key)` for instant per-key feature changes without reload.

### v3.0.0
- Full architecture rewrite from v2.7.
- Removed all `setInterval` timers (replaced by MutationObservers).
- Removed secondary `MutationObserver` per feature (consolidated to single `_mutObs`).
- Extension context invalidation handling added (`_dead` flag pattern).
- IntersectionObserver `rootMargin` reduced from 400px to 200px.
- Separated READ and WRITE frames in `_vFlush()`.
- `queueMicrotask` instead of nested `requestAnimationFrame` for vFlush trigger.
- `_idle()` helper for deferring non-critical boot work to idle time.
- Popup redesigned with dark theme, section labels, iOS-style toggles.
- "Coming soon" section added to popup.
- Version number dynamically rendered from manifest.

### v2.7 (pre-rewrite)
- Original implementation with `setInterval` polling for model badge.
- Multiple per-feature MutationObservers.
- Layout thrash in virtualization flush.
- Per-link hover listeners.
- Polling for context sync.

---

## 8. Known Gotchas & Developer Notes

### Selector fragility
All CSS selectors in `CONFIG.sel` target ChatGPT's DOM structure as of February 2026. ChatGPT frequently changes class names and DOM structure. If a feature breaks, check these selectors first:
- `nav a[href^="/c/"]` — sidebar conversation links
- `button[aria-label*="current model"]` — model switcher
- `div[data-message-author-role]` — message blocks
- `a[href="/images"]`, `a[href="/apps"]` — sidebar nav links (compact sidebar)

### isolated world limitation
Content scripts in Chrome MV3 share the DOM with the page but have a completely separate JavaScript context. This means:
- `window.fetch` patching ONLY intercepts the extension's own fetch calls
- React's state and internal event system are inaccessible
- `document.execCommand` is the only way to trigger React's controlled input update

### `execCommand` deprecation
`document.execCommand('insertText', ...)` is technically deprecated but is still widely supported in Chrome for textarea/contenteditable interaction. It is the only reliable way to update a React-controlled input without knowing the React fiber internals. Monitor for future breakage.

### Storage quota
`chrome.storage.local` has a 10MB quota. Stored data:
- `chatgpt_headers`: ~5 headers × ~100 chars = ~0.5KB
- `cgpt_locked_ids`: One UUID per locked chat = ~37 chars each (negligible)
- `cgpt_pin_hash`: 64 hex chars

`chrome.storage.sync` has a 100KB quota and 512B per-key limit. All 7 boolean settings total ~140 bytes.

### `scheduler.yield()` availability
Used in bulk API loops to yield the thread back to the browser. Available in Chrome 115+ under flag or Chrome 124+ stable. Falls back silently (the `if ('scheduler' in self && scheduler.yield)` guard) for older Chrome versions.

### MutationObserver performance
The single `_mutObs` on `document.body` with `subtree: true` observes every DOM change on the page — including ChatGPT's own streaming text updates. The fast-path attribute checks (`getAttribute`, `hasAttribute`) are O(1) and complete in microseconds per mutation, keeping the overhead minimal.

### Vault encryption is best-effort
The Base64 "encryption" depends on the AI model playing along with the primer instructions. It is not cryptographic encryption — a sufficiently clever person could read the Base64 if they had access to the raw chat. The "Encrypt" mode is designed for incidental privacy (e.g. another person looking at your screen) rather than adversarial security.

### Extension reload during async operations
When the extension is updated or disabled mid-session, all pending async operations throw. The `_dead` flag + `_killScript()` + top-level `unhandledrejection` handler ensure these are caught and silently discarded rather than surfacing as uncaught errors in the console.

### Context bar auth handshake timing
`background.js` captures auth headers only after the first real `fetch` to `backend-api/*` fires from the ChatGPT page. On a fresh browser start, content.js may boot before that first API call. `_fetchCtxData` handles this with up to 5 retries (1.5 s → 3 s delays) and busts `_hdrCache` on every 401 so stale tokens are never reused.

### content.parts API format
ChatGPT's conversation API has historically returned `content.parts` as `string[]`. As of early 2026, newer models (o3, o4-series, gpt-5) may return `{type:string, text:string}[]` objects. Always handle both shapes when iterating parts — check `typeof p === 'string'` first, then `typeof p.text === 'string'`.

### Template literals in Chrome extension content scripts
Chrome's strict-mode JS parser rejects escape sequences inside template literals that resemble legacy octal escapes (`\0`–`\7`), including sequences that appear in embedded CSS (e.g. `\2014` for em-dash, single-char `\s` patterns). This is a **parse-time** error — the code never runs. To embed CSS or regex patterns safely in a content script:
- Build CSS as an array of plain strings joined with `\n`, not a template literal.
- Use `RegExp(pattern, flags)` with `String.fromCharCode()` for any characters (backtick, backslash sequences) that cannot appear literally.
- Run `node --check <file>` after each change to catch these errors before reloading Chrome.
