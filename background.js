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

// ---------------------------------------------------------------------------
// Action enable/disable — only active on chatgpt.com tabs
// ---------------------------------------------------------------------------
function _isChatGPTUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'chatgpt.com' || host.endsWith('.chatgpt.com');
  } catch {
    return false;
  }
}

function _syncAction(tabId, url) {
  if (_isChatGPTUrl(url)) {
    chrome.action.enable(tabId);
  } else {
    chrome.action.disable(tabId);
  }
}

// Disable globally, then immediately re-enable any already-open ChatGPT tabs.
// This must run on every service worker wake (not just install), because MV3
// service workers are ephemeral — Chrome restarts them and re-executes all
// top-level code, which would otherwise leave ChatGPT tabs greyed out after
// a refresh or any event that woke the worker.
chrome.action.disable();
chrome.tabs.query({}, (tabs) => {
  for (const tab of tabs) {
    if (tab.id != null && tab.url) _syncAction(tab.id, tab.url);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab.url) return;
    _syncAction(tabId, tab.url);
  });
});

// Handle both navigations (changeInfo.url) and reloads (changeInfo.status).
// On a same-URL refresh, changeInfo.url is undefined but status fires 'complete'.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    _syncAction(tabId, tab.url || '');
  }
});

// ---------------------------------------------------------------------------
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
