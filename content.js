// ===========================================================================
// ChatGPT Enhanced - content.js  v3.5.0
// Performance-first rewrite: zero unnecessary timers, zero layout thrash,
// zero redundant DOM traversals, minimal MutationObserver scope.
// ===========================================================================
(function () {
'use strict';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const CONFIG = {
  sel: {
    sidebarLink: 'nav a[href^="/c/"]',
    msgBlock:    'main article[data-testid], div[data-message-author-role]',
    modelBtn:    'button[aria-label*="current model"]',
    banner:      'header',   // <header> has no role attr — use tag selector
  },
  api: {
    conversations:    'https://chatgpt.com/backend-api/conversations',
    conversationBase: 'https://chatgpt.com/backend-api/conversation/',
    conversationInit: 'https://chatgpt.com/backend-api/conversation/init',
    memories:         'https://chatgpt.com/backend-api/memories',
    imagesBootstrap:  'https://chatgpt.com/backend-api/images/bootstrap',
    userSysMsg:       'https://chatgpt.com/backend-api/user_system_messages',
  },
};

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  lagFix:         true,
  compactSidebar: true,
  bulkActions:    true,
  modelBadge:     true,
  contextBar:     true,
  contextWarning: false,
  dateGroups:     false,
  alphaMode:      false,
};
let _s = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function isDark() {
  return document.documentElement.classList.contains('dark');
}
// Format a reset_after ISO timestamp into a human-readable string
// e.g. "in 3h 12m", "tomorrow", "Apr 3", "now"
function _fmtReset(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h < 1)  return 'in ' + m + 'm';
  if (h < 24) return 'in ' + h + 'h' + (m ? ' ' + m + 'm' : '');
  if (h < 36) return 'tomorrow';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Persistence — feature limits survive page reloads (file/image/research quotas).
// Raw ISO reset timestamps are stored so "resets in X" stays accurate.
// ---------------------------------------------------------------------------
const _LIMITS_PROG_KEY = 'cgptEnh_limitsProgress';

function _saveLimitsProgress() {
  try {
    if (!Object.keys(_limitsProgress).length) {
      localStorage.removeItem(_LIMITS_PROG_KEY);
      return;
    }
    localStorage.setItem(_LIMITS_PROG_KEY, JSON.stringify(_limitsProgress));
  } catch(e) {}
}
function _loadLimitsProgress() {
  try {
    const raw = localStorage.getItem(_LIMITS_PROG_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    // Discard any entry whose reset time has already passed
    const now = Date.now();
    const valid = {};
    for (const [k, v] of Object.entries(d)) {
      const resetMs = v.resetAfter ? new Date(v.resetAfter).getTime() : Infinity;
      if (resetMs > now) valid[k] = v;
    }
    if (Object.keys(valid).length) _limitsProgress = valid;
    else localStorage.removeItem(_LIMITS_PROG_KEY);
  } catch(e) {}
}

function extractId(href) {
  const m = href?.match(/\/c\/([^/?#]+)/);
  return m ? m[1] : null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// Returns false when the extension was reloaded mid-session (context invalidated).
// Always check this before any chrome.* call in async code.
let _dead = false; // set when context is confirmed dead; shuts down ALL async branches
function _extCtxOk() {
  if (_dead) return false;
  try { return !!chrome.runtime?.id; }
  catch { _dead = true; return false; }
}
function _killScript() {
  // Called once context is confirmed dead. Stop every live watcher.
  _dead = true;
  try { _mutObs?.disconnect(); } catch {}
}
// Checks whether an error caught in a try/catch is a Chrome context-invalidation
// error. Chrome may throw as a proper Error object OR as a plain string, so we
// check both e.message and String(e) to be safe.
function _isCtxErr(e) {
  const msg = (e?.message || String(e) || '').toLowerCase();
  return msg.includes('invalidat') || msg.includes('extension context') || !_extCtxOk();
}
// Safe wrappers — silently return empty results when context is gone.
function _storeGet(keys) {
  if (!_extCtxOk()) return Promise.resolve({});
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(keys, r => {
        try { resolve(chrome.runtime.lastError ? {} : r); } catch { resolve({}); }
      });
    } catch { _dead = true; resolve({}); }
  });
}
function _storeSet(obj) {
  if (!_extCtxOk()) return Promise.resolve();
  return new Promise(resolve => {
    try { chrome.storage.local.set(obj, resolve); }
    catch { _dead = true; resolve(); }
  });
}
function _syncGet(defaults) {
  if (!_extCtxOk()) return Promise.resolve(defaults);
  return new Promise(resolve => {
    try {
      chrome.storage.sync.get(defaults, r => {
        try { resolve(chrome.runtime.lastError ? defaults : r); } catch { resolve(defaults); }
      });
    } catch { _dead = true; resolve(defaults); }
  });
}
// In-memory header cache — populated on first successful storage read.
// Lets async functions that run after context invalidation skip the chrome.storage call.
let _hdrCache = null;
function getHeaders() {
  if (_hdrCache) return Promise.resolve(_hdrCache);
  return _storeGet(['chatgpt_headers']).then(r => {
    const h = r.chatgpt_headers || {};
    if (h.authorization) _hdrCache = h;
    return h;
  });
}
// Defer non-urgent work to idle time; falls back to setTimeout on Safari
function _idle(fn, timeout = 2000) {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout });
  else setTimeout(fn, 16);
}

// ---------------------------------------------------------------------------
// FEATURE 1 — Typing Lag Fix (content-visibility virtualization)
//
// What changed vs v2.7:
//   • rootMargin reduced 400px → 200px  (less over-observation = less IO callbacks)
//   • toShow's getBoundingClientRect moved out of rAF into a THIRD frame so no
//     layout read ever happens inside a write frame
//   • Used queueMicrotask instead of another rAF for the flush trigger, so work
//     is batched within the same task rather than adding an extra 16ms frame
// ---------------------------------------------------------------------------
let _msgObs = null;
const _msgH  = new WeakMap();
let _vHideQ  = [];
let _vShowQ  = [];
let _vTick   = false;

function _vFlush() {
  _vTick = false;
  const hides = _vHideQ.splice(0);
  const shows = _vShowQ.splice(0);

  // READ pass — measure only elements we haven't cached yet
  hides.forEach(el => {
    if (!_msgH.has(el)) {
      const h = el.getBoundingClientRect().height;
      _msgH.set(el, h > 20 ? h : 120);
    }
  });

  // WRITE pass — no layout reads here
  requestAnimationFrame(() => {
    hides.forEach(el => {
      if (el.dataset.cgptV) return;
      el.style.contentVisibility        = 'auto';
      el.style.containIntrinsicBlockSize = _msgH.get(el) + 'px';
      el.dataset.cgptV = '1';
    });
    shows.forEach(el => {
      if (!el.dataset.cgptV) return;
      el.style.contentVisibility        = '';
      el.style.containIntrinsicBlockSize = '';
      delete el.dataset.cgptV;
      // Update height cache in a separate frame — never read layout inside a write frame
      requestAnimationFrame(() => {
        if (!el.dataset.cgptV) {
          const h = el.getBoundingClientRect().height;
          if (h > 20) _msgH.set(el, h);
        }
      });
    });
  });
}

function setupVirtualization() {
  if (_msgObs) return;
  _msgObs = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      const el = entry.target;
      if (!entry.isIntersecting) { if (!el.dataset.cgptV) _vHideQ.push(el); }
      else                       { if (el.dataset.cgptV)  _vShowQ.push(el); }
    });
    if ((_vHideQ.length || _vShowQ.length) && !_vTick) {
      _vTick = true;
      queueMicrotask(_vFlush);
    }
  }, { rootMargin: '200px', threshold: 0 });
  observeMessages();
}

function teardownVirtualization() {
  if (_msgObs) { _msgObs.disconnect(); _msgObs = null; }
  _vHideQ = []; _vShowQ = []; _vTick = false;
  document.querySelectorAll('[data-cgpt-v]').forEach(el => {
    el.style.contentVisibility        = '';
    el.style.containIntrinsicBlockSize = '';
    delete el.dataset.cgptV;
    delete el.dataset.cgptVObs;
  });
}

function observeMessages() {
  if (!_msgObs) return;
  document.querySelectorAll(CONFIG.sel.msgBlock).forEach(el => {
    if (!el.dataset.cgptVObs) {
      el.dataset.cgptVObs = '1';
      _msgObs.observe(el);
    }
  });
}

// ---------------------------------------------------------------------------
// FEATURE 2 — Bulk Checkbox Injection
// ---------------------------------------------------------------------------
let _selectedIds = new Set();
let _lastCb      = null;
let _lockedIds    = new Set();
let _encryptedIds = new Set(); // subset of _lockedIds: chats with full Base64 encryption enabled
let _vaultOpen   = false;
let _vaultTimer  = 0;

function _cbShow(cb, checked, hover = false) {
  const v = checked || hover;
  cb.style.opacity       = v ? '1' : '0';
  cb.style.pointerEvents = v ? 'auto' : 'none';
}

function injectCheckboxes() {
  if (!document.getElementById('cgpt-cb-css')) {
    const s = document.createElement('style');
    s.id = 'cgpt-cb-css';
    s.textContent = `
      .cgpt-cb{-webkit-appearance:none;appearance:none;position:absolute;left:6px;top:50%;
        transform:translateY(-50%);width:15px;height:15px;margin:0;padding:0;z-index:99;
        cursor:pointer;flex-shrink:0;box-sizing:border-box;outline:none;
        border:1.5px solid rgba(107,114,128,.55);border-radius:3px;background:#fff;
        transition:opacity .1s,background .12s,border-color .12s;
        opacity:0;pointer-events:none;will-change:opacity;}
      .cgpt-cb:focus{outline:none;box-shadow:none;}
      .dark .cgpt-cb{background:#1e1e22;border-color:rgba(255,255,255,.28);}
      .cgpt-cb:checked{background:transparent;border-color:rgba(0,0,0,.7);}
      .dark .cgpt-cb:checked{background:transparent;border-color:rgba(255,255,255,.7);}
      .cgpt-cb:checked::after{content:'';display:block;width:5px;height:9px;
        border:2.5px solid #000;border-top:none;border-left:none;
        transform:rotate(45deg);position:absolute;top:0px;left:4px;}
      .dark .cgpt-cb:checked::after{border-color:#fff;}`;
    document.head.appendChild(s);
  }

  const links = document.querySelectorAll(CONFIG.sel.sidebarLink);
  if (!links.length) return;
  let n = 0;
  links.forEach((link, idx) => {
    if (link.dataset.cgptItem) return;
    const chatId = extractId(link.getAttribute('href'));
    if (!chatId) return;

    link.dataset.cgptItem  = '1';
    link.dataset.cgptId    = chatId;
    link.dataset.cgptIndex = idx;
    link.classList.add('cgpt-bulk-item');
    link.style.setProperty('position', 'relative', 'important');
    link.style.setProperty('overflow',  'visible',  'important');

    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'cgpt-cb';
    cb.dataset.chatId = chatId; cb.dataset.index = idx;
    cb.checked = _selectedIds.has(chatId);
    _cbShow(cb, cb.checked);

    cb.addEventListener('click',  e => e.stopPropagation());
    cb.addEventListener('change', e => {
      e.stopPropagation();
      if (e.shiftKey && _lastCb && _lastCb !== cb) {
        const lo = Math.min(+_lastCb.dataset.index, idx);
        const hi = Math.max(+_lastCb.dataset.index, idx);
        const st = _lastCb.checked;
        document.querySelectorAll('.cgpt-cb').forEach(o => {
          const i = +o.dataset.index;
          if (i >= lo && i <= hi) {
            o.checked = st; _cbShow(o, st);
            st ? _selectedIds.add(o.dataset.chatId) : _selectedIds.delete(o.dataset.chatId);
          }
        });
      } else {
        cb.checked ? _selectedIds.add(chatId) : _selectedIds.delete(chatId);
      }
      _cbShow(cb, cb.checked);
      link.style.setProperty('padding-left', cb.checked ? '28px' : '', 'important');
      _lastCb = cb;
      _renderActionBar();
    });
    link.insertBefore(cb, link.firstChild);
    if (_s.alphaMode) {
      _ensureLockCss();
      const lkBtn = document.createElement('span'); lkBtn.className = 'cgpt-lock-icon';
      lkBtn.title = _encryptedIds.has(chatId) ? 'Encrypted' : (_lockedIds.has(chatId) ? 'Hidden' : '');
      lkBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M18 10h-1V7a5 5 0 0 0-10 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-7H9V7a3 3 0 0 1 6 0v3z"/></svg>`;
      if (_lockedIds.has(chatId)) lkBtn.classList.add('cgpt-is-locked');
      if (_encryptedIds.has(chatId)) lkBtn.classList.add('cgpt-is-encrypted');
      link.appendChild(lkBtn);
    }
    n++;
  });
  if (n) {
    console.log(`[CGPT+] ${n} checkboxes injected`);
    // Single delegated listener on nav instead of per-link mouseenter/mouseleave.
    // mouseover/mouseout bubble; mouseenter/mouseleave do not — delegation requires the bubbling variants.
    const nav = document.querySelector('nav') || document.body;
    if (!nav._cgptHover) {
      nav._cgptHover = true;
      nav.addEventListener('mouseover', e => {
        const link = e.target.closest?.('.cgpt-bulk-item');
        if (!link) return;
        const cb = link.querySelector('.cgpt-cb');
        if (cb) { _cbShow(cb, cb.checked, true); link.style.setProperty('padding-left', '28px', 'important'); }
      }, { passive: true });
      nav.addEventListener('mouseout', e => {
        const link = e.target.closest?.('.cgpt-bulk-item');
        if (!link || link.contains(e.relatedTarget)) return;
        const cb = link.querySelector('.cgpt-cb');
        if (cb) { _cbShow(cb, cb.checked, false); if (!cb.checked) link.style.setProperty('padding-left', '', 'important'); }
      }, { passive: true });
    }
  }
}

// ---------------------------------------------------------------------------
// ACTION BAR
// What changed: getSidebarTheme() result cached between renders.
// getComputedStyle + DOM walk was running on EVERY renderActionBar call.
// ---------------------------------------------------------------------------
let _sbBgCache = null;
function _getSbBg() {
  if (_sbBgCache) return _sbBgCache;
  let el = document.querySelector('nav');
  while (el && el !== document.body) {
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)') { _sbBgCache = bg; return bg; }
    el = el.parentElement;
  }
  _sbBgCache = isDark() ? '#171717' : '#f9f9f9';
  return _sbBgCache;
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { _sbBgCache = null; });

