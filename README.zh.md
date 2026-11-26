# Temp Clipboard — temp.thpl.me

[ไทย](README.th.md) · [English](README.md) · **中文**

临时剪贴板：存放**文字 + 图片 + 附件**。登录一次，任何设备都能发帖，然后复制或下载到任何地方继续使用。
所有数据保存在你自己的 Cloudflare KV 中。

## 功能

- 发帖支持文字、图片（最多 4 张）**以及任意类型文件（最多 4 个，单个 20 MB）**——选择文件 / 拖放 / Ctrl+V 粘贴
- 图片上传前自动压缩（最大宽度 1600px，JPEG）；其他文件按原样逐字节保存
- 附件在输入框显示为卡片，在帖子中显示为下载行（保留原文件名，支持中文文件名）
- 分开的复制按钮：文字 / 图片（Clipboard API）+ 下载备用按钮
- 单账户登录（PBKDF2 + HttpOnly HMAC 签名 Cookie，30 天）
- 标签、置顶、搜索、删除/撤销、1–30 天自动过期、临时模式（不保存）、离线队列
- 深色–浅色主题 + 3 种语言：**泰语 / 中文 / 英语**
- PWA——可安装，已加载内容可离线使用
- 用量统计（帖子 / 图片 / 文件 / 字节），对照 KV 免费额度 1 GB

## 架构

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 前端（静态） | `public/` | `index.html`、`assets/app.js`、`assets/i18n.js`、`assets/styles.css`、`sw.js`、字体、图标 |
| API + 静态托管 | `src/worker.js` | Cloudflare Worker，通过 `ASSETS` 绑定托管 `public/` |
| 数据 | Cloudflare KV `temp-clipboard-store` | 键：`feed:v1`（帖子 JSON）、`img:<id>`、`file:<id>`、`auth:v1`、`cfg:secret` |

### API

| 方法 & 路径 | 需登录 | 用途 |
| --- | --- | --- |
| `GET /api/health` | – | 检查 KV 是否可用 |
| `POST /api/login` | – | 邮箱 + 密码 → 会话 Cookie（按 IP 限速） |
| `GET /api/me` | – | `{ authed }` 标志 |
| `POST /api/logout` | – | 清除 Cookie |
| `POST /api/password` | ✓ | 修改密码（轮换签名密钥 → 其他设备全部下线） |
| `GET /api/posts` | ✓ | 全部帖子（已排序、已剔除过期） |
| `POST /api/posts` | ✓ | 创建帖子 — JSON `{ text, tags, expireDays, images:[{dataUrl,w,h}], files:[{name,type,size,dataUrl}] }` |
| `PATCH /api/posts/:id` | ✓ | 置顶 / 标签 |
| `DELETE /api/posts/:id` | ✓ | 删除帖子及其图片/文件 |
| `DELETE /api/posts` | ✓ | 清空全部 |
| `POST /api/import` | ✓ | 批量导入（旧版 IndexedDB 迁移、撤销删除） |
| `GET /api/img/:id` | ✓ | 图片字节（内联显示，immutable 缓存） |
| `GET /api/file/:id` | ✓ | 附件字节——始终 `Content-Disposition: attachment`、`nosniff`、`CSP: sandbox` |

### 限制

| | |
| --- | --- |
| 每帖图片 | 4 张（压缩后每张 6 MB） |
| 每帖文件 | 4 个（每个 20 MB——KV 单值上限 25 MB） |
| 每帖文字 | 20,000 字符 |
| 帖子数 | 500（保留最新） |
| 总存储 | 1 GB（KV 免费版） |

## 部署

需要 Node 18+ 和拥有 `thpl.me` 区域的 Cloudflare 账户

```bash
npm i -D wrangler
npx wrangler login          # 或设置 CLOUDFLARE_API_TOKEN
npx wrangler deploy         # 上传 src/worker.js + public/ 到 Worker "temp-clipboard"
```

`wrangler.jsonc` 绑定：
- `KV` → 命名空间 `f76e0ad7e87d4842a84202c2abae45e0`（`temp-clipboard-store`）
- `ASSETS` → `./public`
- 路由 `temp.thpl.me/*`（区域 `thpl.me`）

回滚：Cloudflare Dashboard → Workers & Pages → **temp-clipboard** → Deployments

> 本配置**不会**创建 KV 命名空间——它已存在于账户中。若部署到新账户，需先创建命名空间并修改 `wrangler.jsonc`

## 本地开发

```bash
npx wrangler dev --local          # http://127.0.0.1:8787
```

KV 中必须存在 `auth:v1` 记录才能登录：
```json
{ "email": "you@example.com", "alg": "PBKDF2-SHA256", "iter": 100000, "salt": "<base64>", "hash": "<base64>", "updatedAt": 0 }
```
`hash` = base64(PBKDF2-SHA256(password, salt, 100000))——用 Node 18+ 的 WebCrypto 生成，再用 `wrangler kv key put auth:v1 --path auth.json` 写入

## 隐私 / 安全

- 文字通过 `textContent` 渲染；附件从不内联显示——只能下载
- 会话 Cookie：`HttpOnly; Secure; SameSite=Lax`，HMAC-SHA256 签名
- 严格 CSP、`nosniff`、`frame-ancestors 'none'`
- 文件名经过清理（去除路径、控制字符，最长 120 字符）；中文文件名通过 `filename*=UTF-8` 保留

## 许可证

MIT——见 [LICENSE](LICENSE)
