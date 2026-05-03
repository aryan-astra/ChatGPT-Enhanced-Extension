<div align="center">

# Modus

<p align="center"><img src="assets/modus-banner.png" alt="Modus banner" /></p>

**A Chrome MV3 extension that makes ChatGPT faster, cleaner, and easier to manage.**

![Version](https://img.shields.io/badge/Version-3.5.1-0a7ea4?style=flat-square)
![Chrome](https://img.shields.io/badge/Chrome-MV3-3c873a?style=flat-square&logo=googlechrome&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Web-FF6D00?style=flat-square&logo=googlechrome&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

</div>

---

## Features

| # | Feature | Detail |
|---|---|---|
| 01 | Typing Lag Fix | Reduces long-chat rendering lag with faster UI handling |
| 02 | Compact Sidebar | Replaces dense history links with a compact icon layout |
| 03 | Bulk Actions | Select and manage multiple chats from one place |
| 04 | Model Badge | Shows the active model with fallback handling |
| 05 | Context Bar | Displays token usage and warning states |
| 06 | Date Groups | Groups chat history by time period |
| 07 | Chat Vault | Keeps hidden chats behind a PIN-protected vault |
| 08 | Header Capture | Captures auth headers for API-aware workflows |
| 09 | Smart Selectors | Uses selector fallbacks to stay resilient across UI changes |
| 10 | Zero Analytics | No tracking, no telemetry, no external services |
| 11 | Privacy First | Stores only what the extension needs locally |

---

## Getting Started

```bash
git clone https://github.com/aryan-astra/Modus.git
cd modus
```

1. Open `chrome://extensions` in Chrome or Edge.
2. Turn on Developer mode.
3. Click Load unpacked and choose this folder.
4. Open ChatGPT and use the extension toolbar popup to configure features.

---

## Releases

When `manifest.json`/`package.json` version is bumped and pushed to `main`, GitHub Actions creates tag `v<version>`, publishes a GitHub Release, and attaches the extension ZIP asset automatically.

Unzip the attached archive and load the extracted folder as an unpacked extension.

---

## Testing

```bash
npm run test:full
npm run playwright:diagnose
```

See [TESTING.md](TESTING.md) for the full testing guide.

---

## Project Layout

```text
manifest.json     Extension metadata
background.js     Service worker
content.js        Main runtime
popup.*           Settings UI
styles.css        Injected styles
assets/           Required logo files
tools/            Playwright utilities
```

---

## License

MIT License. See [LICENSE](LICENSE).