function _renderActionBar() {
  let bar = document.getElementById('cgpt-action-bar');
  if (_selectedIds.size === 0) { bar?.remove(); return; }
  const dark = isDark();
  const bdr  = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.10)';
  const clr  = dark ? '#ececec' : '#111';
  const btnB = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)';
  const sb   = _getSbBg();
  if (!bar) {
    bar = document.createElement('div'); bar.id = 'cgpt-action-bar';
    // Column layout: count text on top row, action buttons on bottom row.
    // Sized tall enough to cover the sidebar user-info footer completely.
    // contain:layout style prevents the bar from triggering full-page layout.
    Object.assign(bar.style, {
      position:'fixed', bottom:'0', left:'0', width:'260px',
      display:'flex', flexDirection:'column', gap:'8px',
      padding:'12px 10px 16px', zIndex:'99999',
      boxSizing:'border-box', fontFamily:'inherit', contain:'layout style'
    });

    const topRow = document.createElement('div');
    Object.assign(topRow.style, { display:'flex', alignItems:'center', gap:'6px' });
    const cnt = document.createElement('span'); cnt.id = 'cgpt-count';
    Object.assign(cnt.style, { fontWeight:'700', fontSize:'13px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', flex:'1' });
    const expBtn = _mkBtn('Export', () => _showExportModal());
    expBtn.id = 'cgpt-exp-btn';
    Object.assign(expBtn.style, { fontSize:'11px', padding:'4px 8px', flexShrink:'0' });
    topRow.append(cnt, expBtn);

    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display:'flex', gap:'5px' });
    const lockBtn = _mkBtn('Lock', () => _bulkLock());
    lockBtn.id = 'cgpt-lock-btn';
    btnRow.append(
      _mkBtn('All',     () => _selectAll()),
      _mkBtn('None',    () => _deselectAll()),
      lockBtn,
      _mkBtn('Archive', () => _bulkAction('archive')),
      _mkBtn('Delete',  () => _bulkAction('delete'), true)
    );
    btnRow.querySelectorAll('.cgpt-ab-btn').forEach(b => b.style.flex = '1');

    bar.append(topRow, btnRow);
    document.body.appendChild(bar);
  }
  Object.assign(bar.style, { background:sb, borderTop:`1px solid ${bdr}`, color:clr, boxShadow: dark ? '0 -6px 24px rgba(0,0,0,.55)' : '0 -6px 24px rgba(0,0,0,.12)' });
  bar.querySelectorAll('.cgpt-ab-btn').forEach(b => {
    const danger = b.dataset.danger === '1';
    Object.assign(b.style, { background: danger ? '#c0392b' : btnB, color: danger ? '#fff' : clr, border:`1px solid ${danger ? 'transparent' : bdr}` });
  });
  document.getElementById('cgpt-count').textContent = `${_selectedIds.size} selected`;
  const lockBtn = document.getElementById('cgpt-lock-btn');
  if (lockBtn) {
    lockBtn.style.display = _s.alphaMode ? '' : 'none';
    const allLocked = _selectedIds.size > 0 && [..._selectedIds].every(id => _lockedIds.has(id));
    lockBtn.textContent = allLocked ? 'Unlock' : 'Lock';
  }
  const expBtn = document.getElementById('cgpt-exp-btn');
  if (expBtn) expBtn.style.display = _s.alphaMode ? '' : 'none';
}

function _mkBtn(label, fn, danger = false) {
  const b = document.createElement('button');
  b.textContent = label; b.className = 'cgpt-ab-btn'; b.dataset.danger = danger ? '1' : '0';
  Object.assign(b.style, { border:'none', borderRadius:'7px', padding:'5px 10px', fontSize:'12px', fontWeight:'500', cursor:'pointer', flexShrink:'0', fontFamily:'inherit', transition:'opacity .1s' });
  b.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); fn(); });
  b.addEventListener('mouseenter', () => b.style.opacity = '.75', { passive: true });
  b.addEventListener('mouseleave', () => b.style.opacity = '1',   { passive: true });
  return b;
}

// ---------------------------------------------------------------------------
// BULK API
// ---------------------------------------------------------------------------

// Mode-picker shown before locking — lets the user choose Hide-only vs Encrypt+Hide.
// Returns 'hide' | 'encrypt' | null (cancelled).
function _vaultModeModal(count) {
  return new Promise(resolve => {
    const dark = isDark();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,.65)', zIndex:'1000002', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' });
    const box = document.createElement('div');
    Object.assign(box.style, { background: dark ? '#1a1a1e' : '#fff', color: dark ? '#ececec' : '#111', borderRadius:'18px', padding:'26px 26px 20px', width:'min(390px,92vw)', boxShadow:'0 24px 64px rgba(0,0,0,.55)', display:'flex', flexDirection:'column', gap:'13px' });
    const ttl = document.createElement('div'); ttl.style.cssText = 'font-weight:700;font-size:15px';
    ttl.textContent = `Lock ${count} chat${count > 1 ? 's' : ''}`;
    const sub = document.createElement('div'); sub.style.cssText = 'font-size:11.5px;opacity:.45;margin-top:-5px';
    sub.textContent = 'Choose a protection level:';
    const opts = [
      { id:'hide',
        emoji:'🔒',
        label:'Hide only',
        desc:'Chats disappear from your sidebar and are hidden by PIN. Your messages are still stored normally on ChatGPT\u2019s servers \u2014 someone who logs into your account on another device can still read them.',
        badge:null },
      { id:'encrypt',
        emoji:'🔐',
        label:'Encrypt + Hide',
        desc:'Every message is Base64-encoded before it ever reaches ChatGPT. On any other device \u2014 mobile, another browser \u2014 the chat shows only unreadable gibberish. Real messages are decoded exclusively by this extension. Maximum privacy.',
        badge:'Best privacy' }
    ];
    let chosen = 'hide';
    const optWrap = document.createElement('div'); optWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px';
    const cards = opts.map(o => {
      const card = document.createElement('button');
      card.dataset.opt = o.id;
      Object.assign(card.style, { display:'flex', alignItems:'flex-start', gap:'12px', padding:'12px 13px', border: dark ? '1.5px solid rgba(255,255,255,.1)' : '1.5px solid rgba(0,0,0,.09)', borderRadius:'12px', background:'none', cursor:'pointer', fontFamily:'inherit', color: dark ? '#ececec' : '#111', textAlign:'left', transition:'border-color .12s,background .12s', width:'100%' });
      const em = document.createElement('span'); em.textContent = o.emoji; em.style.cssText = 'font-size:20px;flex-shrink:0;margin-top:1px';
      const tw = document.createElement('div'); tw.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex:1';
      const lr = document.createElement('div'); lr.style.cssText = 'display:flex;align-items:center;gap:7px';
      const lbl = document.createElement('span'); lbl.textContent = o.label; lbl.style.cssText = 'font-weight:600;font-size:13px'; lr.appendChild(lbl);
      if (o.badge) { const bk = document.createElement('span'); bk.textContent = o.badge; bk.style.cssText = 'font-size:9px;font-weight:700;padding:1px 6px;border-radius:20px;background:#10a37f;color:#fff;letter-spacing:.04em'; lr.appendChild(bk); }
      const dc = document.createElement('span'); dc.textContent = o.desc; dc.style.cssText = 'font-size:11px;opacity:.48;line-height:1.5';
      tw.append(lr, dc); card.append(em, tw);
      return card;
    });
    function markCard(id) {
      chosen = id;
      cards.forEach(c => { const a = c.dataset.opt === id; c.style.borderColor = a ? '#10a37f' : (dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.09)'); c.style.background = a ? (dark ? 'rgba(16,163,127,.12)' : 'rgba(16,163,127,.07)') : 'none'; });
    }
    cards.forEach(c => { c.addEventListener('click', () => markCard(c.dataset.opt)); optWrap.appendChild(c); });
    markCard('hide');
    const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:2px';
    const cancelBtn = document.createElement('button'); cancelBtn.textContent = 'Cancel';
    Object.assign(cancelBtn.style, { background:'none', color: dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)', border:'none', fontSize:'13px', cursor:'pointer', fontFamily:'inherit', padding:'8px 14px', borderRadius:'8px' });
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
    const lockBtn = document.createElement('button'); lockBtn.textContent = 'Lock';
    Object.assign(lockBtn.style, { background:'#10a37f', color:'#fff', border:'none', borderRadius:'9px', padding:'8px 20px', fontSize:'13px', fontWeight:'600', cursor:'pointer', fontFamily:'inherit' });
    lockBtn.onclick = () => { overlay.remove(); resolve(chosen); };
    row.append(cancelBtn, lockBtn);
    box.append(ttl, sub, optWrap, row);
    overlay.appendChild(box); document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { overlay.remove(); resolve(null); } }, { once: true });
    setTimeout(() => lockBtn.focus(), 30);
  });
}

// Lock or unlock all currently selected chats via the action bar.
async function _bulkLock() {
  if (!_selectedIds.size || !_extCtxOk()) return;
  const selected = [..._selectedIds];
  const allLocked = selected.every(id => _lockedIds.has(id));

  if (allLocked) {
    // Unlock all selected — verify PIN once
    let stored;
    try { stored = (await _storeGet(['cgpt_pin_hash'])).cgpt_pin_hash; }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (stored) { const pin = await _vaultPinModal('verify'); if (!pin) return; }
    selected.forEach(id => {
      _lockedIds.delete(id);
      _encryptedIds.delete(id);
      const link = document.querySelector(`a[data-cgpt-id="${id}"]`);
      if (!link) return;
      link.style.removeProperty('display');
      delete link.dataset.cgptLocked;
      delete link.dataset.cgptEncrypted;
      const lk = link.querySelector('.cgpt-lock-icon');
      if (lk) { lk.classList.remove('cgpt-is-locked', 'cgpt-is-encrypted'); lk.title = ''; }
    });
  } else {
    // Ask user which protection level they want
    const newCount = selected.filter(id => !_lockedIds.has(id)).length;
    const mode = await _vaultModeModal(newCount || selected.length);
    if (!mode) return;
    // Set PIN once if needed
    let stored;
    try { stored = (await _storeGet(['cgpt_pin_hash'])).cgpt_pin_hash; }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!stored) {
      const pin = await _vaultPinModal('set'); if (!pin) return;
      const hash = await _hashPin(pin);
      try { await _storeSet({ cgpt_pin_hash: hash }); }
      catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    }
    selected.forEach(id => {
      if (_lockedIds.has(id)) return;
      _lockedIds.add(id);
      if (mode === 'encrypt') _encryptedIds.add(id);
      const link = document.querySelector(`a[data-cgpt-id="${id}"]`);
      if (!link) return;
      link.dataset.cgptLocked = '1';
      if (mode === 'encrypt') link.dataset.cgptEncrypted = '1';
      const lk = link.querySelector('.cgpt-lock-icon');
      if (lk) {
        lk.classList.add('cgpt-is-locked');
        if (mode === 'encrypt') { lk.classList.add('cgpt-is-encrypted'); lk.title = 'Encrypted'; }
        else { lk.title = 'Hidden'; }
      }
      if (!_vaultOpen) link.style.setProperty('display', 'none', 'important');
    });
  }
  try { await _storeSet({ cgpt_locked_ids: [..._lockedIds], cgpt_encrypted_ids: [..._encryptedIds] }); }
  catch (e) { if (_isCtxErr(e)) _killScript(); return; }
  _renderVaultHeader();
  _renderActionBar();
}

async function _selectAll() {
  if (!_extCtxOk()) return;
  let h;
  try { h = await getHeaders(); } catch (e) { if (_isCtxErr(e)) _killScript(); return; }
  if (!_extCtxOk() || !h.authorization) { alert('Auth not captured yet.\nSend a message in ChatGPT first.'); return; }
  const cnt = document.getElementById('cgpt-count');
  const lim = 28; let off = 0, total = Infinity;
  try {
    while (off < total) {
      if (!_extCtxOk()) return;
      let r;
      try { r = await fetch(`${CONFIG.api.conversations}?offset=${off}&limit=${lim}`, { headers: h }); }
      catch (e) { if (_isCtxErr(e)) { _killScript(); return; } throw e; }
      if (!r.ok) throw new Error(r.status);
      let d;
      try { d = await r.json(); }
      catch (e) { if (_isCtxErr(e)) { _killScript(); return; } throw e; }
      total = d.total ?? (d.items || d.conversations || []).length;
      (d.items || d.conversations || []).forEach(x => _selectedIds.add(x.id));
      off += lim;
      if (cnt) cnt.textContent = `Fetched ${Math.min(off, total)}/${total}…`;
      if (off % (lim * 4) === 0 && 'scheduler' in self && scheduler.yield) {
        try { await scheduler.yield(); } catch (e) { if (_isCtxErr(e)) { _killScript(); return; } throw e; }
      }
      try { await sleep(100); } catch (e) { if (_isCtxErr(e)) { _killScript(); return; } throw e; }
    }
  } catch (e) {
    if (!_isCtxErr(e)) alert('Failed to fetch conversations.');
    else _killScript();
  }
  document.querySelectorAll('.cgpt-cb').forEach(cb => { if (_selectedIds.has(cb.dataset.chatId)) cb.checked = true; });
  _renderActionBar();
}

function _deselectAll() {
  _selectedIds.clear();
  // Batch all DOM writes in one rAF to avoid repeated style recalcs
  requestAnimationFrame(() => {
    document.querySelectorAll('.cgpt-cb').forEach(cb => {
      cb.checked = false;
      _cbShow(cb, false);
      cb.closest('.cgpt-bulk-item')?.style.removeProperty('padding-left');
    });
    _renderActionBar(); // size=0 → removes the bar
  });
}

async function _bulkAction(action) {
  if (!_selectedIds.size || !_extCtxOk()) return;
  if (action === 'delete') {
    let ok;
    try { ok = await _modal({ title:`Delete ${_selectedIds.size} conversation${_selectedIds.size > 1 ? 's' : ''}?`, message:'This cannot be undone.', buttons:[{ label:'Cancel', value:false }, { label:'Delete', danger:true, value:true }] }); }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!ok) return;
  }
  if (!_extCtxOk()) return;
  let h;
  try { h = await getHeaders(); } catch (e) { if (_isCtxErr(e)) _killScript(); return; }
  if (!_extCtxOk() || !h.authorization) { alert('Auth not captured.'); return; }
  const cnt  = document.getElementById('cgpt-count');
  const ids  = [..._selectedIds];
  const body = action === 'delete' ? { is_visible: false } : { is_archived: true };
  const verb = action === 'delete' ? 'Deleting' : 'Archiving';
  let done = 0;
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (cnt) cnt.textContent = `${verb} ${i + 1}/${ids.length}…`;
    let ok = false, backoff = 300;
    for (let t = 0; t < 3 && !ok; t++) {
      try {
        let r;
        try { r = await fetch(`${CONFIG.api.conversationBase}${id}`, { method:'PATCH', headers:{ ...h, 'Content-Type':'application/json' }, body:JSON.stringify(body) }); }
        catch (e) { if (_isCtxErr(e)) { _killScript(); return; } break; }
        if (r.ok || r.status === 202) ok = true;
        else if (r.status === 429) {
          backoff *= 2;
          try { await sleep(backoff + Math.random() * 200); } catch (e) { if (_isCtxErr(e)) { _killScript(); return; } }
        }
        else break;
      } catch (e) {
        if (_isCtxErr(e)) { _killScript(); return; }
        break;
      }
    }
    if (ok) { done++; _selectedIds.delete(id); }
    // Yield to UI every 10 items so the tab stays responsive
    if (i % 10 === 9 && 'scheduler' in self && scheduler.yield) {
      try { await scheduler.yield(); } catch (e) { if (_isCtxErr(e)) { _killScript(); return; } }
    }
    try { await sleep(200); } catch (e) { if (_isCtxErr(e)) { _killScript(); return; } }
  }
  if (cnt) cnt.textContent = `Done (${done}/${ids.length}). Reloading…`;
  // Full reload is intentional: ChatGPT's React state owns its conversation
  // list in memory. Surgically patching the sidebar DOM would drift from that
  // state and break navigation. A reload gives a clean, consistent UI.
  setTimeout(() => location.reload(), 1200);
}

// ---------------------------------------------------------------------------
// MODAL
// ---------------------------------------------------------------------------
function _modal({ title, message, buttons }) {
  return new Promise(resolve => {
    const dark = isDark();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,.55)', zIndex:'1000000', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' });
    const box = document.createElement('div');
    Object.assign(box.style, { background: dark ? '#2a2a2a' : '#fff', color: dark ? '#ececec' : '#111', borderRadius:'14px', padding:'24px 28px 20px', width:'min(380px,90vw)', boxShadow:'0 16px 48px rgba(0,0,0,.45)', display:'flex', flexDirection:'column', gap:'12px' });
    const t = document.createElement('div'); t.textContent = title; Object.assign(t.style, { fontWeight:'700', fontSize:'16px' });
    const m = document.createElement('div'); m.textContent = message; Object.assign(m.style, { fontSize:'14px', opacity:'.7', marginBottom:'4px' });
    const row = document.createElement('div'); Object.assign(row.style, { display:'flex', gap:'8px', justifyContent:'flex-end' });
    buttons.forEach(({ label, value, danger }) => {
      const b = document.createElement('button'); b.textContent = label;
      Object.assign(b.style, { background: danger ? '#c0392b' : (dark ? '#3a3b45' : '#f0f0f0'), color: danger ? '#fff' : (dark ? '#ececec' : '#111'), border:'none', borderRadius:'8px', padding:'8px 18px', fontSize:'14px', fontWeight:'600', cursor:'pointer', fontFamily:'inherit' });
      b.onclick = () => { overlay.remove(); resolve(value); };
      row.appendChild(b);
    });
    overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { overlay.remove(); resolve(null); } }, { once: true });
    box.append(t, m, row); overlay.appendChild(box); document.body.appendChild(overlay);
    setTimeout(() => row.lastElementChild?.focus(), 10);
  });
}

