// ===========================================================================
// ChatGPT Enhanced - content.js  v3.4.0
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
    banner:      '[role="banner"]',
  },
  api: {
    conversations:    'https://chatgpt.com/backend-api/conversations',
    conversationBase: 'https://chatgpt.com/backend-api/conversation/',
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
  contextBar:     false,
  contextWarning: false,
  dateGroups:     false,
};
let _s = { ...DEFAULT_SETTINGS };

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------
function isDark() {
  return document.documentElement.classList.contains('dark');
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
        cursor:pointer;flex-shrink:0;box-sizing:border-box;
        border:1.5px solid rgba(107,114,128,.55);border-radius:3px;background:#fff;
        transition:opacity .1s,background .12s,border-color .12s;
        opacity:0;pointer-events:none;will-change:opacity;}
      .dark .cgpt-cb{background:#1e1e22;border-color:rgba(255,255,255,.28);}
      .cgpt-cb:checked{background:#10a37f;border-color:#10a37f;}
      .dark .cgpt-cb:checked{background:#19c37d;border-color:#19c37d;}
      .cgpt-cb:checked::after{content:'';display:block;width:4px;height:7px;
        border:1.5px solid #fff;border-top:none;border-left:none;
        transform:rotate(45deg);position:absolute;top:1px;left:4px;}`;
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

    // Top row: count label + Export button
    const topRow = document.createElement('div');
    Object.assign(topRow.style, { display:'flex', alignItems:'center', gap:'6px' });
    const cnt = document.createElement('span'); cnt.id = 'cgpt-count';
    Object.assign(cnt.style, { fontWeight:'700', fontSize:'13px', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', flex:'1' });
    const expBtn = _mkBtn('Export', () => _showExportModal());
    Object.assign(expBtn.style, { fontSize:'11px', padding:'4px 8px', flexShrink:'0' });
    topRow.append(cnt, expBtn);

    // Button row — all buttons flex-equal so they fill the full width neatly
    const btnRow = document.createElement('div');
    Object.assign(btnRow.style, { display:'flex', gap:'5px' });
    btnRow.append(
      _mkBtn('All',     () => _selectAll()),
      _mkBtn('None',    () => _deselectAll()),
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
// ---------------------------------------------------------------------------
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
  // Only hide label/text children — never hide SVG icons or structural elements.
  Array.from(newChatA.children).forEach((ch, i) => {
    if (i > 0 && (ch.tagName === 'SPAN' || ch.tagName === 'DIV' || ch.tagName === 'P'))
      ch.style.setProperty('display', 'none', 'important');
  });

  const sidebar = newChatA.closest('[role="complementary"]') || newChatA.parentElement;
  if (!sidebar) return;
  let ncBlock = newChatA;
  while (ncBlock.parentElement && ncBlock.parentElement !== sidebar) ncBlock = ncBlock.parentElement;
  const sidebarNav = sidebar.closest('[role="navigation"]') || sidebar.parentElement || null;
  const qRoot = sidebarNav || document.body;

  // Safety guard: never hide an element that contains chat links — that would
  // wipe the entire chat history from view if ChatGPT's DOM structure changes.
  function _isSafe(row) {
    if (!row) return false;
    if (row.querySelector('a[href^="/c/"]')) return false; // contains chat links
    if (row === document.body || row === document.documentElement) return false;
    return true;
  }

  function findByHref(href) {
    const a = qRoot.querySelector(`a[href="${href}"]`);
    if (!a) return null;
    const icon = a.querySelector('svg') || a.querySelector('img');
    const tw2 = document.createTreeWalker(a, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.trim() && !n.parentElement.closest('svg') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    const tn2 = tw2.nextNode();
    const leaf = tn2 ? { textContent: tn2.textContent.trim() } : null;
    // Prefer [data-sidebar-item] wrapper; fall back to the <a> itself (safe — it's just one link)
    const row  = a.closest('[data-sidebar-item]') || a;
    if (!_isSafe(row)) return null;
    return { native: row, label: leaf?.textContent.trim() || href.slice(1), icon };
  }

  // TreeWalker only visits text nodes — avoids scanning every element.
  // Walk up looking for the nearest element with cursor:pointer — that is the
  // actual interactive target (e.g. the search button wrapper, the Projects
  // button). Stopping at cursor:pointer ensures we hide the right element AND
  // that native.click() triggers the correct action.
  function findByText(text) {
    const tw = document.createTreeWalker(qRoot, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.textContent.trim() === text ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    });
    const tn = tw.nextNode();
    if (!tn) return null;
    let el = tn.parentElement;
    // Try closest semantic wrapper first
    let row = el?.closest('[data-sidebar-item]');
    if (!row) {
      // Walk up to 5 levels; target the nearest cursor:pointer ancestor
      // (the actual interactive element). Stop immediately on chat-link
      // containers or elements that are too large to safely hide.
      let cur = el;
      for (let i = 0; i < 5 && cur && cur !== qRoot; i++) {
        cur = cur.parentElement;
        if (!cur || cur === qRoot) break;
        if (cur.querySelector?.('a[href^="/c/"]')) break; // hit chat container — bail
        if (!_isSafe(cur)) break;
        if (cur.querySelectorAll('a,button').length > 6) break; // too large
        if (getComputedStyle(cur).cursor === 'pointer') { row = cur; break; }
      }
    }
    if (!row || !_isSafe(row)) return null;
    if (row.querySelectorAll('a,button').length > 6) return null;
    const icon = row.querySelector('svg') || row.querySelector('img');
    return { native: row, label: text, icon };
  }

  const ITEMS = [
    findByText('Search chats'), findByHref('/images'), findByHref('/apps'),
    findByHref('/codex'), findByText('Projects'),
  ].filter(Boolean);
  if (!ITEMS.length) return;

  if (ITEMS.length < 5 && !window._cgptGridRetried) {
    window._cgptGridRetried = true;
    setTimeout(() => {
      document.querySelectorAll('[data-cgpt-grid-hidden],[data-cgpt-container-hidden]').forEach(el => {
        el.style.removeProperty('display');
        delete el.dataset.cgptGridHidden; delete el.dataset.cgptContainerHidden;
      });
      document.getElementById('cgpt-icon-grid')?.remove();
      delete window._cgptGridRetried;
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
    .cgpt-grid-btn:hover .cgpt-tip{opacity:1;transform:translateX(-50%) translateY(0)}`;

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

  // Container-hiding removed — individual items are already hidden and hiding
  // parent containers risks breaking page layout when ChatGPT updates their DOM.
  // No secondary MutationObserver — _mutObs already detects icon-grid removal.
}

// ---------------------------------------------------------------------------
// FEATURE 4 — Model Badge
// What changed: _syncModelFromBtn (setInterval 3s) is gone. Model reads happen
// only through MutationObserver on the button's aria-label, which ChatGPT
// already updates natively. Zero polling overhead.
// ---------------------------------------------------------------------------
const MODEL_RANK = ['o1-mini','4o-mini','gpt-4o-mini','gpt-3.5','4o','gpt-4o','chatgpt-4o','gpt-4','gpt-4-turbo','5','5.2','o1','o1-preview','o3-mini','o4-mini','o3','o4','o3-pro','gpt-5'];
let _maxRank    = -1;
let _modelBtnObs = null;
let _bannerObs   = null;
let _lastModelBtn = null;   // reference to the last observed model button element
let _modelPollTimer = 0;    // lightweight poll backstop for model changes

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
  if (_s.contextBar || _s.contextWarning) {
    requestAnimationFrame(() => {
      document.getElementById('cgpt-ctx-bar')?.remove();
      _getOrCreateCtxBar();
      _renderCtxBar();
    });
  }
}

function _attachModelBtnObs(btn) {
  if (_modelBtnObs) _modelBtnObs.disconnect();
  _lastModelBtn = btn;
  _modelBtnObs = new MutationObserver(() => _readModel(btn));
  // Watch attributes (aria-label), children (React re-renders), and text changes
  _modelBtnObs.observe(btn, { attributes: true, childList: true, subtree: true, characterData: true });
}

function setupModelBadge(force = false) {
  const btn = document.querySelector(CONFIG.sel.modelBtn);
  if (!btn) return;
  if (force || !document.getElementById('cgpt-model-badge')) _rebuildBadge(btn);
  else _readModel(btn);

  _attachModelBtnObs(btn);

  const bannerEl = btn.closest('[role="banner"]') || btn.parentElement;
  if (bannerEl) {
    if (_bannerObs) _bannerObs.disconnect();
    _bannerObs = new MutationObserver(() => {
      const btn2 = document.querySelector(CONFIG.sel.modelBtn);
      if (!btn2) return;
      // If the model button was replaced by React, re-attach observer
      if (btn2 !== _lastModelBtn) {
        _attachModelBtnObs(btn2);
        if (!document.getElementById('cgpt-model-badge')) {
          requestAnimationFrame(() => _rebuildBadge(btn2));
        }
      }
      // Always re-read model from the (possibly new) button
      _readModel(btn2);
    });
    _bannerObs.observe(bannerEl, { childList: true, subtree: true });
  }

  // Lightweight poll backstop (every 3s) — catches edge cases where
  // React silently replaces the button without triggering mutations.
  clearInterval(_modelPollTimer);
  _modelPollTimer = setInterval(() => {
    if (_dead || !_s.modelBadge) { clearInterval(_modelPollTimer); return; }
    const b = document.querySelector(CONFIG.sel.modelBtn);
    if (!b) return;
    if (b !== _lastModelBtn) {
      _attachModelBtnObs(b);
      if (!document.getElementById('cgpt-model-badge')) _rebuildBadge(b);
    }
    _readModel(b);
  }, 3000);
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
  'gpt-4o':128000,'4o':128000,'chatgpt-4o':128000,'4o-mini':128000,'gpt-4o-mini':128000,
  // GPT-4
  'gpt-4-turbo':128000,'gpt-4':128000,
  // Legacy
  'gpt-3.5':16000,'gpt-3.5-turbo':16000,
};
let _ctxWin  = 128000;
let _ctxToks = 0;
let _ctxFiles = 0;           // attachment/file count in current conversation
let _ctxModel = '';           // latest model slug from conversation API
let _ctxRefreshObs = null;   // MutationObserver for auto-refresh after messages
let _ctxRefreshTimer = 0;    // debounce timer for refresh

function _getCtxWindow(slug) {
  const s = (slug || '').toLowerCase();
  for (const [k, v] of Object.entries(CTX_WINS)) { if (s.includes(k)) return v; }
  return 128000;
}

function _getOrCreateCtxBar() {
  let bar = document.getElementById('cgpt-ctx-bar');
  if (bar) return bar;
  bar = document.createElement('div'); bar.id = 'cgpt-ctx-bar';
  const dark = isDark();
  Object.assign(bar.style, { display:'inline-flex', alignItems:'center', gap:'6px', padding:'3px 9px', borderRadius:'8px', flexShrink:'0', marginLeft:'6px', border: dark ? '1px solid rgba(255,255,255,.14)' : '1px solid rgba(0,0,0,.12)', background: dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)', color: dark ? '#ececec' : '#111', fontSize:'11px', fontFamily:'inherit', fontWeight:'500', cursor:'pointer', userSelect:'none', position:'relative' });
  const fc = dark ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.40)';
  bar.innerHTML = `<div style="width:52px;height:4px;border-radius:2px;background:rgba(128,128,128,.22);overflow:hidden;flex-shrink:0"><div id="cgpt-ctx-fill" style="height:100%;width:0%;border-radius:2px;background:${fc};transition:width .4s"></div></div><span id="cgpt-ctx-pct" style="min-width:44px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums">…</span><span id="cgpt-ctx-files" style="display:none;font-size:10px;opacity:.6;white-space:nowrap"></span>`;
  bar.addEventListener('click', _toggleCtxPopover);
  bar.title = 'Click for context details';
  const badge = document.getElementById('cgpt-model-badge');
  if (badge?.parentElement) badge.parentElement.insertBefore(bar, badge.nextSibling);
  else { const bn = document.querySelector(CONFIG.sel.banner); if (bn) bn.appendChild(bar); }
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
    // File attachment count indicator with upload limit
    const fEl = document.getElementById('cgpt-ctx-files');
    if (fEl) {
      const estLimit = 50;
      fEl.style.display = '';
      if (_ctxFiles > 0) {
        const fPct = Math.min(100, Math.round((_ctxFiles / estLimit) * 100));
        fEl.style.color = fPct >= 100 ? '#ef4444' : fPct >= 70 ? '#f97316' : '';
        fEl.textContent = `\u{1F4CE} ${_ctxFiles} / ~${estLimit}`;
      } else {
        fEl.style.color = '';
        fEl.textContent = `\u{1F4CE} 0 / ~${estLimit}`;
        fEl.style.opacity = '.4';
      }
      if (_ctxFiles > 0) fEl.style.opacity = '.7';
    }
  });
}

