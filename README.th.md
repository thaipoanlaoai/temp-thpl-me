# Temp Clipboard — temp.thpl.me

**ไทย** · [English](README.md) · [中文](README.zh.md)

บอร์ดชั่วคราวสำหรับฝาก **ข้อความ + รูป + ไฟล์แนบ** ล็อกอินครั้งเดียว โพสต์จากอุปกรณ์ไหนก็ได้ แล้วคัดลอกหรือดาวน์โหลดไปใช้ต่อ
ข้อมูลทั้งหมดเก็บใน Cloudflare KV ของคุณเอง

## ฟีเจอร์

- โพสต์ข้อความ รูป (สูงสุด 4 รูป) **และไฟล์ทุกชนิด (สูงสุด 4 ไฟล์ ไฟล์ละ 20 MB)** — เลือกไฟล์ / ลากมาวาง / วางด้วย Ctrl+V
- รูปถูกย่อก่อนอัปโหลด (กว้างสุด 1600px, JPEG); ไฟล์อื่นเก็บตามเนื้อไฟล์เดิมทุกไบต์
- ไฟล์แนบแสดงเป็นการ์ดในช่องโพสต์ และเป็นแถวดาวน์โหลดในโพสต์ (เก็บชื่อไฟล์เดิม รองรับชื่อภาษาไทย/จีน)
- ปุ่มคัดลอกแยก: ข้อความ / รูป (Clipboard API) + ปุ่มดาวน์โหลดสำรอง
- ล็อกอินบัญชีเดียว (PBKDF2 + คุกกี้ HttpOnly ที่เซ็นด้วย HMAC 30 วัน)
- แท็ก ปักหมุด ค้นหา ลบ/กู้คืน ลบอัตโนมัติ 1–30 วัน โหมดชั่วคราว (ไม่บันทึก) คิวออฟไลน์
- ธีมมืด–สว่าง + 3 ภาษา: **ไทย / จีน / อังกฤษ**
- PWA — ติดตั้งได้ ใช้ออฟไลน์กับเนื้อหาที่โหลดแล้ว
- สถิติการใช้งาน (โพสต์ / รูป / ไฟล์ / ไบต์) เทียบโควตาฟรี KV 1 GB

## สถาปัตยกรรม

| ส่วน | ที่อยู่ | หมายเหตุ |
| --- | --- | --- |
| Front-end (static) | `public/` | `index.html`, `assets/app.js`, `assets/i18n.js`, `assets/styles.css`, `sw.js`, ฟอนต์, ไอคอน |
| API + เสิร์ฟไฟล์ static | `src/worker.js` | Cloudflare Worker เสิร์ฟ `public/` ผ่าน binding `ASSETS` |
| ข้อมูล | Cloudflare KV `temp-clipboard-store` | keys: `feed:v1` (โพสต์ JSON), `img:<id>`, `file:<id>`, `auth:v1`, `cfg:secret` |

### API

| Method & path | ล็อกอิน | ใช้ทำอะไร |
| --- | --- | --- |
| `GET /api/health` | – | เช็คว่า KV ใช้ได้ |
| `POST /api/login` | – | อีเมล + รหัสผ่าน → คุกกี้เซสชัน (จำกัดอัตราต่อ IP) |
| `GET /api/me` | – | ธง `{ authed }` |
| `POST /api/logout` | – | ล้างคุกกี้ |
| `POST /api/password` | ✓ | เปลี่ยนรหัสผ่าน (หมุนคีย์เซ็น → เครื่องอื่นหลุดทั้งหมด) |
| `GET /api/posts` | ✓ | โพสต์ทั้งหมด (เรียงแล้ว ตัดที่หมดอายุ) |
| `POST /api/posts` | ✓ | สร้างโพสต์ — JSON `{ text, tags, expireDays, images:[{dataUrl,w,h}], files:[{name,type,size,dataUrl}] }` |
| `PATCH /api/posts/:id` | ✓ | ปักหมุด / แท็ก |
| `DELETE /api/posts/:id` | ✓ | ลบโพสต์พร้อมรูป/ไฟล์ |
| `DELETE /api/posts` | ✓ | ล้างทั้งหมด |
| `POST /api/import` | ✓ | นำเข้าเป็นชุด (ย้ายข้อมูลเก่าจาก IndexedDB, กู้คืนโพสต์ที่ลบ) |
| `GET /api/img/:id` | ✓ | ไบต์ของรูป (แสดง inline, cache immutable) |
| `GET /api/file/:id` | ✓ | ไบต์ของไฟล์แนบ — ส่งเป็น `attachment` เสมอ, `nosniff`, `CSP: sandbox` |

### ขีดจำกัด

| | |
| --- | --- |
| รูปต่อโพสต์ | 4 (6 MB/รูป หลังย่อ) |
| ไฟล์ต่อโพสต์ | 4 (20 MB/ไฟล์ — KV value สูงสุด 25 MB) |
| ข้อความต่อโพสต์ | 20,000 ตัวอักษร |
| โพสต์ | 500 (เก็บล่าสุด) |
| พื้นที่รวม | 1 GB (KV แผนฟรี) |

## Deploy

ต้องมี Node 18+ และบัญชี Cloudflare ที่มีโซน `thpl.me`

```bash
npm i -D wrangler
npx wrangler login          # หรือตั้ง CLOUDFLARE_API_TOKEN
npx wrangler deploy         # อัปโหลด src/worker.js + public/ ไปที่ Worker "temp-clipboard"
```

`wrangler.jsonc` ผูก:
- `KV` → namespace `f76e0ad7e87d4842a84202c2abae45e0` (`temp-clipboard-store`)
- `ASSETS` → `./public`
- route `temp.thpl.me/*` (โซน `thpl.me`)

Rollback: Cloudflare Dashboard → Workers & Pages → **temp-clipboard** → Deployments

> KV namespace ไม่ได้ถูกสร้างโดย config นี้ — มีอยู่แล้วในบัญชี ถ้า deploy ไปบัญชีใหม่ต้องสร้าง namespace แล้วแก้ `wrangler.jsonc`

## พัฒนาในเครื่อง

```bash
npx wrangler dev --local          # http://127.0.0.1:8787
```

ต้องมี record `auth:v1` ใน KV ก่อนจึงจะล็อกอินได้:
```json
{ "email": "you@example.com", "alg": "PBKDF2-SHA256", "iter": 100000, "salt": "<base64>", "hash": "<base64>", "updatedAt": 0 }
```
`hash` = base64(PBKDF2-SHA256(password, salt, 100000)) — สร้างด้วย WebCrypto ใน Node 18+ แล้วใส่ด้วย `wrangler kv key put auth:v1 --path auth.json`

## ความเป็นส่วนตัว / ความปลอดภัย

- ข้อความแสดงผ่าน `textContent`; ไฟล์แนบไม่เคยแสดง inline — ดาวน์โหลดอย่างเดียว
- คุกกี้เซสชัน: `HttpOnly; Secure; SameSite=Lax` เซ็นด้วย HMAC-SHA256
- CSP เข้มงวด, `nosniff`, `frame-ancestors 'none'`
- ชื่อไฟล์ถูกทำความสะอาด (ตัด path, ตัดตัวควบคุม, ยาวสุด 120 ตัวอักษร); ชื่อไทย/จีนเก็บผ่าน `filename*=UTF-8`

## License

MIT — ดู [LICENSE](LICENSE)