// ---------------------------------------------------------------------------
// FEATURE 3 — Compact Sidebar
// What changed:
//   • findByText replaced with TreeWalker — traverses TEXT nodes only, not all
//     elements. O(text-nodes) vs O(all-elements). Zero child-node scanning.
//   • Removed the secondary gObs MutationObserver — global _mutObs handles it.
//   • _cgptGridRetried moved from window to module scope — cleaner isolation.
// ---------------------------------------------------------------------------
let _cgptGridRetried = false;
function setupCompactSidebar() {
  if (document.getElementById('cgpt-icon-grid')) return;
  const dark    = isDark();
  const iconClr = dark ? '#c9cdd4' : '#4b5563';
  const hoverBg = dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)';
  const actBg   = dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.12)';
  const tipBg   = dark ? '#1e1e22' : '#fff';
  const tipClr  = dark ? '#e5e7eb' : '#111827';
  const tipBdr  = dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.10)';

  let newChatA = null;
  for (const a of document.querySelectorAll('a[href="/"]')) {
    if (a.textContent.toLowerCase().includes('new chat')) { newChatA = a; break; }
  }
  if (!newChatA) return;
  Array.from(newChatA.children).forEach((ch, i) => { if (i > 0) ch.style.setProperty('display', 'none', 'important'); });

  const sidebar = newChatA.closest('[role="complementary"]') || newChatA.parentElement;
  if (!sidebar) return;
  let ncBlock = newChatA;
  while (ncBlock.parentElement && ncBlock.parentElement !== sidebar) ncBlock = ncBlock.parentElement;
  const sidebarNav = sidebar.closest('[role="navigation"]') || sidebar.parentElement || null;
  const qRoot = sidebarNav || document.body;

  function findByHref(href) {
    const a = qRoot.querySelector(`a[href="${href}"]`);
    if (!a) return null;
    const icon = a.querySelector('svg') || a.querySelector('img');
    // TreeWalker on text nodes only — avoids spreading a full NodeList array
    const tw2 = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.trim() && !n.parentElement.closest('svg') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    const tn2 = tw2.nextNode();
    const leaf = tn2 ? { textContent: tn2.textContent.trim() } : null;
    const row  = a.closest('[data-sidebar-item]') || a;
    return { native: row, label: leaf?.textContent.trim() || href.slice(1), icon };
  }

  // TreeWalker only visits text nodes — avoids scanning every element
  function findByText(text) {
    const tw = document.createTreeWalker(qRoot, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.trim() === text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    const tn = tw.nextNode();
    if (!tn) return null;
    const el  = tn.parentElement;
    const row = el?.closest('[data-sidebar-item]') || el?.parentElement?.parentElement || el?.parentElement;
    const icon = row?.querySelector('svg') || row?.querySelector('img');
    return { native: row, label: text, icon };
  }

  const ITEMS = [
    findByText('Search chats'), findByHref('/images'), findByHref('/apps'),
    findByHref('/codex'), findByText('Projects'),
  ].filter(Boolean);
  if (!ITEMS.length) return;

  if (ITEMS.length < 5 && !_cgptGridRetried) {
    _cgptGridRetried = true;
    setTimeout(() => {
      document.querySelectorAll('[data-cgpt-grid-hidden],[data-cgpt-container-hidden]').forEach(el => {
        el.style.removeProperty('display');
        delete el.dataset.cgptGridHidden; delete el.dataset.cgptContainerHidden;
      });
      document.getElementById('cgpt-icon-grid')?.remove();
      _cgptGridRetried = false;
      setupCompactSidebar();
    }, 500);
  }

  let s = document.getElementById('cgpt-compact-css');
  if (!s) { s = document.createElement('style'); s.id = 'cgpt-compact-css'; document.head.appendChild(s); }
  s.textContent = `
    #cgpt-icon-grid{display:flex;flex-direction:row;align-items:center;gap:2px;padding:2px 6px 0}
    .cgpt-grid-btn{position:relative;display:flex;align-items:center;justify-content:center;
      width:30px;height:30px;flex-shrink:0;padding:0;border:none;border-radius:7px;
      background:transparent;cursor:pointer;color:${iconClr};transition:background .12s;outline:none}
    .cgpt-grid-btn:hover{background:${hoverBg}}.cgpt-grid-btn:active{background:${actBg}}
    .cgpt-grid-btn svg,.cgpt-grid-btn img{width:18px;height:18px;pointer-events:none;flex-shrink:0}
    .cgpt-grid-btn .cgpt-tip{position:absolute;top:calc(100% + 4px);left:50%;
      transform:translateX(-50%) translateY(-2px);white-space:nowrap;
      background:${tipBg};color:${tipClr};border:1px solid ${tipBdr};border-radius:5px;
      padding:2px 8px;font-size:11px;font-weight:500;pointer-events:none;opacity:0;
      transition:opacity .12s,transform .12s;z-index:10000;box-shadow:0 3px 10px rgba(0,0,0,.18);font-family:inherit}
    .cgpt-grid-btn:hover .cgpt-tip{opacity:1;transform:translateX(-50%) translateY(0)}
    [role="navigation"]{row-gap:0!important;gap:0!important}
    [role="complementary"]{padding-bottom:0!important;margin-bottom:0!important}
    [role="complementary"]>*{margin-bottom:0!important}`;

  const grid = document.createElement('div'); grid.id = 'cgpt-icon-grid';
  ITEMS.forEach(({ native, label, icon }) => {
    native.style.setProperty('display', 'none', 'important');
    native.dataset.cgptGridHidden = '1';
    const btn = document.createElement('button'); btn.className = 'cgpt-grid-btn'; btn.setAttribute('aria-label', label);
    if (icon) { const c = icon.cloneNode(true); c.removeAttribute('width'); c.removeAttribute('height'); c.style.cssText = 'width:18px;height:18px;flex-shrink:0'; btn.appendChild(c); }
    else { const fb = document.createElement('span'); fb.textContent = label[0].toUpperCase(); fb.style.cssText = `font-size:13px;font-weight:700;color:${iconClr}`; btn.appendChild(fb); }
    const tip = document.createElement('span'); tip.className = 'cgpt-tip'; tip.textContent = label; btn.appendChild(tip);
    btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); native.click(); });
    grid.appendChild(btn);
  });
  ncBlock.insertAdjacentElement('afterend', grid);

  if (qRoot !== document.body) {
    for (const ch of [...qRoot.children]) {
      if (!ch || ch === sidebar || ch.contains(sidebar)) continue;
      if (ch.querySelector?.('a[href^="/c/"]')) continue;
      if (!ch.children.length) continue;
      if ([...ch.children].every(c => c.dataset.cgptGridHidden === '1')) {
        ch.style.setProperty('display', 'none', 'important');
        ch.dataset.cgptContainerHidden = '1';
      }
    }
  }
  // No secondary MutationObserver — _mutObs already detects icon-grid removal.
}

// ---------------------------------------------------------------------------
// FEATURE 4 — Model Badge
// What changed: _syncModelFromBtn (setInterval 3s) is gone. Model reads happen
// only through MutationObserver on the button's aria-label, which ChatGPT
// already updates natively. Zero polling overhead.
// ---------------------------------------------------------------------------
const MODEL_RANK = ['o1-mini','4o-mini','gpt-4o-mini','4o','gpt-4o','chatgpt-4o','5.2','o1','o3-mini','o3','o3-pro'];
let _maxRank    = -1;
let _modelBtnObs = null;
let _bannerObs   = null;

function _modelRank(n) {
  const s = (n || '').toLowerCase();
  let best = -1;
  MODEL_RANK.forEach((m, i) => { if (s.includes(m)) best = i; });
  return best;
}
function _badgeTheme(down) {
  const dark = isDark();
  return down
    ? { border:'1px solid rgba(234,88,12,.55)', background: dark ? '#3b1a08' : '#fff7ed', color: dark ? '#fdba74' : '#9a3412' }
    : { border: dark ? '1px solid rgba(255,255,255,.14)' : '1px solid rgba(0,0,0,.12)', background: dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)', color: dark ? '#ececec' : '#111' };
}

function _buildBadge(btn) {
  document.getElementById('cgpt-model-badge')?.remove();
  const th = _badgeTheme(false);
  const b  = document.createElement('div'); b.id = 'cgpt-model-badge';
  Object.assign(b.style, { display:'inline-flex', alignItems:'center', gap:'5px', padding:'3px 10px 3px 8px', borderRadius:'8px', border:th.border, background:th.background, color:th.color, fontSize:'13px', fontWeight:'500', fontFamily:'inherit', cursor:'default', userSelect:'none', pointerEvents:'none', flexShrink:'0', transition:'border-color .25s,background .25s,color .25s', marginLeft:'4px' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('width','14'); svg.setAttribute('height','14'); svg.setAttribute('viewBox','0 0 24 24'); svg.setAttribute('fill','none'); svg.setAttribute('stroke','currentColor'); svg.setAttribute('stroke-width','2'); svg.setAttribute('stroke-linecap','round'); svg.setAttribute('stroke-linejoin','round');
  svg.innerHTML = `<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>`;
  const lbl = document.createElement('span'); lbl.id = 'cgpt-badge-label';
  b.append(svg, lbl);
  btn.parentElement.insertBefore(b, btn.nextSibling);
  return b;
}

function _readModel(btn) {
  const m = (btn.getAttribute('aria-label') || '').match(/current model is (.+)/i);
  if (!m) return;
  const name = m[1].trim(), rank = _modelRank(name);
  if (rank > _maxRank) _maxRank = rank;
  const down = rank !== -1 && _maxRank !== -1 && rank < _maxRank;
  const lbl = document.getElementById('cgpt-badge-label');
  if (lbl) lbl.textContent = name;
  const b = document.getElementById('cgpt-model-badge');
  if (b) {
    const th = _badgeTheme(down);
    b.style.border = th.border; b.style.background = th.background; b.style.color = th.color;
    b.title = down ? '⚠️ Model was downgraded this session' : '';
  }
  // Sync context window on model change — no extra timer needed
  if (_s.contextBar || _s.contextWarning) {
    const w = _getCtxWindow(name);
    if (w !== _ctxWin) { _ctxWin = w; _renderCtxBar(); }
  }
}

function _rebuildBadge(btn) {
  _buildBadge(btn);
  _readModel(btn);
  // After the badge is rebuilt, reposition the context bar (if active) to sit
  // directly after the new badge element. No remove+recreate — just move it.
  if (_s.contextBar || _s.contextWarning) {
    const bar   = document.getElementById('cgpt-ctx-bar');
    const badge = document.getElementById('cgpt-model-badge');
    if (bar && badge) {
      // Reposition: insert bar immediately after the badge in its flex row
      if (badge.parentElement) {
        badge.parentElement.insertBefore(bar, badge.nextSibling);
      }
    } else if (!bar) {
      // Bar was removed externally — recreate
      _getOrCreateCtxBar();
    }
    _renderCtxBar();
  }
}

function setupModelBadge(force = false) {
  const btn = document.querySelector(CONFIG.sel.modelBtn);
  if (!btn) return;
  if (force || !document.getElementById('cgpt-model-badge')) _rebuildBadge(btn);
  else _readModel(btn);

  if (_modelBtnObs) _modelBtnObs.disconnect();
  _modelBtnObs = new MutationObserver(() => _readModel(btn));
  _modelBtnObs.observe(btn, { attributes: true, attributeFilter: ['aria-label'] });

  const bannerEl = btn.closest('header') || btn.parentElement;
  if (bannerEl) {
    if (_bannerObs) _bannerObs.disconnect();
    _bannerObs = new MutationObserver(() => {
      if (!document.getElementById('cgpt-model-badge')) {
        requestAnimationFrame(() => {
          const b2 = document.querySelector(CONFIG.sel.modelBtn);
          if (b2) _rebuildBadge(b2);
        });
      }
    });
  _bannerObs.observe(bannerEl, { childList: true, subtree: true });
  }
}

// ---------------------------------------------------------------------------
// FEATURE 7 — Context Bar
// What changed vs v2.7:
//   • setInterval(_syncModelFromBtn, 3000) REMOVED — model sync happens via
//     _readModel() which is already wired to the MutationObserver on the button.
//   • _parseSSE no longer calls _renderCtxBar() on EVERY token chunk.
//     It collects the last usage metadata and renders ONCE at stream end.
//     This eliminates dozens of DOM writes per message reply.
//   • fetch interceptor is lazy-installed only when user enables contextBar
//     or contextWarning. It no longer taps /me or /accounts/check endpoints —
//     those .clone().json() calls added latency to every API request.
// ---------------------------------------------------------------------------
const CTX_WINS = {
  // Latest frontier models
  'o3':200000,'o3-mini':200000,'o3-pro':200000,
  'o4':200000,'o4-mini':200000,
  'gpt-5':200000,'5.2':200000,'5':200000,
  // o1 family
  'o1':200000,'o1-mini':128000,'o1-preview':128000,
  // GPT-4o family
  'gpt-4o':128000,'4o':128000,'chatgpt-4o':128000,
  // GPT-4
  'gpt-4-turbo':128000,'gpt-4':128000,
  // Legacy
  'gpt-3.5':16000,
};
let _ctxWin  = 128000;
let _ctxToks = 0;
let _ctxFiles = 0;
let _limitsProgress   = {};   // keyed by feature_name: {remaining, resetAfter} from /conversation/init
let _blockedFeatures  = new Set();  // feature names currently hard-blocked (from /conversation/init)
let _memoriesEnabled  = null;       // null = not yet fetched
let _memoriesCount    = 0;
let _imagesCount      = -1;         // -1 = not yet fetched
let _customInstrOn    = null;       // null = not yet fetched
let _ctxModel = '';
let _ctxRefreshObs = null;
let _ctxRefreshTimer = 0;
let _lastCtxFetch = 0;
let _watchdogTimer = 0;

function _getCtxWindow(slug) {
  const s = (slug || '').toLowerCase();
  for (const [k, v] of Object.entries(CTX_WINS)) { if (s.includes(k)) return v; }
  return 128000;
}

// ---------------------------------------------------------------------------
// Fetch real feature usage limits from /backend-api/conversation/init.
// This endpoint returns limits_progress (deep_research, file_upload, image_gen,
// paste_text_to_file) and model_limits (populated when you hit a model rate limit).
// ---------------------------------------------------------------------------
let _limitsLastFetch = 0;
async function _fetchLimitsProgress() {
  if (!_extCtxOk()) return;
  // Debounce: don't hit the endpoint more than once every 60 seconds
  const now = Date.now();
  if (now - _limitsLastFetch < 60000) return;
  _limitsLastFetch = now;
  try {
    let h;
    try { h = await getHeaders(); } catch { return; }
    if (!_extCtxOk()) return;
    const tz = -new Date().getTimezoneOffset();
    let r;
    try {
      r = await fetch(CONFIG.api.conversationInit, {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ gizmo_id: null, requested_default_model: null, conversation_id: null, timezone_offset_min: tz })
      });
    } catch { return; }
    if (!_extCtxOk() || !r.ok) return;
    let data;
    try { data = await r.json(); } catch { return; }
    if (!_extCtxOk()) return;
    // Map limits_progress array to an object keyed by feature_name
    const prog = {};
    (data.limits_progress || []).forEach(item => {
      prog[item.feature_name] = { remaining: item.remaining, resetAfter: item.reset_after };
    });
    _limitsProgress = prog;
    _saveLimitsProgress();
    // Capture blocked_features (features hard-blocked at session level)
    const bl = new Set();
    (data.blocked_features || []).forEach(f => bl.add(f.name));
    _blockedFeatures = bl;
    // Also capture default_model_slug if we haven't read the model yet
    if (!_ctxModel && data.default_model_slug) _ctxModel = data.default_model_slug;
  } catch (e) {
    if (_isCtxErr(e)) _killScript();
  }
}

