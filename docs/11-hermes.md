# สั่งงานทีม AI ทาง Telegram ผ่าน Hermes Agent

Hermes Agent (Nous Research, https://github.com/NousResearch/hermes-agent) เป็นเอเจนต์ส่วนตัวที่คุยผ่าน Telegram ได้ ต่อ MCP server ได้ และรับ webhook ได้ เอกสารนี้ตั้งให้ Hermes เป็น **"ผู้จัดการใหญ่"**: รับคำสั่งจากคุณใน Telegram → ตัดสินใจว่าจะทำอะไร/โปรเจกต์ไหน/แบ่งงานอย่างไร → ส่งโจทย์ (พร้อมแผนถ้าต้องการ) เข้าศูนย์ควบคุมผ่าน MCP → ทีม AI ทำงานโดยกัปตันเลือกคน/ตรวจ QA/รวมผล → ศูนย์ควบคุมยิง webhook กลับ Hermes → Hermes ส่งสรุปเข้า Telegram

แนวคิดคือ **"เสริม" ไม่ "ทับ"**: ฝั่งศูนย์ควบคุมทำทุกอย่างให้พร้อม (ข้อ 2) ส่วนฝั่ง Hermes มีสองทาง (ข้อ 3) — (ก) เพิ่ม MCP server + ทักษะเข้า Hermes ตัวที่ใช้อยู่ หรือ (ข) แยกโปรไฟล์ที่มี config/ความจำ/บอท Telegram ของตัวเอง — ไม่มีขั้นไหนต้องติดตั้ง Hermes ซ้ำหรือแก้ SOUL.md/ทักษะ/cron เดิมของคุณ

ทุกค่าของ Hermes ในเอกสารนี้อ้างจาก repo/เอกสารทางการ (https://hermes-agent.nousresearch.com/docs/) ณ ต.ค. 2026 — ถ้าเวอร์ชันใหม่เปลี่ยน ให้ยึดเอกสารทางการ

## 1. ผังการทำงาน

```
คุณ ──Telegram──▶ Hermes Agent (ผู้จัดการใหญ่: ตัดสินใจ "ทำอะไร / โปรเจกต์ไหน / เมื่อไร")
                      │ MCP (stdio)  tools/mcp-server.mjs → REST + Bearer token สิทธิ์ jobs
                      ▼
            AI Workforce Control Center (กัปตันตัดสินใจ "ใครทำ / QA / รวมผล")
                      │ ทีม 7 ตำแหน่งทำงาน · ผลงานเขียน <โปรเจกต์>/.grock/out/<jobId>/result.md
                      ▼ job.completed / job.failed
            POST JOB_WEBHOOK_URL (+ ลายเซ็น HMAC) ──▶ Hermes webhook route ──▶ Telegram (สรุปผล)
```

การแบ่งหน้าที่ (ข้อสรุปจากการออกแบบ):

| ใคร | ตัดสินใจ |
|---|---|
| Hermes | ทำอะไร, ใส่โปรเจกต์ไหน, เมื่อไร (cron ได้), จะส่งแผนเองหรือให้กัปตันวางแผน |
| ศูนย์ควบคุม | ใครทำแต่ละงาน (ตามหน้าที่), QA ส่งกลับแก้, รวมผลสุดท้าย, งบ/สิทธิ์, เขียนไฟล์ผลงาน, ยิง webhook |

## 2. ฝั่งศูนย์ควบคุม (ทำครั้งเดียว)

### 2.1 `.env`

```ini
# โทเคนสิทธิ์จำกัดสำหรับระบบภายนอก: ชื่อ:โทเคน:สิทธิ์ (คั่นด้วย ,) โทเคน ≥ 16 ตัวอักษร สร้างด้วย: node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
API_TOKENS=hermes:ใส่โทเคนสุ่มยาว ๆ:jobs
# งบรายวันต่อโทเคน (USD) เกินแล้วตอบ 429 จนถึงวันถัดไป — ยอดเก็บใน data/token-usage.json (0 = ไม่จำกัด)
TOKEN_DAILY_USD=5
# ปลายทางแจ้งผลเมื่อโจทย์เสร็จ/ล้มเหลว (Hermes webhook route "grock" บนพอร์ต 8644 — ดูข้อ 3.4; โปรไฟล์แยกใช้ /p/<โปรไฟล์>/webhooks/grock)
JOB_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/grock
# ลายเซ็น HMAC-SHA256 ของ webhook — ต้องตรงกับ secret ของ route ใน Hermes
WEBHOOK_SECRET=ใส่ค่าสุ่มยาว ๆ
# host ที่ยอมให้ส่ง webhookUrl มากับโจทย์ได้ (ไม่ตั้ง = รับเฉพาะ JOB_WEBHOOK_URL)
WEBHOOK_ALLOWED_HOSTS=127.0.0.1,localhost
```

รีสตาร์ตเซิร์ฟเวอร์ (`npm start` หรือ Task Scheduler "Grock Agent Server") แล้วดูบรรทัด `🎫 โทเคน API: hermes (jobs)` และ `📡 webhook แจ้งผล` ตอนเริ่ม (ไม่ตั้ง `JOB_WEBHOOK_URL` ก็ใช้ได้ — Hermes รอผลเองด้วย `wait_job` แทน ดูข้อ 3.1 ขั้น 3)

สิทธิ์ของโทเคน (บังคับทุกคำขอ แม้มาจาก localhost — `server/tokens.js`):

| สิทธิ์ | เรียกได้ |
|---|---|
| `jobs` | `POST /api/jobs`, `GET /api/jobs`, `GET /api/jobs/:id`, `GET /api/state`, `GET /api/projects`, `GET /api/projects/:id/context`, `GET /api/agents`, `GET /api/health` — อย่างอื่น 403 (ลงทะเบียนโปรเจกต์/สลับโหมด/ตั้งค่าทีม/หน้าเว็บทำไม่ได้) |
| `admin` | ทุกอย่างเท่ากับรหัสผ่าน `AUTH_PASSWORD` |

โทเคนส่งเป็นหัว `Authorization: Bearer <โทเคน>` (แทน Basic Auth) โทเคนผิด → 401 · เกินงบรายวัน → 429 · ยังนับ `JOB_RATE_LIMIT` (20 โจทย์/10 นาที) เหมือนคำขอจากภายนอก

### 2.2 REST ที่เพิ่มสำหรับผู้จัดการใหญ่ภายนอก

`POST /api/jobs` รับฟิลด์เพิ่ม:

```json
{
  "goal": "วางแผนเปิดร้านกาแฟพิเศษย่านอารีย์",
  "project": "myshop",
  "requestedBy": "telegram:@somchai",
  "webhookUrl": "http://127.0.0.1:8644/webhooks/grock",
  "plan": [
    { "title": "ค้นข้อมูลตลาดกาแฟพิเศษ", "brief": "ขนาดตลาด แนวโน้ม พฤติกรรมผู้บริโภค", "role": "researcher" },
    { "title": "วางแผนการตลาด", "brief": "ช่องทาง ข้อความหลัก ตัวชี้วัด", "role": "marketer", "dependsOn": [0] },
    { "title": "ประเมินการเงิน 12 เดือน", "brief": "ต้นทุน รายได้ จุดคุ้มทุน", "agentId": "fin-1", "dependsOn": [1] }
  ]
}
```

- `plan` (ไม่บังคับ) ไม่เกิน 12 งาน แต่ละงานมี `title` (≤ 70), `brief` (≤ 4000), `role` (marketer | researcher | finance | engineer | coder | reviewer) หรือ `agentId` (จาก `GET /api/agents`), `dependsOn` = ดัชนีงานก่อนหน้า ผิดตรงไหนตอบ 400 พร้อมบอกตำแหน่ง (`plan[2].agentId "x" ไม่มีในทีม`)
- เมื่อมี `plan` กัปตัน **ไม่วางแผนเอง** (ไม่เสียโทเคน) แต่ยังตรวจแผน จัดลำดับ **เติมงาน QA ปิดท้าย** เลือกคนตามหน้าที่ (ถ้าไม่ได้ระบุ `agentId`) และทำ handoff/QA/รวมผลตามเดิม — เหตุการณ์และฉาก 3 มิติเหมือนโจทย์ปกติ (กัปตันอ่านแผน → ปักงาน → ทีมเดินไปรับ) · `plan.roles` ของโปรเจกต์ยังบังคับ ส่วน `plan.maxTasks` ของโปรเจกต์ไม่ใช้กับแผนภายนอก (ผู้ส่งแผนกำหนดจำนวนเอง เพดาน 12)
- `requestedBy` ข้อความอิสระ ≤ 120 ตัวอักษร แสดงบนการ์ดงาน/แท็บผลงาน/`result.md` และส่งกลับใน webhook
- `webhookUrl` ปลายทางเฉพาะโจทย์นี้ (host ต้องอยู่ใน `WEBHOOK_ALLOWED_HOSTS`) ไม่ใส่ = `JOB_WEBHOOK_URL`
- โจทย์บันทึก `source` = ชื่อโทเคน (เช่น `hermes`), `planSource` = `external` | `captain`

เพิ่มเติม: `GET /api/agents` (รายชื่อ + ตำแหน่ง + หน้าที่ + สถานะ สำหรับเลือก `agentId`/`role`), `GET /api/jobs?limit=50&status=done` (รายการโจทย์ ไม่รวมผลลัพธ์เต็ม)

### 2.3 webhook ขาออก (`server/webhook.js`)

เมื่อโจทย์ `done` หรือ `failed` ศูนย์ควบคุม POST JSON:

```json
{
  "event": "job.completed", "jobId": "job-…", "status": "done",
  "goal": "…", "project": "myshop", "summary": "ย่อหน้าแรกของผลสรุป (≤ 1500 ตัวอักษร)",
  "resultPath": "C:/Projects/MyShop/.grock/out/job-…/result.md", "outputDir": "…",
  "costUsd": 0.1234, "durationSec": 95, "requestedBy": "telegram:@somchai",
  "source": "hermes", "planSource": "external", "error": null, "finishedAt": "2026-10-20T09:05:13.073Z"
}
```

หัวที่แนบ (เมื่อตั้ง `WEBHOOK_SECRET`):

| หัว | ค่า |
|---|---|
| `X-Grock-Signature` | `sha256=<hex HMAC-SHA256(body)>` |
| `X-Webhook-Signature-V2` + `X-Webhook-Timestamp` | hex HMAC-SHA256 ของ `<timestamp>.<body>` (timestamp = unix วินาที) — รูปแบบ "Generic V2" ที่ Hermes ตรวจเอง |
| `X-Webhook-Signature` | hex HMAC-SHA256(body) (Generic V1 เผื่อปลายทางเก่า) |

ส่งไม่สำเร็จ (ต่อไม่ได้/ไม่ใช่ 2xx/เกิน 10 วินาที) ลองใหม่รวม 3 ครั้ง (คั่น `WEBHOOK_RETRY_MS` × ครั้ง) ทุกครั้งลง log แท็บ "บันทึก" + `logs/events.jsonl` และสถานะอยู่ใน `job.webhook` (`GET /api/jobs/:id`, ชิป 📡 บนการ์ดงาน)

### 2.4 MCP server (`tools/mcp-server.mjs`)

JSON-RPC 2.0 ผ่าน stdio ตาม MCP (ไม่เพิ่ม dependency) เรียก REST ด้วย `GROCK_URL` + `GROCK_TOKEN` · ทดลองเอง: `npm run mcp` (อ่าน `.env` → ใช้โทเคนแรกใน `API_TOKENS` ถ้าไม่ตั้ง `GROCK_TOKEN`)

| เครื่องมือ | ทำอะไร |
|---|---|
| `list_projects` | โปรเจกต์ที่ลงทะเบียน (id สำหรับ `project`) |
| `list_agents` | ทีม + ตำแหน่ง + หน้าที่ (เลือก `role`/`agentId` ตอนเขียนแผน) |
| `create_job(goal, project?, plan?, requestedBy?, webhookUrl?, files?)` | สั่งโจทย์ → ได้ `jobId` ทันที |
| `job_status(jobId)` | สถานะ + ความคืบหน้างานย่อย + ต้นทุน + ผลส่ง webhook |
| `job_result(jobId)` | สรุป + ผลลัพธ์เต็ม (≤ 20,000 ตัวอักษร) + `resultPath` + คะแนน QA |
| `wait_job(jobId, timeoutSec=600)` | รอจนเสร็จ/ล้มเหลว แล้วคืนเหมือน `job_result` (หมดเวลา → `timedOut: true` เรียกซ้ำได้) |

ข้อผิดพลาดจาก REST (400/401/403/429) กลับมาเป็นผลลัพธ์ `isError` พร้อมข้อความไทย เอเจนต์จะอ่านแล้วบอกผู้ใช้ได้ · ไฟล์ประกอบสำหรับฝั่ง Hermes (ทักษะ + ตัวอย่าง config) อยู่ใน [tools/hermes/](../tools/hermes/README.md)

## 3. ฝั่ง Hermes Agent

### 3.0 สำรวจก่อนลงมือ (อ่านอย่างเดียว)

ถ้าเครื่องนี้ใช้ Hermes กับงานอื่นอยู่แล้ว **ห้าม** รันสคริปต์ติดตั้งซ้ำ และห้ามแก้ `SOUL.md` / `config.yaml` / `skills/` / `cron/` / `memories/` เดิมโดยไม่สำรองและไม่ถามเจ้าของก่อน — ดูให้รู้ว่ามีอะไรอยู่:

```bash
hermes --version                  # เวอร์ชัน + โฟลเดอร์ติดตั้ง
hermes profile list               # โปรไฟล์ที่มี, โมเดล, gateway กำลังรันไหม
echo %HERMES_HOME%                # Windows native ปกติคือ %LOCALAPPDATA%\hermes (Linux/WSL2: ~/.hermes)
```

ใน Hermes home ดูชื่อไฟล์พอ (ไม่ต้องเปิด `.env`/`auth.json` และห้ามวางค่าในแชต): `config.yaml` (มี `mcp_servers:` ของงานอื่นไหม, มี `platforms:` คือเปิด webhook ingress แล้ว), `.env` (ชื่อตัวแปร `TELEGRAM_*`, `WEBHOOK_*`), `SOUL.md` (บุคลิกที่ปรับไว้ — ถ้ายาวและเฉพาะธุรกิจ แปลว่าไม่ควรแตะ), `skills/`, `cron/jobs.json`, `gateway.pid`/`gateway_state.json` (gateway ที่รันอยู่และแพลตฟอร์มที่ต่อ) แล้วเลือกทาง:

| สถานการณ์ | ทางที่แนะนำ |
|---|---|
| Hermes เดิมคุยกับคุณใน Telegram อยู่แล้ว และอยากสั่งทีม AI จากแชตเดิม | **ทาง ก** (3.1) — เพิ่ม MCP server + ทักษะ บุคลิก/ความจำ/cron เดิมคงอยู่ |
| ไม่อยากให้งานทีม AI ปนกับบุคลิก/ความจำ/cron ของงานอื่น หรืออยากมีบอทแยก | **ทาง ข** (3.2) — โปรไฟล์แยก (`hermes profile create`) |
| เครื่องยังไม่มี Hermes | ติดตั้งตามเอกสารทางการ (3.3) แล้วทำเหมือนทาง ก บนโปรไฟล์ default |

### 3.1 ทาง ก: เสริมเข้า Hermes ตัวเดิม (ไม่ทับอะไร)

1. **เพิ่ม MCP server** — ใน `config.yaml` ของโปรไฟล์ที่ใช้ (ค่าเริ่มต้น `~/.hermes/config.yaml`) เพิ่มรายการใหม่ใต้ `mcp_servers:` ที่มีอยู่แล้ว (สำรองไฟล์ก่อน ไม่ลบรายการเดิม) — คัดลอกจาก [tools/hermes/mcp_servers.example.yaml](../tools/hermes/mcp_servers.example.yaml):

```yaml
mcp_servers:
  # …รายการเดิมของคุณคงไว้…
  grock:
    command: "node"
    args: ["C:/Projects/AI Agent/Grock Agent/tools/mcp-server.mjs"]
    env:
      GROCK_URL: "http://127.0.0.1:3789"
      GROCK_TOKEN: "โทเคน hermes จาก API_TOKENS"     # Hermes ไม่ส่ง env ของ shell ให้ stdio server ต้องใส่ตรงนี้
    timeout: 900
    connect_timeout: 30
```

   Hermes ตั้งชื่อเครื่องมือเป็น `mcp_grock_<ชื่อ>` (เช่น `mcp_grock_create_job`) และรวมเป็น toolset `mcp-grock` · พิมพ์ `/reload-mcp` ในแชต (หรือรีสตาร์ต gateway) แล้วถามบอทว่า "มีเครื่องมือ grock ไหม" · ถ้า `platform_toolsets.telegram` ใน config จำกัด toolset ไว้ ให้เพิ่ม `mcp-grock` เข้าไปด้วย

2. **เพิ่มทักษะ "เมื่อไรใช้ grock"** (กันปนกับงานอื่น) — ไม่ต้องคัดลอกไฟล์ ชี้ Hermes มาที่โฟลเดอร์ทักษะในรีโปนี้:

```yaml
skills:
  external_dirs:
    - "C:/Projects/AI Agent/Grock Agent/tools/hermes/skills"
```

   ทักษะ [`grock-workforce`](../tools/hermes/skills/grock-workforce/SKILL.md) บอกเงื่อนไขใช้/ไม่ใช้ (ใช้เฉพาะเมื่อผู้ใช้พูดถึง "ทีม AI / ศูนย์ควบคุม / grock" หรือถามผลโจทย์ที่สั่งไว้; ห้ามสั่งเองเพราะเสียเงิน; 429 ห้ามลองซ้ำ), ขั้นตอน `list_projects` → `create_job` → ตอบ jobId → `job_status`/`job_result`, รูปแบบ `plan`, และกติกาต้นทุน ทักษะตั้ง `requires_tools: [mcp_grock_create_job]` จึงโผล่เฉพาะเมื่อ MCP server ต่อสำเร็จ และ **ไม่แตะ `SOUL.md`** — บุคลิกเดิมของคุณยังใช้กับงานอื่นตามปกติ (ถ้าอยากสั่งตรง พิมพ์ `/grock-workforce` ก่อนโจทย์)

3. **รับผลกลับ** เลือกอย่างใดอย่างหนึ่ง:
   - **webhook (แนะนำ)**: เปิด webhook ingress ของ gateway เดิม (`WEBHOOK_ENABLED=true`, `WEBHOOK_PORT=8644` ใน `.env` ถ้ายังไม่เปิด) และเพิ่ม route `grock` ใน `platforms.webhook` ตามข้อ 3.4 — เป็นการเพิ่ม listener/route ใหม่ ไม่กระทบแชต/cron เดิม แต่ต้องรีสตาร์ต gateway หนึ่งครั้ง
   - **ไม่แตะ gateway เลย**: ไม่ตั้ง `JOB_WEBHOOK_URL` ฝั่งศูนย์ควบคุม ให้ Hermes เรียก `mcp_grock_wait_job` (ไม่เกิน `timeout` ของ MCP server) แล้วสรุปในแชตเอง หรือสั่งแล้วถามภายหลังด้วย `mcp_grock_job_status` — ทักษะรองรับทั้งสองแบบ

### 3.2 ทาง ข: โปรไฟล์แยก (config / ความจำ / ทักษะ / บอท Telegram ของตัวเอง)

Hermes รองรับหลายโปรไฟล์: แต่ละโปรไฟล์คือ Hermes home แยกที่ `~/.hermes/profiles/<ชื่อ>/` (มี `config.yaml`, `.env`, `SOUL.md`, memories, sessions, skills, cron, state.db ของตัวเอง) คำสั่งทุกคำสั่งใช้ `hermes -p <ชื่อ> …` ซึ่งภายในคือการตั้ง `HERMES_HOME` ไปที่โฟลเดอร์นั้น

```bash
hermes profile create grock          # โปรไฟล์เปล่า (ไม่ใช้ --clone เพื่อไม่ลาก SOUL/ทักษะ/ความจำของงานอื่นมา) + alias คำสั่ง "grock"
hermes -p grock setup                # เลือกโมเดล/ผู้ให้บริการของโปรไฟล์นี้
hermes profile list                  # ต้องเห็น default และ grock
```

ไฟล์ของโปรไฟล์ `~/.hermes/profiles/grock/`:

- `.env`: คีย์ผู้ให้บริการโมเดล + **โทเคนบอท Telegram ตัวใหม่** (สร้างจาก @BotFather อีกตัว — Hermes ล็อกโทเคน ไม่ให้สองโปรไฟล์ใช้บอทเดียวกัน) + `TELEGRAM_ALLOWED_USERS` + `TELEGRAM_HOME_CHANNEL`
- `config.yaml`: `mcp_servers.grock` (เหมือนข้อ 3.1 ขั้น 1) + `skills.external_dirs` (ขั้น 2)
- `SOUL.md`: บุคลิก "ผู้จัดการใหญ่" ของโปรไฟล์นี้โดยเฉพาะ เช่น

```
คุณคือผู้จัดการใหญ่ของทีม AI ขององค์กร งานหลักของคุณคือรับคำสั่งทาง Telegram แล้วสั่งทีมผ่านเครื่องมือ mcp_grock_* ตามทักษะ grock-workforce
ตอบ jobId ให้ผู้ใช้ทันทีไม่ต้องรอ ถ้าผู้ใช้ถามความคืบหน้าใช้ mcp_grock_job_status ได้ 429 ให้แจ้งผู้ใช้ ห้ามลองซ้ำ ตอบภาษาไทย
```

**ทางลัด (ทำแล้วบนเครื่องนี้):** หลัง `hermes profile create grock --no-alias` รันสคริปต์ครั้งเดียว (ผู้ใช้รันเอง เพราะมันเขียนค่าลับลงไฟล์ตั้งค่า):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Projects\AI Agent\Grock Agent\tools\hermes\setup-profile.ps1" -Profile grock -CopyOpenAIKey
```

[tools/hermes/setup-profile.ps1](../tools/hermes/setup-profile.ps1) สร้างโทเคน API + webhook secret แล้วเขียน (ไม่แสดงค่า ไม่แตะโปรไฟล์ default): `.env` ของศูนย์ควบคุม (`API_TOKENS`, `TOKEN_DAILY_USD`, `JOB_WEBHOOK_URL=http://127.0.0.1:8645/webhooks/grock`, `WEBHOOK_SECRET`), `.env` ของโปรไฟล์ (`TELEGRAM_ALLOWED_USERS`/`TELEGRAM_HOME_CHANNEL` คัดลอกจาก default, `OPENAI_API_KEY` คัดลอกเมื่อใส่ `-CopyOpenAIKey`, `WEBHOOK_ENABLED/PORT=8645/SECRET`, `TELEGRAM_BOT_TOKEN=` เว้นว่างให้วางเอง), `config.yaml` ของโปรไฟล์ (model ตาม default, `skills.external_dirs`, `mcp_servers.grock`, route webhook) และ `SOUL.md` จาก [SOUL.grock.md](../tools/hermes/SOUL.grock.md) · มีอยู่แล้วจะไม่เขียนทับ (ใช้ `-Force` ถ้าต้องการ)

**gateway ของโปรไฟล์: multiplexing หรือแยกโปรเซส** — ขึ้นกับรุ่น Hermes:
- เอกสารทางการรุ่นล่าสุดบอกว่า multiplexing (`gateway.multiplex_profiles: true`) เป็นค่าเริ่มต้น: gateway ของ default รับ adapter ของโปรไฟล์ใหม่ให้เองทันทีที่ `.env` ของโปรไฟล์มีโทเคนบอท (สแกน `profiles/` ทุก 30 วินาที) ข้อความถึงบอท `grock` ประมวลผลด้วย config/SOUL/ทักษะ/ความจำ/MCP ของโปรไฟล์ `grock` เท่านั้น และ listener webhook มีตัวเดียว (ของ default): route ของโปรไฟล์อยู่ที่ `http://127.0.0.1:8644/p/grock/webhooks/grock` โดยต้องประกาศ route ใน config ของ **default** พร้อม `profile: grock` (`WEBHOOK_PORT` ของโปรไฟล์รองถูกข้าม) ในโหมดนี้ `hermes -p grock gateway start` แยกโปรเซสถูกปฏิเสธถ้าไม่ใส่ `--force`
- **รุ่นที่ติดตั้งบนเครื่องนี้ (v0.20.2, 2026-08) ค่าเริ่มต้นของ `multiplex_profiles` คือ `false`** (ตรวจจาก `gateway/config.py` ของตัวติดตั้ง) การเปิด multiplexing ต้องแก้ config ของ default + รีสตาร์ต gateway เดิม ซึ่งขัดกับเป้าหมาย "งานเดิมไม่ถูกแตะ" จึงใช้ **gateway แยกโปรเซสของโปรไฟล์ `grock`** แทน: มี webhook listener ของตัวเองที่พอร์ต **8645** (route `http://127.0.0.1:8645/webhooks/grock` ไม่ต้องมี `/p/` และไม่ต้องแตะ config ของ default เลย) รันด้วย

```powershell
hermes -p grock gateway install     # สร้าง Scheduled Task "Hermes_Gateway_grock" (รันตอนล็อกอิน แยกจาก Hermes_Gateway ของ default) แล้วเริ่มให้
hermes -p grock gateway status      # หรือ start / stop / restart — log ที่ %LOCALAPPDATA%\hermes\profiles\grock\logs\gateway.log
```

  ถ้าภายหลังอัปเดต Hermes เป็นรุ่นที่ multiplexing เปิดเป็นค่าเริ่มต้น ให้ `hermes -p grock gateway uninstall` แล้วย้าย route ไปตามข้อแรก (เติม `profile: grock` และเปลี่ยน `JOB_WEBHOOK_URL` เป็น `/p/grock/webhooks/grock` บนพอร์ตของ default)
- ไม่อยากมี webhook เลย: ไม่ตั้ง `JOB_WEBHOOK_URL` แล้วให้ Hermes ใช้ `wait_job`/`job_status` เหมือนข้อ 3.1 ขั้น 3

### 3.3 Telegram gateway (บอทใหม่ หรือเครื่องที่ยังไม่มี Hermes)

ติดตั้ง (เฉพาะเครื่องที่ยังไม่มี): Windows (native, PowerShell) `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` → `%LOCALAPPDATA%\hermes` · Linux / macOS / WSL2 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` → `~/.hermes/` · จากนั้น `hermes setup`

1. สร้างบอทกับ @BotFather (`/newbot`) ได้โทเคนรูปแบบ `123456789:ABC…` (โปรไฟล์แยกต้องเป็นบอทคนละตัวกับโปรไฟล์เดิม)
2. หา user id ของคุณจาก @userinfobot (ไม่ใช่ username)
3. ใส่ใน `.env` ของโปรไฟล์ (`~/.hermes/.env` หรือ `~/.hermes/profiles/grock/.env`):

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_ALLOWED_USERS=123456789        # คั่นด้วย , ไม่ตั้ง = ปฏิเสธทุกคน
TELEGRAM_HOME_CHANNEL=123456789         # แชตที่รับผล cron/webhook เมื่อไม่ระบุ chat_id (หรือพิมพ์ /sethome ในแชต)
```

4. โปรไฟล์ default: `hermes gateway setup` (เลือก Telegram) แล้ว `hermes gateway` (หรือ `hermes gateway start`) · โปรไฟล์แยก: `hermes -p grock gateway install` (แยกโปรเซส) หรือไม่ต้องสั่งอะไรถ้า multiplexing เปิดอยู่ (ดู 3.2) · ทักบอทแล้วควรตอบภายในไม่กี่วินาที คำสั่งที่ใช้บ่อย: `/help`, `/new`, `/sethome`, `/whoami`, `/model`, `/reload-mcp`

### 3.4 route รับ webhook แล้วส่งเข้า Telegram

`.env` ของโปรไฟล์ default (ข้ามถ้ามีอยู่แล้ว):

```ini
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
```

`config.yaml` ของโปรไฟล์ default — เพิ่ม route ใต้ `platforms.webhook.extra.routes` (ถ้ามีบล็อก `platforms:` อยู่แล้วให้เพิ่มเฉพาะ `grock:`; ตัวอย่างเต็มใน [tools/hermes/webhook-route.example.yaml](../tools/hermes/webhook-route.example.yaml)):

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        grock:                                  # → http://127.0.0.1:8644/webhooks/grock = JOB_WEBHOOK_URL ของศูนย์ควบคุม
          secret: "ค่าเดียวกับ WEBHOOK_SECRET"   # Hermes ตรวจ X-Webhook-Signature-V2 + X-Webhook-Timestamp (HMAC ของ <ts>.<body>) ให้เอง
          # profile: grock                      # ทาง ข: ให้โปรไฟล์ grock เป็นผู้รับ → URL เป็น /p/grock/webhooks/grock
          deliver: "telegram"
          deliver_extra:
            chat_id: "123456789"                # ไม่ใส่ = TELEGRAM_HOME_CHANNEL ของโปรไฟล์ที่รับ
          deliver_only: true                    # ส่งข้อความที่เรนเดอร์จาก prompt ตรง ๆ ไม่เรียกโมเดล (ไม่เสียโทเคน)
          prompt: |
            {event} — {goal}
            {summary}
            💵 ${costUsd} · ⏱ {durationSec} วินาที · ผู้ขอ {requestedBy}
            📁 {resultPath}
```

- `{ฟิลด์}` อ้างคีย์ใน payload ของเรา (จุดสำหรับคีย์ซ้อน, `{__raw__}` = ทั้ง payload) คีย์ที่ไม่มีจะคงเป็นข้อความ `{คีย์}`
- อยากให้ Hermes "อ่านผลแล้วสรุปเอง" ก่อนส่ง (เสียโทเคนของ Hermes): ตัด `deliver_only` ออก แล้วเขียน prompt เป็นคำสั่ง เช่น `สรุปผลโจทย์นี้ให้ผู้ใช้ใน 5 บรรทัด: {__raw__}` และจะให้ Hermes เรียก `mcp_grock_job_result` อ่านฉบับเต็มก่อนก็ได้
- รีสตาร์ต gateway แล้วตรวจ: `curl http://127.0.0.1:8644/health` → `{"status":"ok","platform":"webhook"}` · ทดสอบจากศูนย์ควบคุมด้วยโจทย์สั้น ๆ ในโหมด sim (`MODE=sim`) ก่อนใช้ live
- พอร์ต 8644 ควรฟังเฉพาะในเครื่อง/LAN — ไม่ต้องเปิดออกอินเทอร์เน็ต ศูนย์ควบคุมส่งจากเครื่องเดียวกัน (หรือ LAN เดียวกัน)
- ถ้า Hermes อยู่ใน WSL2 แต่ศูนย์ควบคุมอยู่บน Windows: `127.0.0.1` ใน WSL2 ไม่ใช่ Windows — ใน `GROCK_URL` ใช้ IP ของ Windows จาก `ip route show default` หรือเปิด `networkingMode=mirrored` ใน `.wslconfig` และเพิ่ม host นั้นใน `ALLOWED_HOSTS` ของศูนย์ควบคุม

### 3.5 งานตามเวลา (cron) — ทางเลือก

Hermes มี scheduler ในตัว ส่งผลเข้า Telegram ได้เอง เช่นในแชต: `/cron add "weekdays at 9am" "ใช้ mcp_grock_create_job สั่งทีมสรุปข่าว AI ที่กระทบธุรกิจเราวันนี้ โปรเจกต์ newsroom แล้วรอผลด้วย mcp_grock_wait_job และสรุปให้ฉัน 5 บรรทัด"` หรือทาง CLI `hermes cron create "every monday 9am" "…"` (`deliver: telegram` / `telegram:<chat_id>`, ดู `hermes cron list`) — งาน cron ที่ยิงโจทย์ทุกวันกินงบรายวันของโทเคน ตั้ง `TOKEN_DAILY_USD` ให้สอดคล้อง และสร้างในโปรไฟล์ที่ต้องการเท่านั้น (cron ของแต่ละโปรไฟล์แยกกัน)

## 4. ตัวอย่างบทสนทนา

```
คุณ:     @ชื่อบอท ให้ทีม AI ช่วยวางแผนเปิดร้านกาแฟพิเศษย่านอารีย์ ใช้โปรเจกต์ myshop
          แบ่งเป็น วิจัยตลาด → แผนการตลาด → ประเมินการเงิน 12 เดือน

Hermes:  (ทักษะ grock-workforce ตรงเงื่อนไข "ให้ทีม AI" → เรียก mcp_grock_list_projects เห็น myshop · mcp_grock_list_agents มี res-1, mkt-1, fin-1)
         (เรียก mcp_grock_create_job goal="วางแผนเปิดร้านกาแฟพิเศษย่านอารีย์" project="myshop"
          requestedBy="telegram:@somchai"
          plan=[{title:"ค้นข้อมูลตลาดกาแฟพิเศษ", role:"researcher", brief:"…"},
                {title:"วางแผนการตลาด", role:"marketer", brief:"…", dependsOn:[0]},
                {title:"ประเมินการเงิน 12 เดือน", agentId:"fin-1", brief:"…", dependsOn:[1]}])
         รับโจทย์แล้ว jobId job-mvh2…  ทีมกำลังทำ 3 งาน (+QA) ผลจะส่งมาที่นี่เมื่อเสร็จ

  … ศูนย์ควบคุม: กัปตันรับแผน 3 งานจาก hermes ตรวจแล้วได้ 4 งานย่อย (เติม QA 1 งาน) → ต้น (นักวิจัย) → ริน (นักการตลาด)
    → ฟ้า (การเงิน) → ครูแก้ว (QA ให้ 84/100 ผ่าน) → กัปตันรวบรวมผล → result.md → webhook …

Hermes:  job.completed — วางแผนเปิดร้านกาแฟพิเศษย่านอารีย์
         ตลาดกาแฟพิเศษในกรุงเทพฯ โต ~12%/ปี กลุ่มเป้าหมายหลักคือพนักงานออฟฟิศอายุ 25–40 … จุดคุ้มทุนเดือนที่ 14 …
         💵 $0.42 · ⏱ 186 วินาที · ผู้ขอ telegram:@somchai
         📁 C:/Projects/MyShop/.grock/out/job-mvh2…/result.md

คุณ:     ขอดูส่วนการเงินฉบับเต็ม
Hermes:  (เรียก mcp_grock_job_result → อ่าน result แล้วคัดส่วน "ประเมินการเงิน 12 เดือน" มาตอบ)

คุณ:     ช่วยสรุปอีเมลลูกค้าเมื่อวาน        ← งานอื่นของ Hermes เดิม ไม่เข้าเงื่อนไขทักษะ → Hermes ทำเองตามปกติ ไม่สั่งทีม
```

ไม่ส่ง `plan` ก็ได้ ("ให้ทีมคิดแผนการตลาดเปิดตัวแอป") → กัปตันวางแผนเองเหมือนสั่งจากหน้าเว็บ

## 5. ข้อควรระวัง: ค่าใช้จ่าย สิทธิ์ และการไม่ปนกับงานอื่น

- **ทุกโจทย์ในโหมด live มีค่า API จริง** (กัปตันวางแผน + งานย่อย + QA + รวมผล; ส่งแผนมาเองประหยัดส่วนวางแผน) ชั้นป้องกันที่มี: `TOKEN_DAILY_USD` (ต่อโทเคน/วัน), `JOB_RATE_LIMIT` (ต่อ 10 นาที), `MAX_USD_PER_JOB` / `budget.maxUsdPerJob` ของโปรเจกต์ (ต่อโจทย์) และ `TOOL_MAX_USES` — ตั้งทั้งหมดก่อนให้ Hermes สั่งงานอัตโนมัติ (cron)
- Hermes เองก็ใช้โมเดล (ทุกข้อความ/ทุก webhook ที่ไม่ใช่ `deliver_only`) คิดค่าใช้จ่ายรวม 2 ฝั่ง
- **กันปนกับงานอื่น**: ทาง ก อาศัยทักษะ `grock-workforce` เป็นตัวกำหนดเงื่อนไข (ใช้เฉพาะเมื่อผู้ใช้สั่ง "ทีม AI/ศูนย์ควบคุม/grock") และ `requires_tools` ให้ทักษะโผล่เฉพาะเมื่อต่อ MCP สำเร็จ ถ้ายังกังวล (เช่นมี cron/ทักษะของงานอื่นที่อาจเรียกเครื่องมือทุกตัวที่เห็น) ให้ใช้ทาง ข ซึ่งแยก config/ความจำ/ทักษะ/cron ทั้งชุด · ห้ามใช้ `--clone` ตอนสร้างโปรไฟล์ถ้าไม่ต้องการลากบุคลิก/ความจำเดิมมา
- โทเคนสิทธิ์ `jobs` ลงทะเบียนโปรเจกต์ ตั้งค่าทีม สลับโหมด หรือ apply patch ไม่ได้ — ตั้งใจให้ Hermes "สั่งงานและอ่านผล" เท่านั้น งานแก้ไฟล์จริงของ Developer ยังต้องอนุมัติ patch บนแดชบอร์ด/CLI เหมือนเดิม
- โทเคนและ `WEBHOOK_SECRET` อยู่ใน `.env`/`config.yaml` ทั้งสองฝั่ง ห้ามพิมพ์ในแชต Telegram; `TELEGRAM_ALLOWED_USERS` ต้องตั้งเสมอ (Hermes ปฏิเสธทุกคนถ้าไม่ตั้ง) ใครคุยกับบอทได้ = สั่งงานที่เสียเงินได้
- `GET /api/state` ที่โทเคน `jobs` อ่านได้มีผลงานทุกโจทย์และรายชื่อโปรเจกต์ (พาธบนเครื่อง) — ให้โทเคนเฉพาะระบบที่ไว้ใจ และเปลี่ยนโทเคนได้ทันทีโดยแก้ `API_TOKENS` แล้วรีสตาร์ต
- webhook: ปลายทางรับได้เฉพาะ `JOB_WEBHOOK_URL` หรือ host ใน `WEBHOOK_ALLOWED_HOSTS`; ไม่ตั้ง `WEBHOOK_SECRET` ระบบจะส่งโดยไม่มีลายเซ็นและเตือนใน log — ปลายทางที่ไม่ตรวจลายเซ็นอาจถูกปลอมข้อความ "โจทย์เสร็จ" ได้
- ผ่านอินเทอร์เน็ต (Hermes อยู่คนละเครื่อง): ชี้ `GROCK_URL` ไปที่โดเมนใน `ALLOWED_HOSTS` (docs/10) โทเคน Bearer ใช้แทน Basic Auth ได้ และ webhook กลับมาต้องมีทางเข้าถึง Hermes (tunnel/LAN) — อย่าเปิดพอร์ต 8644 สาธารณะโดยไม่มี secret

## 6. ไม่ใช้ Hermes: บอท Telegram ต่อตรง (`tools/telegram-bot.mjs`)

สำหรับคนที่อยากสั่งงานจาก Telegram โดยไม่ติดตั้ง Hermes (ไม่มี "ผู้จัดการใหญ่" ที่คิดแผนให้ แต่กัปตันวางแผนเองอยู่แล้ว) — ไม่มี dependency, ใช้ long polling ไม่ต้องเปิดพอร์ตสาธารณะ ใช้บอท Telegram คนละตัวกับ Hermes

```ini
# .env ของศูนย์ควบคุม (เพิ่มจากข้อ 2.1)
TELEGRAM_BOT_TOKEN=123456789:ABC…
TELEGRAM_ALLOWED_USERS=123456789
GROCK_TOKEN=โทเคนใน API_TOKENS (สิทธิ์ jobs)
TELEGRAM_HOOK_PORT=3790                              # ไม่บังคับ: รับ webhook ที่ http://127.0.0.1:3790/webhooks/telegram
JOB_WEBHOOK_URL=http://127.0.0.1:3790/webhooks/telegram   # ให้ศูนย์ควบคุมส่งผลมาที่บอท (ถ้าไม่ตั้ง บอทจะถามสถานะเองทุก 20 วินาที)
```

```bash
npm run telegram
```

ในแชต: พิมพ์โจทย์ตรง ๆ (หรือ `@myshop โจทย์…` เพื่อระบุโปรเจกต์ครั้งเดียว), `/project myshop` ตั้งโปรเจกต์เริ่มต้นของแชต, `/projects`, `/agents`, `/status <jobId>`, `/result <jobId>`, `/jobs` — เมื่อโจทย์เสร็จบอทส่งสรุป + ต้นทุน + พาธ result.md กลับแชตเดิม (สถานะโจทย์ที่สั่งเก็บใน `data/telegram-bot.json`)

## 7. ทดสอบ

- `npm test` รวม `tools/tests/test-hermes.mjs` (unit: โทเคน/สิทธิ์/งบรายวัน, validateExternalPlan, ลายเซ็น/summary/retry ของ webhook) และ `tools/tests/e2e-hermes.mjs` (เซิร์ฟเวอร์ชั่วคราวโหมด sim บนพอร์ตว่าง + ปลายทาง webhook จำลอง + MCP server จริงผ่าน stdio: initialize → tools/list → create_job พร้อมแผน 3 งาน → wait_job → job_result, ตรวจลายเซ็น V1/V2, 401/403/400/429, ลองใหม่เมื่อปลายทางตอบ 503, โจทย์ล้มเหลว → `job.failed`) — เทสต์ไม่แตะ Hermes ของผู้ใช้เลย ใช้เฉพาะ MCP server ของเราผ่าน stdio
- ทดลองกับเซิร์ฟเวอร์จริงโดยไม่ต้องมี Hermes: `npm run mcp` แล้วพิมพ์ทีละบรรทัด

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_job","arguments":{"goal":"ทดสอบจาก MCP","requestedBy":"manual"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wait_job","arguments":{"jobId":"job-…","timeoutSec":300}}}
```