function _showCtxWarn() {
  if (!_s.contextWarning || document.getElementById('cgpt-ctx-warn')) return;
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
async function _parseSSE(stream) {
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
  if (window._cgptFetchHooked) return;
  window._cgptFetchHooked = true;
  const _orig = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    // NOTE: content scripts run in an isolated JS world. This patched window.fetch
    // only intercepts fetches made by our own extension code, NOT ChatGPT's page.
    // Tee only the streaming POST for context bar SSE parsing (best-effort).
    const res = await _orig.call(this, input, init);
    if ((init?.method || 'GET').toUpperCase() === 'POST'
        && url.includes('/backend-api/conversation')
        && !url.includes('?')
        && res.body) {
      try {
        const [b1, b2] = res.body.tee();
        _parseSSE(b2);
        return new Response(b1, { status: res.status, statusText: res.statusText, headers: res.headers });
      } catch {}
    }
    return res;
  };
}

async function _fetchCtxData(chatId, retries = 2) {
  if (!chatId || (!_s.contextBar && !_s.contextWarning) || !_extCtxOk()) return;
  try {
    let h;
    try { h = await getHeaders(); } catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!_extCtxOk()) return;
    let r;
    try { r = await fetch(`${CONFIG.api.conversationBase}${chatId}`, Object.keys(h).length ? { headers: h } : undefined); }
    catch (e) { if (_isCtxErr(e)) _killScript(); return; }
    if (!_extCtxOk()) return;
    if (r.status === 401 && retries > 0) { setTimeout(() => { if (!_dead) _fetchCtxData(chatId, retries - 1); }, 3000); return; }
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
        if (typeof p === 'string') chars += p.length;
        else if (p && (p.asset_pointer || p.content_type === 'image_asset_pointer')) files++;
      });
    });
    _ctxToks  = maxToks > 0 ? maxToks : Math.round(chars / 4);
    _ctxFiles = files;
    _ctxModel = slug;
    const w = _getCtxWindow(slug);
    if (w !== _ctxWin) _ctxWin = w;
    // Sync model badge from API data (catches model changes the button observer might miss)
    if (slug && _s.modelBadge) {
      const lbl = document.getElementById('cgpt-badge-label');
      // API model_slug is the ground truth — update badge label directly
      if (lbl && lbl.textContent !== slug) lbl.textContent = slug;
      const btn = document.querySelector(CONFIG.sel.modelBtn);
      if (btn) _readModel(btn);
    }
    _renderCtxBar();
  } catch (e) {
    if (_isCtxErr(e)) { _killScript(); return; }
    _renderCtxBar();
  }
}