// ---------------------------------------------------------------------------
// Fetch supplemental account data once per session (memories, images, custom
// instructions). These are background metrics shown in the Context Intelligence
// popover. Debounced to once every 5 minutes to avoid spam.
// ---------------------------------------------------------------------------
let _extDataLastFetch = 0;
async function _fetchExtendedData() {
  if (!_extCtxOk()) return;
  const now = Date.now();
  if (now - _extDataLastFetch < 300000) return; // 5 min cooldown
  _extDataLastFetch = now;
  try {
    let h;
    try { h = await getHeaders(); } catch { return; }
    if (!_extCtxOk()) return;
    const doFetch = url => fetch(url, Object.keys(h).length ? { headers: h } : undefined)
      .then(r => r.ok ? r.json() : null).catch(() => null);
    const [mems, imgs, usm] = await Promise.all([
      doFetch(CONFIG.api.memories),
      doFetch(CONFIG.api.imagesBootstrap),
      doFetch(CONFIG.api.userSysMsg),
    ]);
    if (!_extCtxOk()) return;
    if (mems) {
      _memoriesEnabled = mems.memory_enabled !== false;
      _memoriesCount   = Array.isArray(mems.memories) ? mems.memories.length : 0;
    }
    if (imgs) {
      _imagesCount = imgs.images_count ?? 0;
    }
    if (usm) {
      _customInstrOn = usm.enabled === true;
    }
  } catch (e) {
    if (_isCtxErr(e)) _killScript();
  }
}

