# ใช้งานออนไลน์: เก็บผลงานบนคลาวด์ ล็อกอิน และสถานะถาวร

ศูนย์ควบคุมยังเป็น **เซิร์ฟเวอร์ตัวเดียว** (Node 24, ไม่มี framework) แต่เมื่อจะเปิดให้ใช้จากอินเทอร์เน็ตและไม่อยากให้ผลงานอยู่แค่บนดิสก์เครื่องเดียว เอกสารนี้อธิบาย 4 ชั้นที่เพิ่มเข้ามา (ทั้งหมดปิดอยู่จนกว่าจะตั้งค่าใน `.env`):

| ชั้น | ไฟล์ | ทำอะไร |
|---|---|---|
| ล็อกอิน | `server/auth.js` | `AUTH=token` + `DASHBOARD_TOKEN` → หน้า `/login`, คุกกี้ HttpOnly, Bearer สำหรับ CLI, จำกัดการเดาโทเคนต่อ IP, **ไม่ยอมสตาร์ต**ถ้าเปิดรับจากภายนอกโดยไม่มีล็อกอิน |
| ผลงานบนคลาวด์ | `server/storage.js` | โจทย์จบ → อัปโหลด `.grock/out/<jobId>/` ขึ้น bucket S3-compatible (Cloudflare R2 ฯลฯ) ลองใหม่ 3 ครั้ง ผลใน `job.json` + แท็บผลงาน |
| สถานะถาวร | `server/state-db.js` | SQLite `data/state.db` (node:sqlite) write-through — รีสตาร์ตแล้วโจทย์เก่า/ผลงาน/ตัวชี้วัดยังอยู่ |
| โค้ดขึ้น GitHub | `server/gitpush.js` | โปรเจกต์ที่เปิด `git.pushBranch` → branch `grock/<jobId>` รออนุมัติบนแดชบอร์ดก่อน push ด้วย git ของเครื่อง |

ทดสอบทั้งหมดในโหมด `sim` กับ S3 จำลองในเครื่อง (`npm test` → `test-storage`, `test-state-db`, `test-auth`, `e2e-online`) ไม่เรียก API จริง

## 1. ชนิดข้อมูล → ที่เก็บ

