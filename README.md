<div align="center">

# ChatGPT Enhanced

**Privacy-first Chrome extension that optimizes ChatGPT's UI with performance tuning, smart organization, and powerful workflow features — all processed locally in your browser.**

![Version](https://img.shields.io/badge/Version-3.5.1-0a7ea4?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-MV3-3c873a?style=flat-square&logo=googlechrome&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Web-FF6D00?style=flat-square&logo=googlechrome&logoColor=white)
![Status](https://img.shields.io/badge/Status-Production-22C55E?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

</div>

---

## ✨ Features

| # | Feature | What It Does |
|---|---------|-------------|
| 01 | **Typing Lag Fix** | Virtualized message rendering eliminates lag in long conversations |
| 02 | **Compact Sidebar** | Icon-grid navigation replaces verbose text entries for faster access |
| 03 | **Bulk Actions** | Select, archive, delete, and export multiple conversations at once |
| 04 | **Model Badge** | Live display of current model with auto-fallback for accuracy |
| 05 | **Context Bar** | Real-time token usage and warning states for context management |
| 06 | **Date Groups** | Organized, collapsible chat history by time period |
| 07 | **Chat Vault** | PIN-protected hidden chats with optional full encryption |
| 08 | **Header Capture** | Automatic auth header extraction for API data accuracy |
| 09 | **Smart Selectors** | Fallback selector arrays ensure resilience across ChatGPT updates |
| 10 | **Zero Analytics** | No tracking, no telemetry, no external dependencies |
| 11 | **Privacy First** | All data stays local—settings in chrome.storage.sync only |

---

## 🚀 Quick Start

### Installation

1. **Clone and load:**
   \\\ash
   git clone https://github.com/aryan-astra/ChatGPT-Enhanced-Extension.git
   cd chatgpt-enhanced
   \\\

2. **Open Chrome extensions:**
   - Go to \chrome://extensions\
   - Enable **Developer mode** (toggle in top-right)
   - Click **Load unpacked**
   - Select the cloned folder

3. **Visit ChatGPT:**
   - Open \https://chatgpt.com\
   - Extension popup in the toolbar to configure features

### Testing

\\\ash
npm run test:full
npm run playwright:diagnose
\\\

See [TESTING.md](TESTING.md) for detailed instructions.

---

## 🏗️ Architecture

### Reliability Strategy

To stay compatible as ChatGPT evolves:

- **Selector Fallbacks** — Multiple selector paths per element
- **Single Observer** — One shared MutationObserver with narrow scheduling gates
- **Feature Retries** — Auto-recheck at 3s to recover from race conditions
- **Header Extraction** — Auth headers captured for API data accuracy

### Performance Optimizations

- **Zero Polling** — Event-driven updates only
- **Layout Efficiency** — Batched DOM updates via requestAnimationFrame
- **CSS-First** — Visibility controlled by CSS :hover and :checked rules
- **O(1) Checks** — Fast-path attribute validation before traversal

### Key Files

\\\
manifest.json          Extension metadata (MV3)
background.js          Service worker (120 lines)
content.js             Main runtime (~2600 lines)
popup.html/js/css      Settings UI
styles.css             Injected page styles
assets/                Logo icons (48px, 128px)
tools/                 Playwright test scripts
\\\

---

## 🔒 Privacy & Data

| Component | Storage | Detail |
|-----------|---------|--------|
| **Settings** | chrome.storage.sync | Feature toggles |
| **Headers** | chrome.storage.local | Auth (temp, auto-cleared) |
| **Chat Data** | In-memory only | Never sent outside browser |
| **Vault** | chrome.storage.local | Encrypted IDs with PIN lock |

✅ **No external APIs** — No analytics, no backend, no third-party services

---

## 🛠️ Development

### Prerequisites

- Node.js (for test tools)
- Chrome/Chromium browser
- Git

### Validate Code

\\\ash
node --check content.js
node --check background.js
node --check popup.js
\\\

### Git Workflow

\\\ash
git checkout main          # Production-ready code
git checkout canary        # Testing new features
\\\

---

## 📋 Browser Support

- ✅ Chrome / Edge (MV3)
- ✅ chatgpt.com, *.chatgpt.com, chat.openai.com, *.openai.com
- ⚠️ Firefox and Safari — not supported (MV3 required)

---

## 🤝 Contributing

1. **Test** — Run \
pm run test:full\ to verify
2. **Report** — Create issue with console logs
3. **Code** — PRs welcome; follow selector fallback pattern

---

## 📄 License

MIT License — see [LICENSE](LICENSE)

---

## 🙏 Acknowledgments

Inspired by real ChatGPT usage patterns and built with performance & privacy first.

[GitHub Issues](https://github.com/aryan-astra/ChatGPT-Enhanced-Extension/issues)