function _getOrCreateCtxBar() {
  let bar = document.getElementById('cgpt-ctx-bar');
  if (bar) return bar;
  bar = document.createElement('div'); bar.id = 'cgpt-ctx-bar';
  const dark = isDark();
  Object.assign(bar.style, { display:'inline-flex', flexDirection:'column', alignItems:'flex-start', gap:'2px', padding:'4px 9px', borderRadius:'8px', flexShrink:'0', marginLeft:'6px', border: dark ? '1px solid rgba(255,255,255,.14)' : '1px solid rgba(0,0,0,.12)', background: dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)', color: dark ? '#ececec' : '#111', fontSize:'11px', fontFamily:'inherit', fontWeight:'500', cursor:'pointer', userSelect:'none', position:'relative' });
  const fc = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.40)';
  // Row 1: progress bar + token count (+ fallback file count if no API data)
  // Row 2: feature limit pills (hidden until API data arrives)
  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:5px;white-space:nowrap">
      <div style="width:52px;height:4px;border-radius:2px;background:rgba(128,128,128,.22);overflow:hidden;flex-shrink:0"><div id="cgpt-ctx-fill" style="height:100%;width:0%;border-radius:2px;background:${fc};transition:width .4s"></div></div>
      <span id="cgpt-ctx-pct" style="min-width:44px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">…</span>
      <span id="cgpt-ctx-files" style="display:none;font-size:10px;opacity:.6;white-space:nowrap"></span>
    </div>
    <div id="cgpt-ctx-limits" style="display:none;font-size:10px;opacity:.6;white-space:nowrap;line-height:1.1"></div>
  `;
  bar.addEventListener('click', _toggleCtxPopover);
  bar.title = 'Click for context details';

  // Insert bar directly after the badge (or model button) in the same flex row.
  // Do NOT walk up to header level — that puts it outside the left flex container.
  const anchor = document.getElementById('cgpt-model-badge')
              ?? document.querySelector(CONFIG.sel.modelBtn);
  if (anchor?.parentElement) {
    anchor.parentElement.insertBefore(bar, anchor.nextSibling);
  } else {
    const banner = document.querySelector(CONFIG.sel.banner);
    if (banner) banner.appendChild(bar);
  }
  return bar;
}

let _ctxRenderRaf = 0;
function _renderCtxBar(immediate = false) {
  if (!_s.contextBar) return;
  _getOrCreateCtxBar();
  // Batch DOM writes in a single rAF to avoid layout thrash during streaming
  if (!immediate && _ctxRenderRaf) return;
  _ctxRenderRaf = requestAnimationFrame(() => {
    _ctxRenderRaf = 0;
    const pct  = _ctxToks > 0 ? Math.min(100, Math.round((_ctxToks / _ctxWin) * 100)) : 0;
    const dark = isDark();
    const fc   = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f97316' : dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.40)';
    const fill = document.getElementById('cgpt-ctx-fill');
    const lbl  = document.getElementById('cgpt-ctx-pct');
    if (fill) { fill.style.width = pct + '%'; fill.style.background = fc; }
    // Show absolute token counts: e.g. "14k / 128k"
    if (lbl) {
      if (_ctxToks > 0) {
        const used = _ctxToks >= 1000 ? Math.round(_ctxToks / 1000) + 'k' : _ctxToks;
        const win  = _ctxWin  >= 1000 ? Math.round(_ctxWin  / 1000) + 'k' : _ctxWin;
        lbl.textContent = `${used} / ${win}`;
      } else {
        lbl.textContent = '…';
      }
    }
    // File attachment count indicator — only show when API limit data is absent
    const fEl = document.getElementById('cgpt-ctx-files');
    if (fEl) {
      if (_ctxFiles > 0 && !_limitsProgress.file_upload) {
        fEl.style.display = '';
        fEl.innerHTML = '\uD83D\uDCCE\uFE0F\u202F' + _ctxFiles;
      } else {
        fEl.style.display = 'none';
      }
    }
    // Inline quota summary — all limits with icons
    const lEl = document.getElementById('cgpt-ctx-limits');
    if (lEl) {
      const PILL_META = {
        deep_research:      { icon: '\uD83D\uDD2D' },
        image_gen:          { icon: '\uD83D\uDDBC\uFE0F' },
        paste_text_to_file: { icon: '\uD83D\uDCCB' },
        file_upload:        { icon: '\uD83D\uDCCE' },
      };
      const entries = Object.entries(_limitsProgress)
        .filter(([k]) => PILL_META[k])
        .sort((a, b) => a[1].remaining - b[1].remaining);
      if (entries.length > 0) {
        lEl.style.display = '';
        lEl.innerHTML = entries.map(([k, v]) => {
          const isBlocked = _blockedFeatures.has(k);
          const col = v.remaining === 0 ? '#ef4444' : v.remaining <= 2 ? '#f97316' : '';
          const icon = PILL_META[k].icon;
          const rst = _fmtReset(v.resetAfter);
          const rstHtml = rst ? '<span style="opacity:.3;font-size:9px;margin-left:1px">' + rst + '</span>' : '';
          let val;
          if (k === 'file_upload') {
            const total = _ctxFiles + v.remaining;
            val = icon + '\u202F' + _ctxFiles + '/' + total;
          } else {
            val = icon + '\u202F' + v.remaining;
          }
          return '<span' + (col ? ' style="color:' + col + ';font-weight:600"' : '') + '>' + val + rstHtml + '</span>';
        }).join('<span style="opacity:.35"> · </span>');
      } else {
        lEl.style.display = 'none';
      }
    }
  });
}

function _showCtxWarn() {  if (!_s.contextWarning || document.getElementById('cgpt-ctx-warn')) return;
  const dark = isDark();
  const w = document.createElement('div'); w.id = 'cgpt-ctx-warn';
  Object.assign(w.style, { position:'fixed', bottom:'84px', left:'50%', transform:'translateX(-50%)', zIndex:'999998', background: dark ? '#1e1e1e' : '#fff', border:'1px solid #ef4444', borderRadius:'10px', padding:'11px 14px', color: dark ? '#ececec' : '#111', fontSize:'13px', boxShadow:'0 8px 32px rgba(0,0,0,.55)', display:'flex', alignItems:'center', gap:'10px', maxWidth:'min(480px,92vw)' });
  w.innerHTML = `<span style="font-size:16px;flex-shrink:0">⚠️</span><span style="line-height:1.45"><strong style="color:#ef4444">Context window full</strong> — ChatGPT is now forgetting your earliest messages. <a href="/" style="color:#10a37f;text-decoration:none;font-weight:600;margin-left:4px">Start a new chat</a></span><button style="background:none;border:none;color:rgba(128,128,128,.7);cursor:pointer;font-size:17px;padding:0;flex-shrink:0;line-height:1" title="Dismiss">✕</button>`;
  w.querySelector('button').onclick = () => w.remove();
  document.body.appendChild(w);
  setTimeout(() => w?.remove(), 14000);
}

// Parse SSE stream: update context bar in real-time (throttled), render finally at [DONE]
let _sseTick = 0; // timestamp of last real-time render
async function _parseSSE(stream, encChatId) {
  const reader = stream.getReader();
  const dec    = new TextDecoder();
  let buf = '', lastUsage = null, done_flag = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line === 'data: [DONE]') {
          if (!done_flag) {
            done_flag = true;
            if (lastUsage) {
              const total = (lastUsage.prompt_tokens || 0) + (lastUsage.completion_tokens || 0);
              if (total > 0) { _ctxToks = total; _renderCtxBar(true); }
            } else {
              const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
              if (chatId) setTimeout(() => _fetchCtxData(chatId), 600);
            }
            // Decrypt assistant reply and restore user message text for encrypted chats
            if (encChatId && _encryptedIds.has(encChatId)) {
              setTimeout(() => { _decryptAll(); _restoreUserDisplay(); }, 500);
            }
          }
          continue;
        }
        if (!line.startsWith('data: ')) continue;
        try {
          const obj = JSON.parse(line.slice(6));
          const u = obj?.message?.metadata?.usage;
          if (u?.prompt_tokens) {
            lastUsage = u;
            // Real-time bar update throttled to at most once per 500ms during streaming
            const total = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
            if (total > 0) {
              const now = Date.now();
              if (now - _sseTick > 500) { _sseTick = now; _ctxToks = total; _renderCtxBar(); }
            }
          }
          if (obj?.message?.metadata?.finish_details?.type === 'max_tokens') {
            _ctxToks = _ctxWin; _renderCtxBar(true); _showCtxWarn();
          }
        } catch {}
      }
    }
  } catch {}
}

function _installFetchInterceptor() {
  if (_cgptFetchHooked) return;
  _cgptFetchHooked = true;
  const _orig = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    // NOTE: content scripts run in an isolated JS world. This patched window.fetch
    // only intercepts fetches made by our own extension code, NOT ChatGPT's page.
    // Outgoing encryption is handled via the DOM send interceptor (_setupSendInterceptor).
    // Tee only the streaming POST for context bar SSE parsing (best-effort).
    const res = await _orig.call(this, input, init);
    if ((init?.method || 'GET').toUpperCase() === 'POST'
        && url.includes('/backend-api/conversation')
        && !url.includes('?')
        && res.body) {
      try {
        const chatIdForSse = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
        const [b1, b2] = res.body.tee();
        _parseSSE(b2, chatIdForSse);
        return new Response(b1, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch {}
    }
    return res;
  };
}

async function _fetchCtxData(chatId, retries = 5) {
  if (!chatId || (!_s.contextBar && !_s.contextWarning) || !_extCtxOk()) return;
  _lastCtxFetch = Date.now();
  try {
    let h;
    try { h = await getHeaders(); } catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!_extCtxOk()) return;
    let r;
    try { r = await fetch(`${CONFIG.api.conversationBase}${chatId}`, Object.keys(h).length ? { headers: h } : undefined); }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!_extCtxOk()) return;
    if (r.status === 401 && retries > 0) {
      _hdrCache = null; // bust stale cached token so next attempt re-reads from storage
      const delay = Object.keys(h).length === 0 ? 1500 : 3000; // faster retry when no auth was stored
      setTimeout(() => { if (!_dead) _fetchCtxData(chatId, retries - 1); }, delay);
      return;
    }
    if (!r.ok) return;
    let data;
    try { data = await r.json(); } catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!_extCtxOk()) return;
    let chars = 0, slug = data.default_model_slug || '', maxToks = 0, files = 0;
    Object.values(data.mapping || {}).forEach(node => {
      const msg = node?.message;
      if (!msg) return;
      if (msg.author?.role === 'assistant' && msg.metadata?.model_slug) slug = msg.metadata.model_slug;
      const u = msg?.metadata?.usage;
      if (u?.prompt_tokens) {
        const tot = (u.prompt_tokens || 0) + (u.completion_tokens || 0);
        if (tot > maxToks) maxToks = tot;
      }
      // Count file attachments
      const atts = msg.metadata?.attachments;
      if (Array.isArray(atts)) files += atts.length;
      const parts = msg.content?.parts;
      if (Array.isArray(parts)) parts.forEach(p => {
        if (typeof p === 'string') {
          chars += p.length; // legacy format: parts is array of plain strings
        } else if (p && typeof p === 'object') {
          if (typeof p.text === 'string') chars += p.text.length; // new format: {type:'text', text:'...'}
          else if (p.asset_pointer || p.content_type === 'image_asset_pointer') files++;
        }
      });
    });
    _ctxToks  = maxToks > 0 ? maxToks : Math.round(chars / 4);
    _ctxFiles = files;
    _ctxModel = slug;
    const w = _getCtxWindow(slug);
    if (w !== _ctxWin) _ctxWin = w;
    // Sync model badge from API data (catches model changes the button observer might miss)
    if (slug && _s.modelBadge) {
      const btn = document.querySelector(CONFIG.sel.modelBtn);
      if (btn) _readModel(btn);
    }
    // Refresh real feature limits (debounced — at most once per 60s)
    _fetchLimitsProgress();
    _renderCtxBar();
  } catch (e) {
    if (_isCtxErr(e)) { _killScript(); return; }
    _renderCtxBar();
  }
}

// Retry counter for context bar setup when the banner isn't in the DOM yet
let _ctxBarRetries = 0;
function setupContextBar() {
  _installFetchInterceptor(); // lazy — only when this feature is on
  // Sync model window from button immediately (no timer)
  const btn = document.querySelector(CONFIG.sel.modelBtn);
  if (btn) {
    const m = (btn.getAttribute('aria-label') || '').match(/current model is (.+)/i);
    if (m) _ctxWin = _getCtxWindow(m[1].trim());
  }
  if (_s.contextBar) {
    const banner = document.querySelector(CONFIG.sel.banner);
    if (!banner && _ctxBarRetries < 6) {
      // Banner not rendered yet (very early load) — retry shortly
      _ctxBarRetries++;
      setTimeout(() => { if (!_dead && (_s.contextBar || _s.contextWarning)) setupContextBar(); }, 400);
      return;
    }
    _ctxBarRetries = 0;
    _getOrCreateCtxBar();
  }
  const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
  if (chatId) { _fetchCtxData(chatId); _setupCtxRefreshObserver(); }
  else _renderCtxBar();
  // Fetch real feature limits from the conversation/init API (fire-and-forget)
  _fetchLimitsProgress();
  // Fetch supplemental system data (memories, images count, custom instructions)
  _fetchExtendedData();
}

function teardownContextBar() {
  document.getElementById('cgpt-ctx-bar')?.remove();
  document.getElementById('cgpt-ctx-warn')?.remove();
  document.getElementById('cgpt-ctx-popover')?.remove();
  _teardownCtxRefreshObserver();
  _ctxToks = 0;
  _ctxFiles = 0;
  _ctxModel = '';
  _blockedFeatures  = new Set();
  _memoriesEnabled  = null;
  _memoriesCount    = 0;
  _imagesCount      = -1;
  _customInstrOn    = null;
  _extDataLastFetch = 0;
}

// ---------------------------------------------------------------------------
// Auto-refresh observer — watches <main> for new messages, then re-fetches
// context data after a debounce. This replaces the broken SSE tee approach
// (SSE tee can't intercept ChatGPT's page fetches from the isolated world).
// Also re-reads the model button on each refresh to catch model switches.
// ---------------------------------------------------------------------------
function _setupCtxRefreshObserver() {
  if (_ctxRefreshObs || (!_s.contextBar && !_s.contextWarning)) return;
  _ctxRefreshObs = new MutationObserver(() => {
    clearTimeout(_ctxRefreshTimer);
    _ctxRefreshTimer = setTimeout(() => {
      const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
      if (chatId && (_s.contextBar || _s.contextWarning)) {
        _lastCtxFetch = Date.now();
        _fetchCtxData(chatId);
        if (_s.modelBadge) {
          const btn = document.querySelector(CONFIG.sel.modelBtn);
          if (btn) _readModel(btn);
        }
      }
    }, 1200);
  });
  _ctxRefreshObs.observe(document.body, { childList: true, subtree: true });
}

function _teardownCtxRefreshObserver() {
  clearTimeout(_ctxRefreshTimer);
  _ctxRefreshObs?.disconnect();
  _ctxRefreshObs = null;
}

// ---------------------------------------------------------------------------
// Context Intelligence Popover — detailed stats on click
// ---------------------------------------------------------------------------
function _toggleCtxPopover() {
  const existing = document.getElementById('cgpt-ctx-popover');
  if (existing) { existing.remove(); return; }
  const bar = document.getElementById('cgpt-ctx-bar');
  if (!bar) return;
  const dark = isDark();
  const pop = document.createElement('div');
  pop.id = 'cgpt-ctx-popover';
  const rect = bar.getBoundingClientRect();
  Object.assign(pop.style, {
    position:'fixed',
    top: (rect.bottom + 8) + 'px',
    right: Math.max(8, window.innerWidth - rect.right) + 'px',
    zIndex:'999999',
    background: dark ? '#1a1a1e' : '#fff',
    border: dark ? '1px solid rgba(255,255,255,.12)' : '1px solid rgba(0,0,0,.1)',
    borderRadius:'14px',
    padding:'16px 18px',
    minWidth:'260px',
    maxWidth:'340px',
    boxShadow: dark ? '0 16px 48px rgba(0,0,0,.6)' : '0 16px 48px rgba(0,0,0,.18)',
    color: dark ? '#ececec' : '#111',
    fontSize:'12px',
    fontFamily:'inherit',
    lineHeight:'1.55'
  });

  const pct  = _ctxToks > 0 ? Math.min(100, Math.round((_ctxToks / _ctxWin) * 100)) : 0;
  const fc   = pct >= 90 ? '#ef4444' : pct >= 70 ? '#f97316' : '#10a37f';
  const used = _ctxToks > 0 ? (_ctxToks >= 1000 ? (_ctxToks / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : _ctxToks) : '—';
  const win  = _ctxWin >= 1000 ? Math.round(_ctxWin / 1000) + 'k' : _ctxWin;
  const model = _ctxModel || document.getElementById('cgpt-badge-label')?.textContent || '—';

  // File section: use real API data if available, otherwise fall back to local estimate
  const f = _ctxFiles;
  const fuApi = _limitsProgress.file_upload;
  const estLimit = fuApi ? (_ctxFiles + fuApi.remaining) : 50;
  const fPct = f > 0 ? Math.min(100, Math.round((f / estLimit) * 100)) : 0;
  const fColor = fPct >= 100 ? '#ef4444' : fPct >= 70 ? '#f97316' : '#10a37f';
  let fStatus;
  if (f >= estLimit) {
    fStatus = `<span style="color:#ef4444;font-weight:600">\u26A0 File upload limit reached</span><br><span style="opacity:.55;font-size:11px;line-height:1.5">Start a new conversation for a fresh quota.</span>`;
  } else if (fuApi) {
    // Real API data: show exact remaining
    const remColor = fuApi.remaining <= 1 ? '#ef4444' : fuApi.remaining <= 2 ? '#f97316' : '';
    const remStyle = remColor ? `color:${remColor};font-weight:600` : 'opacity:.5';
    const rst = _fmtReset(fuApi.resetAfter);
    fStatus = `<span style="${remStyle}">${fuApi.remaining} upload${fuApi.remaining !== 1 ? 's' : ''} remaining</span>`
      + (rst ? `<span style="opacity:.35;font-size:11px"> \u00b7 resets ${rst}</span>` : '');
  } else if (f >= estLimit * 0.7) {
    fStatus = `<span style="color:#f97316;font-weight:600">\u26A0 Approaching upload limit</span><br><span style="opacity:.55;font-size:11px">${estLimit - f} more files estimated before limit</span>`;
  } else if (f > 0) {
    fStatus = `<span style="opacity:.5">${estLimit - f} more files estimated before limit</span>`;
  } else {
    fStatus = `<span style="opacity:.35">No files uploaded in this chat</span>`;
  }

  const sep = `border-top:1px solid ${dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};padding-top:10px;margin-top:10px`;

  // Pre-compute usage limits section from real /conversation/init API data
  const FEAT_META = {
    deep_research:     { icon: '\uD83D\uDD2D',          label: 'Deep Research' },
    image_gen:         { icon: '\uD83D\uDDBC\uFE0F',   label: 'Image Gen' },
    paste_text_to_file:{ icon: '\uD83D\uDCCB',          label: 'Paste to File' },
    file_upload:       { icon: '\uD83D\uDCCE',          label: 'File Upload' },
  };
  const limitsEntries = Object.keys(FEAT_META)
    .filter(k => _limitsProgress[k] !== undefined)
    .map(k => ({ key: k, ...FEAT_META[k], ..._limitsProgress[k] }));
  let uSection = '';
  if (limitsEntries.length > 0) {
    let rows = limitsEntries.map(e => {
      const rem = e.remaining;
      const color = rem === 0 ? '#ef4444' : rem <= 2 ? '#f97316' : 'inherit';
      const weight = rem <= 2 ? 'font-weight:600' : '';
      const rst = _fmtReset(e.resetAfter);
      let valText;
      if (e.key === 'file_upload') {
        const total = _ctxFiles + rem;
        valText = _ctxFiles + '/' + total + ' used';
      } else {
        valText = rem + ' left';
      }
      return '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">'
        + '<span style="opacity:.6;font-size:11px">' + e.icon + '\u00A0' + e.label + '</span>'
        + '<span style="font-size:11px;' + weight + ';color:' + color + '">'
        + valText + (rst ? '<span style="opacity:.4;font-weight:400;margin-left:4px">\u23F1\uFE0F\u202F' + rst + '</span>' : '')
        + '</span></div>';
    }).join('');
    uSection = '<div style="' + sep + '"><div style="opacity:.5;font-size:11px;margin-bottom:6px">USAGE LIMITS <span style="opacity:.5;font-weight:400;font-size:10px">\u00B7 from API</span></div>' + rows + '</div>';
  }

  // System section: memory count, generated images count, custom instructions
  let sysSection = '';
  {
    const sysRows = [];
    if (_memoriesEnabled !== null) {
      const mText = _memoriesEnabled
        ? (_memoriesCount > 0 ? _memoriesCount + ' saved' : 'On (empty)')
        : 'Disabled';
      const mStyle = _memoriesEnabled ? '' : 'opacity:.4';
      sysRows.push('<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">'
        + '<span style="opacity:.6;font-size:11px">\uD83E\uDDE0\u00A0Memory</span>'
        + '<span style="font-size:11px;' + mStyle + '">' + mText + '</span></div>');
    }
    if (_imagesCount >= 0) {
      sysRows.push('<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">'
        + '<span style="opacity:.6;font-size:11px">\uD83D\uDDBC\uFE0F\u00A0Generated Images</span>'
        + '<span style="font-size:11px">' + _imagesCount + '</span></div>');
    }
    if (_customInstrOn !== null) {
      const cText = _customInstrOn ? 'On' : 'Off';
      const cStyle = _customInstrOn ? '' : 'opacity:.4';
      sysRows.push('<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">'
        + '<span style="opacity:.6;font-size:11px">\uD83D\uDCDD\u00A0Custom Instructions</span>'
        + '<span style="font-size:11px;' + cStyle + '">' + cText + '</span></div>');
    }
    if (sysRows.length) {
      sysSection = '<div style="' + sep + '"><div style="opacity:.5;font-size:11px;margin-bottom:6px">SYSTEM</div>' + sysRows.join('') + '</div>';
    }
  }

  pop.innerHTML = `
    <div style="font-weight:700;font-size:14px;margin-bottom:12px;display:flex;align-items:center;gap:6px">
      <span style="font-size:15px">\u{1F9E0}</span> Context Intelligence
    </div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
      <span style="opacity:.5;font-size:11px">CONTEXT USAGE</span>
      <span style="font-weight:600;font-variant-numeric:tabular-nums">${used} / ${win}${pct > 0 ? ' <span style="opacity:.45;font-weight:400">('+pct+'%)</span>' : ''}</span>
    </div>
    <div style="width:100%;height:6px;border-radius:3px;background:rgba(128,128,128,.18);overflow:hidden;margin-bottom:4px">
      <div style="height:100%;width:${pct}%;border-radius:3px;background:${fc};transition:width .3s"></div>
    </div>
    ${pct >= 90 ? '<div style="color:#ef4444;font-size:11px;font-weight:600;margin-bottom:2px">\u26A0 Context nearly full — earliest messages may be forgotten</div>' : ''}
    <div style="${sep}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="opacity:.5;font-size:11px">MODEL</span>
        <span style="font-weight:600">${model}</span>
      </div>
    </div>
    <div style="${sep}">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
        <span style="opacity:.5;font-size:11px">FILES</span>
        <span style="font-weight:600">${f} uploaded</span>
      </div>
      ${f > 0 ? `<div style="width:100%;height:4px;border-radius:2px;background:rgba(128,128,128,.18);overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${fPct}%;border-radius:2px;background:${fColor}"></div></div>` : ''}
      <div style="font-size:11px;line-height:1.55">${fStatus}</div>
    </div>
    ${uSection}
    ${sysSection}
    <div style="${sep};font-size:10px;opacity:.25;text-align:center;padding-top:8px">Click pill to close &middot; Auto-refreshes every message</div>
  `;

  document.body.appendChild(pop);
  // Close on outside click
  const closeHandler = (e) => {
    if (!pop.contains(e.target) && !bar.contains(e.target)) {
      pop.remove();
      document.removeEventListener('click', closeHandler, true);
    }
  };
  requestAnimationFrame(() => document.addEventListener('click', closeHandler, true));
}

// ---------------------------------------------------------------------------
// FEATURE 8 — Sidebar Date Groups
// ---------------------------------------------------------------------------
let _dgSetup = false;

function _bucket(ts) {
  if (!ts) return 'Older';
  // API returns either a float Unix-seconds number OR an ISO-8601 string.
  // Multiplying a string by 1000 yields NaN → "Invalid Date", so detect the type.
  const msg = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(msg.getTime())) return 'Older'; // guard against any unexpected format
  const now = new Date();
  if (msg.toDateString() === now.toDateString()) return 'Today';
  const yd = new Date(now); yd.setDate(now.getDate() - 1);
  if (msg.toDateString() === yd.toDateString()) return 'Yesterday';
  const d7 = new Date(now); d7.setDate(now.getDate() - 7); d7.setHours(0,0,0,0);
  if (msg >= d7) return 'Last 7 Days';
  const d30 = new Date(now); d30.setDate(now.getDate() - 30); d30.setHours(0,0,0,0);
  if (msg >= d30) return 'Last 30 Days';
  // Anything older: show the actual month + year (e.g. "February 2026", "November 2025")
  return msg.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

async function setupDateGroups() {
  if (_dgSetup || !_extCtxOk()) return;
  _dgSetup = true;

  // Each await is wrapped individually — Chrome MV3 throws "Extension context
  // invalidated" AT the resumption point of any await when the context dies,
  // BEFORE any guard code on that line can run. Individual try/catch blocks
  // catch it at the exact suspension point rather than relying solely on the
  // outer handler.
  let h;
  try { h = await getHeaders(); }
  catch (e) { if (_isCtxErr(e)) _killScript(); _dgSetup = false; return; }
  if (!h?.authorization) { _dgSetup = false; return; }

  const idMap = {};
  const lim = 100; let off = 0, total = Infinity, pages = 0;
  while (off < total && pages < 5) {
    if (!_extCtxOk()) { _dgSetup = false; return; }
    let res;
    try { res = await fetch(`${CONFIG.api.conversations}?offset=${off}&limit=${lim}`, { headers: h }); }
    catch (e) { if (_isCtxErr(e)) _killScript(); _dgSetup = false; return; }
    if (!res.ok) { _dgSetup = false; return; }

    let data;
    try { data = await res.json(); }
    catch (e) { if (_isCtxErr(e)) _killScript(); _dgSetup = false; return; }
    total = data.total ?? 0;
    const items = data.items || data.conversations || [];
    if (!items.length) break;
    items.forEach(x => { if (x.id) idMap[x.id] = _bucket(x.update_time || x.create_time); });
    off += lim; pages++;
    if (off < total && pages < 5) {
      if (!_extCtxOk()) { _dgSetup = false; return; }
      try { await sleep(80); }
      catch (e) { if (_isCtxErr(e)) _killScript(); _dgSetup = false; return; }
    }
  }

  if (!_extCtxOk()) { _dgSetup = false; return; }

  if (!document.getElementById('cgpt-dg-css')) {
    const s = document.createElement('style'); s.id = 'cgpt-dg-css';
    s.textContent = `.cgpt-dg-hdr{display:flex;align-items:center;gap:4px;padding:10px 12px 2px;font-size:10.5px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;opacity:.40;cursor:pointer;user-select:none;background:none;border:none;width:100%;text-align:left;font-family:inherit;color:inherit;box-sizing:border-box}.cgpt-dg-hdr:hover{opacity:.65}.cgpt-dg-arr{font-size:7px;display:inline-block;transition:transform .15s;flex-shrink:0}.cgpt-dg-hdr.cgpt-dg-col .cgpt-dg-arr{transform:rotate(-90deg)}.cgpt-dg-hidden{display:none!important}`;
    document.head.appendChild(s);
  }

  const links = [...document.querySelectorAll(CONFIG.sel.sidebarLink)];
  if (!links.length) {
    _dgSetup = false;
    setTimeout(() => { if (!_dead && _s.dateGroups && !_dgSetup) setupDateGroups(); }, 1200);
    return;
  }

  const colState = {};
  let lastBkt = null;
  links.forEach(link => {
    const id  = extractId(link.getAttribute('href'));
    const bkt = (id && idMap[id]) || 'Older';
    link.dataset.cgptDgBucket = bkt;
    if (bkt !== lastBkt) {
      lastBkt = bkt; colState[bkt] = false;
      const hdr = document.createElement('button');
      hdr.className = 'cgpt-dg-hdr'; hdr.dataset.cgptDgHdr = bkt;
      hdr.innerHTML = `<span class="cgpt-dg-arr">&#9660;</span>${bkt}`;
      hdr.onclick = () => {
        colState[bkt] = !colState[bkt];
        hdr.classList.toggle('cgpt-dg-col', colState[bkt]);
        document.querySelectorAll(`[data-cgpt-dg-bucket="${bkt}"]`)
          .forEach(l => l.classList.toggle('cgpt-dg-hidden', colState[bkt]));
      };
      if (link.parentElement) link.parentElement.insertBefore(hdr, link);
    }
  });
}

function teardownDateGroups() {
  _dgSetup = false;
  document.querySelectorAll('[data-cgpt-dg-hdr]').forEach(el => el.remove());
  document.querySelectorAll('[data-cgpt-dg-bucket]').forEach(el => {
    el.classList.remove('cgpt-dg-hidden');
    delete el.dataset.cgptDgBucket;
  });
  document.getElementById('cgpt-dg-css')?.remove();
}

// ---------------------------------------------------------------------------
// FEATURE 9 — Chat Vault (PIN-protected locked chats)
// ---------------------------------------------------------------------------

