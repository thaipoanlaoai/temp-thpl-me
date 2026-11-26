/* Temp Clipboard — Worker API
 *
 *  เก็บข้อมูลขนาดเล็กบน Cloudflare KV
 *    feed:v1     → { v, posts: [{ id, createdAt, text, tags, pinned, pinnedAt, images:[{id,w,h,size,type}], files:[{id,name,type,size}], expireAt? }] }
 *    auth:v1     → { email, salt, hash, iter, alg, updatedAt }
 *    img:<id>    → ไฟล์รูป (ArrayBuffer) + metadata
 *    file:<id>   → ไฟล์แนบทั่วไป (ArrayBuffer) + metadata { name, type, size }
 *    cfg:secret  → คีย์เซ็นคุกกี้ (สร้างอัตโนมัติครั้งแรก ถ้าไม่ได้ตั้ง SESSION_SECRET)
 *
 *  ล็อกอินบัญชีเดียวด้วยคุกกี้ HttpOnly ที่เซ็นด้วย HMAC-SHA256 (30 วัน)
 */

const SESSION_COOKIE = 'tc_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGES = 4;
const MAX_FILES = 4; // ไฟล์แนบที่ไม่ใช่รูป ต่อโพสต์ (นอกเหนือจากรูป MAX_IMAGES รูป)
const MAX_TEXT = 20000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // KV value สูงสุด 25 MB เผื่อ overhead ของ base64
const MAX_BODY_BYTES = 100 * 1024 * 1024; // Workers รับ body ได้ถึง 100 MB (แผนฟรี)
const MAX_POSTS = 500;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 24;
const MAX_NAME_LEN = 120;
const QUOTA_BYTES = 1024 * 1024 * 1024; // KV free plan: 1 GB
const PBKDF2_ITER = 100000; // Workers WebCrypto รองรับสูงสุด 100,000 รอบ

const FEED_KEY = 'feed:v1';
const AUTH_KEY = 'auth:v1';
const SECRET_KEY = 'cfg:secret';

/* ---------------------------------------------------------------- utils */

const enc = new TextEncoder();

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra
    }
  });
}

const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

function b64urlEncode(bytes) {
  let bin = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 1) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64Encode(bytes) {
  const b = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < b.length; i += 1) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

function b64Decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqual(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i += 1) {
    diff |= (ab[i % ab.length] || 0) ^ (bb[i % bb.length] || 0);
  }
  return diff === 0;
}