| ชนิดข้อมูล | ที่เก็บ | หมายเหตุ |
|---|---|---|
| โค้ดของศูนย์ควบคุม | GitHub (repo นี้) | `data/`, `samples/`, `logs/`, `.env`, โมเดล 3 มิติ, ภาพจากเกม **ไม่เข้า git** (`.gitignore`) |
| ผลงานของทีม AI (result.md, tasks/*.md, job.json, plan.json, patches/) | ดิสก์ `<โปรเจกต์>/.grock/out/<jobId>/` **และ** คลาวด์ `<S3_PREFIX>/<projectId>/<jobId>/` | โจทย์ที่ไม่ระบุโปรเจกต์ขึ้นคลาวด์ใต้ `workspace/` (สร้างไฟล์จากหน่วยความจำ) |
| โค้ดที่ทีมแก้ (patch ที่อนุมัติแล้ว) + ผลงาน | branch `grock/<jobId>` บน remote ของโปรเจกต์ | ต้องเปิดต่อโปรเจกต์และกดอนุมัติ |
| สถานะโจทย์/งาน/ตัวชี้วัด | หน่วยความจำ (แหล่งความจริงตอนรัน) + `data/state.db` | โหลดกลับตอนรีสตาร์ต (ล่าสุด `STATE_DB_KEEP`=300 โจทย์) |
| ทะเบียนโปรเจกต์, การตั้งค่าทีม, งบโทเคน | `data/projects.json`, `data/team.json`, `data/token-usage.json` | สำรองโฟลเดอร์ `data/` ถ้าย้ายเครื่อง |
| เหตุการณ์ทั้งหมด | `logs/events.jsonl` | ปิดด้วย `LOG_EVENTS=0` |
| คีย์/โทเคนทุกชนิด | `.env` ของเครื่องที่รันเท่านั้น | ห้ามใส่ใน `project.json`, โค้ด, หรือ commit |

## 2. ทางเลือกที่รัน

### 2.1 เครื่องตัวเอง + Cloudflare Tunnel (แนะนำเริ่มที่นี่)

ฟีเจอร์ครบที่สุด: โปรเจกต์บนดิสก์, Developer แก้ไฟล์จริงผ่าน `claude` CLI ที่ล็อกอินไว้, git push ด้วย credential ของคุณ, โมเดล 3 มิติอยู่ในเครื่อง ขั้นตอนติดตั้ง tunnel/service/autostart อยู่ใน [docs/10-deploy-tunnel.md](10-deploy-tunnel.md) — เอกสารนี้เพิ่มแค่ว่าตั้ง `.env` อย่างไร (ข้อ 3–4) ข้อแลก: เครื่องต้องเปิดตลอดเวลาที่ใช้

### 2.2 VPS + Docker

```bash
git clone https://github.com/JKrollinger/AI-Agent.git grock && cd grock
cp .env.example .env            # ใส่ DASHBOARD_TOKEN, ANTHROPIC_API_KEY, S3_* (ข้อ 3–4)
docker compose up -d --build    # เปิด http://127.0.0.1:3789 เฉพาะใน VPS
docker compose --profile tunnel up -d   # (ทางเลือก) Cloudflare Tunnel แบบโทเคน: ตั้ง TUNNEL_TOKEN ใน .env
```

- `Dockerfile` ใช้ `node:24-alpine` + `git` + `tini` รันเป็น user `node`, ตั้ง `HOST=0.0.0.0` → **ต้องมี `DASHBOARD_TOKEN`** ไม่งั้นคอนเทนเนอร์ออกทันทีพร้อมข้อความบอกเหตุ
- volume `grock-data` (`/app/data`: ทะเบียนโปรเจกต์, team.json, `state.db`) และ `grock-logs` — สำรอง 2 volume นี้พอ ผลงานอยู่บนคลาวด์อยู่แล้ว
- โปรเจกต์ที่ให้ทีมทำ: mount โฟลเดอร์เข้ามา (เช่น `./projects:/projects`) แล้ว `docker compose exec grock node tools/grock.mjs init /projects/myshop --id myshop`
- Developer แก้ไฟล์จริง (Phase 2) ต้องมี `claude` CLI ในคอนเทนเนอร์ — ภาพนี้ไม่ได้ติดตั้งให้ (ใช้แบบ "เสนอ patch" ไม่ได้ในคอนเทนเนอร์) ถ้าต้องการให้ต่อยอด Dockerfile เอง
- git push จากคอนเทนเนอร์: mount `~/.ssh` แบบอ่านอย่างเดียวและใช้ remote แบบ SSH หรือใช้ `git config credential.helper store` ใน volume (ระวัง: ไฟล์ credential อยู่ใน volume นั้น)
- ทางเข้าจากอินเทอร์เน็ต: Tunnel (profile `tunnel`) หรือ reverse proxy (Caddy/nginx) ชี้ `127.0.0.1:3789` แล้วใส่โดเมนใน `ALLOWED_HOSTS`

### 2.3 Railway / Render / Fly (PaaS)

ใช้ `Dockerfile` เดียวกัน ตั้ง env ใน dashboard ของผู้ให้บริการ (ไม่ต้องมี `.env`) และ **ต้องผูก persistent volume ที่ `/app/data`** ไม่งั้นทะเบียนโปรเจกต์/`state.db` หายทุก deploy; ตั้ง `ALLOWED_HOSTS=<โดเมนที่ได้>` และ `PORT` ตามที่ PaaS กำหนด (เช่น Railway ให้ `PORT` มาเอง) — เหมาะกับโหมดที่ไม่มีโปรเจกต์บนดิสก์ (โจทย์ workspace + ผลงานขึ้น R2) เพราะ PaaS ไม่มีโฟลเดอร์โปรเจกต์ของคุณ

## 3. เก็บผลงานบน Cloudflare R2 (หรือ S3 อื่น)

ไม่เพิ่ม dependency: `server/storage.js` เซ็นคำขอ AWS Signature V4 ด้วย `node:crypto` เอง (ตรวจกับ test vector ของ AWS ใน `tools/tests/test-storage.mjs`) ใช้ได้กับ R2, AWS S3, MinIO, Backblaze B2 ที่รองรับ path-style `https://<endpoint>/<bucket>/<key>`

### 3.1 สร้าง bucket และโทเคนใน R2

1. Cloudflare dashboard → **R2 Object Storage → Create bucket** → ชื่อเช่น `grock-results` (location อัตโนมัติ)
2. **R2 → Manage R2 API Tokens → Create API token** → Permissions = **Object Read & Write**, จำกัด **Specify bucket(s)** = bucket นี้ (อย่าให้สิทธิ์ทั้งบัญชี) → Create → จด **Access Key ID**, **Secret Access Key** และ endpoint `https://<account-id>.r2.cloudflarestorage.com` (แสดงหน้าเดียวกัน; Secret เห็นครั้งเดียว)
3. (ทางเลือก) ให้ลิงก์บนแดชบอร์ดเปิดได้ในเบราว์เซอร์: bucket → **Settings → Public access** → เปิด r2.dev subdomain หรือต่อ custom domain → เอา URL มาใส่ `S3_PUBLIC_URL` — **ระวัง** เท่ากับทุกคนที่รู้ URL อ่านผลงานได้ ถ้าผลงานมีข้อมูลภายในให้ปิดไว้ (ลิงก์จะชี้ endpoint ที่ต้องใช้คีย์เปิด เช่นผ่าน `rclone`/`aws s3`)

### 3.2 ใส่ `.env`

```ini
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=grock-results
S3_ACCESS_KEY_ID=<Access Key ID>
S3_SECRET_ACCESS_KEY=<Secret Access Key>
S3_PREFIX=grock            # โฟลเดอร์บนสุด (ว่างได้)
S3_REGION=auto             # R2 = auto · AWS = region ของ bucket เช่น ap-southeast-1
# S3_PUBLIC_URL=https://pub-xxxxxxxx.r2.dev
# S3_MAX_MB=50
```

รีสตาร์ตแล้วบรรทัดเริ่มต้นต้องขึ้น `☁️ เก็บผลงานขึ้นคลาวด์: … bucket grock-results` ถ้าตั้งค่าไม่ครบจะขึ้น `⚠️ STORAGE_PROVIDER=s3 แต่ตั้งค่าไม่ครบ` และทำงานต่อโดยไม่อัปโหลด

### 3.3 สิ่งที่เกิดขึ้นเมื่อโจทย์จบ

- `job.completed` / `job.failed` → หลัง `result.md`/`job.json` ถูกเขียนลงดิสก์ ระบบอ่านทั้งโฟลเดอร์ `.grock/out/<jobId>/` (result.md, job.json, plan.json, tasks/, patches/ — ข้าม symlink และไฟล์ > `S3_MAX_MB`) แล้ว PUT ขึ้น `<S3_PREFIX>/<projectId>/<jobId>/<path>` ทีละ 3 ไฟล์ **แบบ async** ไม่บล็อกการทำงานของทีม แต่ละไฟล์ลองใหม่ 3 ครั้ง (1s, 2s)
- โจทย์ที่ไม่ระบุโปรเจกต์ไม่มีโฟลเดอร์บนดิสก์ → สร้าง result.md / tasks/*.md / job.json ชุดเดียวกันจากหน่วยความจำ ขึ้นใต้ `workspace/<jobId>/`
- ผล: `job.storage = { status: uploading|uploaded|failed, uploaded, url, resultUrl, bucket, keyPrefix, files, bytes, skipped[], error, at }` → event `job.storage` → แท็บผลงานขึ้นชิป ☁️ และลิงก์ `<bucket>/<prefix>/` + ปุ่มคัดลอกลิงก์ result.md · `job.json` บนดิสก์ถูกเขียนใหม่พร้อม `storage` แล้วส่งขึ้นคลาวด์อีกครั้งให้ตรงกัน
- ล้มเหลวทุกครั้งมี log `☁️ อัปโหลด … ครั้งที่ N ไม่สำเร็จ` และสุดท้าย `job.storage.error` (ไม่ลองใหม่เองหลังจากนั้น — ส่งโจทย์ใหม่หรืออัปโหลดเองด้วย `rclone copy .grock/out/<jobId> r2:grock-results/grock/<projectId>/<jobId>`)

## 4. เปิดล็อกอิน (AUTH=token)

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"   # สร้างโทเคน
```

```ini
AUTH=token                      # หรือปล่อย auto — มี DASHBOARD_TOKEN = token อัตโนมัติ
DASHBOARD_TOKEN=<โทเคนที่สร้าง>  # ≥ 16 ตัวอักษร ไม่มีช่องว่าง
ALLOWED_HOSTS=ai.example.com    # โดเมนของ tunnel/proxy (ขึ้นต้นด้วย . = ทุกโดเมนย่อย)
SESSION_DAYS=7                  # อายุคุกกี้
LOGIN_MAX_FAILS=5               # เดาผิดเกินนี้ต่อ IP ใน LOGIN_WINDOW_MIN นาที → 429 ทุกคำขอจาก IP นั้นจนพ้นช่วง
LOGIN_WINDOW_MIN=15
```

| สิ่งที่ได้ | รายละเอียด |
|---|---|
| หน้า `/login` | ฟอร์มใส่โทเคน (ธีมเดียวกับแดชบอร์ด) → คุกกี้ `grock_session` **HttpOnly, SameSite=Strict, Secure** เมื่อมาทาง https (ตรง หรือหัว `X-Forwarded-Proto`/`CF-Visitor` จาก Cloudflare) · คุกกี้ = เวลาหมดอายุ + HMAC จากโทเคน (ไม่มี session ในหน่วยความจำ รีสตาร์ตแล้วยังใช้ได้ เปลี่ยน `DASHBOARD_TOKEN` = ทุกคนต้องล็อกอินใหม่) |
| ทุก path ต้องล็อกอิน | หน้าเว็บ, `/api/*`, SSE `/api/events`, ไฟล์โมเดล 3 มิติ — เบราว์เซอร์ที่ยังไม่ล็อกอินถูกพาไป `/login?next=…`, API ได้ `401 {"error","login":"/login"}` แดชบอร์ดพาไปหน้า login เองเมื่อเซสชันหมดอายุ |
| CLI / สคริปต์ | ส่ง `Authorization: Bearer <DASHBOARD_TOKEN>` — `tools/grock.mjs` อ่านจาก `GROCK_TOKEN` หรือ `DASHBOARD_TOKEN` ใน env, `restart-task.ps1` ใช้ตรวจ `/api/health` ให้เอง, `API_TOKENS` (Hermes/บอท) ยังใช้ได้ตามสิทธิ์เดิม |
| ออกจากระบบ | ปุ่ม "⎋ ออกจากระบบ" บนหัวแดชบอร์ด (`POST /logout` ลบคุกกี้) |
| Basic Auth เดิม | ยังใช้ได้ (`AUTH_PASSWORD`) ทั้งเดี่ยว ๆ (`AUTH=basic`) หรือควบคู่กับโทเคน |
| บังคับความปลอดภัย | `HOST` ไม่ใช่ loopback (เช่น `0.0.0.0` ใน Docker) หรือมี `ALLOWED_HOSTS` แต่ไม่มีการล็อกอิน → เซิร์ฟเวอร์พิมพ์เหตุผลแล้ว **exit 1** (ตั้ง `AUTH=none` เองเท่านั้นถึงจะข้ามได้ พร้อมคำเตือน) |

**ชั้นเพิ่มที่แนะนำ: Cloudflare Access** (ฟรี ≤ 50 ผู้ใช้) — คำขอที่ไม่ผ่าน Access จะไม่ถึงเครื่องคุณเลย โทเคนของแอปเป็นชั้นที่สอง ขั้นตอนอยู่ใน [docs/10-deploy-tunnel.md §3.2](10-deploy-tunnel.md) (Access → Applications → Self-hosted → นโยบายอีเมล) · SSE/fetch ของแดชบอร์ดใช้คุกกี้ของ Access ได้เอง · ถ้าใช้ `curl`/CLI ผ่านโดเมนต้องส่งหัว `CF-Access-Client-Id/Secret` ของ Service Token เพิ่มจาก Bearer

## 5. สถานะถาวร (SQLite)

- เปิดอัตโนมัติ: `data/state.db` (ใต้ `GROCK_DATA_DIR`) ผ่านโมดูล `node:sqlite` ของ Node 22.13+/24 — ไม่ต้องติดตั้งอะไร · `STATE_DB=0` เพื่อปิด
- **write-through**: หน่วยความจำยังเป็นแหล่งความจริง ทุก event `job.*`/`task.*` ถูกเขียนลงฐานทันที (ยกเว้น `task.progress` ที่ยิงถี่) ตัวชี้วัดต่อคนบันทึกเมื่องาน/โจทย์จบ ส่งต่อ ตรวจ
- **รีสตาร์ต**: โหลดโจทย์ล่าสุด `STATE_DB_KEEP` (300) รายการ + งานย่อย + ตัวชี้วัดกลับมา → แท็บผลงาน/งาน/ตัวชี้วัดเหมือนก่อนปิด (ชิป "💾 หลังรีสตาร์ต" บนโจทย์ที่ถูกกู้) · โจทย์ที่ค้างอยู่ (planning/running/synthesizing) → `failed` พร้อม `error: เซิร์ฟเวอร์รีสตาร์ตขณะโจทย์ยังไม่เสร็จ (สถานะเดิม: running)` และงานย่อยที่ยังไม่จบ → `cancelled` (log เตือนทุกโจทย์) — ส่งโจทย์ใหม่ถ้าต้องการ
- ข้อจำกัด: บริบทโปรเจกต์ (pack/ไฟล์ที่อ่าน) ไม่ถูกเก็บ → โจทย์เก่าหลังรีสตาร์ต "ทำใหม่"/apply patch/push ไม่ได้ (ได้ 409 บอกเหตุ) ใช้ไฟล์ใน `.grock/out` กับ git เอง · ฐานข้อมูลเสีย/เปิดไม่ได้ → เตือนแล้วทำงานในหน่วยความจำต่อ

## 6. โค้ดขึ้น GitHub เป็น branch `grock/<jobId>`

เปิดต่อโปรเจกต์ใน `<โปรเจกต์>/.grock/project.json` (ปิดเป็นค่าเริ่มต้น):

```json
"git": { "pushBranch": true, "remote": "origin" }
```

- โปรเจกต์ต้องเป็น git repo ที่มี remote ชื่อนั้น (ไม่ใช่ → `job.git.status = skipped` พร้อมเหตุผล)
- โจทย์เสร็จ (`job.completed`) → `job.git = { status: "pending", branch: "grock/<jobId>", remote }` → แท็บผลงานขึ้น "📤 รออนุมัติ push" + ปุ่ม **Push ไป origin** / **ไม่ push** (badge 📤N บนแท็บ) · API: `POST /api/jobs/:id/push {note}` (202) และ `POST /api/jobs/:id/push/reject {reason}` — โทเคน `API_TOKENS` สิทธิ์ `jobs` ทำไม่ได้ (403)
- อนุมัติแล้วระบบสร้าง commit จาก **index ชั่วคราว** (ไม่แตะ index/working tree/branch ปัจจุบันของคุณ):
  - ไม่มี patch ที่ apply แล้ว → branch แบบ orphan มี**เฉพาะ**ไฟล์ใน `.grock/out/<jobId>/` (เพิ่มแบบ `-f` เพราะ `.grock/out/` อยู่ใน `.gitignore` ของโปรเจกต์)
  - มี patch ของ Developer ที่อนุมัติแล้ว (Phase 2) → parent = HEAD ของโปรเจกต์ + ไฟล์ที่ patch แก้ (ตามที่อยู่จริงใน working tree) + โฟลเดอร์ผลงาน → เปิด Pull Request จาก branch นี้ได้เลย
- `git push <remote> refs/heads/grock/<jobId>` ด้วย git CLI ของเครื่อง (`GIT_TERMINAL_PROMPT=0` ไม่ถามรหัส) → ใช้ credential helper / SSH key ที่คุณมีอยู่แล้ว **ระบบไม่เก็บโทเคน GitHub** · ผล `job.git = { status: pushed|failed, commit, mode: orphan|patch, url }` (URL ของ branch บน GitHub/GitLab/Bitbucket) ลง `job.json` และ log; ล้มเหลวกด "ลอง push ใหม่" ได้
- ตั้งชื่อผู้ commit ด้วย `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` ใน `.env` (ค่าเริ่มต้น `Grock Agent <grock-agent@localhost>`)

## 7. ข้อควรระวังเรื่องคีย์และความปลอดภัย

- **คีย์ทุกตัวอยู่ใน `.env` เท่านั้น** (`ANTHROPIC_API_KEY`, `DASHBOARD_TOKEN`, `S3_*`, `API_TOKENS`, `WEBHOOK_SECRET`, `TUNNEL_TOKEN`) — ไฟล์นี้ถูก `.gitignore` และ `.dockerignore`; ห้ามใส่ใน `project.json`, โค้ด, log หรือแชต · ตัวอ่านบริบทโปรเจกต์ปิดบังค่าลับก่อนส่งเข้าโมเดลอยู่แล้ว (`redactSecrets`)
- โทเคน R2 ให้สิทธิ์ **Object Read & Write เฉพาะ bucket เดียว** · ผลงานที่อัปโหลดคือทุกไฟล์ใน `.grock/out/<jobId>/` รวม `patches/*.diff` (โค้ดของโปรเจกต์บางส่วน) — ถ้า bucket เปิดสาธารณะ (`S3_PUBLIC_URL`) คนที่รู้ URL จะเห็น
- `DASHBOARD_TOKEN` ให้สิทธิ์ admin ทั้งหมด (สั่งงาน = เสียเงิน API, apply patch = แก้ไฟล์โปรเจกต์, push = เขียน remote) — ใช้ร่วมกับ Cloudflare Access และตั้ง `JOB_RATE_LIMIT`, `MAX_USD_PER_JOB`, `TOKEN_DAILY_USD` ให้ต่ำเมื่อเปิดให้คนอื่นใช้
- เปลี่ยนโทเคนเมื่อสงสัยว่ารั่ว: แก้ `.env` → รีสตาร์ต (`tools\autostart\restart-task.ps1`) → คุกกี้เก่าใช้ไม่ได้ทันที
- git push ใช้ credential ของเครื่องที่รันเซิร์ฟเวอร์ — branch `grock/*` เขียนไปยัง remote ที่โปรเจกต์ตั้งไว้เท่านั้น ไม่ force-push ทับ branch อื่น
- `state.db` มีผลงานทั้งหมด (รวมผลลัพธ์ของโจทย์) อยู่ใน `data/` ซึ่งไม่เข้า git — ถ้าแชร์เครื่อง/volume ให้ตั้งสิทธิ์ไฟล์ให้เหมาะ

## 8. ตรวจว่าใช้งานได้ (checklist)

1. `npm start` → เห็น `🔒 ล็อกอินด้วยโทเคน`, `💾 สถานะถาวร: …state.db`, `☁️ เก็บผลงานขึ้นคลาวด์: …`
2. เปิดโดเมนของ tunnel → เจอหน้า login → ใส่โทเคน → แดชบอร์ด (มีปุ่ม ⎋ ออกจากระบบ)
3. สั่งโจทย์ (sim ก็ได้) → แท็บผลงานขึ้น ☁️ เก็บบนคลาวด์แล้ว → เปิด R2 dashboard เห็น `grock/<projectId>/<jobId>/result.md`
4. โปรเจกต์ที่เปิด `git.pushBranch` → การ์ดผลงานขึ้น 📤 → กด Push → `git ls-remote origin 'refs/heads/grock/*'` เห็น branch
5. รีสตาร์ตเซิร์ฟเวอร์ → แท็บผลงาน/ตัวชี้วัดยังอยู่ → โจทย์ที่ค้างขึ้น "ล้มเหลว: เซิร์ฟเวอร์รีสตาร์ต…"