function _ensureLockCss() {
  if (document.getElementById('cgpt-lock-css')) return;
  const s = document.createElement('style'); s.id = 'cgpt-lock-css';
  // Lock icon is a static visual indicator only — no pointer-events.
  // It becomes visible (amber) only when the chat is locked (cgpt-is-locked).
  s.textContent = `
    .cgpt-lock-icon{position:absolute;right:34px;top:50%;transform:translateY(-50%);
      display:flex;align-items:center;justify-content:center;
      width:18px;height:18px;border-radius:4px;
      opacity:0;pointer-events:none;
      transition:opacity .12s;z-index:100;color:#f59e0b;}
    .cgpt-lock-icon.cgpt-is-locked{opacity:1 !important;}
    .cgpt-lock-icon.cgpt-is-encrypted{opacity:1 !important;color:#3b82f6 !important;}`;
  document.head.appendChild(s);
}

async function _hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function _vaultPinModal(mode) {
  return new Promise(resolve => {
    const dark = isDark();
    const overlay = document.createElement('div');
    Object.assign(overlay.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,.65)', zIndex:'1000001', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' });
    const box = document.createElement('div');
    Object.assign(box.style, { background: dark ? '#1a1a1e' : '#fff', color: dark ? '#ececec' : '#111', borderRadius:'18px', padding:'32px 28px 24px', width:'min(300px,92vw)', boxShadow:'0 24px 64px rgba(0,0,0,.55)', display:'flex', flexDirection:'column', gap:'16px', textAlign:'center', alignItems:'center' });
    const title = document.createElement('div'); title.style.cssText = 'font-weight:700;font-size:17px;margin-top:4px';
    title.textContent = mode === 'set' ? 'Create Vault PIN' : 'Vault Locked';
    const sub = document.createElement('div'); sub.style.cssText = 'font-size:12px;opacity:.5;margin-top:-8px;line-height:1.5';
    sub.textContent = mode === 'set' ? 'Choose a 4-digit PIN to protect your locked chats' : 'Enter 4-digit PIN to access your locked chats';

    function makeDots(label) {
      const wrap = document.createElement('div'); wrap.style.cssText = 'width:100%';
      if (label) { const l = document.createElement('div'); l.textContent = label; l.style.cssText = 'font-size:11px;opacity:.4;margin-bottom:8px;text-align:left'; wrap.appendChild(l); }
      const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:center';
      const inps = [];
      for (let i = 0; i < 4; i++) {
        const inp = document.createElement('input');
        inp.type='password'; inp.maxLength=1; inp.inputMode='numeric'; inp.pattern='[0-9]';
        Object.assign(inp.style, { width:'48px', height:'54px', border: dark ? '1.5px solid rgba(255,255,255,.18)' : '1.5px solid rgba(0,0,0,.18)', borderRadius:'11px', background: dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)', color: dark ? '#fff' : '#111', fontSize:'24px', fontWeight:'700', textAlign:'center', outline:'none', caretColor:'transparent', fontFamily:'inherit', transition:'border-color .15s,box-shadow .15s' });
        inp.addEventListener('focus', () => { inp.style.borderColor='#10a37f'; inp.style.boxShadow='0 0 0 3px rgba(16,163,127,.2)'; });
        inp.addEventListener('blur',  () => { inp.style.borderColor = dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.18)'; inp.style.boxShadow='none'; });
        inp.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g,'').slice(-1); if (e.target.value && i < 3) inps[i+1].focus(); if (inps.every(x => x.value)) setTimeout(() => submitBtn.click(), 60); });
        inp.addEventListener('keydown', e => { if (e.key==='Backspace' && !inp.value && i>0) { inps[i-1].value=''; inps[i-1].focus(); } if (e.key==='Escape') { overlay.remove(); resolve(null); } });
        inps.push(inp); row.appendChild(inp);
      }
      wrap.appendChild(row);
      return { wrap, inps };
    }

    const { wrap: d1, inps: pin1 } = makeDots(mode === 'set' ? 'PIN' : null);
    let pin2 = null, d2 = null;
    if (mode === 'set') { const r = makeDots('Confirm PIN'); d2 = r.wrap; pin2 = r.inps; }

    const errMsg = document.createElement('div'); errMsg.style.cssText = 'color:#ef4444;font-size:12px;min-height:14px;width:100%;text-align:center';
    const submitBtn = document.createElement('button');
    submitBtn.textContent = mode === 'set' ? 'Set PIN' : 'Unlock';
    Object.assign(submitBtn.style, { background:'#10a37f', color:'#fff', border:'none', borderRadius:'11px', padding:'12px', fontSize:'14px', fontWeight:'600', cursor:'pointer', fontFamily:'inherit', width:'100%', transition:'opacity .1s' });
    submitBtn.addEventListener('mouseenter', () => submitBtn.style.opacity='.85');
    submitBtn.addEventListener('mouseleave', () => submitBtn.style.opacity='1');
    submitBtn.addEventListener('click', async () => {
      const pin = pin1.map(x=>x.value).join('');
      if (pin.length < 4) { errMsg.textContent='Enter all 4 digits'; return; }
      if (mode === 'set') {
        const conf = pin2.map(x=>x.value).join('');
        if (conf.length < 4) { errMsg.textContent='Confirm your PIN'; return; }
        if (pin !== conf) { errMsg.textContent='PINs do not match'; pin1.forEach(x=>x.value=''); pin2.forEach(x=>x.value=''); pin1[0].focus(); return; }
        overlay.remove(); resolve(pin);
      } else {
        const hash = await _hashPin(pin);
        const stored = (await _storeGet(['cgpt_pin_hash'])).cgpt_pin_hash;
        if (hash === stored) { overlay.remove(); resolve(pin); }
        else { errMsg.textContent='Incorrect PIN'; pin1.forEach(x=>x.value=''); pin1[0].focus(); }
      }
    });
    const cancelBtn = document.createElement('button'); cancelBtn.textContent='Cancel';
    Object.assign(cancelBtn.style, { background:'none', color: dark ? 'rgba(255,255,255,.35)' : 'rgba(0,0,0,.35)', border:'none', fontSize:'13px', cursor:'pointer', fontFamily:'inherit' });
    cancelBtn.onclick = () => { overlay.remove(); resolve(null); };
    box.append(title, sub, d1);
    if (d2) box.append(d2);
    box.append(errMsg, submitBtn, cancelBtn);
    overlay.appendChild(box); document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target===overlay) { overlay.remove(); resolve(null); } });
    setTimeout(() => pin1[0].focus(), 60);
  });
}

async function _toggleLockChat(chatId, link) {
  if (_lockedIds.has(chatId)) {
    // Already locked — verify PIN before unlocking
    let stored;
    try { stored = (await _storeGet(['cgpt_pin_hash'])).cgpt_pin_hash; }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (stored) { const pin = await _vaultPinModal('verify'); if (!pin) return; }
    _lockedIds.delete(chatId);
    _encryptedIds.delete(chatId);
    link.style.removeProperty('display');
    delete link.dataset.cgptLocked;
    delete link.dataset.cgptEncrypted;
    const lk = link.querySelector('.cgpt-lock-icon');
    if (lk) { lk.classList.remove('cgpt-is-locked', 'cgpt-is-encrypted'); lk.title = ''; }
  } else {
    // Not locked — set PIN if first time, then lock
    let stored;
    try { stored = (await _storeGet(['cgpt_pin_hash'])).cgpt_pin_hash; }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!stored) {
      const pin = await _vaultPinModal('set'); if (!pin) return;
      const hash = await _hashPin(pin);
      try { await _storeSet({ cgpt_pin_hash: hash }); }
      catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    }
    _lockedIds.add(chatId);
    link.dataset.cgptLocked = '1';
    const lk = link.querySelector('.cgpt-lock-icon');
    if (lk) { lk.classList.add('cgpt-is-locked'); lk.title = 'Hidden'; }
    if (!_vaultOpen) link.style.setProperty('display','none','important');
  }
  try { await _storeSet({ cgpt_locked_ids: [..._lockedIds], cgpt_encrypted_ids: [..._encryptedIds] }); }
  catch (e) { if (_isCtxErr(e)) _killScript(); return; }
  _renderVaultHeader();
}

let _vaultHdrRetry = 0;
function _renderVaultHeader() {
  if (!_s.alphaMode) { document.getElementById('cgpt-vault-hdr')?.remove(); return; }
  const count = _lockedIds.size;
  let hdr = document.getElementById('cgpt-vault-hdr');

  const firstLink = document.querySelector(CONFIG.sel.sidebarLink);
  const navEl = firstLink?.closest('nav') ?? document.querySelector('nav[aria-label]') ?? document.querySelector('nav');
  if (!navEl) {
    hdr?.remove();
    if (_vaultHdrRetry < 5) { _vaultHdrRetry++; setTimeout(_renderVaultHeader, 600); }
    return;
  }
  _vaultHdrRetry = 0;

  if (!hdr) {
    hdr = document.createElement('button'); hdr.id = 'cgpt-vault-hdr';
    const dark = isDark();
    Object.assign(hdr.style, {
      display:'flex', alignItems:'center', gap:'8px', width:'100%',
      padding:'8px 14px', margin:'0', border:'none',
      borderBottom: dark ? '1px solid rgba(255,255,255,.07)' : '1px solid rgba(0,0,0,.07)',
      background:'none', cursor:'pointer', fontFamily:'inherit',
      color: dark ? '#c9cdd4' : '#4b5563', fontSize:'12px', fontWeight:'600',
      textAlign:'left', boxSizing:'border-box', transition:'background .12s',
      flexShrink:'0'
    });
    hdr.addEventListener('mouseenter', () => hdr.style.background = isDark() ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.04)');
    hdr.addEventListener('mouseleave', () => hdr.style.background = 'none');
    hdr.addEventListener('click', _openVault);

    // Insert between logo-header row and the icons area (New chat, Search, etc.).
    // Use firstLink.closest('nav') so we always get the correct sidebar nav even
    // when multiple <nav> elements exist on the page.
    // The <aside> element inside nav is the icons/New-chat section (implicit role
    // "complementary") — inserting before it puts vault between logo row and icons.
    try {
      const asideEl = navEl.querySelector('aside') || navEl.querySelector('[role="complementary"]');
      let refNode = asideEl;
      while (refNode && refNode.parentElement !== navEl) refNode = refNode.parentElement;
      navEl.insertBefore(hdr, refNode ?? null);
    } catch (_) {
      navEl.appendChild(hdr);
    }
  }

  const lckSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true" style="flex-shrink:0;opacity:.5"><path d="M18 10h-1V7a5 5 0 0 0-10 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-7H9V7a3 3 0 0 1 6 0v3z"/></svg>`;
  const encCount  = _encryptedIds.size;
  const hideCount = count - encCount;
  const detailParts = [];
  if (encCount  > 0) detailParts.push(`${encCount} encrypted`);
  if (hideCount > 0) detailParts.push(`${hideCount} hidden`);
  const statusTxt = count === 0
    ? 'select chats to lock them'
    : (_vaultOpen ? 'open \u2014 click to lock' : (detailParts.join(' \u00b7 ') + ' \u2014 click to unlock'));
  hdr.innerHTML = `${lckSvg}<span style="flex:1">Hidden Chats${count ? ' \u00b7 '+count : ''}</span><span style="font-size:10px;opacity:.35;font-weight:400">${statusTxt}</span>`;
}

async function _openVault() {
  if (!_lockedIds.size) return;
  if (_vaultOpen) { _closeVault(); return; }
  const stored = (await _storeGet(['cgpt_pin_hash'])).cgpt_pin_hash;
  if (stored) { const pin = await _vaultPinModal('verify'); if (!pin) return; }
  _vaultOpen = true;
  document.querySelectorAll('[data-cgpt-locked="1"]').forEach(l => l.style.removeProperty('display'));
  _renderVaultHeader();
  clearTimeout(_vaultTimer);
  _vaultTimer = setTimeout(_closeVault, 3 * 60 * 1000); // auto-relock after 3 min
}

function _closeVault() {
  _vaultOpen = false; clearTimeout(_vaultTimer);
  document.querySelectorAll('[data-cgpt-locked="1"]').forEach(l => l.style.setProperty('display','none','important'));
  _renderVaultHeader();
}

async function setupVault() {
  let data;
  try { data = await _storeGet(['cgpt_locked_ids', 'cgpt_encrypted_ids']); }
  catch (e) { if (_isCtxErr(e)) _killScript(); return; }
  _lockedIds    = new Set(data.cgpt_locked_ids    || []);
  _encryptedIds = new Set(data.cgpt_encrypted_ids || []);
  _ensureLockCss();
  if (_lockedIds.size) {
    document.querySelectorAll(CONFIG.sel.sidebarLink).forEach(link => {
      const id = extractId(link.getAttribute('href'));
      if (!id || !_lockedIds.has(id)) return;
      link.dataset.cgptLocked = '1';
      if (_encryptedIds.has(id)) link.dataset.cgptEncrypted = '1';
      if (!_vaultOpen) link.style.setProperty('display','none','important');
      const lk = link.querySelector('.cgpt-lock-icon');
      if (lk) {
        lk.classList.add('cgpt-is-locked');
        if (_encryptedIds.has(id)) { lk.classList.add('cgpt-is-encrypted'); lk.title = 'Encrypted'; }
        else { lk.title = 'Hidden'; }
      }
    });
  }
  _renderVaultHeader();
}

// ---------------------------------------------------------------------------
// FEATURE 11 — Vault Encryption (Base64 channel for locked chats)
// ---------------------------------------------------------------------------
// ARCHITECTURE NOTE:
// Chrome MV3 content scripts run in an ISOLATED JavaScript world. Patching
// window.fetch in a content script only intercepts the extension's OWN fetches,
// not the ChatGPT page's requests. We therefore intercept outgoing messages at
// the DOM level (capture-phase listeners on the send button and Enter key),
// encode the textarea content before React reads it, then re-fire the event.
// Incoming replies are decoded via a MutationObserver on the assistant message
// elements as they are added to the DOM.
// ---------------------------------------------------------------------------

// chat IDs that have already received the one-time encryption primer this session
const _cgptEncPrimed = new Set();
// pending {chatId, original, encoded} entries — lets us restore displayed user text
const _cgptEncQueue  = [];

// UTF-8–safe Base64 encode / decode
function _b64Enc(str) {
  try { return btoa(unescape(encodeURIComponent(str))); }
  catch { return btoa(str); }
}
function _b64Dec(str) {
  try { return decodeURIComponent(escape(atob(str.replace(/\s+/g, '')))); }
  catch { return null; }
}
// Returns true only when a string is a plausible Base64 block:
// valid charset, length is multiple of 4, long enough to be a real message.
function _looksBase64(str) {
  const s = str.replace(/\s+/g, '');
  return s.length >= 8 && /^[A-Za-z0-9+/]+=*$/.test(s) && s.length % 4 === 0;
}

// Encode a user message for transmission. Prepends the one-time primer on the
// first message of a locked chat so the model knows to reply only in Base64.
function _encOutgoing(text, chatId) {
  const b64 = _b64Enc(text);
  _cgptEncQueue.push({ chatId, original: text, encoded: b64 });
  if (_cgptEncPrimed.has(chatId)) return b64;
  _cgptEncPrimed.add(chatId);
  // ACK string: the exact Base64 we expect the model to echo back as confirmation.
  const ack = _b64Enc('Encrypted channel active. I understand and will comply.');
  return (
    `[ENCRYPTED CHANNEL — follow exactly]\n` +
    `Rule 1: Every message I send you is Base64-encoded. Decode it first to understand me.\n` +
    `Rule 2: Your ENTIRE reply must always be ONE Base64 string only — absolutely nothing else before or after it (no preamble, no labels, no markdown).\n` +
    `Rule 3: Confirm you understood by replying with ONLY this exact Base64 string: ${ack}\n\n` +
    b64
  );
}

