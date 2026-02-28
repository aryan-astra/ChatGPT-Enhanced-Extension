const DEFAULTS = {
  lagFix: true,
  compactSidebar: true,
  bulkActions: true,
  modelBadge: true,
  contextBar: false,
  contextWarning: false,
  dateGroups: false,
};

function getSettings(cb) {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    cb({ ...DEFAULTS, ...stored });
  });
}

function saveAndNotify(settings) {
  chrome.storage.sync.set(settings);
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (tab?.id && tab.url?.includes('chatgpt.com')) {
      chrome.tabs.sendMessage(tab.id, { type: 'CGPT_SETTINGS_UPDATE', settings }).catch(() => {});
    }
  });
}

function renderVersion() {
  const el = document.getElementById('ext-version');
  if (el && chrome.runtime?.getManifest) {
    const v = chrome.runtime.getManifest().version;
    if (v) el.textContent = 'v' + v;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderVersion();

  getSettings((settings) => {
    document.querySelectorAll('.toggle-row[data-key]').forEach((row) => {
      const key = row.dataset.key;
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!checkbox || !(key in settings)) return;

      checkbox.checked = settings[key];

      checkbox.addEventListener('change', () => {
        settings[key] = checkbox.checked;
        saveAndNotify(settings);
      });
    });
  });
});