function randomId(len = 16) {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function parseCookies(request) {
  const out = {};
  const raw = request.headers.get('cookie') || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* --------------------------------------------------------------- crypto */

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signToken(payload, secret) {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64urlEncode(sig);
}

async function verifyToken(token, secret) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64urlEncode(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  if (!timingSafeEqual(expected, sig)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key,
    256
  );
  return new Uint8Array(bits);
}

async function getSecret(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  let signingKey = await env.KV.get(SECRET_KEY);
  if (!signingKey) {
    signingKey = randomId(32);
    await env.KV.put(SECRET_KEY, signingKey);
  }
  return signingKey;
}

/* ---------------------------------------------------------------- session */

async function makeSession(email, secret, rememberDays) {
  const days = Math.max(1, Math.min(365, Number(rememberDays) || 30));
  const ttlMs = Math.min(SESSION_MS, days * 24 * 60 * 60 * 1000);
  return {
    token: await signToken({ sub: email, exp: Date.now() + ttlMs }, secret),
    maxAge: Math.floor(ttlMs / 1000)
  };
}

async function getSession(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const secret = await getSecret(env);
  return verifyToken(token, secret);
}

function cookieHeader(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

const clearCookieHeader = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/* -------------------------------------------------------------- login rate */

const attempts = new Map(); // ip → { count, first }
function tooManyAttempts(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > 15 * 60 * 1000) return false;
  return rec.count >= 12;
}
function noteAttempt(ip, ok) {
  const now = Date.now();
  if (ok) { attempts.delete(ip); return; }
  const rec = attempts.get(ip);
  if (!rec || now - rec.first > 15 * 60 * 1000) attempts.set(ip, { count: 1, first: now });
  else rec.count += 1;
}

/* ------------------------------------------------------------------- feed */

const emptyFeed = () => ({ v: 1, posts: [] });

/** แท็ก: รับได้ทั้ง array และสตริงคั่นด้วย , หรือ # — ตัดซ้ำแบบไม่สนตัวพิมพ์ */
function cleanTags(input) {
  let list = [];
  if (Array.isArray(input)) list = input;
  else if (typeof input === 'string') list = input.split(/[,;]+/);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/^#+/, '').slice(0, MAX_TAG_LEN).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** ปักหมุดขึ้นก่อน แล้วเรียงใหม่ → เก่า */
function sortPosts(posts) {
  return posts.slice().sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    if (pa && pb) return (b.pinnedAt || b.createdAt) - (a.pinnedAt || a.createdAt);
    return b.createdAt - a.createdAt;
  });
}

async function readFeed(env) {
  const raw = await env.KV.get(FEED_KEY, 'json');
  if (!raw || !Array.isArray(raw.posts)) return emptyFeed();
  return raw;
}

const pruneExpired = (posts) => posts.filter((p) => !p.expireAt || p.expireAt > Date.now());

async function writeFeed(env, feed) {
  const posts = sortPosts(pruneExpired(feed.posts)).slice(0, MAX_POSTS);
  const next = { v: 1, posts };
  await env.KV.put(FEED_KEY, JSON.stringify(next));
  return next;
}

/* ---------------------------------------------------------------- images */

function decodeImage(input) {
  if (!input || typeof input !== 'string') return null;
  let data = input;
  let type = 'image/jpeg';
  const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(input);
  if (m) {
    type = m[1].toLowerCase();
    data = m[2];
  }
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) type = 'image/jpeg';
  let bytes;
  try {
    bytes = b64Decode(data);
  } catch (e) {
    return null;
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return null;
  return { bytes, type };
}

async function putImages(env, images, ttlSeconds) {
  const stored = [];
  for (const img of images) {
    const decoded = decodeImage(img && (img.dataUrl || img.data));
    if (!decoded) continue;
    const id = randomId(12);
    const meta = {
      type: decoded.type,
      w: Math.max(0, Math.round(Number(img.w) || 0)),
      h: Math.max(0, Math.round(Number(img.h) || 0)),
      size: decoded.bytes.length
    };
    const opts = { metadata: meta };
    if (ttlSeconds) opts.expirationTtl = ttlSeconds;
    await env.KV.put('img:' + id, decoded.bytes, opts);
    stored.push({ id, ...meta });
  }
  return stored;
}

async function deleteImages(env, images) {
  await Promise.all((images || []).map((im) => env.KV.delete('img:' + im.id).catch(() => {})));
}

/* ---------------------------------------------------------------- files */

/** ไฟล์แนบทั่วไป: รับ data URL (data:<mime>;base64,...) หรือ base64 เปล่า ๆ + type แยก */
function decodeFile(input, fallbackType) {
  if (!input || typeof input !== 'string') return null;
  let data = input;
  let type = typeof fallbackType === 'string' && fallbackType ? fallbackType.toLowerCase() : 'application/octet-stream';
  const m = /^data:([a-z0-9][a-z0-9!#$&^_.+-]*\/*[a-z0-9!#$&^_.+-]*);base64,(.*)$/i.exec(input);
  if (m) {
    type = m[1].toLowerCase();
    data = m[2];
  }
  if (!type || type === '') type = 'application/octet-stream';
  let bytes;
  try {
    bytes = b64Decode(data);
  } catch (e) {
    return null;
  }
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) return null;
  return { bytes, type };
}

/** ตัดชื่อไฟล์ให้ปลอดภัย: เอา path, ตัวควบคุม, และตัดความยาว */
function safeFileName(name) {
  const base = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const cut = base.slice(0, MAX_NAME_LEN).trim();
  return cut || 'file';
}

function fileExtOf(name, type) {
  const ext = /\.([a-z0-9]{1,10})$/i.exec(name || '');
  if (ext) return ext[1].toLowerCase();
  const known = {
    'application/pdf': 'pdf', 'application/zip': 'zip', 'application/x-zip-compressed': 'zip',
    'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4'
  };
  return known[String(type || '').toLowerCase()] || 'bin';
}

async function putFiles(env, files, ttlSeconds) {
  const stored = [];
  for (const f of files) {
    if (!f || typeof f !== 'object') continue;
    const decoded = decodeFile(f.dataUrl || f.data, f.type);
    if (!decoded) continue;
    const id = randomId(12);
    const name = safeFileName(f.name);
    const meta = { name, type: decoded.type, size: decoded.bytes.length };
    const opts = { metadata: meta };
    if (ttlSeconds) opts.expirationTtl = ttlSeconds;
    await env.KV.put('file:' + id, decoded.bytes, opts);
    stored.push({ id, ...meta });
  }
  return stored;
}

async function deleteFiles(env, files) {
  await Promise.all((files || []).map((f) => env.KV.delete('file:' + f.id).catch(() => {})));
}

/** ลบทรัพย์สินทั้งหมดของโพสต์ (รูป + ไฟล์แนบ) */
async function deletePostAssets(env, post) {
  await Promise.all([deleteImages(env, post && post.images), deleteFiles(env, post && post.files)]);
}

/** RFC 5987: filename*=UTF-8''... สำหรับชื่อไฟล์ภาษาไทย/จีน + fallback ASCII */
function contentDisposition(name, type) {
  const ascii = String(name || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  const utf8 = encodeURIComponent(String(name || 'file')).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/* ------------------------------------------------------------------ stats */

function buildStats(posts) {
  const monthFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit' });
  const byMonth = new Map();
  const byTag = new Map();
  let imageBytes = 0;
  let fileBytes = 0;
  let textBytes = 0;
  let images = 0;
  let files = 0;
  let pinned = 0;
  let expiredSoon = 0;
  const now = Date.now();

  for (const p of posts) {
    const text = p.text || '';
    const tb = enc.encode(text).length;
    textBytes += tb;
    let ib = 0;
    for (const im of p.images || []) {
      images += 1;
      ib += Number(im.size) || 0;
    }
    imageBytes += ib;
    let fb = 0;
    for (const f of p.files || []) {
      files += 1;
      fb += Number(f.size) || 0;
    }
    fileBytes += fb;
    ib += fb; // รวมไฟล์แนบไปใน bytes ของโพสต์
    if (p.pinned) pinned += 1;
    if (p.expireAt && p.expireAt - now < 7 * 86400000) expiredSoon += 1;

    let key = 'unknown';
    try { key = monthFmt.format(new Date(p.createdAt)); } catch (e) { /* ignore */ }
    const m = byMonth.get(key) || { month: key, posts: 0, bytes: 0 };
    m.posts += 1;
    m.bytes += tb + ib;
    byMonth.set(key, m);

    for (const tag of p.tags || []) {
      const k = tag.toLowerCase();
      const t = byTag.get(k) || { tag, posts: 0 };
      t.posts += 1;
      byTag.set(k, t);
    }
  }

  const nowKey = monthFmt.format(new Date());
  const [cy, cm] = nowKey.split('-').map(Number);
  const months = [];
  for (let i = 11; i >= 0; i -= 1) {
    const key = new Date(Date.UTC(cy, cm - 1 - i, 1)).toISOString().slice(0, 7);
    months.push(byMonth.get(key) || { month: key, posts: 0, bytes: 0 });
  }
  const tags = Array.from(byTag.values()).sort((a, b) => b.posts - a.posts || a.tag.localeCompare(b.tag));
  const totalBytes = imageBytes + fileBytes + textBytes;

  return {
    posts: posts.length,
    images,
    files,
    pinned,
    tags: tags.length,
    textBytes,
    imageBytes,
    fileBytes,
    totalBytes,
    quotaBytes: QUOTA_BYTES,
    quotaUsed: Math.min(1, totalBytes / QUOTA_BYTES),
    expiredSoon,
    oldest: posts.length ? Math.min(...posts.map((p) => p.createdAt)) : null,
    newest: posts.length ? Math.max(...posts.map((p) => p.createdAt)) : null,
    months,
    tagList: tags.slice(0, 30)
  };
}

/* ------------------------------------------------------------------- API */

async function handleApi(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/api';
  const method = request.method.toUpperCase();

  if (path === '/api/health' && method === 'GET') {
    let kv = true;
    try { await env.KV.get('__health'); } catch (e) { kv = false; }
    return json({ ok: kv, kv });
  }

  if (path === '/api/login' && method === 'POST') {
    const ip = request.headers.get('cf-connecting-ip') || 'local';
    if (tooManyAttempts(ip)) return bad('พยายามเข้าสู่ระบบหลายครั้งเกินไป — รอสักครู่แล้วลองใหม่', 429);

    let body;
    try { body = await request.json(); } catch (e) { return bad('รูปแบบข้อมูลไม่ถูกต้อง'); }
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return bad('กรอกอีเมลและรหัสผ่านให้ครบ');

    const auth = await env.KV.get(AUTH_KEY, 'json');
    if (!auth) return bad('ยังไม่ได้ตั้งค่าบัญชีผู้ใช้', 503);

    const okEmail = email === String(auth.email).toLowerCase();
    const derived = await pbkdf2(password, b64Decode(auth.salt), Number(auth.iter) || PBKDF2_ITER);
    const okPass = timingSafeEqual(b64Encode(derived), auth.hash);

    if (!okEmail || !okPass) {
      noteAttempt(ip, false);
      await new Promise((r) => setTimeout(r, 350));
      return bad('อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    }

    noteAttempt(ip, true);
    const secret = await getSecret(env);
    const { token, maxAge } = await makeSession(auth.email, secret, body.rememberDays);
    return json({ ok: true, email: auth.email }, 200, { 'set-cookie': cookieHeader(token, maxAge) });
  }

  const session = await getSession(request, env);

  if (path === '/api/me' && method === 'GET') {
    // ตอบ 200 เสมอพร้อมธง authed เพื่อไม่ให้ console มี error ตอนยังไม่ล็อกอิน
    if (!session) return json({ ok: true, authed: false });
    const auth = await env.KV.get(AUTH_KEY, 'json');
    return json({ ok: true, authed: true, email: session.sub, since: auth && auth.updatedAt ? auth.updatedAt : null });
  }

  if (path === '/api/logout' && method === 'POST') {
    return json({ ok: true }, 200, { 'set-cookie': clearCookieHeader() });
  }

  if (path === '/api/password' && method === 'POST') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    let body;
    try { body = await request.json(); } catch (e) { return bad('รูปแบบข้อมูลไม่ถูกต้อง'); }
    const current = String(body.current || '');
    const next = String(body.next || '');
    if (next.length < 6) return bad('รหัสผ่านใหม่ต้องยาวอย่างน้อย 6 ตัวอักษร');
    if (next.length > 200) return bad('รหัสผ่านใหม่ยาวเกินไป');

    const auth = await env.KV.get(AUTH_KEY, 'json');
    if (!auth) return bad('ไม่พบบัญชีผู้ใช้', 503);
    const derived = await pbkdf2(current, b64Decode(auth.salt), Number(auth.iter) || PBKDF2_ITER);
    if (!timingSafeEqual(b64Encode(derived), auth.hash)) {
      await new Promise((r) => setTimeout(r, 300));
      return bad('รหัสผ่านปัจจุบันไม่ถูกต้อง', 403);
    }

    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    const hash = await pbkdf2(next, salt, PBKDF2_ITER);
    await env.KV.put(AUTH_KEY, JSON.stringify({
      email: auth.email,
      alg: 'PBKDF2-SHA256',
      iter: PBKDF2_ITER,
      salt: b64Encode(salt),
      hash: b64Encode(hash),
      updatedAt: Date.now()
    }));

    // เปลี่ยนรหัสแล้วให้ session เครื่องอื่นหลุดทั้งหมด:
    // หมุนคีย์ที่ใช้เซ็นคุกกี้ แล้วออกคุกกี้ใหม่ให้เครื่องที่เปลี่ยน
    const newSecret = randomId(32);
    await env.KV.put(SECRET_KEY, newSecret);
    const fresh = await makeSession(auth.email, newSecret, 30);
    return json({ ok: true }, 200, { 'set-cookie': cookieHeader(fresh.token, fresh.maxAge) });
  }

  if (path === '/api/posts' && method === 'GET') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const feed = await readFeed(env);
    return json({ ok: true, posts: sortPosts(pruneExpired(feed.posts)) });
  }

  if (path === '/api/stats' && method === 'GET') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const feed = await readFeed(env);
    return json({ ok: true, stats: buildStats(pruneExpired(feed.posts)) });
  }

  if (path === '/api/posts' && method === 'POST') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY_BYTES) return bad('ข้อมูลใหญ่เกินไป', 413);

    let body;
    try { body = await request.json(); } catch (e) { return bad('รูปแบบข้อมูลไม่ถูกต้อง'); }

    const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
    const imagesIn = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    const filesIn = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : [];
    if (!text && !imagesIn.length && !filesIn.length) return bad('ต้องมีข้อความ รูป หรือไฟล์อย่างน้อยหนึ่งอย่าง');

    const days = Number(body.expireDays) || 0;
    const ttl = days > 0 ? Math.max(60, Math.round(days * 86400)) : 0;
    const expireAt = days > 0 ? Date.now() + days * 86400000 : 0;

    const storedImages = await putImages(env, imagesIn, ttl);
    if (imagesIn.length && !storedImages.length) return bad('รูปที่ส่งมาไม่ถูกต้อง');
    const storedFiles = await putFiles(env, filesIn, ttl);
    if (filesIn.length && !storedFiles.length) return bad('ไฟล์ที่ส่งมาไม่ถูกต้อง (ใหญ่เกิน 20 MB หรือเสียหาย)');

    const post = {
      id: randomId(10),
      createdAt: Number(body.createdAt) > 0 ? Number(body.createdAt) : Date.now(),
      text,
      tags: cleanTags(body.tags),
      images: storedImages,
      ...(storedFiles.length ? { files: storedFiles } : {}),
      ...(expireAt ? { expireAt } : {})
    };

    const feed = await readFeed(env);
    feed.posts.unshift(post);
    const next = await writeFeed(env, feed);
    return json({ ok: true, post, posts: next.posts }, 201);
  }

  if (path === '/api/posts' && method === 'DELETE') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const feed = await readFeed(env);
    const all = feed.posts;
    for (const p of all) await deletePostAssets(env, p);
    await env.KV.put(FEED_KEY, JSON.stringify(emptyFeed()));
    return json({ ok: true, removed: all.length });
  }

  const postMatch = /^\/api\/posts\/([a-z0-9]+)$/i.exec(path);

  if (postMatch && (method === 'PATCH' || method === 'PUT')) {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    let body;
    try { body = await request.json(); } catch (e) { return bad('รูปแบบข้อมูลไม่ถูกต้อง'); }

    const id = postMatch[1];
    const feed = await readFeed(env);
    const post = feed.posts.find((p) => p.id === id);
    if (!post) return bad('ไม่พบโพสต์นี้', 404);

    if (Object.prototype.hasOwnProperty.call(body, 'pinned')) {
      post.pinned = !!body.pinned;
      if (post.pinned) post.pinnedAt = Date.now();
      else delete post.pinnedAt;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'tags')) {
      post.tags = cleanTags(body.tags);
    }

    const next = await writeFeed(env, feed);
    const fresh = next.posts.find((p) => p.id === id) || post;
    return json({ ok: true, post: fresh, posts: next.posts });
  }

  if (postMatch && method === 'DELETE') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const id = postMatch[1];
    const feed = await readFeed(env);
    const post = feed.posts.find((p) => p.id === id);
    if (!post) return bad('ไม่พบโพสต์นี้', 404);
    await deletePostAssets(env, post);
    feed.posts = feed.posts.filter((p) => p.id !== id);
    const next = await writeFeed(env, feed);
    return json({ ok: true, posts: next.posts });
  }

  if (path === '/api/import' && method === 'POST') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const len = Number(request.headers.get('content-length') || 0);
    if (len > MAX_BODY_BYTES) return bad('ข้อมูลใหญ่เกินไป', 413);
    let body;
    try { body = await request.json(); } catch (e) { return bad('รูปแบบข้อมูลไม่ถูกต้อง'); }
    const incoming = Array.isArray(body.posts) ? body.posts.slice(0, 50) : [];
    if (!incoming.length) return bad('ไม่มีโพสต์ที่จะนำเข้า');

    const feed = await readFeed(env);
    const known = new Set(feed.posts.map((p) => p.id));
    let added = 0;
    for (const raw of incoming) {
      const images = Array.isArray(raw.images) ? raw.images.slice(0, MAX_IMAGES) : [];
      const files = Array.isArray(raw.files) ? raw.files.slice(0, MAX_FILES) : [];
      const stored = await putImages(env, images, 0);
      const storedFiles = await putFiles(env, files, 0);
      const wanted = raw.id ? String(raw.id) : '';
      const post = {
        id: wanted && !known.has(wanted) && /^[a-z0-9]{1,32}$/i.test(wanted) ? wanted : randomId(10),
        createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : Date.now(),
        text: typeof raw.text === 'string' ? raw.text.slice(0, MAX_TEXT) : '',
        tags: cleanTags(raw.tags),
        images: stored,
        ...(storedFiles.length ? { files: storedFiles } : {})
      };
      known.add(post.id);
      feed.posts.push(post);
      added += 1;
    }
    const next = await writeFeed(env, feed);
    return json({ ok: true, added, posts: next.posts });
  }

  const fileMatch = /^\/api\/file\/([a-z0-9]+)$/i.exec(path);
  if (fileMatch && method === 'GET') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const id = fileMatch[1];
    const etag = '"f-' + id + '"';
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    const got = await env.KV.getWithMetadata('file:' + id, 'arrayBuffer');
    if (!got || !got.value) return bad('ไม่พบไฟล์นี้', 404);
    const meta = got.metadata || {};
    const type = meta.type || 'application/octet-stream';
    const name = meta.name || ('file.' + fileExtOf('', type));
    // ส่งเป็น attachment เสมอ — กัน HTML/SVG ที่ฝังสคริปต์ทำงานในโดเมนเรา
    return new Response(got.value, {
      headers: {
        'content-type': type,
        'content-length': String(got.value.byteLength),
        'content-disposition': contentDisposition(name, 'attachment'),
        'cache-control': 'private, max-age=31536000, immutable',
        etag,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox"
      }
    });
  }

  const imgMatch = /^\/api\/img\/([a-z0-9]+)$/i.exec(path);
  if (imgMatch && method === 'GET') {
    if (!session) return bad('ยังไม่ได้เข้าสู่ระบบ', 401);
    const id = imgMatch[1];
    const etag = '"' + id + '"';
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    const got = await env.KV.getWithMetadata('img:' + id, 'arrayBuffer');
    if (!got || !got.value) return bad('ไม่พบรูปนี้', 404);
    const meta = got.metadata || {};
    return new Response(got.value, {
      headers: {
        'content-type': meta.type || 'image/jpeg',
        'content-length': String(got.value.byteLength),
        'cache-control': 'private, max-age=31536000, immutable',
        etag,
        'x-content-type-options': 'nosniff'
      }
    });
  }

  return bad('ไม่พบคำขอนี้', 404);
}