function setupContextBar() {
  _installFetchInterceptor(); // lazy — only when this feature is on
  // Sync model window from button immediately (no timer)
  const btn = document.querySelector(CONFIG.sel.modelBtn);
  if (btn) {
    const m = (btn.getAttribute('aria-label') || '').match(/current model is (.+)/i);
    if (m) _ctxWin = _getCtxWindow(m[1].trim());
  }
  if (_s.contextBar) _getOrCreateCtxBar();
  const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
  if (chatId) { _fetchCtxData(chatId); _setupCtxRefreshObserver(); }
  else _renderCtxBar();
}

function teardownContextBar() {
  document.getElementById('cgpt-ctx-bar')?.remove();
  document.getElementById('cgpt-ctx-warn')?.remove();
  document.getElementById('cgpt-ctx-popover')?.remove();
  _teardownCtxRefreshObserver();
  _ctxToks = 0;
  _ctxFiles = 0;
  _ctxModel = '';
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
        _fetchCtxData(chatId);
        // Also refresh model badge
        if (_s.modelBadge) {
          const btn = document.querySelector(CONFIG.sel.modelBtn);
          if (btn) _readModel(btn);
        }
      }
    }, 2500); // 2.5s debounce — lets streaming finish before re-fetching
  });
  const target = document.querySelector('main') || document.body;
  _ctxRefreshObs.observe(target, { childList: true, subtree: true });
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

  // File upload limit estimation — soft guidance based on known ChatGPT limits
  const f = _ctxFiles;
  const estLimit = 50; // approximate per-conversation file limit (ChatGPT Plus/Pro)
  const fPct = f > 0 ? Math.min(100, Math.round((f / estLimit) * 100)) : 0;
  const fColor = fPct >= 100 ? '#ef4444' : fPct >= 70 ? '#f97316' : '#10a37f';
  let fStatus;
  if (f >= estLimit) {
    fStatus = `<span style="color:#ef4444;font-weight:600">\u26A0 File upload limit likely reached</span><br><span style="opacity:.55;font-size:11px;line-height:1.5">Start a new conversation for a fresh file quota.<br>Limits typically refresh within a few hours.</span>`;
  } else if (f >= estLimit * 0.7) {
    fStatus = `<span style="color:#f97316;font-weight:600">\u26A0 Approaching upload limit</span><br><span style="opacity:.55;font-size:11px">${estLimit - f} more files estimated before limit</span>`;
  } else if (f > 0) {
    fStatus = `<span style="opacity:.5">${estLimit - f} more files estimated before limit</span>`;
  } else {
    fStatus = `<span style="opacity:.35">No files uploaded in this chat</span>`;
  }

  const sep = `border-top:1px solid ${dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)'};padding-top:10px;margin-top:10px`;

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
        <span style="opacity:.5;font-size:11px">\u{1F4CE} FILES</span>
        <span style="font-weight:600">${f} uploaded</span>
      </div>
      ${f > 0 ? `<div style="width:100%;height:4px;border-radius:2px;background:rgba(128,128,128,.18);overflow:hidden;margin-bottom:6px"><div style="height:100%;width:${fPct}%;border-radius:2px;background:${fColor}"></div></div>` : ''}
      <div style="font-size:11px;line-height:1.55">${fStatus}</div>
    </div>
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

