# สั่งงานทีม AI ทาง Telegram ผ่าน Hermes Agent

Hermes Agent (Nous Research, https://github.com/NousResearch/hermes-agent) เป็นเอเจนต์ส่วนตัวที่คุยผ่าน Telegram ได้ ต่อ MCP server ได้ และรับ webhook ได้ เอกสารนี้ตั้งให้ Hermes เป็น **"ผู้จัดการใหญ่"**: รับคำสั่งจากคุณใน Telegram → ตัดสินใจว่าจะทำอะไร/โปรเจกต์ไหน/แบ่งงานอย่างไร → ส่งโจทย์ (พร้อมแผนถ้าต้องการ) เข้าศูนย์ควบคุมผ่าน MCP → ทีม AI ทำงานโดยกัปตันเลือกคน/ตรวจ QA/รวมผล → ศูนย์ควบคุมยิง webhook กลับ Hermes → Hermes ส่งสรุปเข้า Telegram

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
# ปลายทางแจ้งผลเมื่อโจทย์เสร็จ/ล้มเหลว (Hermes webhook route "grock" บนพอร์ต 8644)
JOB_WEBHOOK_URL=http://127.0.0.1:8644/webhooks/grock
# ลายเซ็น HMAC-SHA256 ของ webhook — ต้องตรงกับ secret ของ route ใน Hermes
WEBHOOK_SECRET=ใส่ค่าสุ่มยาว ๆ
# host ที่ยอมให้ส่ง webhookUrl มากับโจทย์ได้ (ไม่ตั้ง = รับเฉพาะ JOB_WEBHOOK_URL)
WEBHOOK_ALLOWED_HOSTS=127.0.0.1,localhost
```

รีสตาร์ตเซิร์ฟเวอร์ (`npm start` หรือ Task Scheduler "Grock Agent Server") แล้วดูบรรทัด `🎫 โทเคน API: hermes (jobs)` และ `📡 webhook แจ้งผล` ตอนเริ่ม

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

ข้อผิดพลาดจาก REST (400/401/403/429) กลับมาเป็นผลลัพธ์ `isError` พร้อมข้อความไทย เอเจนต์จะอ่านแล้วบอกผู้ใช้ได้

## 3. ตั้งค่า Hermes Agent

### 3.1 ติดตั้ง

- Windows (native, PowerShell): `iex (irm https://hermes-agent.nousresearch.com/install.ps1)` — ไฟล์ตั้งค่าอยู่ที่ `%LOCALAPPDATA%\hermes` (ในเอกสาร Hermes เรียกรวมว่า `~/.hermes/`)
- Linux / macOS / WSL2: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` → `~/.hermes/`
- จากนั้น `hermes setup` (เลือกโมเดล/ผู้ให้บริการ) และตั้ง "ตัวตน" ของผู้จัดการใหญ่ใน `~/.hermes/SOUL.md` (ช่องแรกของ system prompt) เช่น

```
คุณคือผู้จัดการใหญ่ของทีม AI ขององค์กร เมื่อผู้ใช้สั่งงานที่ต้องใช้ทีม (วิจัย/การตลาด/การเงิน/โค้ด/AI)
ให้ใช้เครื่องมือ mcp_grock_*: ดู mcp_grock_list_projects และ mcp_grock_list_agents ก่อน
แล้วสั่ง mcp_grock_create_job (ใส่ requestedBy เป็น telegram:@ชื่อผู้ใช้ และใส่ plan เมื่อผู้ใช้ระบุขั้นตอนชัดเจน)
ตอบ jobId ให้ผู้ใช้ทันที ไม่ต้องรอ — ผลจะถูกส่งกลับทาง webhook เอง ถ้าผู้ใช้ถามความคืบหน้าใช้ mcp_grock_job_status
ได้ 429 (เกินงบรายวัน) ให้แจ้งผู้ใช้ ห้ามลองซ้ำ
```

### 3.2 Telegram gateway

1. สร้างบอทกับ @BotFather (`/newbot`) ได้โทเคนรูปแบบ `123456789:ABC…`
2. หา user id ของคุณจาก @userinfobot (ไม่ใช่ username)
3. ใส่ใน `~/.hermes/.env`:

```ini
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_ALLOWED_USERS=123456789        # คั่นด้วย , ไม่ตั้ง = ปฏิเสธทุกคน
TELEGRAM_HOME_CHANNEL=123456789         # แชตที่รับผล cron/webhook เมื่อไม่ระบุ chat_id (หรือพิมพ์ /sethome ในแชต)
```

4. `hermes gateway setup` (เลือก Telegram) แล้ว `hermes gateway` (หรือ `hermes gateway start`) — ทักบอทแล้วควรตอบภายในไม่กี่วินาที คำสั่งที่ใช้บ่อย: `/help`, `/new`, `/sethome`, `/whoami`, `/model`

### 3.3 ลงทะเบียน MCP server ของศูนย์ควบคุม

ใน `~/.hermes/config.yaml` (Hermes ไม่ส่ง environment ของ shell ให้ stdio server ต้องใส่ `env` เอง):

```yaml
mcp_servers:
  grock:
    command: "node"
    args: ["C:\\Projects\\AI Agent\\Grock Agent\\tools\\mcp-server.mjs"]   # WSL2/Linux: ["/path/to/Grock Agent/tools/mcp-server.mjs"]
    env:
      GROCK_URL: "http://127.0.0.1:3789"
      GROCK_TOKEN: "โทเคน hermes จาก API_TOKENS"
    timeout: 900          # วินาทีต่อการเรียกเครื่องมือ (wait_job รอได้นาน)
    connect_timeout: 30
```

Hermes จะตั้งชื่อเครื่องมือเป็น `mcp_grock_<ชื่อ>` เช่น `mcp_grock_create_job` และรวมเป็น toolset `mcp-grock` · แก้ config แล้วพิมพ์ `/reload-mcp` ในแชต หรือรีสตาร์ต gateway · จำกัดเครื่องมือได้ด้วย `tools: { include: [create_job, wait_job, job_result, list_projects, list_agents, job_status] }`

ถ้า Hermes อยู่ใน WSL2 แต่ศูนย์ควบคุมอยู่บน Windows: `127.0.0.1` ใน WSL2 ไม่ใช่ Windows — ใช้ IP ของ Windows จาก `ip route show default` หรือเปิด `networkingMode=mirrored` ใน `.wslconfig` และเพิ่ม host นั้นใน `ALLOWED_HOSTS` ของศูนย์ควบคุมถ้า Host header ไม่ใช่ localhost

### 3.4 รับ webhook แล้วส่งเข้า Telegram

`~/.hermes/.env`:

```ini
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
```

`~/.hermes/config.yaml`:

```yaml
platforms:
  webhook:
    enabled: true
    extra:
      port: 8644
      routes:
        grock:                                  # → http://127.0.0.1:8644/webhooks/grock = JOB_WEBHOOK_URL ของศูนย์ควบคุม
          secret: "ค่าเดียวกับ WEBHOOK_SECRET"   # Hermes ตรวจ X-Webhook-Signature-V2 + X-Webhook-Timestamp (HMAC ของ <ts>.<body>) ให้เอง
          deliver: "telegram"
          deliver_extra:
            chat_id: "123456789"                # ไม่ใส่ = TELEGRAM_HOME_CHANNEL
          deliver_only: true                    # ส่งข้อความที่เรนเดอร์จาก prompt ตรง ๆ ไม่เรียกโมเดล (ไม่เสียโทเคน)
          prompt: |
            {event} — {goal}
            {summary}
            💵 ${costUsd} · ⏱ {durationSec} วินาที · ผู้ขอ {requestedBy}
            📁 {resultPath}
```

- `{ฟิลด์}` อ้างคีย์ใน payload ของเรา (จุดสำหรับคีย์ซ้อน, `{__raw__}` = ทั้ง payload) คีย์ที่ไม่มีจะคงเป็นข้อความ `{คีย์}`
- อยากให้ Hermes "อ่านผลแล้วสรุปเอง" ก่อนส่ง (เสียโทเคนของ Hermes): ตัด `deliver_only` ออก แล้วเขียน prompt เป็นคำสั่ง เช่น `สรุปผลโจทย์นี้ให้ผู้ใช้ใน 5 บรรทัด: {__raw__}` และจะให้ Hermes เรียก `mcp_grock_job_result` อ่านฉบับเต็มก่อนก็ได้
- ตรวจว่า route ขึ้นแล้ว: `curl http://127.0.0.1:8644/health` → `{"status":"ok","platform":"webhook"}` · ทดสอบจากศูนย์ควบคุมด้วยโจทย์สั้น ๆ ในโหมด sim (`MODE=sim`) ก่อนใช้ live
- พอร์ต 8644 ควรฟังเฉพาะในเครื่อง/LAN — ไม่ต้องเปิดออกอินเทอร์เน็ต ศูนย์ควบคุมส่งจากเครื่องเดียวกัน (หรือ LAN เดียวกัน)

### 3.5 งานตามเวลา (cron) — ทางเลือก

Hermes มี scheduler ในตัว ส่งผลเข้า Telegram ได้เอง เช่นในแชต: `/cron add "weekdays at 9am" "ใช้ mcp_grock_create_job สั่งทีมสรุปข่าว AI ที่กระทบธุรกิจเราวันนี้ โปรเจกต์ newsroom แล้วรอผลด้วย mcp_grock_wait_job และสรุปให้ฉัน 5 บรรทัด"` หรือทาง CLI `hermes cron create "every monday 9am" "…"` (`deliver: telegram` / `telegram:<chat_id>`, ดู `hermes cron list`) — งาน cron ที่ยิงโจทย์ทุกวันกินงบรายวันของโทเคน ตั้ง `TOKEN_DAILY_USD` ให้สอดคล้อง

## 4. ตัวอย่างบทสนทนา

```
คุณ:     @ชื่อบอท ช่วยวางแผนเปิดร้านกาแฟพิเศษย่านอารีย์ ใช้โปรเจกต์ myshop
          แบ่งเป็น วิจัยตลาด → แผนการตลาด → ประเมินการเงิน 12 เดือน

Hermes:  (เรียก mcp_grock_list_projects → เห็น myshop · mcp_grock_list_agents → มี res-1, mkt-1, fin-1)
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
```

ไม่ส่ง `plan` ก็ได้ ("ช่วยคิดแผนการตลาดเปิดตัวแอป") → กัปตันวางแผนเองเหมือนสั่งจากหน้าเว็บ

## 5. ข้อควรระวัง: ค่าใช้จ่ายและสิทธิ์

- **ทุกโจทย์ในโหมด live มีค่า API จริง** (กัปตันวางแผน + งานย่อย + QA + รวมผล; ส่งแผนมาเองประหยัดส่วนวางแผน) ชั้นป้องกันที่มี: `TOKEN_DAILY_USD` (ต่อโทเคน/วัน), `JOB_RATE_LIMIT` (ต่อ 10 นาที), `MAX_USD_PER_JOB` / `budget.maxUsdPerJob` ของโปรเจกต์ (ต่อโจทย์) และ `TOOL_MAX_USES` — ตั้งทั้งหมดก่อนให้ Hermes สั่งงานอัตโนมัติ (cron)
- Hermes เองก็ใช้โมเดล (ทุกข้อความ/ทุก webhook ที่ไม่ใช่ `deliver_only`) คิดค่าใช้จ่ายรวม 2 ฝั่ง
- โทเคนสิทธิ์ `jobs` ลงทะเบียนโปรเจกต์ ตั้งค่าทีม สลับโหมด หรือ apply patch ไม่ได้ — ตั้งใจให้ Hermes "สั่งงานและอ่านผล" เท่านั้น งานแก้ไฟล์จริงของ Developer ยังต้องอนุมัติ patch บนแดชบอร์ด/CLI เหมือนเดิม
- โทเคนและ `WEBHOOK_SECRET` อยู่ใน `.env` ทั้งสองฝั่ง ห้ามพิมพ์ในแชต Telegram; `TELEGRAM_ALLOWED_USERS` ต้องตั้งเสมอ (Hermes ปฏิเสธทุกคนถ้าไม่ตั้ง) ใครคุยกับบอทได้ = สั่งงานที่เสียเงินได้
- `GET /api/state` ที่โทเคน `jobs` อ่านได้มีผลงานทุกโจทย์และรายชื่อโปรเจกต์ (พาธบนเครื่อง) — ให้โทเคนเฉพาะระบบที่ไว้ใจ และเปลี่ยนโทเคนได้ทันทีโดยแก้ `API_TOKENS` แล้วรีสตาร์ต
- webhook: ปลายทางรับได้เฉพาะ `JOB_WEBHOOK_URL` หรือ host ใน `WEBHOOK_ALLOWED_HOSTS`; ไม่ตั้ง `WEBHOOK_SECRET` ระบบจะส่งโดยไม่มีลายเซ็นและเตือนใน log — ปลายทางที่ไม่ตรวจลายเซ็นอาจถูกปลอมข้อความ "โจทย์เสร็จ" ได้
- ผ่านอินเทอร์เน็ต (Hermes อยู่คนละเครื่อง): ชี้ `GROCK_URL` ไปที่โดเมนใน `ALLOWED_HOSTS` (docs/10) โทเคน Bearer ใช้แทน Basic Auth ได้ และ webhook กลับมาต้องมีทางเข้าถึง Hermes (tunnel/LAN) — อย่าเปิดพอร์ต 8644 สาธารณะโดยไม่มี secret

## 6. ไม่ใช้ Hermes: บอท Telegram ต่อตรง (`tools/telegram-bot.mjs`)

สำหรับคนที่อยากสั่งงานจาก Telegram โดยไม่ติดตั้ง Hermes (ไม่มี "ผู้จัดการใหญ่" ที่คิดแผนให้ แต่กัปตันวางแผนเองอยู่แล้ว) — ไม่มี dependency, ใช้ long polling ไม่ต้องเปิดพอร์ตสาธารณะ

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

- `npm test` รวม `tools/tests/test-hermes.mjs` (unit: โทเคน/สิทธิ์/งบรายวัน, validateExternalPlan, ลายเซ็น/summary/retry ของ webhook) และ `tools/tests/e2e-hermes.mjs` (เซิร์ฟเวอร์ชั่วคราวโหมด sim บนพอร์ตว่าง + ปลายทาง webhook จำลอง + MCP server จริงผ่าน stdio: initialize → tools/list → create_job พร้อมแผน 3 งาน → wait_job → job_result, ตรวจลายเซ็น V1/V2, 401/403/400/429, ลองใหม่เมื่อปลายทางตอบ 503, โจทย์ล้มเหลว → `job.failed`)
- ทดลองกับเซิร์ฟเวอร์จริงโดยไม่ต้องมี Hermes: `npm run mcp` แล้วพิมพ์ทีละบรรทัด

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_job","arguments":{"goal":"ทดสอบจาก MCP","requestedBy":"manual"}}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wait_job","arguments":{"jobId":"job-…","timeoutSec":300}}}
```
