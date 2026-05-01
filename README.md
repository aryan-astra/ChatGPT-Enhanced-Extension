# ChatGPT Enhanced

![Version](https://img.shields.io/badge/version-3.5.1-0a7ea4)
![Chrome MV3](https://img.shields.io/badge/Chrome-MV3-3c873a)
![Target](https://img.shields.io/badge/Target-chatgpt.com-111111)
![Status](https://img.shields.io/badge/status-active_canary-f59e0b)

ChatGPT Enhanced is a privacy-first Chrome extension that upgrades the ChatGPT web UI with performance, organization, and workflow features while keeping all processing local to your browser.

## Highlights

- Typing lag reduction for long chats via viewport-based rendering optimization.
- Bulk chat actions in the sidebar: select, archive, delete, and export.
- Live model badge and context-usage bar with warning states.
- Date-grouped chat history for faster navigation.
- Optional Chat Vault with PIN-based lock/hide flow.
- Compact sidebar mode with icon-grid shortcuts.

## Privacy and Data Handling

- No external backend, telemetry, analytics, or account system.
- Extension traffic targets only ChatGPT/OpenAI web APIs required for feature parity.
- Settings are stored in `chrome.storage.sync`.
- Session/header/cache and vault metadata are stored in `chrome.storage.local`.
- Conversation content is processed in-memory for rendering/exports and not sent to third-party services.

## Reliability Strategy

To reduce breakage when ChatGPT UI or DOM structures evolve, the extension uses:

- Selector fallback arrays for key anchors (sidebar links, model buttons, header banners).
- A single shared mutation observer with narrow scheduling gates.
- Feature-specific retries for early-load race conditions.
- Header capture from outbound backend requests to keep API-backed data accurate.

## Feature Set

- Typing Lag Fix: Optimizes offscreen message rendering.
- Compact Sidebar: Replaces verbose nav entries with a compact icon strip.
- Bulk Actions: Select all, archive, delete, and export flows.
- Model Badge: Displays active model label and fallback warning behavior.
- Context Bar and Warning: Shows context utilization and max-token warnings.
- Date Groups: Adds collapsible time buckets in chat history.
- Chat Vault (Alpha path): PIN-protected hidden chats and vault header controls.

## Project Structure

```text
chatgpt-enhanced/
  manifest.json          Extension metadata (MV3)
  background.js          Service worker (header capture + action state)
  content.js             Main runtime and feature logic
  popup.html             Extension popup shell
  popup.js               Popup setting handlers
  popup.css              Popup styling
  styles.css             Injected page styles
  assets/                Icons and branding assets
  tests/                 Test scaffold
```

## Installation (Local)

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked.
5. Select the repository root folder.
6. Open `chatgpt.com` and use the extension popup to configure features.

## Development

```bash
git clone <your-fork-url>
cd chatgpt-enhanced
npm install
node --check content.js
node --check background.js
node --check popup.js
```

Reload the extension from `chrome://extensions` after each source change.

## Branching and Release Flow

- `canary`: integration and hardening branch.
- `main`: stable release branch.

Recommended flow:

1. Implement and validate on `canary`.
2. Verify feature behavior on current ChatGPT UI.
3. Merge `canary` into `main` after validation.
4. Bump `manifest.json` version for release.

## Permissions

- `activeTab`, `tabs`: active-tab messaging and icon enablement.
- `storage`: persistent settings and local runtime metadata.
- `webRequest`: capture outbound auth and `oai-*` headers for API-backed features.
- `scripting`: MV3 runtime capability.
- `host_permissions`: scoped to ChatGPT/OpenAI domains in the manifest.

## Notes

- This project is independent and not affiliated with OpenAI.
- ChatGPT and OpenAI are trademarks of their respective owners.