// TOP-BAR EXPORT BUTTON — inline button in the banner (right side)
// ---------------------------------------------------------------------------
function _getOrCreateExportBtn() {
  let btn = document.getElementById('cgpt-export-btn');
  if (btn) return btn;
  const dark = isDark();
  btn = document.createElement('button'); btn.id = 'cgpt-export-btn';
  Object.assign(btn.style, { display:'inline-flex', alignItems:'center', gap:'5px', padding:'3px 10px 3px 8px', borderRadius:'8px', border: dark ? '1px solid rgba(255,255,255,.14)' : '1px solid rgba(0,0,0,.12)', background: dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)', color: dark ? '#ececec' : '#111', fontSize:'12px', fontWeight:'500', fontFamily:'inherit', cursor:'pointer', userSelect:'none', flexShrink:'0', marginLeft:'6px', transition:'opacity .12s' });
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Export</span>`;
  btn.addEventListener('mouseenter', () => btn.style.opacity = '.75');
  btn.addEventListener('mouseleave', () => btn.style.opacity = '1');
  btn.addEventListener('click', _exportCurrentChat);
  // Place after context bar, or after model badge, or append to banner
  const ctxBar = document.getElementById('cgpt-ctx-bar');
  const badge  = document.getElementById('cgpt-model-badge');
  const ref    = ctxBar || badge;
  const parent = ref?.parentElement;
  if (parent) parent.insertBefore(btn, ref.nextSibling);
  else { const bn = document.querySelector(CONFIG.sel.banner); if (bn) bn.appendChild(btn); }
  return btn;
}

function _exportCurrentChat() {
  const chatId = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
  if (!chatId) { alert('Navigate to a chat first.'); return; }
  _showExportModal(new Set([chatId]));
}

// ---------------------------------------------------------------------------
// FEATURE 10 — Export Selected Chats (Markdown / Plain Text / PDF)
// ---------------------------------------------------------------------------
function _showExportModal(exportIds) {
  const ids = exportIds || _selectedIds;
  if (!ids.size) { alert('No chats selected for export.'); return; }
  const dark = isDark();
  const overlay = document.createElement('div');
  Object.assign(overlay.style, { position:'fixed', inset:'0', background:'rgba(0,0,0,.65)', zIndex:'1000001', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' });
  const box = document.createElement('div');
  Object.assign(box.style, { background: dark ? '#1a1a1e' : '#fff', color: dark ? '#ececec' : '#111', borderRadius:'18px', padding:'28px', width:'min(360px,92vw)', boxShadow:'0 24px 64px rgba(0,0,0,.55)', display:'flex', flexDirection:'column', gap:'14px' });
  const ttl = document.createElement('div'); ttl.style.cssText='font-weight:700;font-size:16px';
  ttl.textContent = `Export ${ids.size} conversation${ids.size>1?'s':''}`;
  const sub = document.createElement('div'); sub.style.cssText='font-size:12px;opacity:.5';
  sub.textContent = 'Choose a format:';
  const formats = [
    { id:'md',  label:'Markdown (.md)',  desc:'Preserves code blocks, headers, bold text' },
    { id:'txt', label:'Plain Text (.txt)',desc:'Clean, simple, universally readable' },
    { id:'pdf', label:'PDF',              desc:'Beautiful styled document — opens browser print' },
  ];
  let chosen = 'md';
  const fmtWrap = document.createElement('div'); fmtWrap.style.cssText='display:flex;flex-direction:column;gap:7px';
  formats.forEach(f => {
    const btn = document.createElement('button'); btn.dataset.fmt = f.id;
    Object.assign(btn.style, { display:'flex', alignItems:'center', gap:'12px', padding:'11px 13px', border: dark ? '1.5px solid rgba(255,255,255,.1)' : '1.5px solid rgba(0,0,0,.09)', borderRadius:'11px', background:'none', cursor:'pointer', fontFamily:'inherit', color: dark ? '#ececec' : '#111', textAlign:'left', transition:'border-color .12s,background .12s' });
    btn.innerHTML = `<span><span style="display:block;font-weight:600;font-size:13px">${f.label}</span><span style="display:block;font-size:11px;opacity:.45;margin-top:1px">${f.desc}</span></span>`;
    const mark = () => { chosen=f.id; fmtWrap.querySelectorAll('button').forEach(b=>{b.style.borderColor=b.dataset.fmt===f.id?'#10a37f':(dark?'rgba(255,255,255,.1)':'rgba(0,0,0,.09)');b.style.background=b.dataset.fmt===f.id?(dark?'rgba(16,163,127,.12)':'rgba(16,163,127,.07)'):'none';}); };
    btn.addEventListener('click', mark); if (f.id==='md') setTimeout(mark,0);
    fmtWrap.appendChild(btn);
  });
  const prog = document.createElement('div'); prog.style.cssText='font-size:12px;opacity:.5;min-height:14px;text-align:center';
  const expBtn = document.createElement('button'); expBtn.textContent='Export';
  Object.assign(expBtn.style, { background:'#10a37f', color:'#fff', border:'none', borderRadius:'11px', padding:'12px', fontSize:'14px', fontWeight:'600', cursor:'pointer', fontFamily:'inherit', transition:'opacity .1s' });
  expBtn.addEventListener('mouseenter',()=>expBtn.style.opacity='.85');
  expBtn.addEventListener('mouseleave',()=>expBtn.style.opacity='1');
  expBtn.addEventListener('click', async () => {
    expBtn.disabled=true; expBtn.style.opacity='.5'; expBtn.textContent='Exporting…';
    try { await _runExport(chosen, prog, ids); overlay.remove(); }
    catch(e) { prog.textContent='Error: '+e.message; expBtn.disabled=false; expBtn.style.opacity='1'; expBtn.textContent='Export'; }
  });
  const cancelBtn = document.createElement('button'); cancelBtn.textContent='Cancel';
  Object.assign(cancelBtn.style, { background:'none', color: dark?'rgba(255,255,255,.35)':'rgba(0,0,0,.35)', border:'none', fontSize:'13px', cursor:'pointer', fontFamily:'inherit' });
  cancelBtn.onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if(e.target===overlay) overlay.remove(); });
  box.append(ttl, sub, fmtWrap, prog, expBtn, cancelBtn);
  overlay.appendChild(box); document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Minimal ZIP file generator (STORE method, no compression, pure JS)
// ---------------------------------------------------------------------------
function _crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function _createZipBlob(files) {
  const enc = new TextEncoder();
  const parts = [], centralDir = [];
  let offset = 0;
  files.forEach(file => {
    const nameBytes = enc.encode(file.name);
    const dataBytes = enc.encode(file.content);
    const crc = _crc32(dataBytes);
    // Local file header (30 + name length)
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint32(14, crc, true);
    lv.setUint32(18, dataBytes.length, true);
    lv.setUint32(22, dataBytes.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, dataBytes);
    // Central directory entry (46 + name length)
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, dataBytes.length, true);
    cv.setUint32(24, dataBytes.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    centralDir.push(cd);
    offset += local.length + dataBytes.length;
  });
  const cdOffset = offset;
  let cdSize = 0;
  centralDir.forEach(cd => { parts.push(cd); cdSize += cd.length; });
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  parts.push(eocd);
  return new Blob(parts, { type: 'application/zip' });
}

async function _runExport(format, progress, exportIds) {
  if (!_extCtxOk()) throw new Error('Extension reloaded — please refresh the page');
  let h;
  try { h = await getHeaders(); } catch (e) { if (_isCtxErr(e)) _killScript(); throw new Error('Extension reloaded — please refresh the page'); }
  if (!_extCtxOk() || !h.authorization) throw new Error('Auth not captured — send a message in ChatGPT first');
  const ids = [...(exportIds || _selectedIds)], convos = [];
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

  // Multi-chat: create individual files and zip them together
  if (convos.length > 1 && (format === 'md' || format === 'txt')) {
    if (progress) progress.textContent = 'Creating zip…';
    const ext = format === 'md' ? '.md' : '.txt';
    const usedNames = {};
    const files = convos.map(c => {
      let name = (c.title || 'chat').replace(/[^\w\s-]/g, '').trim().slice(0, 50) || 'chat';
      if (usedNames[name]) { usedNames[name]++; name += ` (${usedNames[name]})`; } else { usedNames[name] = 1; }
      return { name: name + ext, content: format === 'md' ? _buildMd([c]) : _buildTxt([c]) };
    });
    const zipBlob = _createZipBlob(files);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zipBlob);
    a.download = `chatgpt-export-${date}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    return;
  }

  const base = convos.length===1 ? (convos[0].title||'chat').replace(/[^\w\s-]/g,'').trim().slice(0,50) : `chatgpt-export-${date}`;
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
      const text  = Array.isArray(parts) ? parts.filter(p => typeof p==='string').join('') : (msg.content.text||'');
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
  const out = [`# ChatGPT Export`, `*Exported ${new Date().toLocaleString()}*`, ''];
  convos.forEach((c, ci) => {
    if (ci>0) out.push('', '---', '');
    out.push(`## ${c.title}`);
    if (c.create_time) out.push(`*${_fmtTime(c.create_time)}*`);
    out.push('');
    c.msgs.forEach(m => {
      out.push(m.role==='user' ? '### You' : '### ChatGPT');
      out.push('');
      out.push(m.text);
      out.push('');
    });
  });
  return out.join('\n');
}