// Attempt to decrypt a single assistant message <div> and show plain text.
// Leaves the element completely untouched if it is not valid Base64.
function _decryptMsgEl(el) {
  if (el.dataset.cgptDec) return;
  // ChatGPT renders message text into a .markdown / prose div
  const prose = el.querySelector('.markdown, [class*="prose"], [class*="markdown"]')
                 || el.querySelector('[data-message-content]')
                 || el;
  const raw = prose.innerText?.trim() ?? '';
  if (!raw || raw.length < 8) return;
  // Strategy: try the whole text (whitespace stripped), then scan lines
  // last-to-first (model sometimes prepends a short preamble line).
  let decoded = null;
  const full = raw.replace(/\s+/g, '');
  if (_looksBase64(full)) decoded = _b64Dec(full);
  if (!decoded) {
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      if (_looksBase64(lines[i])) { decoded = _b64Dec(lines[i]); break; }
    }
  }
  if (!decoded) return; // not Base64 — leave untouched
  el.dataset.cgptDec = '1';
  const overlay = document.createElement('div');
  overlay.dataset.cgptDecOverlay = '1';
  overlay.style.cssText = 'white-space:pre-wrap;word-break:break-word;line-height:1.75';
  overlay.textContent = decoded;
  prose.style.setProperty('display', 'none', 'important');
  el.insertBefore(overlay, prose);
}

// Scan and decrypt all undecrypted assistant messages in the current encrypted chat.
function _decryptAll() {
  const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
  if (!chatId || !_encryptedIds.has(chatId)) return;
  document.querySelectorAll('div[data-message-author-role="assistant"]:not([data-cgpt-dec])').forEach(_decryptMsgEl);
}

// After a user message was encoded before sending, its DOM node shows Base64.
// Find it and overlay the original readable text on top.
function _restoreUserDisplay() {
  if (!_cgptEncQueue.length) return;
  const userEls = [...document.querySelectorAll('div[data-message-author-role="user"]')];
  // iterate a copy so splices don't skip items
  [..._cgptEncQueue].forEach((item, qi) => {
    const el = userEls.find(e =>
      !e.dataset.cgptDecUser &&
      (e.innerText?.trim() === item.encoded || e.innerText?.includes(item.encoded))
    );
    if (!el) return;
    el.dataset.cgptDecUser = '1';
    const overlay = document.createElement('div');
    overlay.dataset.cgptDecOverlay = '1';
    overlay.style.cssText = 'white-space:pre-wrap;word-break:break-word';
    overlay.textContent = item.original;
    // Hide only the direct prose descendant so layout is preserved
    const prose = el.querySelector('[class*="prose"], [class*="whitespace"]') || el;
    if (prose !== el) {
      prose.style.setProperty('display', 'none', 'important');
      el.insertBefore(overlay, prose);
    } else {
      el.insertBefore(overlay, el.firstChild);
    }
    _cgptEncQueue.splice(qi, 1);
  });
}

// ---------------------------------------------------------------------------
// DOM-level send interceptor — encodes textarea content in capture phase.
// Content scripts run in an isolated JS world, so window.fetch patching only
// intercepts the extension's own fetches, not ChatGPT's page requests.
// We intercept at the DOM level: capture-phase listeners fire before React,
// we encode the text via execCommand (which triggers React's input events),
// then re-fire the original send event so React submits the encoded value.
// ---------------------------------------------------------------------------
let _cgptSendInProgress = false;
let _cgptSendHooked    = false;  // prevents double-installation of send interceptor
let _cgptFetchHooked   = false;  // prevents double-installation of fetch interceptor

function _setupSendInterceptor() {
  if (_cgptSendHooked) return;
  _cgptSendHooked = true;

  const _encode = (e) => {
    if (_cgptSendInProgress) return;
    const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
    if (!chatId || !_encryptedIds.has(chatId)) return;
    const ta = document.getElementById('prompt-textarea')
             || document.querySelector('div[contenteditable="true"][aria-label]')
             || document.querySelector('div[contenteditable="true"]');
    if (!ta) return;
    const text = (ta.innerText || ta.textContent || '').trim();
    if (!text) return;

    e.stopImmediatePropagation();
    e.preventDefault();

    const encoded = _encOutgoing(text, chatId);
    // execCommand triggers React's native input-event chain so React's
    // internal fiber state updates to the encoded value synchronously.
    ta.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, encoded);

    _cgptSendInProgress = true;
    requestAnimationFrame(() => {
      _cgptSendInProgress = false;
      if (e.type === 'click') {
        (e.target.closest('button') || document.querySelector('[data-testid="send-button"]'))?.click();
      } else {
        ta.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          bubbles: true, cancelable: true
        }));
      }
    });
  };

  document.addEventListener('click', e => {
    if (e.target.closest('[data-testid="send-button"]')) _encode(e);
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey
        && e.target.closest('#prompt-textarea, [contenteditable="true"]')) _encode(e);
  }, true);
}

// MutationObserver on <main> — decrypts assistant messages as they appear in the DOM.
let _decryptObs = null;

function _setupDecryptObserver() {
  if (_decryptObs) return;
  _decryptObs = new MutationObserver(() => {
    const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
    if (!chatId || !_encryptedIds.has(chatId)) return;
    document.querySelectorAll('div[data-message-author-role="assistant"]:not([data-cgpt-dec])').forEach(_decryptMsgEl);
    if (_cgptEncQueue.length) _restoreUserDisplay();
  });
  const target = document.querySelector('main') || document.body;
  _decryptObs.observe(target, { childList: true, subtree: true });
}

function _teardownDecryptObserver() {
  _decryptObs?.disconnect();
  _decryptObs = null;
}

// ---------------------------------------------------------------------------
// FEATURE 10 — Export Selected Chats (Markdown / Plain Text / PDF)
// ---------------------------------------------------------------------------
function _showExportModal() {
  const dark = isDark();
  const overlay = document.createElement('div');
  Object.assign(overlay.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,.6)', zIndex:'1000001', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' });
  const box = document.createElement('div');
  Object.assign(box.style, { background:dark?'#111':'#fff', color:dark?'#f0f0f0':'#111', border:dark?'1px solid rgba(255,255,255,.1)':'1px solid rgba(0,0,0,.1)', borderRadius:'10px', padding:'22px', width:'min(320px,92vw)', boxShadow:'0 16px 48px rgba(0,0,0,.4)', display:'flex', flexDirection:'column', gap:'12px' });
  const ttl = document.createElement('div'); ttl.style.cssText='font-weight:700;font-size:14.5px;letter-spacing:-.01em';
  ttl.textContent = `Export ${_selectedIds.size} conversation${_selectedIds.size>1?'s':''}`;
  const sub = document.createElement('div'); sub.style.cssText=`font-size:11.5px;opacity:.4`;
  sub.textContent = 'Select a format:';
  const formats = [
    { id:'md',  label:'Markdown (.md)',   desc:'Code blocks, headers, formatting' },
    { id:'txt', label:'Plain Text (.txt)', desc:'Clean transcript, universally readable' },
    { id:'pdf', label:'PDF',               desc:'Whitepaper layout via print dialog' },
  ];
  let chosen = 'md';
  const fmtWrap = document.createElement('div'); fmtWrap.style.cssText='display:flex;flex-direction:column;gap:5px';
  const selBorder = dark?'#fff':'#000';
  const selBg     = dark?'rgba(255,255,255,.06)':'rgba(0,0,0,.04)';
  const defBorder = dark?'rgba(255,255,255,.1)':'rgba(0,0,0,.09)';
  formats.forEach(f => {
    const btn = document.createElement('button'); btn.dataset.fmt = f.id;
    Object.assign(btn.style, { display:'flex', alignItems:'center', gap:'10px', padding:'9px 11px', border:`1.5px solid ${defBorder}`, borderRadius:'7px', background:'none', cursor:'pointer', fontFamily:'inherit', color:dark?'#f0f0f0':'#111', textAlign:'left', transition:'border-color .1s,background .1s' });
    btn.innerHTML = `<span><span style="display:block;font-weight:600;font-size:12.5px">${f.label}</span><span style="display:block;font-size:10.5px;opacity:.4;margin-top:1px">${f.desc}</span></span>`;
    const mark = () => { chosen=f.id; fmtWrap.querySelectorAll('button').forEach(b=>{const a=b.dataset.fmt===f.id; b.style.borderColor=a?selBorder:defBorder; b.style.background=a?selBg:'none';}); };
    btn.addEventListener('click', mark); if (f.id==='md') setTimeout(mark,0);
    fmtWrap.appendChild(btn);
  });
  const prog = document.createElement('div'); prog.style.cssText='font-size:11px;opacity:.4;min-height:14px;text-align:center';
  const expBtn = document.createElement('button'); expBtn.textContent='Export';
  Object.assign(expBtn.style, { background:dark?'#fff':'#000', color:dark?'#000':'#fff', border:'none', borderRadius:'7px', padding:'10px', fontSize:'13px', fontWeight:'600', cursor:'pointer', fontFamily:'inherit', transition:'opacity .1s' });
  expBtn.addEventListener('mouseenter',()=>expBtn.style.opacity='.75');
  expBtn.addEventListener('mouseleave',()=>expBtn.style.opacity='1');
  expBtn.addEventListener('click', async () => {
    expBtn.disabled=true; expBtn.style.opacity='.35'; expBtn.textContent='Exporting…';
    try { await _runExport(chosen, prog); overlay.remove(); }
    catch(e) { prog.textContent='Error: '+e.message; expBtn.disabled=false; expBtn.style.opacity='1'; expBtn.textContent='Export'; }
  });
  const cancelBtn = document.createElement('button'); cancelBtn.textContent='Cancel';
  Object.assign(cancelBtn.style, { background:'none', color:dark?'rgba(255,255,255,.3)':'rgba(0,0,0,.3)', border:'none', fontSize:'12px', cursor:'pointer', fontFamily:'inherit' });
  cancelBtn.onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if(e.target===overlay) overlay.remove(); });
  box.append(ttl, sub, fmtWrap, prog, expBtn, cancelBtn);
  overlay.appendChild(box); document.body.appendChild(overlay);
}

async function _runExport(format, progress) {
  if (!_extCtxOk()) throw new Error('Extension reloaded — please refresh the page');
  let h;
  try { h = await getHeaders(); } catch (e) { if (_isCtxErr(e)) _killScript(); throw new Error('Extension reloaded — please refresh the page'); }
  if (!_extCtxOk() || !h.authorization) throw new Error('Auth not captured — send a message in ChatGPT first');
  const ids = [..._selectedIds], convos = [];
  for (let i = 0; i < ids.length; i++) {
    if (!_extCtxOk()) throw new Error('Extension reloaded — please refresh the page');
    if (progress) progress.textContent = `Fetching ${i+1} / ${ids.length}…`;
    let data;
    try { data = await _fetchConvoFull(ids[i], h); } catch (e) { if (_isCtxErr(e)) { _killScript(); throw new Error('Extension reloaded — please refresh the page'); } }
    if (data) convos.push(data);
    try { await sleep(120); } catch (e) { if (_isCtxErr(e)) { _killScript(); throw new Error('Extension reloaded — please refresh the page'); } }
  }
  if (!convos.length) throw new Error('No conversations could be fetched');
  const date = new Date().toISOString().slice(0,10);
  const sanitize = t => (t||'chat').replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'_').slice(0,60)||'chat';
  const base = convos.length===1 ? `${sanitize(convos[0].title)}_${date}` : `chatgpt-export_${date}`;
  if (format==='md')  _downloadBlob(_buildMd(convos),  `${base}.md`,  'text/markdown');
  if (format==='txt') _downloadBlob(_buildTxt(convos), `${base}.txt`, 'text/plain');
  if (format==='pdf') _printPdf(_buildPdfHtml(convos));
}

async function _fetchConvoFull(chatId, headers) {
  try {
    let r;
    try { r = await fetch(`${CONFIG.api.conversationBase}${chatId}`, { headers }); }
    catch (e) { if (_isCtxErr(e)) throw e; return null; }
    if (!r.ok) return null;
    let data;
    try { data = await r.json(); }
    catch (e) { if (_isCtxErr(e)) throw e; return null; }
    return { id:chatId, title:data.title||'Untitled', create_time:data.create_time, msgs:_walkMessages(data) };
  } catch (e) { if (_isCtxErr(e)) throw e; return null; }
}

function _walkMessages(data) {
  if (!data.mapping) return [];
  // Walk from current_node upward via parent to get the active branch, then reverse
  const map = data.mapping;
  const path = [];
  let cur = data.current_node;
  const seen = new Set();
  while (cur && map[cur] && !seen.has(cur)) {
    seen.add(cur);
    const node = map[cur];
    const msg  = node.message;
    if (msg?.author && msg?.content) {
      const role  = msg.author.role;
      const parts = msg.content.parts;
      const text  = Array.isArray(parts) ? parts.map(p => typeof p==='string' ? p : (p&&typeof p==='object'&&typeof p.text==='string'?p.text:'')).join('') : (msg.content.text||'');
      if ((role==='user'||role==='assistant') && text.trim()) {
        path.unshift({ role, text: text.trim(), time: msg.create_time });
      }
    }
    cur = node.parent;
  }
  return path;
}

function _fmtTime(ts) {
  if (!ts) return '';
  const d = typeof ts==='number' ? new Date(ts*1000) : new Date(ts);
  return isNaN(d) ? '' : d.toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
}

function _buildMd(convos) {
  const date = new Date().toISOString().slice(0,10);
  const modelName = document.getElementById('cgpt-badge-label')?.textContent||'ChatGPT';
  const out = [];
  convos.forEach((c, ci) => {
    const msgs = Array.isArray(c?.msgs) ? c.msgs : [];
    if (ci > 0) out.push('', '---', '');
    out.push('# ' + (c?.title||'Untitled'), '');
    out.push('Model: ' + modelName);
    out.push('Exported: ' + date);
    out.push('Source: ChatGPT Enhanced');
    out.push('');
    msgs.forEach(m => {
      const role = m?.role === 'user' ? 'USER' : 'ASSISTANT';
      out.push('## ' + role, '');
      out.push(typeof m?.text === 'string' ? m.text : '');
      out.push('');
    });
  });
  return out.join('\n');
}

function _buildTxt(convos) {
  const SEP = '-'.repeat(72);
  const date = new Date().toISOString().slice(0,10);
  const modelName = document.getElementById('cgpt-badge-label')?.textContent||'ChatGPT';
  const out = [];
  convos.forEach((c, ci) => {
    const msgs = Array.isArray(c?.msgs) ? c.msgs : [];
    if (ci > 0) out.push('', SEP, '');
    out.push((c?.title||'UNTITLED').toUpperCase());
    out.push('');
    out.push('Model:    ' + modelName);
    out.push('Exported: ' + date);
    out.push('Source:   ChatGPT Enhanced');
    out.push('', SEP, '');
    msgs.forEach(m => {
      out.push('[' + (m?.role==='user' ? 'USER' : 'ASSISTANT') + ']');
      out.push(typeof m?.text === 'string' ? m.text : '');
      out.push('');
    });
  });
  return out.join('\n');
}

