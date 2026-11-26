# Temp Clipboard — temp.thpl.me

Temporary board for **text + images + file attachments**. Sign in once, post from any device, copy or download anywhere.
Data lives in your own Cloudflare KV.

[ไทย](README.th.md) · [中文](README.zh.md)

## Features

- Post text, images (up to 4) **and any file type (up to 4, 20 MB each)** — pick, drag & drop, or Ctrl+V paste
- Images are resized before upload (max 1600 px, JPEG); other files are stored byte-for-byte
- Files show as cards in the composer and as download rows in the post (original filename preserved, Thai/Chinese names supported)
- Separate copy buttons: text / image (Clipboard API) + download fallback
- Single account login (PBKDF2 password, HttpOnly HMAC-signed cookie, 30 days)
- Tags, pin, search, delete/undo, auto-expire 1–30 days, temporary (not saved) mode, offline queue
- Dark/light theme, 3 languages: Thai / 简体中文 / English
- PWA — installable, works offline for already-loaded content
- Usage stats (posts / images / files / bytes) against the 1 GB KV free quota

## Architecture

| Part | Where | Notes |
| --- | --- | --- |
| Static front-end | `public/` | `index.html`, `assets/app.js`, `assets/i18n.js`, `assets/styles.css`, `sw.js`, fonts, icons |
| API + static serving | `src/worker.js` | Cloudflare Worker, also serves `public/` through the `ASSETS` binding |
| Data | Cloudflare KV namespace `temp-clipboard-store` | keys: `feed:v1` (posts JSON), `img:<id>`, `file:<id>`, `auth:v1`, `cfg:secret` |

### API

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/health` | – | KV reachability check |
| `POST /api/login` | – | Email + password → session cookie (rate-limited per IP) |
| `GET /api/me` | – | `{ authed }` flag |
| `POST /api/logout` | – | clear cookie |
| `POST /api/password` | ✓ | change password (rotates signing key → other devices are logged out) |
| `GET /api/posts` | ✓ | all posts (sorted, expired pruned) |
| `POST /api/posts` | ✓ | create post — JSON `{ text, tags, expireDays, images:[{dataUrl,w,h}], files:[{name,type,size,dataUrl}] }` |
| `PATCH /api/posts/:id` | ✓ | pin / tags |
| `DELETE /api/posts/:id` | ✓ | delete post + its images/files |
| `DELETE /api/posts` | ✓ | clear all |
| `POST /api/import` | ✓ | bulk import (legacy IndexedDB migration, undo-delete) |
| `GET /api/img/:id` | ✓ | image bytes (inline, immutable cache) |
| `GET /api/file/:id` | ✓ | attachment bytes — always `Content-Disposition: attachment`, `nosniff`, `CSP: sandbox` |

### Limits

| | |
| --- | --- |
| Images per post | 4 (6 MB each after resize) |
| Files per post | 4 (20 MB each — KV value limit is 25 MB) |
| Text per post | 20,000 chars |
| Posts | 500 (newest kept) |
| Total storage | 1 GB (KV free plan) |

## Deploy

Requires Node 18+ and a Cloudflare account with the `thpl.me` zone.

```bash
npm i -D wrangler
npx wrangler login          # or set CLOUDFLARE_API_TOKEN
npx wrangler deploy         # uploads src/worker.js + public/ to Worker "temp-clipboard"
```

`wrangler.jsonc` binds:
- `KV` → namespace `f76e0ad7e87d4842a84202c2abae45e0` (`temp-clipboard-store`)
- `ASSETS` → `./public`
- route `temp.thpl.me/*` (zone `thpl.me`)

Roll back from Cloudflare Dashboard → Workers & Pages → **temp-clipboard** → Deployments.

> The KV namespace is **not** created by this config — it already exists in the account. If you deploy to a new account, create a namespace and update `wrangler.jsonc`.

## Local development

```bash
npx wrangler dev --local          # http://127.0.0.1:8787
# seed a test account into local KV:
node -e "…"   # see "Auth record" below
```

The login record `auth:v1` must exist in KV before anyone can sign in:
```json
{ "email": "you@example.com", "alg": "PBKDF2-SHA256", "iter": 100000, "salt": "<base64>", "hash": "<base64>", "updatedAt": 0 }
```
`hash` = base64(PBKDF2-SHA256(password, salt, 100000)). Create it once with any script (e.g. WebCrypto in Node 18+) and `wrangler kv key put auth:v1 --path auth.json`.

## Privacy / Security

- Text is rendered with `textContent`; attachments are never rendered inline — only downloaded
- Session cookie: `HttpOnly; Secure; SameSite=Lax`, HMAC-SHA256 signed
- Strict CSP, `nosniff`, `frame-ancestors 'none'`
- File names are sanitised (path stripped, control chars removed, 120 chars max); Thai/Chinese names kept via `filename*=UTF-8`

## License

MIT — see [LICENSE](LICENSE).