function _buildTxt(convos) {
  const HR = '─'.repeat(64);
  const out = [`ChatGPT Export — ${new Date().toLocaleString()}`, HR, ''];
  convos.forEach((c, ci) => {
    if (ci>0) out.push('', HR, '');
    out.push(`▌ ${c.title.toUpperCase()}`);
    if (c.create_time) out.push(`  ${_fmtTime(c.create_time)}`);
    out.push('');
    c.msgs.forEach(m => {
      out.push(m.role==='user' ? 'YOU:' : 'CHATGPT:');
      m.text.split('\n').forEach(line => {
        if (line.length<=80) { out.push('  '+line); return; }
        let rem=line;
        while (rem.length>80) { const p=rem.lastIndexOf(' ',80); const cut=p>0?p:80; out.push('  '+rem.slice(0,cut)); rem=rem.slice(cut+1); }
        if (rem) out.push('  '+rem);
      });
      out.push('');
    });
  });
  return out.join('\n');
}

function _buildPdfHtml(convos) {
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const fmtBody = raw => esc(raw)
    .replace(/```(\w*)\n?([\s\S]*?)```/g, (_,lang,code)=>`<pre class="cb"><code${lang?` class="lang-${lang}"`:''}>${code}</code></pre>`)
    .replace(/`([^`]+)`/g,'<code class="ic">$1</code>')
    .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.+?)\*/g,'<em>$1</em>')
    .replace(/\n/g,'<br>');
  const msgsHtml = convos.map((c,ci) => {
    const sep = ci>0 ? '<div class="conv-sep"></div>' : '';
    const msgs = c.msgs.map(m => `
      <div class="msg ${m.role==='user'?'mu':'ma'}">
        <div class="role">${m.role==='user'?'You':'ChatGPT'}</div>
        <div class="body">${fmtBody(m.text)}</div>
      </div>`).join('');
    return `${sep}<h2 class="ctitle">${esc(c.title||'Untitled')}</h2>${c.create_time?`<p class="cdate">${_fmtTime(c.create_time)}</p>`:''}<div class="msgs">${msgs}</div>`;
  }).join('');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>ChatGPT Export</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#1a1a1a;font-size:14px;line-height:1.75;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{max-width:740px;margin:0 auto;padding:52px 44px}
.exp-hdr{padding-bottom:24px;margin-bottom:40px;border-bottom:2px solid #efefef}
.exp-hdr h1{font-size:22px;font-weight:700;display:flex;align-items:center;gap:10px}
.exp-hdr .meta{font-size:12px;color:#999;margin-top:6px}
.conv-sep{border:none;border-top:2px solid #f0f0f0;margin:48px 0;page-break-after:always}
.ctitle{font-size:18px;font-weight:700;color:#111;margin-bottom:5px}
.cdate{font-size:12px;color:#aaa;margin-bottom:28px}
.msgs{display:flex;flex-direction:column;gap:16px}
.msg{border-radius:12px;padding:16px 20px;page-break-inside:avoid}
.mu{background:#f0faf7;border-left:3.5px solid #10a37f}
.ma{background:#fafafa;border-left:3.5px solid #e0e0e0}
.role{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.mu .role{color:#0d8a6b}
.ma .role{color:#888}
.body{color:#1a1a1a;white-space:pre-wrap;word-wrap:break-word}
pre.cb{background:#1e1e2e;color:#cdd6f4;border-radius:10px;padding:16px 20px;margin:12px 0;overflow-x:auto;font-family:'JetBrains Mono',Consolas,monospace;font-size:12.5px;line-height:1.6;page-break-inside:avoid;white-space:pre}
code.ic{background:rgba(0,0,0,.07);color:#c2185b;padding:2px 6px;border-radius:4px;font-family:'JetBrains Mono',monospace;font-size:12px}
@media print{
  body{background:#fff}
  .page{padding:0;max-width:100%}
  .conv-sep{page-break-after:always}
  .msg{page-break-inside:avoid}
}
</style></head><body><div class="page">
<div class="exp-hdr"><h1>ChatGPT Export</h1><div class="meta">Exported ${new Date().toLocaleString()} &nbsp;·&nbsp; ${convos.length} conversation${convos.length>1?'s':''} &nbsp;·&nbsp; ${convos.reduce((a,c)=>a+c.msgs.length,0)} messages</div></div>
${msgsHtml}</div></body></html>`;
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
  // Wait for fonts/images to settle before triggering the print dialog
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
    if (!_dead && _s.bulkActions) injectCheckboxes();
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
  try {
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
  } catch (e) { console.warn('[CGPT+] observer error:', e); }
});
// NOTE: _mutObs.observe() is called inside the boot callback, NOT here.
// Starting the observer at parse time fires during React's hydration flood,
// causing injectCheckboxes() to modify React-managed DOM mid-reconciliation.

