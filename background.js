// Headers we want to capture from outgoing ChatGPT API requests
const TARGET_URLS = ["https://chatgpt.com/backend-api/*"];
const TARGET_HEADERS = [
  "authorization",
  "oai-device-id",
  "oai-language",
  "oai-client-build-number",
  "oai-client-version"
];

// CRITICAL: "extraHeaders" is required to capture the Authorization header.
// Without it, Chrome blocks sensitive headers like Authorization from the webRequest API.
// onSendHeaders is non-blocking (read-only) — safe and correct for MV3.
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!details.requestHeaders || details.requestHeaders.length === 0) return;

    const headersToSave = {};
    let hasRelevantHeaders = false;

    for (const header of details.requestHeaders) {
      const lowerName = header.name.toLowerCase();
      if (TARGET_HEADERS.includes(lowerName) && header.value) {
        headersToSave[lowerName] = header.value;
        hasRelevantHeaders = true;
      }
    }

    if (hasRelevantHeaders) {
      chrome.storage.local.get(['chatgpt_headers']).then((result) => {
        const existingHeaders = result.chatgpt_headers || {};
        const merged = { ...existingHeaders, ...headersToSave };
        chrome.storage.local.set({ chatgpt_headers: merged });
      }).catch(() => {});
    }
  },
  { urls: TARGET_URLS },
  // "extraHeaders" is REQUIRED — without it, Authorization is never visible to webRequest
  ["requestHeaders", "extraHeaders"]
);

// Write default settings on first install (only if key doesn't exist yet)
chrome.runtime.onInstalled.addListener(() => {
  const DEFAULTS = {
    lagFix: true,
    compactSidebar: true,
    bulkActions: true,
    modelBadge: true,
    contextBar: false,
    contextWarning: false,
    dateGroups: false,
    alphaMode: false,
  };
  chrome.storage.sync.get(Object.keys(DEFAULTS), (stored) => {
    const missing = {};
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (!(k in stored)) missing[k] = v;
    }
    if (Object.keys(missing).length) chrome.storage.sync.set(missing);
  });
});
