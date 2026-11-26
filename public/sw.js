/* Temp Clipboard — service worker
 * - หน้า HTML (navigation): network-first เพื่อไม่ให้ติดเวอร์ชันเก่า
 * - รูป /api/img/*: network-first + แคชไว้ดูออฟไลน์
 * - ไฟล์ static อื่น: cache-first + อัปเดตเงียบ ๆ
 * - ไม่แตะ API อื่น (ข้อมูลต้องสดและต้องมีคุกกี้)
 */
const CACHE = 'temp-clipboard-v5';
const IMG_CACHE = 'temp-clipboard-img-v1';
const ASSETS = [
  './',
  './index.html',
  './assets/styles.css',
  './assets/app.js',
  './assets/i18n.js',
  './assets/fonts.css',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './manifest.webmanifest'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // ไฟล์แนบ: ไม่แคช (อาจใหญ่ถึง 20 MB และเป็น attachment) — ให้ผ่านไปเครือข่ายตรงๆ
  if (url.pathname.startsWith('/api/file/')) return;

  // รูปโพสต์: เก็บลงแคชเพื่อเปิดดูได้ตอนเน็ตหลุด
  if (url.pathname.startsWith('/api/img/')) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(IMG_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  const isDoc = req.mode === 'navigate' || req.destination === 'document';
  const isFont = url.pathname.indexOf('/assets/fonts/') === 0;

  if (isDoc) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./')))
    );
    return;
  }

  if (isFont) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.status === 200) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })));
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