// ---------------------------------------------------------------------------
// SPA NAVIGATION DETECTOR
// We do NOT patch history.pushState / replaceState at all.
// Reason: content scripts run at document_idle, BEFORE ChatGPT's JS bundle
// finishes loading. Capturing history.pushState at that point gives us the
// *native* function — before React Router wraps it. Calling that native
// version later bypasses React Router entirely, freezing the page.
// Instead we poll location.pathname every 750ms. This is imperceptible to
// users and is the standard pattern used by browser extensions.
// ---------------------------------------------------------------------------
function _onNav() {
  _sbBgCache = null;
  _ctxToks   = 0;
  _ctxFiles  = 0;
  _ctxModel  = '';
  document.getElementById('cgpt-ctx-bar')?.remove();
  document.getElementById('cgpt-ctx-warn')?.remove();
  document.getElementById('cgpt-ctx-popover')?.remove();
  document.getElementById('cgpt-export-btn')?.remove();
  delete window._cgptGridRetried;

  requestAnimationFrame(() => {
    try { if (_s.compactSidebar) setupCompactSidebar(); } catch (e) { console.warn('[CGPT+] nav compactSidebar:', e); }
    try { if (_s.dateGroups) { teardownDateGroups(); setTimeout(setupDateGroups, 600); } } catch (e) { console.warn('[CGPT+] nav dateGroups:', e); }
    requestAnimationFrame(() => {
      try { if (_s.modelBadge) setupModelBadge(true); } catch (e) { console.warn('[CGPT+] nav modelBadge:', e); }
      try {
        if (_s.contextBar || _s.contextWarning) {
          if (_s.contextBar) _getOrCreateCtxBar();
          const id = location.pathname.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
          if (id) { _fetchCtxData(id); _setupCtxRefreshObserver(); }
          else { _teardownCtxRefreshObserver(); _renderCtxBar(); }
        }
      } catch (e) { console.warn('[CGPT+] nav contextBar:', e); }
      try { if (location.pathname.match(/\/c\//)) _getOrCreateExportBtn(); } catch {}
      try { if (_s.bulkActions) injectCheckboxes(); } catch (e) { console.warn('[CGPT+] nav bulkActions:', e); }
    });
  });
}

// URL polling replaces history.pushState patching — see comment above.
let _lastNavPath = '';
function _installNavDetector() {
  _lastNavPath = location.pathname;
  // Poll every 750ms — imperceptible lag, zero impact on ChatGPT's router.
  setInterval(() => {
    if (_dead) return;
    const cur = location.pathname;
    if (cur === _lastNavPath) return;
    _lastNavPath = cur;
    // Refresh context bar on any URL change (even same-chat param changes)
    if (_s.contextBar || _s.contextWarning) {
      const id = cur.match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
      if (id) _fetchCtxData(id); else { _ctxToks = 0; _renderCtxBar(); }
    }
    // Full nav refresh — run after a short delay so React has settled
    setTimeout(_onNav, 120);
  }, 750);
  // popstate (browser back/forward) doesn't need polling
  window.addEventListener('popstate', () => {
    _lastNavPath = location.pathname;
    setTimeout(_onNav, 120);
  }, { passive: true });
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
    case 'bulkActions':
      if (_s.bulkActions) { injectCheckboxes(); break; }
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
      delete window._cgptGridWatcher; delete window._cgptGridRetried;
      break;
    case 'modelBadge':
      if (_s.modelBadge) { setupModelBadge(true); break; }
      document.getElementById('cgpt-model-badge')?.remove();
      document.getElementById('cgpt-ctx-bar')?.remove();
      document.getElementById('cgpt-export-btn')?.remove();
      _bannerObs?.disconnect(); _modelBtnObs?.disconnect();
      clearInterval(_modelPollTimer);
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

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------
setTimeout(() => {
  _syncGet(DEFAULT_SETTINGS).then(stored => {
    if (!_extCtxOk()) return; // context died before we got storage data
    _s = { ...DEFAULT_SETTINGS, ...stored };
    // Critical path — run immediately (affect visible content)
    // Each feature is isolated so one failure doesn't break the rest.
    try { if (_s.lagFix)     setupVirtualization(); } catch (e) { console.warn('[CGPT+] lagFix init:', e); }
    try { if (_s.modelBadge) setupModelBadge(); } catch (e) { console.warn('[CGPT+] modelBadge init:', e); }
    try { if (_s.contextBar || _s.contextWarning) setupContextBar(); } catch (e) { console.warn('[CGPT+] contextBar init:', e); }
    // Top-bar export button on chat pages
    if (location.pathname.match(/\/c\//)) setTimeout(() => { try { _getOrCreateExportBtn(); } catch {} }, 500);
    // Non-critical — defer to idle so we don't block first paint
    try { _installFetchInterceptor(); } catch (e) { console.warn('[CGPT+] fetchInterceptor:', e); }
    // Nav detector uses URL polling — does NOT patch history.pushState.
    try { _installNavDetector(); } catch (e) { console.warn('[CGPT+] navDetector:', e); }
    // Start MutationObserver NOW (after settings load) — not at parse time.
    // Firing during React hydration caused injectCheckboxes() to mutate the
    // React-managed DOM mid-reconciliation, corrupting the fiber tree.
    try { _mutObs.observe(document.body, { childList: true, subtree: true }); } catch (e) { console.warn('[CGPT+] mutObs:', e); }
    _idle(() => {
      try { if (_s.bulkActions)    injectCheckboxes(); } catch (e) { console.warn('[CGPT+] bulkActions init:', e); }
      try { if (_s.compactSidebar) setupCompactSidebar(); } catch (e) { console.warn('[CGPT+] compactSidebar init:', e); }
      try { if (_s.dateGroups)     setupDateGroups(); } catch (e) { console.warn('[CGPT+] dateGroups init:', e); }
    });

    console.log('[CGPT+] v3.4.0 ready');
  });
}, 150);

})();

