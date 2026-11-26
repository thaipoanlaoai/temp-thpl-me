/* Temp Clipboard — app logic (cloud edition v2)
 * - บัญชีเดียว + คุกกี้ session 30 วัน (Cloudflare Worker)
 * - โพสต์/รูปเก็บบน KV: อ่าน/เขียนผ่าน /api/*
 * - ค้นหา + แท็ก + ปักหมุด + สถิติพื้นที่
 * - ออฟไลน์: แคชฟีดล่าสุด + คิวโพสต์รอส่ง (IndexedDB)
 * - ติดตั้งเป็นแอป (PWA)
 */
(() => {
  'use strict';
  const T = window.TCI18N;

  /* ---------- config ---------- */
  const SETTINGS_KEY = 'tc:settings:v1';
  const DRAFT_KEY = 'tc:draft:v1';
  const DRAFT_TAGS_KEY = 'tc:draft-tags:v1';
  const IMPORT_FLAG = 'tc:imported:v1';
  const FEED_CACHE = 'tc:feed-cache:v1';
  const LEGACY_DB = 'temp-thpl-me';
  const OFFLINE_DB = 'tc-offline';
  const OFFLINE_STORE = 'outbox';
  const MAX_IMAGES = 4;
  const MAX_FILES = 4;          // ไฟล์แนบที่ไม่ใช่รูป ต่อโพสต์
  const MAX_TAGS = 8;
  const MAX_TAG_LEN = 24;
  const MAX_DIM = 1600;
  const JPEG_QUALITY = 0.85;
  const HARD_FILE_LIMIT = 25 * 1024 * 1024;   // รูปต้นฉบับก่อนบีบอัด
  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // ไฟล์แนบ (ตรงกับ Worker: MAX_FILE_BYTES)
  const POLL_MS = 30000;

  /* ---------- dom ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const el = {
    gate: $('#gate'),
    app: $('#app'),
    loginForm: $('#login-form'),
    loginEmail: $('#login-email'),
    loginPassword: $('#login-password'),
    loginRemember: $('#login-remember'),
    loginSubmit: $('#login-submit'),
    loginError: $('#login-error'),

    offlineBar: $('#offline-bar'),
    offlineText: $('#offline-text'),
    pendingCount: $('#pending-count'),

    draft: $('#draft'),
    tagInput: $('#tag-input'),
    tagSuggest: $('#tag-suggest'),
    attachStrip: $('#attach-strip'),
    fileInput: $('#file-input'),
    btnAttach: $('#btn-attach'),
    btnClearDraft: $('#btn-clear-draft'),
    btnPost: $('#btn-post'),
    tempNote: $('#temp-note'),

    search: $('#search'),
    searchClear: $('#search-clear'),
    tagBar: $('#tag-bar'),

    feed: $('#feed'),
    empty: $('#empty'),
    emptyTitle: $('#empty-title'),
    emptyHint: $('#empty-hint'),
    stats: $('#stats'),
    sync: $('#sync'),
    btnStats: $('#btn-stats'),
    btnClearAll: $('#btn-clear-all'),
    expireSelect: $('#expire-select'),
    sessionMode: $('#session-mode'),
    toast: $('#toast'),
    themeToggle: $('#theme-toggle'),
    composer: $('#composer'),

    acctBtn: $('#acct-btn'),
    acctAva: $('#acct-ava'),
    acctMenu: $('#acct-menu'),
    acctMail: $('#acct-mail'),
    acctInstall: $('#acct-install'),
    acctPass: $('#acct-pass'),
    acctOut: $('#acct-out'),

    importBar: $('#import-bar'),
    importText: $('#import-text'),
    importYes: $('#import-yes'),
    importNo: $('#import-no'),

    pwDialog: $('#pw-dialog'),
    pwForm: $('#pw-form'),
    pwCurrent: $('#pw-current'),
    pwNext: $('#pw-next'),
    pwConfirm: $('#pw-confirm'),
    pwError: $('#pw-error'),
    pwSave: $('#pw-save'),
    pwCancel: $('#pw-cancel'),

    statsDialog: $('#stats-dialog'),
    statGrid: $('#stat-grid'),
    monthBars: $('#month-bars'),
    tagStats: $('#tag-stats'),
    quotaPct: $('#quota-pct'),
    quotaFill: $('#quota-fill'),
    statsClose: $('#stats-close'),

    installDialog: $('#install-dialog'),
    installText: $('#install-text'),
    installClose: $('#install-close'),

    langs: Array.from(document.querySelectorAll('.lang'))
  };

  /* ---------- state ---------- */
  let settings = { lang: null, theme: null, expireDays: 0, session: false };
  let view = { q: '', tag: null, pinned: false };
  let posts = [];        // cloud posts
  let memPosts = [];     // temporary posts (this tab only)
  let queuedPosts = [];  // offline queue rendered optimistically
  let me = null;
  let draftImages = [];
  let draftFiles = [];   // ไฟล์แนบที่ไม่ใช่รูป: { id, blob, url, name, type, size }
  let lastDeleted = null;
  let clearArmed = false;
  let clearTimer = 0;
  let toastTimer = 0;
  let searchTimer = 0;
  let saving = false;
  let syncing = false;
  let polling = 0;
  let draftTimer = 0;
  let lastLoadFailed = false;
  let deferredPrompt = null;
  let readyResolve = null;
  const readyPromise = new Promise((r) => { readyResolve = r; });

  /* ---------- i18n ---------- */
  const t = (key, params) => {
    const dict = T.dicts[settings.lang] || T.dicts.th;
    let s = dict[key] != null ? dict[key] : (T.dicts.th[key] != null ? T.dicts.th[key] : key);
    if (params) for (const k of Object.keys(params)) s = s.split('{' + k + '}').join(String(params[k]));
    return s;
  };

  /* ---------- api ---------- */
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      const err = new Error('network');
      err.network = true;
      throw err;
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  /* ---------- utils ---------- */
  const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  function fmtBytes(n) {
    if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)) + ' ' + units[i];
  }
  function fmtDate(ms) {
    try {
      return new Intl.DateTimeFormat(T.locales[settings.lang] || 'th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    } catch (e) { return new Date(ms).toLocaleString(); }
  }
  function fmtMonth(ym) {
    try {
      const [y, m] = ym.split('-').map(Number);
      return new Intl.DateTimeFormat(T.locales[settings.lang] || 'th-TH', { month: 'short', year: '2-digit' }).format(new Date(y, m - 1, 1));
    } catch (e) { return ym; }
  }
  function fmtMonthShort(ym) {
    try {
      const [y, m] = ym.split('-').map(Number);
      return new Intl.DateTimeFormat(T.locales[settings.lang] || 'th-TH', { month: 'short' }).format(new Date(y, m - 1, 1));
    } catch (e) { return ym; }
  }
  const postSize = (p) => (p.text ? new Blob([p.text]).size : 0)
    + (p.images || []).reduce((a, im) => a + (im.size || (im.blob ? im.blob.size : 0) || 0), 0)
    + (p.files || []).reduce((a, f) => a + (f.size || (f.blob ? f.blob.size : 0) || 0), 0);
  const isImageFile = (f) => !!(f && f.type && f.type.indexOf('image/') === 0);
  const bytesToDataUrl = (blob) => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.onerror = () => rej(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
  const parseTags = (str) => String(str || '').split(/[,;]+/).map((s) => s.trim().replace(/^#+/, '')).filter(Boolean);
  const cleanTags = (list) => {
    const out = [];
    const seen = new Set();
    for (const raw of list || []) {
      const tag = String(raw).trim().replace(/^#+/, '').slice(0, MAX_TAG_LEN).trim();
      if (!tag) continue;
      const k = tag.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(tag);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  };
  const postTags = (p) => (Array.isArray(p.tags) ? p.tags : []);

  /** เรียงแบบเดียวกับเซิร์ฟเวอร์: ปักหมุดก่อน แล้วใหม่ → เก่า */
  function sortPosts(list) {
    return list.slice().sort((a, b) => {
      const pa = a.pinned ? 1 : 0;
      const pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (pa && pb) return (b.pinnedAt || b.createdAt) - (a.pinnedAt || a.createdAt);
      return b.createdAt - a.createdAt;
    });
  }
  const allPosts = () => sortPosts(queuedPosts.concat(memPosts).concat(posts));

  function matchesView(p) {
    if (view.pinned && !p.pinned) return false;
    if (view.tag) {
      const want = view.tag.toLowerCase();
      if (!postTags(p).some((x) => x.toLowerCase() === want)) return false;
    }
    const q = view.q.trim().toLowerCase();
    if (q) {
      const hay = ((p.text || '') + ' ' + postTags(p).join(' ')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  /* ---------- settings ---------- */
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) { /* ignore */ }
    return settings;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* ---------- theme / lang ---------- */
  function applyTheme() {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = settings.theme || (prefersDark ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', theme);
  }
  function detectLang() {
    if (settings.lang && T.dicts[settings.lang]) return settings.lang;
    const langs = navigator.languages || [navigator.language || ''];
    for (const l of langs) {
      const v = String(l).toLowerCase();
      if (v.indexOf('zh') === 0) return 'zh';
      if (v.indexOf('th') === 0) return 'th';
      if (v.indexOf('en') === 0) return 'en';
    }
    return 'th';
  }
  function applyLang(lang) {
    settings.lang = lang;
    document.documentElement.lang = lang;
    document.title = t('app.docTitle');
    document.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
    document.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.setAttribute('placeholder', t(n.getAttribute('data-i18n-ph'))); });
    document.querySelectorAll('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.getAttribute('data-i18n-aria'))); });
    el.langs.forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
    el.expireSelect.value = String(settings.expireDays || 0);
    el.sessionMode.checked = !!settings.session;
    el.tempNote.hidden = !settings.session;
    el.searchClear.setAttribute('aria-label', t('search.clear'));
    el.search.setAttribute('aria-label', t('search.placeholder'));
    el.tagBar.setAttribute('aria-label', t('filters.aria'));
    updateOfflineBar();
    render();
  }

  /* ---------- toast ---------- */
  function showToast(msg, opts) {
    opts = opts || {};
    el.toast.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg;
    el.toast.append(span);
    if (opts.actionLabel && typeof opts.onAction === 'function') {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'toast-action'; b.textContent = opts.actionLabel;
      b.addEventListener('click', () => { hideToast(); opts.onAction(); });
      el.toast.append(b);
    }
    el.toast.hidden = false;
    requestAnimationFrame(() => el.toast.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, opts.ms || 4200);
  }
  function hideToast() {
    el.toast.classList.remove('show');
    setTimeout(() => { el.toast.hidden = true; }, 220);
  }

  /* ---------- sync indicator / offline bar ---------- */
  function setSync(state) {
    const map = { synced: 'sync.synced', busy: 'sync.busy', offline: 'sync.offline', error: 'sync.error' };
    el.sync.textContent = t(map[state] || 'sync.synced');
    el.sync.className = 'sync ' + state;
    updateOfflineBar();
  }
  function updateOfflineBar() {
    const offline = !navigator.onLine || lastLoadFailed;
    const n = queuedPosts.length;
    el.offlineBar.hidden = !(offline || n);
    el.offlineText.textContent = t('offline.text');
    el.pendingCount.textContent = n ? t('offline.pending', { n }) : '';
  }

  /* ---------- offline queue (IndexedDB) ---------- */
  let offlineDB = null;
  function openOfflineDB() {
    if (offlineDB) return Promise.resolve(offlineDB);
    return new Promise((resolve, reject) => {
      const rq = indexedDB.open(OFFLINE_DB, 1);
      rq.onupgradeneeded = () => {
        const db = rq.result;
        if (!db.objectStoreNames.contains(OFFLINE_STORE)) db.createObjectStore(OFFLINE_STORE, { keyPath: 'id' });
      };
      rq.onsuccess = () => { offlineDB = rq.result; resolve(offlineDB); };
      rq.onerror = () => reject(rq.error);
    });
  }
  async function outboxAll() {
    try {
      const db = await openOfflineDB();
      return await new Promise((res, rej) => {
        const tx = db.transaction(OFFLINE_STORE, 'readonly');
        const rq = tx.objectStore(OFFLINE_STORE).getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { return []; }
  }
  async function outboxPut(rec) {
    try {
      const db = await openOfflineDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(OFFLINE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_STORE).put(rec);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* ignore */ }
  }
  async function outboxDel(id) {
    try {
      const db = await openOfflineDB();
      await new Promise((res, rej) => {
        const tx = db.transaction(OFFLINE_STORE, 'readwrite');
        tx.objectStore(OFFLINE_STORE).delete(id);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    } catch (e) { /* ignore */ }
  }
  function toQueuedPost(rec) {
    return {
      id: rec.id,
      createdAt: rec.createdAt,
      text: rec.text,
      tags: rec.tags || [],
      local: true,
      pending: true,
      images: (rec.images || []).map((im) => ({ id: 'q', url: im.dataUrl, w: im.w, h: im.h, size: 0 })),
      files: (rec.files || []).map((f) => ({ id: 'q', name: f.name, type: f.type, size: f.size || 0 }))
    };
  }
  async function loadQueue() {
    const rows = await outboxAll();
    rows.sort((a, b) => a.createdAt - b.createdAt);
    queuedPosts = rows.map(toQueuedPost);
    updateOfflineBar();
  }
  async function queuePost(payload) {
    const rec = Object.assign({ id: uid(), createdAt: Date.now() }, payload);
    await outboxPut(rec);
    queuedPosts = queuedPosts.concat(toQueuedPost(rec));
    updateOfflineBar();
    render();
    return rec;
  }
  let flushing = false;
  async function flushQueue(silent) {
    if (flushing || !navigator.onLine) return 0;
    const rows = await outboxAll();
    if (!rows.length) { queuedPosts = []; updateOfflineBar(); return 0; }
    flushing = true;
    let sent = 0;
    for (const rec of rows) {
      try {
        const data = await api('/api/posts', {
          method: 'POST',
          body: { text: rec.text, tags: rec.tags, images: rec.images, files: rec.files, expireDays: rec.expireDays || 0, createdAt: rec.createdAt }
        });
        posts = data.posts || posts;
        await outboxDel(rec.id);
        sent += 1;
      } catch (e) {
        if (e.status === 401) { showGate(); break; }
        if (e.status >= 400 && e.status < 500) {
          // ข้อมูลถูกปฏิเสธ (เช่น ใหญ่เกิน) — เอาออกจากคิวเพื่อไม่ให้ค้างตลอด
          await outboxDel(rec.id);
          continue;
        }
        break;
      }
    }
    queuedPosts = (await outboxAll()).map(toQueuedPost);
    flushing = false;
    updateOfflineBar();
    render();
    if (sent && !silent) showToast(t('offline.synced', { n: sent }));
    else if (rows.length && !sent && !silent) showToast(t('offline.fail'));
    return sent;
  }

  /* ---------- images ---------- */
  async function loadBitmap(file) {
    if (window.createImageBitmap) {
      const bmp = await createImageBitmap(file);
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => { if (bmp.close) bmp.close(); } };
    }
    return new Promise((res, rej) => {
      const img = new Image();
      const u = URL.createObjectURL(file);
      img.onload = () => res({ width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(u) });
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode failed')); };
      img.src = u;
    });
  }
  async function compressImage(file) {
    const bmp = await loadBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp.source, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (!blob) throw new Error('encode failed');
    return { blob, w, h };
  }
  async function addFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f && typeof f === 'object');
    if (!files.length) return;
    for (const f of files) {
      if (isImageFile(f)) {
        if (draftImages.length >= MAX_IMAGES) continue;
        if (f.size > HARD_FILE_LIMIT) { showToast(t('toast.imgFail', { name: f.name || 'image' })); continue; }
        try {
          const out = await compressImage(f);
          draftImages.push({ id: uid(), blob: out.blob, url: URL.createObjectURL(out.blob), w: out.w, h: out.h, name: f.name || 'image.jpg' });
        } catch (e) {
          // ถ้าบีบอัดไม่ได้ (เช่น HEIC/SVG บางเบราว์เซอร์) ให้แนบเป็นไฟล์ธรรมดาแทน
          if (draftFiles.length < MAX_FILES && f.size <= MAX_ATTACHMENT_BYTES) {
            draftFiles.push({ id: uid(), blob: f, url: URL.createObjectURL(f), name: f.name || 'image', type: f.type, size: f.size });
          } else {
            showToast(t('toast.imgFail', { name: f.name || 'image' }));
          }
        }
      } else {
        if (draftFiles.length >= MAX_FILES) continue;
        if (f.size > MAX_ATTACHMENT_BYTES) { showToast(t('toast.fileTooBig', { name: f.name || 'file', max: fmtBytes(MAX_ATTACHMENT_BYTES) })); continue; }
        draftFiles.push({ id: uid(), blob: f, url: URL.createObjectURL(f), name: f.name || 'file', type: f.type || 'application/octet-stream', size: f.size });
      }
    }
    renderAttach();
    updatePostButton();
  }
  function renderAttach() {
    el.attachStrip.innerHTML = '';
    if (!draftImages.length && !draftFiles.length) { el.attachStrip.hidden = true; return; }
    el.attachStrip.hidden = false;
    for (const im of draftImages) {
      const item = document.createElement('div');
      item.className = 'attach-item';
      const img = document.createElement('img'); img.src = im.url; img.alt = '';
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'rm'; rm.textContent = '✕';
      rm.setAttribute('aria-label', t('a11y.removeImage'));
      rm.addEventListener('click', () => {
        URL.revokeObjectURL(im.url);
        draftImages = draftImages.filter((x) => x.id !== im.id);
        renderAttach(); updatePostButton();
      });
      item.append(img, rm);
      el.attachStrip.append(item);
    }
    for (const f of draftFiles) {
      const item = document.createElement('div');
      item.className = 'attach-item attach-file';
      item.title = f.name;
      const icon = document.createElement('span');
      icon.className = 'attach-ext';
      const ext = (/\.([a-z0-9]{1,6})$/i.exec(f.name || '') || [])[1] || 'FILE';
      icon.textContent = ext.toUpperCase().slice(0, 5);
      const meta = document.createElement('span');
      meta.className = 'attach-meta';
      const nm = document.createElement('span'); nm.className = 'attach-name'; nm.textContent = f.name;
      const sz = document.createElement('span'); sz.className = 'attach-size'; sz.textContent = fmtBytes(f.size);
      meta.append(nm, sz);
      const rm = document.createElement('button');
      rm.type = 'button'; rm.className = 'rm'; rm.textContent = '✕';
      rm.setAttribute('aria-label', t('a11y.removeFile'));
      rm.addEventListener('click', () => {
        URL.revokeObjectURL(f.url);
        draftFiles = draftFiles.filter((x) => x.id !== f.id);
        renderAttach(); updatePostButton();
      });
      item.append(icon, meta, rm);
      el.attachStrip.append(item);
    }
  }
  function clearDraft() {
    draftImages.forEach((im) => URL.revokeObjectURL(im.url));
    draftFiles.forEach((f) => URL.revokeObjectURL(f.url));
    draftFiles = [];
    draftImages = [];
    el.draft.value = '';
    el.tagInput.value = '';
    try {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_TAGS_KEY);
    } catch (e) { /* ignore */ }
    autoGrow();
    renderAttach();
    updatePostButton();
  }
  function updatePostButton() { el.btnPost.disabled = saving || (!el.draft.value.trim() && !draftImages.length && !draftFiles.length); }
  function autoGrow() {
    el.draft.style.height = 'auto';
    el.draft.style.height = Math.min(el.draft.scrollHeight, 320) + 'px';
  }
  function persistDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try {
        const v = el.draft.value;
        if (v.trim()) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY);
        const tg = el.tagInput.value;
        if (tg.trim()) localStorage.setItem(DRAFT_TAGS_KEY, tg); else localStorage.removeItem(DRAFT_TAGS_KEY);
      } catch (e) { /* ignore */ }
    }, 300);
  }
  function restoreDraft() {
    try {
      const v = localStorage.getItem(DRAFT_KEY);
      const tg = localStorage.getItem(DRAFT_TAGS_KEY);
      if (v) el.draft.value = v;
      if (tg) el.tagInput.value = tg;
    } catch (e) { /* ignore */ }
  }

  /* ---------- filters ---------- */
  function allTags() {
    const map = new Map();
    for (const p of allPosts()) {
      for (const tag of postTags(p)) {
        const k = tag.toLowerCase();
        const rec = map.get(k) || { tag, count: 0 };
        rec.count += 1;
        map.set(k, rec);
      }
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }
  function setFilterTag(tag) {
    view.tag = view.tag && view.tag.toLowerCase() === String(tag).toLowerCase() ? null : tag;
    render();
  }
  function renderFilters() {
    const tags = allTags();
    el.tagBar.innerHTML = '';
    const mk = (label, active, onClick, extra) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (active ? ' active' : '') + (extra ? ' ' + extra : '');
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };
    el.tagBar.append(mk(t('filters.all'), !view.tag && !view.pinned, () => { view.tag = null; view.pinned = false; render(); }));
    el.tagBar.append(mk(t('filters.pinned'), view.pinned, () => { view.pinned = !view.pinned; render(); }, 'chip-pin'));
    for (const rec of tags.slice(0, 14)) {
      const active = view.tag && view.tag.toLowerCase() === rec.tag.toLowerCase();
      el.tagBar.append(mk('#' + rec.tag, active, () => setFilterTag(rec.tag)));
    }
    // datalist สำหรับช่องกรอกแท็ก
    el.tagSuggest.innerHTML = '';
    for (const rec of tags.slice(0, 30)) {
      const o = document.createElement('option');
      o.value = rec.tag;
      el.tagSuggest.append(o);
    }
  }

  /* ---------- render ---------- */
  function render() {
    const list = allPosts();
    const shown = list.filter(matchesView);
    el.feed.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const p of shown) frag.append(renderPost(p));
    el.feed.append(frag);
    el.empty.hidden = shown.length > 0;
    if (!shown.length) {
      const filtered = list.length > 0;
      el.emptyTitle.textContent = t(filtered ? 'empty.noResultsTitle' : 'empty.title');
      el.emptyHint.textContent = t(filtered ? 'empty.noResultsHint' : 'empty.hint');
    }
    renderCounts(list, shown);
    renderFilters();
    updateOfflineBar();
  }
  function renderCounts(list, shown) {
    const size = shown.reduce((a, p) => a + postSize(p), 0);
    let text;
    if (shown.length !== list.length) text = t('search.results', { n: shown.length });
    else text = (settings.lang === 'en' && list.length === 1) ? t('posts.count1') : t('posts.count', { n: list.length });
    el.stats.textContent = text + ' · ' + t('posts.size', { size: fmtBytes(size) });
    el.searchClear.hidden = !view.q;
  }
  const ICON_PATHS = {
    copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.5"/><path d="M5.5 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5"/>',
    image: '<rect x="3.2" y="3.2" width="17.6" height="17.6" rx="3.6"/><circle cx="9" cy="9.4" r="1.7"/><path d="M20.8 15.2 16 10.8 6.4 20.8"/>',
    download: '<path d="M12 3.5v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4.5 20.5h15"/>',
    trash: '<path d="M4.5 6.5h15"/><path d="M9.5 6V4.4a1.4 1.4 0 0 1 1.4-1.4h2.2a1.4 1.4 0 0 1 1.4 1.4V6"/><path d="M6.5 6.5 7.4 19a1.8 1.8 0 0 0 1.8 1.6h5.6a1.8 1.8 0 0 0 1.8-1.6l.9-12.5"/>',
    pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/>',
    tag: '<path d="M4 12.5V5a1 1 0 0 1 1-1h7.5L20 11.5 12.5 19 4 12.5Z"/><circle cx="8.2" cy="8.2" r="1.4"/>'
  };
  function svgIcon(name) {
    return '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATHS[name] + '</svg>';
  }
  function makeBtn(cls, iconName, label, onClick, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    if (iconName) b.insertAdjacentHTML('beforeend', svgIcon(iconName));
    const s = document.createElement('span');
    s.textContent = label;
    b.append(s);
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }
  const imgSrc = (p, im) => (p.local ? im.url : '/api/img/' + im.id);
  const fileHref = (p, f) => (p.local || p.pending ? (f.url || '#') : '/api/file/' + f.id);

  function renderPost(p) {
    const article = document.createElement('article');
    article.className = 'post' + (p.pinned ? ' pinned' : '');
    article.dataset.id = p.id;

    const head = document.createElement('div');
    head.className = 'post-head';
    const time = document.createElement('time');
    time.className = 'post-time';
    time.dateTime = new Date(p.createdAt).toISOString();
    time.textContent = fmtDate(p.createdAt);
    head.append(time);
    if (p.pinned) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-pin';
      badge.textContent = t('filters.pinned');
      head.append(badge);
    }
    if (p.local) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = t(p.pending ? 'posts.pending' : 'posts.temp');
      head.append(badge);
    }
    if (!p.local) {
      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'pin-btn' + (p.pinned ? ' on' : '');
      pinBtn.title = t(p.pinned ? 'post.unpin' : 'post.pin');
      pinBtn.setAttribute('aria-label', pinBtn.title);
      pinBtn.setAttribute('aria-pressed', p.pinned ? 'true' : 'false');
      pinBtn.innerHTML = svgIcon('pin');
      pinBtn.addEventListener('click', () => togglePin(p));
      head.append(pinBtn);
    }
    article.append(head);

    if (p.text) {
      const div = document.createElement('div');
      div.className = 'post-text';
      div.textContent = p.text;
      article.append(div);
    }
    if (p.images && p.images.length) {
      const grid = document.createElement('div');
      grid.className = 'post-imgs count-' + Math.min(p.images.length, 4);
      for (const im of p.images) {
        const url = imgSrc(p, im);
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        const img = document.createElement('img');
        img.src = url; img.alt = ''; img.loading = 'lazy';
        a.append(img);
        grid.append(a);
      }
      article.append(grid);
    }
    if (p.files && p.files.length) {
      const list = document.createElement('div');
      list.className = 'post-files';
      for (const f of p.files) {
        const a = document.createElement('a');
        a.className = 'file-row';
        a.href = fileHref(p, f);
        a.setAttribute('download', f.name || '');
        a.rel = 'noopener';
        const icon = document.createElement('span');
        icon.className = 'attach-ext';
        const ext = (/\.([a-z0-9]{1,6})$/i.exec(f.name || '') || [])[1] || 'FILE';
        icon.textContent = ext.toUpperCase().slice(0, 5);
        const meta = document.createElement('span');
        meta.className = 'attach-meta';
        const nm = document.createElement('span'); nm.className = 'attach-name'; nm.textContent = f.name || 'file';
        const sz = document.createElement('span'); sz.className = 'attach-size'; sz.textContent = fmtBytes(f.size) + (f.type ? ' · ' + f.type : '');
        meta.append(nm, sz);
        const dl = document.createElement('span'); dl.className = 'file-dl'; dl.innerHTML = svgIcon('download');
        a.append(icon, meta, dl);
        list.append(a);
      }
      article.append(list);
    }

    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'post-tags';
    renderPostTags(p, tagsWrap, article);
    article.append(tagsWrap);

    const actions = document.createElement('div');
    actions.className = 'post-actions';
    if (p.text) actions.append(makeBtn('btn sm copy', 'copy', t('post.copyText'), () => doCopyText(p.text)));
    if (p.images && p.images.length && canCopyImage()) {
      actions.append(makeBtn('btn sm copy', 'image', t('post.copyImage'), () => doCopyImage(p), p.images.length > 1 ? t('post.copyImageHint') : ''));
    }
    if (p.images && p.images.length) actions.append(makeBtn('btn sm', 'download', t('post.download'), () => doDownload(p)));
    if (!p.local) actions.append(makeBtn('btn sm del', 'trash', t('post.delete'), () => doDelete(p)));
    article.append(actions);
    return article;
  }

  function renderPostTags(p, wrap, article) {
    wrap.innerHTML = '';
    const tags = postTags(p);
    for (const tag of tags) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip chip-sm' + (view.tag && view.tag.toLowerCase() === tag.toLowerCase() ? ' active' : '');
      b.textContent = '#' + tag;
      b.addEventListener('click', () => setFilterTag(tag));
      wrap.append(b);
    }
    if (p.local) return;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'chip chip-sm chip-ghost';
    edit.innerHTML = tags.length ? svgIcon('tag') : svgIcon('tag') + '<span>' + t('post.tagsEmpty') + '</span>';
    edit.title = t('post.editTags');
    edit.setAttribute('aria-label', t('post.editTags'));
    edit.addEventListener('click', () => openTagEditor(p, wrap));
    wrap.append(edit);
  }

  function openTagEditor(p, wrap) {
    wrap.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tag-edit';
    input.value = postTags(p).join(', ');
    input.setAttribute('list', 'tag-suggest');
    input.placeholder = t('composer.tagsPh');
    const save = document.createElement('button');
    save.type = 'button'; save.className = 'chip chip-sm active'; save.textContent = t('post.tagsSave');
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'chip chip-sm chip-ghost'; cancel.textContent = t('post.tagsCancel');

    let done = false;
    const commit = async () => {
      if (done) return;
      done = true;
      const tags = cleanTags(parseTags(input.value));
      try {
        const data = await api('/api/posts/' + p.id, { method: 'PATCH', body: { tags } });
        posts = data.posts || posts;
        showToast(t('toast.tagsSaved'));
      } catch (e) {
        showToast(e.status === 401 ? t('login.errWrong') : t('toast.tagsFail'));
      }
      render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { done = true; render(); }
    });
    save.addEventListener('click', commit);
    cancel.addEventListener('click', () => { done = true; render(); });
    wrap.append(input, save, cancel);
    input.focus();
    input.select();
  }

  async function togglePin(p) {
    const next = !p.pinned;
    p.pinned = next;
    p.pinnedAt = next ? Date.now() : undefined;
    render();
    try {
      const data = await api('/api/posts/' + p.id, { method: 'PATCH', body: { pinned: next } });
      posts = data.posts || posts;
      showToast(t(next ? 'toast.pinned' : 'toast.unpinned'));
    } catch (e) {
      p.pinned = !next;
      showToast(t('toast.pinFail'));
    }
    render();
  }

  /* ---------- clipboard ---------- */
  const canCopyImage = () => !!(navigator.clipboard && window.ClipboardItem);
  function legacyCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('copy failed');
  }
  async function doCopyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else legacyCopyText(text);
      showToast(t('toast.copyText'));
    } catch (e) {
      try { legacyCopyText(text); showToast(t('toast.copyText')); }
      catch (e2) { showToast(t('toast.copyFail')); }
    }
  }
  function blobToPng(blob) {
    if (blob.type === 'image/png') return Promise.resolve(blob);
    return new Promise((res, rej) => {
      const img = new Image();
      const u = URL.createObjectURL(blob);
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(u);
        c.toBlob((b) => { b ? res(b) : rej(new Error('encode failed')); }, 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode failed')); };
      img.src = u;
    });
  }
  async function fetchImageBlob(p, im) {
    if (p.local) {
      if (im.blob) return im.blob;
      const r = await fetch(im.url);
      return r.blob();
    }
    const res = await fetch('/api/img/' + im.id, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('image fetch failed');
    return res.blob();
  }
  async function fetchFileBlob(p, f) {
    if (p.local) {
      if (f.blob) return f.blob;
      const r = await fetch(f.url);
      return r.blob();
    }
    const res = await fetch('/api/file/' + f.id, { credentials: 'same-origin' });
    if (!res.ok) throw new Error('file fetch failed');
    return res.blob();
  }
  async function doCopyImage(p) {
    try {
      if (!canCopyImage()) throw new Error('unsupported');
      const blob = await fetchImageBlob(p, p.images[0]);
      const item = new ClipboardItem({ 'image/png': blobToPng(blob) });
      await navigator.clipboard.write([item]);
      showToast(t('toast.copyImage'));
    } catch (e) { showToast(t('toast.copyFail')); }
  }
  async function doDownload(p) {
    const im = p.images && p.images[0];
    if (!im) return;
    try {
      const blob = await fetchImageBlob(p, im);
      const d = new Date(p.createdAt);
      const pad = (n) => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'temp-' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.jpg';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { showToast(t('toast.copyFail')); }
  }

  /* ---------- post actions ---------- */
  function setSaving(on) {
    saving = on;
    el.btnPost.textContent = on ? t('composer.posting') : t('composer.post');
    updatePostButton();
  }

  async function submit() {
    const text = el.draft.value.trim();
    const tags = cleanTags(parseTags(el.tagInput.value));
    if (!text && !draftImages.length && !draftFiles.length) return;
    if (saving) return;

    if (settings.session) {
      const post = {
        id: uid(),
        createdAt: Date.now(),
        text,
        tags,
        local: true,
        images: draftImages.map((im) => ({ id: im.id, url: im.url, blob: im.blob, w: im.w, h: im.h, size: im.blob.size })),
        files: draftFiles.map((f) => ({ id: f.id, url: f.url, blob: f.blob, name: f.name, type: f.type, size: f.size }))
      };
      draftFiles = [];
      draftImages = [];
      el.draft.value = '';
      el.tagInput.value = '';
      try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(DRAFT_TAGS_KEY); } catch (e) { /* ignore */ }
      autoGrow(); renderAttach(); updatePostButton();
      memPosts.unshift(post);
      render();
      showToast(t('toast.temp'));
      el.draft.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setSaving(true);
    setSync('busy');
    const payload = { text, tags, expireDays: Number(settings.expireDays) || 0, images: [], files: [] };
    try {
      for (const im of draftImages) {
        payload.images.push({ dataUrl: await bytesToDataUrl(im.blob), w: im.w, h: im.h });
      }
      for (const f of draftFiles) {
        payload.files.push({ name: f.name, type: f.type, size: f.size, dataUrl: await bytesToDataUrl(f.blob) });
      }
      const data = await api('/api/posts', { method: 'POST', body: payload });
      posts = data.posts || posts;
      lastLoadFailed = false;
      clearDraft();
      render();
      setSync('synced');
      showToast(t('toast.posted'));
      el.draft.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      if (e.status === 401) { showGate(); }
      else if (e.network) {
        // เก็บเข้าคิวในเครื่อง แล้วส่งใหม่เมื่อออนไลน์
        await queuePost(payload);
        clearDraft();
        lastLoadFailed = true;
        setSync('offline');
        showToast(t('offline.queued'), { ms: 5200 });
      } else {
        setSync('error');
        showToast(t('toast.postFail'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function doDelete(p) {
    if (p.local) {
      memPosts = memPosts.filter((x) => x.id !== p.id);
      render();
      showToast(t('toast.deleted'));
      return;
    }
    const snapshot = { post: p, images: [], files: [], index: posts.findIndex((x) => x.id === p.id) };
    for (const im of p.images || []) {
      try { snapshot.images.push({ blob: await fetchImageBlob(p, im), ...im }); } catch (e) { /* ignore */ }
    }
    for (const f of p.files || []) {
      try { snapshot.files.push({ blob: await fetchFileBlob(p, f), ...f }); } catch (e) { /* ignore */ }
    }
    lastDeleted = snapshot;
    posts = posts.filter((x) => x.id !== p.id);
    render();
    showToast(t('toast.deleted'), { actionLabel: t('toast.undo'), onAction: undoDelete, ms: 6000 });
    try {
      const data = await api('/api/posts/' + p.id, { method: 'DELETE' });
      posts = data.posts || posts;
      setSync('synced');
    } catch (e) {
      setSync(navigator.onLine ? 'error' : 'offline');
    }
    render();
  }

  async function undoDelete() {
    if (!lastDeleted) return;
    const { post, images, files, index } = lastDeleted;
    lastDeleted = null;
    try {
      const payload = { id: post.id, createdAt: post.createdAt, text: post.text, tags: postTags(post), images: [], files: [] };
      for (const im of images) {
        payload.images.push({ dataUrl: await bytesToDataUrl(im.blob), w: im.w, h: im.h });
      }
      for (const f of files || []) {
        payload.files.push({ name: f.name, type: f.type, size: f.size, dataUrl: await bytesToDataUrl(f.blob) });
      }
      const data = await api('/api/import', { method: 'POST', body: { posts: [payload] } });
      posts = data.posts || posts;
      render();
      showToast(t('toast.undone'));
    } catch (e) {
      if (index >= 0) { posts.splice(Math.min(index, posts.length), 0, post); render(); }
      showToast(t('toast.undoFail'));
    }
  }

  async function clearAll() {
    if (!clearArmed) {
      clearArmed = true;
      el.btnClearAll.classList.add('armed');
      el.btnClearAll.textContent = t('posts.clearConfirm');
      clearTimer = setTimeout(() => {
        clearArmed = false;
        el.btnClearAll.classList.remove('armed');
        el.btnClearAll.textContent = t('posts.clearAll');
      }, 3500);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    el.btnClearAll.classList.remove('armed');
    el.btnClearAll.textContent = t('posts.clearAll');
    posts = [];
    memPosts = [];
    lastDeleted = null;
    render();
    try {
      await api('/api/posts', { method: 'DELETE' });
      setSync('synced');
    } catch (e) {
      setSync(navigator.onLine ? 'error' : 'offline');
    }
    showToast(t('toast.cleared'));
  }

  async function sweepExpired() {
    const days = Number(settings.expireDays) || 0;
    if (!days) return 0;
    const cutoff = Date.now() - days * 86400000;
    const old = posts.filter((p) => p.createdAt < cutoff);
    if (!old.length) return 0;
    posts = posts.filter((p) => p.createdAt >= cutoff);
    render();
    for (const p of old.slice(0, 20)) {
      try { await api('/api/posts/' + p.id, { method: 'DELETE' }); } catch (e) { /* ignore */ }
    }
    showToast(t('toast.expired', { n: old.length }));
    return old.length;
  }

  /* ---------- stats ---------- */
  function localStats() {
    const list = posts.filter((p) => !p.expireAt || p.expireAt > Date.now());
    const byMonth = new Map();
    const byTag = new Map();
    let imageBytes = 0;
    let fileBytes = 0;
    let textBytes = 0;
    let images = 0;
    let files = 0;
    let pinned = 0;
    for (const p of list) {
      const tb = new Blob([p.text || '']).size;
      textBytes += tb;
      let ib = 0;
      for (const im of p.images || []) { images += 1; ib += Number(im.size) || 0; }
      imageBytes += ib;
      let fb = 0;
      for (const f of p.files || []) { files += 1; fb += Number(f.size) || 0; }
      fileBytes += fb;
      ib += fb;
      if (p.pinned) pinned += 1;
      const d = new Date(p.createdAt);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const m = byMonth.get(key) || { month: key, posts: 0, bytes: 0 };
      m.posts += 1; m.bytes += tb + ib;
      byMonth.set(key, m);
      for (const tag of postTags(p)) {
        const k = tag.toLowerCase();
        const rec = byTag.get(k) || { tag, posts: 0 };
        rec.posts += 1;
        byTag.set(k, rec);
      }
    }
    const nowDate = new Date();
    const months = [];
    for (let i = 11; i >= 0; i -= 1) {
      const d = new Date(nowDate.getFullYear(), nowDate.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      months.push(byMonth.get(key) || { month: key, posts: 0, bytes: 0 });
    }
    const tags = Array.from(byTag.values()).sort((a, b) => b.posts - a.posts);
    const totalBytes = imageBytes + fileBytes + textBytes;
    return {
      posts: list.length, images, files, pinned, tags: tags.length, textBytes, imageBytes, fileBytes, totalBytes,
      quotaBytes: 1024 * 1024 * 1024, quotaUsed: Math.min(1, totalBytes / (1024 * 1024 * 1024)),
      months, tagList: tags.slice(0, 30)
    };
  }
  function renderStatsPanel(stats) {
    el.statGrid.innerHTML = '';
    const card = (label, value, sub) => {
      const d = document.createElement('div');
      d.className = 'stat-card';
      const l = document.createElement('span'); l.className = 'stat-label'; l.textContent = label;
      const v = document.createElement('strong'); v.className = 'stat-value'; v.textContent = value;
      d.append(l, v);
      if (sub) { const s = document.createElement('span'); s.className = 'stat-sub'; s.textContent = sub; d.append(s); }
      return d;
    };
    el.statGrid.append(
      card(t('stats.posts'), String(stats.posts || 0)),
      card(t('stats.images'), String(stats.images || 0)),
      card(t('stats.files'), String(stats.files || 0)),
      card(t('stats.size'), fmtBytes(stats.totalBytes || 0)),
      card(t('stats.pinned'), String(stats.pinned || 0)),
      card(t('stats.tags'), String(stats.tags || 0))
    );

    const months = (stats.months || []).slice(-12);
    el.monthBars.innerHTML = '';
    if (!months.length) {
      const p = document.createElement('p');
      p.className = 'stats-empty';
      p.textContent = t('stats.empty');
      el.monthBars.append(p);
    } else {
      const max = Math.max.apply(null, months.map((m) => m.bytes || 0)) || 1;
      for (const m of months) {
        const col = document.createElement('div');
        col.className = 'month-col';
        col.title = fmtMonth(m.month) + ' · ' + t('stats.monthPosts', { n: m.posts }) + ' · ' + fmtBytes(m.bytes);
        const bar = document.createElement('i');
        bar.style.height = Math.max(3, Math.round(((m.bytes || 0) / max) * 100)) + '%';
        const lab = document.createElement('span');
        lab.textContent = fmtMonthShort(m.month);
        col.append(bar, lab);
        el.monthBars.append(col);
      }
    }

    el.tagStats.innerHTML = '';
    const tags = stats.tagList || [];
    if (!tags.length) {
      const p = document.createElement('p');
      p.className = 'stats-empty';
      p.textContent = t('stats.empty');
      el.tagStats.append(p);
    } else {
      const max = tags[0].posts || 1;
      for (const rec of tags.slice(0, 12)) {
        const row = document.createElement('div');
        row.className = 'tag-row';
        const name = document.createElement('span'); name.className = 'tag-name'; name.textContent = '#' + rec.tag;
        const bar = document.createElement('i'); bar.style.width = Math.max(4, Math.round((rec.posts / max) * 100)) + '%';
        const num = document.createElement('span'); num.className = 'tag-num'; num.textContent = String(rec.posts);
        row.append(name, bar, num);
        el.tagStats.append(row);
      }
    }

    const pct = Math.max(0, Math.min(100, (stats.quotaUsed || 0) * 100));
    el.quotaFill.style.width = Math.max(pct > 0 ? 1 : 0, pct).toFixed(2) + '%';
    el.quotaPct.textContent = fmtBytes(stats.totalBytes || 0) + ' / ' + fmtBytes(stats.quotaBytes || 1000000000) + ' · ' + pct.toFixed(pct < 10 ? 2 : 1) + '%';
  }
  async function openStats() {
    let stats = null;
    try {
      const data = await api('/api/stats');
      stats = data.stats;
    } catch (e) {
      stats = localStats();
    }
    renderStatsPanel(stats || localStats());
    if (typeof el.statsDialog.showModal === 'function') el.statsDialog.showModal();
    else el.statsDialog.setAttribute('open', '');
  }

  /* ---------- install (PWA) ---------- */
  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function refreshInstallItem() {
    const show = !isStandalone() && (!!deferredPrompt || isIOS());
    el.acctInstall.hidden = !show;
  }
  async function doInstall() {
    closeMenu();
    if (deferredPrompt) {
      try {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        deferredPrompt = null;
        refreshInstallItem();
        return;
      } catch (e) { deferredPrompt = null; }
    }
    el.installText.textContent = t(isIOS() ? 'install.ios' : 'install.other');
    if (typeof el.installDialog.showModal === 'function') el.installDialog.showModal();
    else el.installDialog.setAttribute('open', '');
  }

  /* ---------- auth ---------- */
  function enterApp(email) {
    me = email;
    try { localStorage.setItem('tc:email', email); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-auth', 'in');
    el.gate.hidden = true;
    el.app.hidden = false;
    el.acctMail.textContent = email;
    el.acctAva.textContent = (email || '?').trim().charAt(0).toUpperCase();
    refreshInstallItem();
    startPolling();
    autoGrow();
    loadPosts();
    loadQueue().then(() => { if (navigator.onLine) flushQueue(true); });
    checkLegacy();
    if (readyResolve) { readyResolve(); readyResolve = null; }
  }
  function showGate(message) {
    me = null;
    document.documentElement.setAttribute('data-auth', 'out');
    el.gate.hidden = false;
    el.app.hidden = true;
    stopPolling();
    if (message) showLoginError(message);
    setTimeout(() => { try { el.loginEmail.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }, 60);
  }
  function showLoginError(msg) {
    if (!msg) { el.loginError.hidden = true; el.loginError.textContent = ''; return; }
    el.loginError.textContent = msg;
    el.loginError.hidden = false;
  }
  function setLoginBusy(on) {
    el.loginSubmit.disabled = on;
    el.loginSubmit.textContent = on ? t('login.busy') : t('login.submit');
  }
  async function onLogin(ev) {
    ev.preventDefault();
    const email = el.loginEmail.value.trim();
    const password = el.loginPassword.value;
    if (!email || !password) { showLoginError(t('login.errRequired')); return; }
    showLoginError('');
    setLoginBusy(true);
    try {
      const res = await api('/api/login', {
        method: 'POST',
        body: { email, password, rememberDays: el.loginRemember.checked ? 30 : 1 }
      });
      el.loginPassword.value = '';
      enterApp(res.email || email);
    } catch (e) {
      if (e.status === 401 || e.status === 503) showLoginError(t('login.errWrong'));
      else if (e.status === 429) showLoginError(t('login.errLocked'));
      else if (e.network) showLoginError(t('login.errNet'));
      else showLoginError(e.message || t('login.errNet'));
    } finally {
      setLoginBusy(false);
    }
  }
  async function logout() {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    closeMenu();
    posts = [];
    memPosts = [];
    queuedPosts = [];
    clearDraft();
    try { localStorage.removeItem(FEED_CACHE); } catch (e) { /* ignore */ }
    try { localStorage.removeItem('tc:email'); } catch (e) { /* ignore */ }
    showGate();
    showToast(t('toast.loggedOut'));
  }

  /* ---------- account menu ---------- */
  function openMenu() {
    el.acctMenu.hidden = false;
    el.acctBtn.setAttribute('aria-expanded', 'true');
  }
  function closeMenu() {
    el.acctMenu.hidden = true;
    el.acctBtn.setAttribute('aria-expanded', 'false');
  }

  /* ---------- change password ---------- */
  function openPw() {
    closeMenu();
    el.pwError.hidden = true;
    el.pwForm.reset();
    if (typeof el.pwDialog.showModal === 'function') el.pwDialog.showModal();
    else el.pwDialog.setAttribute('open', '');
  }
  async function onPwSubmit(ev) {
    ev.preventDefault();
    const current = el.pwCurrent.value;
    const next = el.pwNext.value;
    const confirm = el.pwConfirm.value;
    if (next.length < 6) { el.pwError.textContent = t('pw.short'); el.pwError.hidden = false; return; }
    if (next !== confirm) { el.pwError.textContent = t('pw.mismatch'); el.pwError.hidden = false; return; }
    el.pwError.hidden = true;
    el.pwSave.disabled = true;
    try {
      await api('/api/password', { method: 'POST', body: { current, next } });
      el.pwDialog.close();
      showToast(t('pw.done'));
    } catch (e) {
      el.pwError.textContent = e.status === 403 ? t('pw.wrong') : (e.message || t('pw.fail'));
      el.pwError.hidden = false;
    } finally {
      el.pwSave.disabled = false;
    }
  }

  /* ---------- feed cache + load ---------- */
  function saveFeedCache(list) {
    try {
      const slim = list.map((p) => ({
        id: p.id, createdAt: p.createdAt, text: p.text, tags: postTags(p),
        pinned: !!p.pinned, pinnedAt: p.pinnedAt || null, expireAt: p.expireAt || null,
        images: (p.images || []).map((im) => ({ id: im.id, w: im.w, h: im.h, size: im.size, type: im.type })),
        files: (p.files || []).map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size }))
      }));
      localStorage.setItem(FEED_CACHE, JSON.stringify({ at: Date.now(), posts: slim }));
    } catch (e) { /* ignore */ }
  }
  function loadFeedCache() {
    try {
      const raw = localStorage.getItem(FEED_CACHE);
      if (!raw) return [];
      const data = JSON.parse(raw);
      return Array.isArray(data.posts) ? data.posts : [];
    } catch (e) { return []; }
  }
  async function loadPosts() {
    if (syncing) return;
    syncing = true;
    setSync('busy');
    try {
      const data = await api('/api/posts');
      posts = data.posts || [];
      lastLoadFailed = false;
      saveFeedCache(posts);
      setSync('synced');
      render();
      sweepExpired();
      if (navigator.onLine && queuedPosts.length) flushQueue(true);
    } catch (e) {
      if (e.status === 401) { showGate(); return; }
      lastLoadFailed = true;
      if (!posts.length) {
        const cached = loadFeedCache();
        if (cached.length) posts = cached;
      }
      setSync(navigator.onLine ? 'error' : 'offline');
      render();
    } finally {
      syncing = false;
    }
  }

  function startPolling() {
    stopPolling();
    polling = setInterval(() => {
      if (document.hidden || !me) return;
      loadPosts();
    }, POLL_MS);
  }
  function stopPolling() {
    if (polling) clearInterval(polling);
    polling = 0;
  }

  /* ---------- legacy import ---------- */
  async function readLegacyPosts() {
    if (!indexedDB.databases) return [];
    let list = [];
    try { list = await indexedDB.databases(); } catch (e) { return []; }
    if (!list.some((d) => d.name === LEGACY_DB)) return [];
    let db;
    try {
      db = await new Promise((res, rej) => {
        const rq = indexedDB.open(LEGACY_DB);
        rq.onsuccess = () => res(rq.result);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { return []; }
    if (!db.objectStoreNames.contains('posts')) { db.close(); return []; }
    let rows = [];
    try {
      rows = await new Promise((res, rej) => {
        const tx = db.transaction('posts', 'readonly');
        const rq = tx.objectStore('posts').getAll();
        rq.onsuccess = () => res(rq.result || []);
        rq.onerror = () => rej(rq.error);
      });
    } catch (e) { rows = []; }
    db.close();
    return rows.filter((p) => p && p.id && (p.text || (p.images && p.images.length) || (p.files && p.files.length)));
  }

  let legacyCache = [];
  async function checkLegacy() {
    if (localStorage.getItem(IMPORT_FLAG) === '1') return;
    legacyCache = await readLegacyPosts();
    if (!legacyCache.length) return;
    el.importText.textContent = t('import.text', { n: legacyCache.length });
    el.importBar.hidden = false;
  }
  async function importLegacy() {
    if (!legacyCache.length) { el.importBar.hidden = true; return; }
    el.importYes.disabled = true;
    el.importYes.textContent = t('sync.busy');
    const total = legacyCache.length;
    let ok = 0;
    const batch = legacyCache.slice();
    for (let i = 0; i < batch.length; i += 2) {
      const chunk = batch.slice(i, i + 2);
      const payload = [];
      for (const p of chunk) {
        const images = [];
        for (const im of p.images || []) {
          if (!im || !im.blob) continue;
          try { images.push({ dataUrl: await bytesToDataUrl(im.blob), w: im.w, h: im.h }); } catch (e) { /* ignore */ }
        }
        const files = [];
        for (const f of p.files || []) {
          if (!f || !f.blob) continue;
          try { files.push({ name: f.name, type: f.type, size: f.size, dataUrl: await bytesToDataUrl(f.blob) }); } catch (e) { /* ignore */ }
        }
        payload.push({ id: p.id, createdAt: p.createdAt, text: p.text || '', tags: p.tags || [], images, files });
      }
      try {
        const data = await api('/api/import', { method: 'POST', body: { posts: payload } });
        posts = data.posts || posts;
        ok += chunk.length;
        render();
      } catch (e) {
        if (e.status === 401) { showGate(); break; }
      }
    }
    try { localStorage.setItem(IMPORT_FLAG, '1'); } catch (e) { /* ignore */ }
    el.importBar.hidden = true;
    el.importYes.disabled = false;
    el.importYes.textContent = t('import.yes');
    showToast(t('import.partial', { ok, n: total }), { ms: 5000 });
  }

  /* ---------- wiring ---------- */
  function wire() {
    el.loginForm.addEventListener('submit', onLogin);

    el.draft.addEventListener('input', () => { autoGrow(); updatePostButton(); persistDraft(); });
    el.tagInput.addEventListener('input', persistDraft);
    el.draft.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
    });
    el.draft.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      const files = [];
      for (const it of items) {
        if (it.kind === 'file') {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    el.btnAttach.addEventListener('click', () => el.fileInput.click());
    el.fileInput.addEventListener('change', () => { addFiles(el.fileInput.files); el.fileInput.value = ''; });
    el.btnClearDraft.addEventListener('click', clearDraft);
    el.btnPost.addEventListener('click', submit);
    el.btnClearAll.addEventListener('click', clearAll);

    el.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        view.q = el.search.value;
        render();
      }, 120);
    });
    el.searchClear.addEventListener('click', () => {
      el.search.value = '';
      view.q = '';
      render();
      el.search.focus();
    });

    const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1);
    ['dragenter', 'dragover'].forEach((ev) => el.composer.addEventListener(ev, (e) => { if (hasFiles(e)) { e.preventDefault(); el.composer.classList.add('drag'); } }));
    ['dragleave', 'drop'].forEach((ev) => el.composer.addEventListener(ev, () => el.composer.classList.remove('drag')));
    el.composer.addEventListener('drop', (e) => {
      if (hasFiles(e)) { e.preventDefault(); addFiles(e.dataTransfer.files); }
    });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      if (hasFiles(e) && !el.composer.contains(e.target)) {
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) { e.preventDefault(); addFiles(files); window.scrollTo({ top: 0, behavior: 'smooth' }); }
      }
    });

    el.langs.forEach((b) => b.addEventListener('click', () => { applyLang(b.dataset.lang); saveSettings(); }));
    el.themeToggle.addEventListener('click', () => {
      settings.theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      applyTheme();
      saveSettings();
    });
    el.expireSelect.addEventListener('change', () => {
      settings.expireDays = Number(el.expireSelect.value) || 0;
      saveSettings();
      sweepExpired();
    });
    el.sessionMode.addEventListener('change', () => {
      settings.session = el.sessionMode.checked;
      el.tempNote.hidden = !settings.session;
      saveSettings();
    });

    el.acctBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (el.acctMenu.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener('click', (e) => {
      if (!el.acctMenu.hidden && !el.acctMenu.contains(e.target) && e.target !== el.acctBtn) closeMenu();
    });
    el.acctOut.addEventListener('click', logout);
    el.acctPass.addEventListener('click', openPw);
    el.acctInstall.addEventListener('click', doInstall);

    el.pwForm.addEventListener('submit', onPwSubmit);
    el.pwCancel.addEventListener('click', () => el.pwDialog.close());

    el.btnStats.addEventListener('click', openStats);
    el.statsClose.addEventListener('click', () => el.statsDialog.close());
    el.installClose.addEventListener('click', () => el.installDialog.close());

    el.importYes.addEventListener('click', importLegacy);
    el.importNo.addEventListener('click', () => {
      try { localStorage.setItem(IMPORT_FLAG, '1'); } catch (e) { /* ignore */ }
      el.importBar.hidden = true;
    });

    window.addEventListener('online', () => {
      lastLoadFailed = false;
      updateOfflineBar();
      if (me) {
        loadPosts();
        flushQueue(false);
      }
    });
    window.addEventListener('offline', () => {
      lastLoadFailed = true;
      setSync('offline');
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && me) loadPosts();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      refreshInstallItem();
    });
    window.addEventListener('appinstalled', () => {
      deferredPrompt = null;
      refreshInstallItem();
    });

    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (!settings.theme) applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  }

  /* ---------- init ---------- */
  async function init() {
    loadSettings();
    settings.lang = detectLang();
    applyTheme();
    wire();
    restoreDraft();
    applyLang(settings.lang);
    updatePostButton();
    autoGrow();
    updateOfflineBar();

    try {
      const info = await api('/api/me');
      if (info.authed === false) showGate();
      else enterApp(info.email);
    } catch (e) {
      const cachedEmail = (() => { try { return localStorage.getItem('tc:email'); } catch (err) { return null; } })();
      const cached = loadFeedCache();
      if (e.network && cachedEmail && cached.length) {
        posts = cached;
        lastLoadFailed = true;
        enterApp(cachedEmail);
        setSync('offline');
      } else {
        showGate();
      }
    }

    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  /* ---------- debug hook ---------- */
  window.__TC__ = {
    ready: readyPromise,
    submit,
    addFiles,
    load: loadPosts,
    flush: () => flushQueue(false),
    stats: () => localStats(),
    legacy: () => readLegacyPosts(),
    setQuery: (q) => { view.q = q; el.search.value = q; render(); },
    setTag: (tag) => setFilterTag(tag),
    state: () => ({
      me,
      count: posts.length,
      queued: queuedPosts.length,
      temp: memPosts.length,
      view,
      settings,
      posts: allPosts().map((p) => ({ id: p.id, text: p.text, tags: postTags(p), pinned: !!p.pinned, images: (p.images || []).length, files: (p.files || []).length }))
    })
  };
})();