/* --------------------------------------------------------------- fetch */

const wantsHtml = (request) => {
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.indexOf('text/html') !== -1;
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'content-security-policy': [
    "default-src 'self'",
    "img-src 'self' blob: data:",
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "connect-src 'self' https://cloudflareinsights.com",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; ')
};

function withHeaders(res) {
  const out = new Response(res.body, res);
  for (const key of Object.keys(SECURITY_HEADERS)) {
    if (!out.headers.has(key)) out.headers.set(key, SECURITY_HEADERS[key]);
  }
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }
      const res = await env.ASSETS.fetch(request);
      // SPA fallback เฉพาะเวลาเปิดหน้าเว็บ (ไม่ใช่ไฟล์หาย) กัน asset ที่ไม่มีกลายเป็น HTML
      if (res.status === 404 && wantsHtml(request)) {
        const fallback = await env.ASSETS.fetch(new Request(new URL('/', url), request));
        return withHeaders(new Response(fallback.body, { status: 200, headers: fallback.headers }));
      }
      return withHeaders(res);
    } catch (err) {
      if (url.pathname.startsWith('/api/')) {
        return json({ ok: false, error: 'เซิร์ฟเวอร์ผิดพลาด: ' + (err && err.message ? err.message : 'unknown') }, 500);
      }
      return new Response('Internal error', { status: 500 });
    }
  }
};