function _buildPdfHtml(convos) {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmtBody = raw => {
    let s = esc(raw);
    const BT = String.fromCharCode(96);
    const reCodeBlock = new RegExp(BT+BT+BT+'(\\w*)\\n?([\\s\\S]*?)'+BT+BT+BT, 'g');
    const reInlineCode = new RegExp(BT+'([^'+BT+']+)'+BT, 'g');
    s = s.replace(reCodeBlock, function(_,lang,code){ return '<pre class="cb"><code' + (lang?' class="lang-'+lang+'"':'') + '>' + code + '</code></pre>'; });
    s = s.replace(reInlineCode, '<code class="ic">$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  };
  const date = new Date().toISOString().slice(0,10);
  const modelName = document.getElementById('cgpt-badge-label')?.textContent||'ChatGPT';
  const totalMsgs = convos.reduce((a,c)=>a+(Array.isArray(c?.msgs)?c.msgs.length:0),0);
  const singleTitle = convos.length===1 ? esc(convos[0]?.title||'Untitled') : null;
  const docTitle = singleTitle || 'ChatGPT Enhanced Export';
  const msgsHtml = convos.map((c,ci) => {
    const msgList = Array.isArray(c?.msgs) ? c.msgs : [];
    const sep = ci>0 ? '<div class="conv-sep"></div>' : '';
    const hdr = convos.length>1 ? '<h2 class="ctitle">'+esc(c?.title||'Untitled')+'</h2>' : '';
    const msgs = msgList.map(m => {
      const isUser = m?.role === 'user';
      const label = isUser ? 'USER' : 'ASSISTANT';
      const cls = isUser ? 'mu' : 'ma';
      return '<div class="msg '+cls+'"><div class="role">'+label+'</div><div class="body">'+fmtBody(m?.text)+'</div></div>';
    }).join('');
    return sep+hdr+'<div class="msgs">'+msgs+'</div>';
  }).join('');
  const metaExtra = convos.length>1 ? '<br>Conversations: '+convos.length+' &middot; Messages: '+totalMsgs : '';
  const css = [
    '@page{size:A4;margin:1in}',
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica Neue,Arial,sans-serif;background:#fff;color:#1a1a1a;font-size:12pt;line-height:1.65;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    '.page{max-width:680px;margin:0 auto;padding:48px 0}',
    '.doc-title{font-size:22pt;font-weight:700;color:#000;line-height:1.2}',
    '.meta{font-size:9pt;color:#888;line-height:1.9;margin-top:12px}',
    '.divider{border:none;border-top:1px solid #000;margin:20px 0 32px}',
    '.conv-sep{border:none;border-top:1px solid #d0d0d0;margin:40px 0;page-break-after:always}',
    '.ctitle{font-size:15pt;font-weight:700;color:#000;margin-bottom:20px;page-break-after:avoid}',
    '.msgs{display:flex;flex-direction:column}',
    '.msg{padding:14px 0 14px 16px;border-left:1px solid rgba(0,0,0,.15);margin-bottom:18px;page-break-inside:avoid}',
    '.role{font-size:7.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.12em;margin-bottom:8px;color:#000}',
    '.body{color:#1a1a1a;white-space:pre-wrap;word-wrap:break-word;font-size:11pt;line-height:1.65}',
    'pre.cb{background:#f5f5f5;color:#1a1a1a;border:1px solid #ccc;border-radius:4px;padding:14px 16px;margin:12px 0;font-family:Consolas,Courier New,monospace;font-size:9pt;line-height:1.55;page-break-inside:avoid;white-space:pre;overflow-x:auto}',
    'code.ic{background:#f0f0f0;color:#1a1a1a;padding:1px 5px;border:1px solid #ddd;border-radius:3px;font-family:Consolas,Courier New,monospace;font-size:9pt}',
    'strong{font-weight:700}em{font-style:italic}',
    '.footer{margin-top:48px;padding-top:12px;border-top:1px solid #e0e0e0;font-size:8pt;color:#aaa;text-align:center}',
    '@media print{.page{padding:0;max-width:100%}.conv-sep{page-break-after:always}.msg{page-break-inside:avoid}}'
  ].join('\n');
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>'+docTitle+'</title>\n'+
    '<style>\n'+css+'\n</style></head><body><div class="page">\n'+
    '<div class="doc-title">'+docTitle+'</div>\n'+
    '<div class="meta">Model: '+modelName+'<br>Exported: '+date+'<br>Source: ChatGPT Enhanced'+metaExtra+'</div>\n'+
    '<hr class="divider">\n'+
    msgsHtml+'\n'+
    '<div class="footer">ChatGPT Enhanced</div>\n'+
    '</div></body></html>';
}

function _downloadBlob(content, filename, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime+';charset=utf-8' }));
  a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function _printPdf(html) {
  const w = window.open('', '_blank', 'width=940,height=720');
  if (!w) { alert('Pop-up blocked. Allow pop-ups for chatgpt.com, then try again.'); return; }
  w.document.open(); w.document.write(html); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch {} }, 900);
}

// ---------------------------------------------------------------------------
// MUTATION OBSERVER — single narrowly-scoped observer
// What changed vs v2.7:
//   • Fast-path attribute checks happen BEFORE any querySelector / subtree walk.
//   • Slow-path querySelector only runs when appropriate feature is enabled AND
//     not already scheduled AND the fast-path didn't match.
//   • compactSidebar re-setup guard added so we don't call it redundantly.
// ---------------------------------------------------------------------------
let _riInject  = false;
let _riObserve = false;
let _riBadge   = false;
let _riSidebar = false;

function _schedInject() {
  if (_riInject) return; _riInject = true;
  requestAnimationFrame(() => {
    _riInject = false;
    if (!_dead && _s.bulkActions) {
      injectCheckboxes();
      if (_s.alphaMode) _renderVaultHeader();
    }
  });
}
function _schedObserve() {
  if (_riObserve) return; _riObserve = true;
  requestAnimationFrame(() => { _riObserve = false; if (!_dead && _s.lagFix) observeMessages(); });
}
function _schedBadge() {
  if (_riBadge) return; _riBadge = true;
  requestAnimationFrame(() => { _riBadge = false; if (!_dead && _s.modelBadge) setupModelBadge(); });
}
function _schedSidebar() {
  if (_riSidebar) return; _riSidebar = true;
  requestAnimationFrame(() => {
    _riSidebar = false;
    if (!_dead && _s.compactSidebar && !document.getElementById('cgpt-icon-grid')) setupCompactSidebar();
  });
}

const _mutObs = new MutationObserver(mutations => {
  if (_dead) { _mutObs.disconnect(); return; }
  for (const mut of mutations) {
    for (const node of mut.addedNodes) {
      if (node.nodeType !== 1) continue;
      // Fast attribute checks — no DOM traversal, O(1) each
      if (!_riInject) {
        const href = node.getAttribute?.('href');
        if (href?.startsWith('/c/')) { _schedInject(); continue; }
      }
      if (!_riObserve) {
        if (node.hasAttribute?.('data-message-author-role')) { _schedObserve(); continue; }
      }
      if (!_riBadge) {
        if ((node.getAttribute?.('aria-label') || '').includes('current model')) { _schedBadge(); continue; }
      }
      // Slow path — only enter if needed and node actually has children
      if (node.children?.length) {
        if (!_riInject  && _s.bulkActions    && node.querySelector('a[href^="/c/"]'))                    _schedInject();
        if (!_riObserve && _s.lagFix         && node.querySelector('[data-message-author-role]'))        _schedObserve();
        if (!_riBadge   && _s.modelBadge     && node.querySelector(CONFIG.sel.modelBtn))                 _schedBadge();
        if (!_riSidebar && _s.compactSidebar && node.querySelector('a[href="/images"],a[href="/apps"]')) _schedSidebar();
      }
    }
    if (!_riBadge) {
      for (const node of mut.removedNodes) {
        if (node.nodeType === 1 && node.id === 'cgpt-model-badge') { _schedBadge(); break; }
      }
    }
  }
});
_mutObs.observe(document.body, { childList: true, subtree: true });

// ---------------------------------------------------------------------------
// SPA NAVIGATION
// ---------------------------------------------------------------------------
function _onNav() {
  _sbBgCache        = null;
  _ctxToks          = 0;
  _ctxFiles         = 0;
  _ctxModel         = '';
  _limitsProgress   = {};   // reset so popover shows fresh data for the new chat
  _limitsLastFetch  = 0;    // allow immediate re-fetch on next nav
  _ctxBarRetries = 0;
  _lastCtxFetch  = 0;
  _teardownCtxRefreshObserver();
  document.getElementById('cgpt-ctx-bar')?.remove();
  document.getElementById('cgpt-ctx-warn')?.remove();
  document.getElementById('cgpt-ctx-popover')?.remove();
  _cgptGridRetried = false;

  requestAnimationFrame(() => {
    if (_s.compactSidebar) setupCompactSidebar();
    if (_s.dateGroups) { teardownDateGroups(); setTimeout(setupDateGroups, 600); }
    requestAnimationFrame(() => {
      if (_s.modelBadge) setupModelBadge(true);
      if (_s.contextBar || _s.contextWarning) {
        if (_s.contextBar) _getOrCreateCtxBar();
        const id = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
        if (id) { _fetchCtxData(id); _setupCtxRefreshObserver(); }
        else { _teardownCtxRefreshObserver(); _renderCtxBar(); }
      }
      if (_s.bulkActions) {
        injectCheckboxes();
        if (_s.alphaMode) setupVault();
      }
      // Decrypt observer: active only when viewing an encrypted chat
      const _navId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
      if (_navId && _encryptedIds.has(_navId)) {
        _setupDecryptObserver();
        setTimeout(_decryptAll, 900);
      } else {
        _teardownDecryptObserver();
      }
    });
  });
}

const _origPush    = history.pushState.bind(history);
const _origReplace = history.replaceState.bind(history);
history.pushState = function (...a) { _origPush(...a); _onNav(); };
// replaceState fires for URL-param-only changes (e.g. ?model= updates during a chat).
// We do NOT trigger a full _onNav — just refresh the context bar if needed.
history.replaceState = function (...a) {
  _origReplace(...a);
  if (_s.contextBar || _s.contextWarning) {
    const id = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
    if (id) _fetchCtxData(id); else { _ctxToks = 0; _renderCtxBar(); }
  }
};
// passive: true — _onNav never calls preventDefault
window.addEventListener('popstate', _onNav, { passive: true });

// ---------------------------------------------------------------------------
// WATCHDOG — periodic self-healing ticker (8-second interval)
// Re-reads model badge and re-fetches ctx if MutationObserver went quiet.
// ---------------------------------------------------------------------------
function _startWatchdog() {
  if (_watchdogTimer) return;
  _watchdogTimer = setInterval(() => {
    if (_dead) { clearInterval(_watchdogTimer); _watchdogTimer = 0; return; }
    const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
    if (!chatId) return;
    if (_s.modelBadge) {
      const btn = document.querySelector(CONFIG.sel.modelBtn);
      if (btn) _readModel(btn);
    }
    if ((_s.contextBar || _s.contextWarning) && Date.now() - _lastCtxFetch > 7000) {
      _lastCtxFetch = Date.now();
      _fetchCtxData(chatId);
    }
  }, 8000);
}

// ---------------------------------------------------------------------------
// SETTINGS — instant apply handler
// ---------------------------------------------------------------------------
function _apply(key) {
  switch (key) {
    case 'lagFix':
      if (_s.lagFix) { setupVirtualization(); observeMessages(); }
      else            teardownVirtualization();
      break;
    case 'alphaMode':
      if (_s.alphaMode) {
        if (_s.bulkActions) {
          _ensureLockCss();
          document.querySelectorAll('.cgpt-bulk-item').forEach(link => {
            if (link.querySelector('.cgpt-lock-icon')) return;
            const chatId = link.dataset.cgptId;
            const lkBtn = document.createElement('span'); lkBtn.className = 'cgpt-lock-icon';
            lkBtn.title = _encryptedIds.has(chatId) ? 'Encrypted' : (_lockedIds.has(chatId) ? 'Hidden' : '');
            lkBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M18 10h-1V7a5 5 0 0 0-10 0v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2zm-6 7a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm3-7H9V7a3 3 0 0 1 6 0v3z"/></svg>`;
            if (_lockedIds.has(chatId)) lkBtn.classList.add('cgpt-is-locked');
            if (_encryptedIds.has(chatId)) lkBtn.classList.add('cgpt-is-encrypted');
            link.appendChild(lkBtn);
          });
          _renderVaultHeader();
        }
        _renderActionBar();
      } else {
        document.getElementById('cgpt-vault-hdr')?.remove();
        document.querySelectorAll('.cgpt-lock-icon').forEach(el => el.remove());
        _renderActionBar();
      }
      break;
    case 'bulkActions':
      if (_s.bulkActions) { injectCheckboxes(); if (_s.alphaMode) _renderVaultHeader(); break; }
      document.querySelectorAll('.cgpt-cb').forEach(cb => cb.remove());
      document.querySelectorAll('.cgpt-bulk-item').forEach(link => {
        link.style.removeProperty('position'); link.style.removeProperty('overflow'); link.style.removeProperty('padding-left');
        link.classList.remove('cgpt-bulk-item');
        delete link.dataset.cgptItem; delete link.dataset.cgptId; delete link.dataset.cgptIndex;
      });
      document.getElementById('cgpt-action-bar')?.remove();
      document.getElementById('cgpt-cb-css')?.remove();
      _selectedIds.clear(); _lastCb = null;
      break;
    case 'compactSidebar':
      if (_s.compactSidebar) { setupCompactSidebar(); break; }
      document.getElementById('cgpt-icon-grid')?.remove();
      document.getElementById('cgpt-compact-css')?.remove();
      document.querySelectorAll('[data-cgpt-grid-hidden]').forEach(el => { el.style.removeProperty('display'); delete el.dataset.cgptGridHidden; });
      document.querySelectorAll('[data-cgpt-container-hidden]').forEach(el => { el.style.removeProperty('display'); delete el.dataset.cgptContainerHidden; });
      _cgptGridRetried = false;
      break;
    case 'modelBadge':
      if (_s.modelBadge) { setupModelBadge(true); break; }
      document.getElementById('cgpt-model-badge')?.remove();
      document.getElementById('cgpt-ctx-bar')?.remove();
      _bannerObs?.disconnect(); _modelBtnObs?.disconnect();
      break;
    case 'contextBar':
    case 'contextWarning':
      if (_s.contextBar || _s.contextWarning) setupContextBar();
      else teardownContextBar();
      break;
    case 'dateGroups':
      if (_s.dateGroups) setupDateGroups(); else teardownDateGroups();
      break;
  }
}

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (_dead || area !== 'sync') return;
    Object.keys(changes).forEach(k => { if (k in _s) { _s[k] = changes[k].newValue; _apply(k); } });
  });
  chrome.runtime.onMessage.addListener(msg => {
    if (_dead || msg?.type !== 'CGPT_SETTINGS_UPDATE') return;
    const inc = msg.settings || {};
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (k in inc && _s[k] !== inc[k]) { _s[k] = inc[k]; _apply(k); }
    });
  });
} catch (e) { /* extension context already invalid at attach time */ }

// ---------------------------------------------------------------------------
// GLOBAL CONTEXT-INVALIDATION ABSORBERS
// Chrome MV3 can surface "Extension context invalidated" as an unhandled
// rejection even when individual awaits are wrapped in try/catch, depending
// on timing. These top-level handlers swallow such events silently.
// ---------------------------------------------------------------------------
window.addEventListener('unhandledrejection', ev => {
  if (_isCtxErr(ev.reason)) { ev.preventDefault(); _killScript(); }
});
window.addEventListener('error', ev => {
  const src = ev.error || ev.message || '';
  if (_isCtxErr(src)) { ev.preventDefault(); _killScript(); }
});

// Re-sync model + context immediately after the tab becomes visible again
// (e.g. user switches back from another tab after a long absence).
document.addEventListener('visibilitychange', () => {
  if (_dead || document.hidden) return;
  const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
  if (!chatId) return;
  if (_s.modelBadge) {
    const btn = document.querySelector(CONFIG.sel.modelBtn);
    if (btn) _readModel(btn);
  }
  if (_s.contextBar || _s.contextWarning) {
    _lastCtxFetch = Date.now();
    _fetchCtxData(chatId);
  }
}, { passive: true });

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
setTimeout(() => {
  _loadLimitsProgress();   // restore persisted feature limits (deep research, files, etc.)
  _syncGet(DEFAULT_SETTINGS).then(stored => {
    if (!_extCtxOk()) return; // context died before we got storage data
    _s = { ...DEFAULT_SETTINGS, ...stored };
    // Critical path — run immediately (affect visible content)
    if (_s.lagFix)     setupVirtualization();
    if (_s.modelBadge) setupModelBadge();
    if (_s.contextBar || _s.contextWarning) setupContextBar();
    // Non-critical — defer to idle so we don't block first paint
    // Always install the fetch interceptor — needed for vault encryption
    // even when contextBar/contextWarning are both off.
    _installFetchInterceptor();
    _setupSendInterceptor();
    _idle(() => {
      if (_s.bulkActions) {
        injectCheckboxes();
        if (_s.alphaMode) setupVault();
      }
      if (_s.compactSidebar) setupCompactSidebar();
      if (_s.dateGroups)     setupDateGroups();
    });
    _startWatchdog();

    console.log('[CGPT+] v3.5.0 ready');
  });
}, 150);

})();

