# ChatGPT++ — Chrome Extension

> A performance-focused, privacy-first Chrome extension that improves the ChatGPT interface without modifying, storing, or transmitting your data.

**Version:** v3.4.3 &nbsp;·&nbsp; **Platform:** Chrome (Manifest V3) &nbsp;·&nbsp; **Target:** `chatgpt.com` only

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Privacy-First Architecture](#privacy-first-architecture)
4. [Permissions Explained](#permissions-explained)
5. [Installation](#installation)
6. [Folder Structure](#folder-structure)
7. [Development Setup](#development-setup)
8. [Versioning](#versioning)
9. [Roadmap](#roadmap)
10. [License](#license)
11. [Trademark Disclaimer](#trademark-disclaimer)

---

## Overview

ChatGPT++ is a Chrome browser extension that injects into `chatgpt.com` and adds functionality the native interface does not provide. It is designed around three principles:

- **Performance first.** Long conversations cause significant typing lag in the default ChatGPT UI. This extension eliminates that by virtualizing off-screen messages so Chrome does not render what you cannot see.
- **No external servers.** Every feature runs client-side. The extension makes API calls only to `chatgpt.com`'s own backend, using the same authentication tokens ChatGPT already uses. Nothing leaves your browser to a third-party server.
- **Opt-in by default.** Heavier features (context bar, date groups, alpha mode) are disabled by default and must be explicitly enabled. You control exactly what runs.

---

## Features

### Typing Lag Fix
ChatGPT renders every message in a conversation simultaneously, causing significant CPU/GPU load in long threads. This feature applies CSS `content-visibility: auto` to off-screen messages via an `IntersectionObserver`, telling Chrome it can skip layout and paint for anything outside the viewport. Off-screen messages are re-measured before being virtualized so the scrollbar does not jump. The result is near-zero rendering overhead for messages you are not currently reading.

**Default:** On

---

### Compact Sidebar
The ChatGPT sidebar contains several navigation links (Search, Images, Apps, Codex, Projects) that consume significant vertical space. This feature hides those links and replaces them with a compact horizontal icon strip — small clickable buttons that trigger the same actions as the originals, with hover tooltips.

**Default:** On

---

### Bulk Archive / Delete
Injects a checkbox into every conversation link in the sidebar. Checkboxes are invisible until hover, appearing only when you need them. Selecting one or more conversations reveals a floating action bar with options to:

- **Select All** — fetches all conversation IDs from the API and selects them
- **Deselect All**
- **Archive** — sends `PATCH /backend-api/conversation/{id}` with `{"is_archived": true}`
- **Delete** — sends `PATCH /backend-api/conversation/{id}` with `{"is_visible": false}`
- **Lock** — moves selected chats into the Chat Vault
- **Export** — exports selected chats to PDF, Markdown, or TXT

API calls are rate-limited at 200ms per request with exponential backoff on HTTP 429.

**Default:** On

---

### Organize by Date
Groups sidebar conversations into collapsible date buckets: Today, Yesterday, Last 7 Days, Last 30 Days, and month/year headings for older content. Fetches up to 500 conversations from the API to build the map, then injects heading elements directly into the sidebar DOM. Headings are clickable — clicking collapses or expands that group.

**Default:** Off

---

### Model Badge
Reads the current AI model from ChatGPT's header button and injects a small badge next to the chat title. The badge updates in real-time via a `MutationObserver` on the model button's `aria-label` attribute — no polling required.

Also tracks the highest-ranked model seen in the current session. If the model drops below that rank (e.g. ChatGPT silently falls back to a lower model), the badge turns amber with a warning tooltip.

**Default:** On

---

### Context % Bar
Shows a live token-usage progress bar in the chat header indicating how full the model's context window is. The bar changes colour at usage thresholds:

| Usage | Colour |
|---|---|
| < 70% | Green |
| 70–89% | Orange |
| ≥ 90% | Red |

Token counts are fetched from the conversation API (`/backend-api/conversation/{id}`) and refreshed after each new message. Clicking the bar opens a detailed popover showing token counts, the current model, and file attachment usage. Context window sizes are maintained per-model (200k for o3/o4-series, 128k for GPT-4o, etc.).

**Default:** Off

---

### Context Limit Warning
When ChatGPT's API returns `finish_details.type === "max_tokens"` (indicating the model hit its context ceiling mid-response), a red toast notification appears at the bottom of the screen with a direct link to start a new chat. The toast auto-dismisses after 14 seconds.

**Default:** Off

---

### Secure Chat Lock (Chat Vault)
Allows you to select conversations and lock them behind a 4-digit PIN. Locked chats are hidden from the sidebar until the correct PIN is entered. The PIN is hashed with SHA-256 via the browser's native `crypto.subtle` API — the raw PIN is never stored anywhere.

Two protection levels are available:

| Mode | What it does |
|---|---|
| **Hide only** | Removes the chat from the sidebar view. Messages remain on OpenAI's servers as normal. |
| **Encrypt + Hide** | Encodes every outgoing message as Base64 before it reaches ChatGPT. On any other device or signed-in account, the conversation appears as unreadable encoded text. The extension decodes it transparently on your device. |

The vault auto-relocks after 3 minutes of inactivity. Locked chat IDs persist in `chrome.storage.local` and survive browser restarts.

> **Note:** The Base64 channel is designed for incidental privacy (e.g. screen sharing), not adversarial cryptographic security. It relies on the AI model following a set of encoding/decoding instructions provided in the first message.

**Default:** Enabled when Bulk Actions is on (vault header appears automatically if locked chats exist)

---

### Export to PDF / Markdown / TXT
Exports selected conversations in three formats:

| Format | Style |
|---|---|
| **Markdown** | Level-1 title, metadata block, `## USER` / `## ASSISTANT` sections |
| **Plain Text** | Clean transcript with `[USER]` / `[ASSISTANT]` labels, no markup |
| **PDF** | Minimal whitepaper layout — A4, 1-inch margins, system fonts, strictly black and white. Opens in a new browser window and triggers `window.print()`. |

Filenames follow the format `ConversationTitle_YYYY-MM-DD.ext`. The conversation message tree is walked via ChatGPT's linked-list node structure (`current_node` → parent chain) to reconstruct the active branch in chronological order.

**Default:** Accessible via the Bulk Actions bar when chats are selected

---

### Alpha Mode
A gated toggle for experimental or in-development features. When enabled, unreleased functionality becomes accessible. Alpha Mode is clearly labelled in the popup and defaults to off. It is intended for testing purposes only.

**Default:** Off

---

## Privacy-First Architecture

ChatGPT++ collects no data. It has no analytics, no telemetry, no account system, and no external server of any kind.

- **API calls** go only to `chatgpt.com`'s own backend (`/backend-api/*`), using the same `Authorization` and `oai-*` headers that ChatGPT itself uses. These headers are captured from outgoing requests by the service worker and stored temporarily in `chrome.storage.local` for use within the same session.
- **Settings** are stored in `chrome.storage.sync` (synced across your signed-in Chrome profile, never sent to any third-party).
- **Vault data** (locked chat IDs, PIN hash, encrypted chat IDs) is stored in `chrome.storage.local` on your device only.
- **No content is read or stored.** The extension processes conversation data in memory only, for the purpose of rendering the export or the context bar. Nothing is written to disk or transmitted.

---

## Permissions Explained

| Permission | Why it is required |
|---|---|
| `activeTab` | Allows the popup to communicate with the currently active ChatGPT tab to apply settings changes immediately without a page reload. |
| `scripting` | Required for Manifest V3 dynamic script injection. |
| `webRequest` | Used to intercept outgoing request headers (specifically `Authorization` and `oai-*` headers) so the extension can make authenticated API calls on your behalf to ChatGPT's own backend. Read-only — the extension never blocks or modifies requests. |
| `storage` | Stores feature toggle preferences (`chrome.storage.sync`) and session data such as captured headers and vault state (`chrome.storage.local`). |
| `tabs` | Used to send settings-update messages to the active ChatGPT tab, and to enable/disable the extension toolbar icon based on whether the current tab is on `chatgpt.com`. |
| `host_permissions: *://chatgpt.com/*` | Restricts all content script injection and API interception exclusively to `chatgpt.com`. The extension does not run on any other website. |

---

## Installation

### Option A — Load Unpacked (Developer / Manual Install)

1. Download or clone this repository.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked**.
5. Select the root folder of this repository (the folder containing `manifest.json`).
6. The extension icon will appear in your toolbar. Navigate to `chatgpt.com` to use it.

To update after pulling new changes: click the **reload** icon (↺) on the extension card in `chrome://extensions`, then hard-refresh the ChatGPT tab with `Ctrl+Shift+R`.

### Option B — Chrome Web Store

> Coming soon. The extension is currently in pre-release.

---

## Folder Structure

```
chatgpt-enhanced/
├── manifest.json        Chrome Extension manifest (MV3)
├── background.js        Service worker — captures API headers, scopes icon to chatgpt.com
├── content.js           Main feature script injected into chatgpt.com (~2400 lines)
├── popup.html           Toolbar popup — feature toggle UI
├── popup.js             Popup logic — reads/writes chrome.storage.sync
├── popup.css            Popup styles — dark theme, black/white accents
├── styles.css           Content script CSS — sidebar checkboxes, action bar base styles
├── package.json         Node.js dependencies (Playwright, for future E2E tests)
├── assets/
│   ├── chatgpt-enhanced-48_logo.png     Toolbar icon (48px)
│   ├── chatgpt-enhanced-128_logo.png    Extensions page icon (128px)
│   ├── chatgpt-enhanced-1024_logo.png   Web Store listing (1024px)
│   └── chatgpt-enhanced-full_logo.png   Banner / marketing asset
└── tests/               Reserved for Playwright end-to-end tests (currently empty)
```

---

## Development Setup

### Prerequisites

- Chrome 105 or later (required for `:has()` CSS selector support)
- Node.js (optional — only needed for running the syntax check or future tests)

### Running Locally

```bash
# Clone the repository
git clone https://github.com/your-repo/chatgpt-enhanced.git
cd chatgpt-enhanced

# Install test dependencies (optional)
npm install

# Validate JavaScript syntax without running Chrome
node --check content.js
node --check background.js
node --check popup.js
```

Load the extension in Chrome using the **Load Unpacked** steps above.

### Making Changes

- Edit any source file directly — there is no build step or bundler.
- After changing `content.js`, `background.js`, `popup.*`, or `styles.css`: reload the extension in `chrome://extensions` (↺ button), then hard-refresh the ChatGPT tab (`Ctrl+Shift+R`).
- After changing `manifest.json`: reload the extension in `chrome://extensions`.
- Check the browser console (`F12 → Console`) for `[CGPT+] v3.4.3 ready` to confirm the correct version loaded.

### Key Constraints for Contributors

- **No template literals in `content.js`** — Chrome's strict-mode parser rejects escape sequences inside template literals that resemble octal codes (e.g. CSS values like `\2014`). Use string concatenation and `RegExp()` with `String.fromCharCode()` for any patterns that require special characters.
- **No `setInterval` polling** — all dynamic updates use `MutationObserver` or event listeners.
- **Single top-level `MutationObserver`** — all features share `_mutObs` on `document.body`. Do not add per-feature observers.
- **Check for context invalidation** — wrap every `await` in `try/catch` and check `_isCtxErr(e)`. The MV3 service worker can be terminated mid-async-operation.

---

## Versioning

This project uses [Semantic Versioning](https://semver.org/):

- **Patch** (x.x.**N**) — bug fixes, minor improvements, no new settings keys
- **Minor** (x.**N**.0) — new features, new settings keys added to `chrome.storage.sync`
- **Major** (**N**.0.0) — architectural rewrites or breaking changes to storage schema

The version number is defined in `manifest.json` and rendered dynamically in the popup via `chrome.runtime.getManifest().version`. It does not need to be manually updated in HTML.

Current version history is maintained in [`updates-till-now.md`](updates-till-now.md).

---

## Roadmap

The following features are under consideration. None are committed or scheduled.

- [ ] 16px dedicated toolbar icon asset
- [ ] Playwright end-to-end test suite
- [ ] Conversation search / filter in the sidebar
- [ ] Token cost estimator (per-model pricing overlay)
- [ ] Folder / tag system for sidebar organisation
- [ ] Chrome Web Store public release

---

## License

MIT License

```
Copyright (c) 2026 ChatGPT Enhanced Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Trademark Disclaimer

ChatGPT is a trademark of OpenAI, L.L.C. This extension is an independent, community-developed project and is not affiliated with, endorsed by, sponsored by, or in any way officially connected to OpenAI or any of its products or services. The use of the name "ChatGPT" in this project is solely for the purpose of identifying the third-party service that this extension operates alongside, in accordance with nominative fair use.
