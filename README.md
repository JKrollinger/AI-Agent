# AI Workforce Control Center — ศูนย์ควบคุมพนักงาน AI

ต้นแบบระบบ "องค์กรที่มี AI ทำงาน" ที่ได้แรงบันดาลใจจากสถาปัตยกรรม multi-agent ของ Grok (xAI):
กัปตัน (Project Manager) 1 คนรับโจทย์ แตกงาน มอบหมายให้ทีมผู้เชี่ยวชาญ 6 ตำแหน่ง (การตลาด, วิจัย, การเงิน/กลยุทธ์, วิศวกร AI, นักพัฒนา, QA & Compliance) ทำงานคู่ขนาน ส่งต่องานกันได้
มี QA ตรวจคุณภาพและส่งกลับแก้ และมี **หน้าเว็บเดียว** ที่เห็นทุกอย่างสด ๆ เป็นแอนิเมชัน พร้อมตัวชี้วัดและปุ่มควบคุม

![ภาพรวม](docs/screenshot-overview.jpg)

## ฉากออฟฟิศ 3 มิติ — เห็นทีม AI ทำงานจริงในออฟฟิศ

- ทีม 7 ตำแหน่งในร่างคน 3 มิติ (three.js + ตัวละคร Mixamo): **ผู้จัดการโครงการ** (กัปตัน) นั่งในห้องผู้จัดการกระจก · นักการตลาด · นักวิจัย · วิศวกร AI · นักวิเคราะห์การเงิน · นักพัฒนา · ผู้ตรวจคุณภาพ ที่โต๊ะทำงานของตัวเอง — เปลี่ยนชื่อ/ชื่อเล่นได้จากหน้าเว็บ (⚙ ตั้งค่า AI → บันทึกลง `data/team.json`) หรือค่าเริ่มต้นใน `server/agents.js` และตั้งชื่อเฉพาะโปรเจกต์ได้ใน `.grock/project.json` (`roles.<ตำแหน่ง>.name`) — การมอบหมายใช้ id + ตำแหน่ง + หน้าที่ ไม่ใช้ชื่อ
- **ทุกการเคลื่อนไหวมาจากเหตุการณ์จริง** ไม่มีพฤติกรรมสุ่มระหว่างมีโจทย์: กัปตันเดินไปปักกระดาษงานบนบอร์ดประจำโต๊ะผู้รับแล้วกลับ · ผู้รับนั่งทำทันที (ท่าพิมพ์ / อ่านจอเมื่อค้นเว็บ / พิมพ์เร็วเมื่อรันโค้ด / คิด) · เสร็จแล้วเดินไปส่งผลงานที่ห้องผู้จัดการ · QA ส่งกลับ → "แก้รอบที่ N" · ส่งต่อ → คนส่งเดินไปโต๊ะคนรับ · กัปตันเข้าห้องประชุมตอนวางแผน นั่งเขียนสรุปตอนรวบรวมผล · โจทย์เสร็จทั้งทีมดีใจ
- **จอคอมบนโต๊ะแสดงสิ่งที่กำลังพิมพ์สด ๆ** แตะจอ (หรือปุ่ม 🖥️ ใน drawer) เปิด "หน้าจอการทำงานจริง": ข้อความที่สตรีม เครื่องมือที่ใช้ (คำค้น/URL/คำสั่ง → ผล) ผลตรวจ QA และผลงาน · แตะตัวละคร = กล้องซูมเข้าโต๊ะ + เปิดรายละเอียด · ลากซ้ายหมุน ลากขวาเลื่อน ล้อซูม ปุ่ม "⟲ มุมกล้อง" กลับมุมเดิม
- แผงรายชื่อทีมซ้าย (สถานะ · % · เสร็จวันนี้ · เครื่องมือ) การ์ดงานล่าสุดพร้อมไทม์ไลน์ 5 ขั้น และปุ่ม "⚙ ตั้งค่า AI" เลือกโมเดล/ความลึก/เครื่องมือต่อคน
- **รูปแทนตัวทุกที่เป็นใบหน้าตัวละคร 3 มิติของแต่ละคน** — ฉากเรนเดอร์ภาพศีรษะจากโมเดลให้เอง หรือวางภาพเองที่ `public/office3d/portraits/<jobId>.png` (ไม่มีทั้งสองอย่าง = อีโมจิประจำตำแหน่งเดิม) ดู [docs/09-office3d.md §8](docs/09-office3d.md)
- ไฟล์โมเดล (`public/office3d/models/`, ~40 MB) ไม่อยู่ใน git — คู่มือฉาก, ตาราง event → การเคลื่อนไหว, API และวิธีวาง/แปลงไฟล์: [docs/09-office3d.md](docs/09-office3d.md) · เปิดฉากเดี่ยว ๆ ได้ที่ `/office3d/index.html`

## สิ่งที่ทำได้

- **เห็นว่า AI แต่ละตัวกำลังทำอะไร** — ชื่องาน เฟสที่กำลังทำ % ความคืบหน้า และข้อความที่กำลังพิมพ์ (สด)
- **แอนิเมชันเรียลไทม์** — ก้อนงานวิ่งจากกัปตันไปหาพนักงาน วิ่งระหว่างพนักงานเมื่อส่งต่อ และวิ่งกลับเมื่อเสร็จ
- **ส่งต่องาน (handoff)** — อัตโนมัติเมื่อ QA ไม่ผ่าน หรือสั่งเองจากหน้าเว็บ (เลือกคนรับ + เหตุผล)
- **ควบคุมได้ในหน้าเดียว** — มอบหมายโจทย์, หยุด/ให้พนักงานกลับมาทำงาน, ยกเลิก/ทำใหม่, ปรับความเร็วจำลอง, สลับโหมด SIM/LIVE
- **พนักงานมีเครื่องมือจริง (server tools ของ Claude)** — นักวิจัยค้นเว็บ/อ่านหน้าเว็บ นักวิเคราะห์และนักพัฒนารันโค้ดใน sandbox QA เปิดตรวจแหล่งอ้างอิง
  เห็นไอคอน 🔎 🌐 ⚙️ ใต้ป้ายงานบนแผนผังขณะใช้ และนับจำนวนครั้งต่อคน/ต่องาน (โหมด `sim` จำลองให้ดูได้โดยไม่ต้องมี key)
- **วัดผล** — งานเสร็จ/ล้มเหลว, เวลาเฉลี่ย, อัตราใช้งาน, โทเคน/ต้นทุน, คะแนนคุณภาพจาก QA, จำนวนส่งต่อ, จำนวนครั้งที่ใช้เครื่องมือ ต่อคนและต่อโจทย์
- **บันทึกทุกเหตุการณ์** ลง `logs/events.jsonl` เพื่อทำรายงานย้อนหลัง
- **2 โหมด** — `sim` จำลองการทำงาน (ใช้ได้ทันที ไม่ต้องมี key) และ `live` เรียก Claude จริงผ่าน Anthropic SDK

## เริ่มใช้งาน

ต้องมี Node.js 22.9 ขึ้นไป (ทดสอบบน Node 24)

```bash
npm install
npm start
```

เปิด http://127.0.0.1:3789 แล้วกด **"ลองงานตัวอย่าง"** หรือพิมพ์โจทย์ของคุณเองแล้วกด **"มอบหมายงาน"**

### โหมด LIVE (เรียก Claude จริง)

```bash
copy .env.example .env
```

ใส่ `ANTHROPIC_API_KEY=...` ในไฟล์ `.env` แล้ว `npm start` ใหม่ ระบบจะขึ้นป้าย **LIVE** เอง
(ค่าเริ่มต้น: กัปตันและ QA ใช้ `claude-opus-5-5`, ทีมงานใช้ `claude-sonnet-5-5` ปรับได้ใน `.env`)

ในโหมด LIVE พนักงานแต่ละตำแหน่งมี **server tools ของ Claude** (รันบนฝั่ง Anthropic ไม่ต้องตั้งค่าอะไรเพิ่ม):

| ตำแหน่ง | เครื่องมือ |
|---|---|
| นักวิจัย | `web_search` + `web_fetch` (อย่างละไม่เกิน `TOOL_MAX_USES` ครั้งต่องาน ค่าเริ่มต้น 5) |
| นักวิเคราะห์ / นักพัฒนา | `code_execution` (Python/Bash ใน sandbox ไม่มีอินเทอร์เน็ต) |
| QA | `web_fetch` (เปิดตรวจ URL ที่ผลงานอ้างอิง ไม่เกิน 3 ครั้ง) |
| นักเขียน / กัปตัน | ไม่ใช้เครื่องมือ |

- ปิดเครื่องมือทั้งหมดด้วย `TOOLS_ENABLED=0` ใน `.env`
- ถ้าโมเดลใช้เครื่องมือหลายรอบจน API ตอบ `pause_turn` ระบบจะต่อ turn ให้เองอัตโนมัติ (สูงสุด 5 รอบ)
- ขณะใช้เครื่องมือ dashboard จะขึ้นเฟส "กำลังค้นเว็บ: …" / "กำลังอ่านหน้าเว็บ: …" / "กำลังรันโค้ด" พร้อมไอคอนใต้ป้ายงาน และนับใน "ใช้เครื่องมือ"

ต้นทุนต่อโจทย์ในโหมด LIVE แสดงสดบน dashboard (คำนวณจาก usage จริง × ราคาต่อล้านโทเคน + ค่า web search $10 ต่อ 1,000 ครั้ง)

> หมายเหตุ: โค้ดฝั่ง LIVE ทดสอบกับ API จำลอง (SSE) แล้วว่าส่ง `tools`, จับ event เครื่องมือ และต่อ `pause_turn` ถูกต้อง
> แต่ยังไม่ได้ทดสอบกับ API จริง เพราะเครื่องที่พัฒนาไม่มี `ANTHROPIC_API_KEY`

## วิธีใช้หน้าเว็บ

| ส่วน | ใช้ทำอะไร |
|---|---|
| แถบบน | พิมพ์โจทย์ → มอบหมายงาน / ลองงานตัวอย่าง · KPI รวม · ป้ายโหมด (คลิกเพื่อสลับ) |
| ฉากออฟฟิศ 3 มิติ (กลาง) | ตัวละครทำงาน/เดินตามเหตุการณ์จริง ป้ายเหนือหัว = ชื่องาน เฟส % เครื่องมือ · จอคอมแสดงข้อความสด · คลิกตัวละคร = ซูมเข้าโต๊ะ + เปิดแผงควบคุม · คลิกจอ = หน้าจอการทำงานจริง · ลาก/ล้อ = หมุน/เลื่อน/ซูม |
| แผงควบคุม (drawer) | หยุด/ให้กลับมาทำงาน · ส่งต่องานให้คนอื่น · ยกเลิกงาน · ดูข้อความที่กำลังพิมพ์สด · หน้าที่ของคนนั้น · ตัวชี้วัดรายคน (รวม "ใช้เครื่องมือ" และเครื่องมือประจำตำแหน่ง) |
| ⚙ ตั้งค่า AI | ตั้ง **ชื่อ/ชื่อเล่น** ของแต่ละคนได้เอง (เปลี่ยนทันทีบนการ์ดงาน แผงรายชื่อ ป้ายในฉาก 3 มิติ และใน prompt — การมอบหมายใช้ id/ตำแหน่ง/หน้าที่ จึงไม่กระทบ) · กำหนด **หน้าที่** ของแต่ละคน (กัปตันใช้เลือกคนทำงาน และ AI เห็นหน้าที่ใน prompt) · โมเดล · ความลึกการคิด · เปิด/ปิดเครื่องมือ — บันทึกลง `data/team.json` ใช้ต่อหลังรีสตาร์ต |
| แท็บ "งาน" | งานทุกชิ้นแยกตามโจทย์ พร้อมสถานะ ผู้รับ รอบที่ทำ คะแนน QA จำนวนครั้งที่ใช้เครื่องมือ · คลิกการ์ดเพื่อดูรายละเอียด/ส่งต่อ/ทำใหม่ |
| แท็บ "ตัวชี้วัด" | สรุปรวม + การ์ดรายคน (งานเสร็จ เวลาเฉลี่ย ใช้งาน% โทเคน ต้นทุน คุณภาพ ส่งต่อ ใช้เครื่องมือ) |
| แท็บ "บันทึก" | เหตุการณ์ทั้งหมดเป็นภาษาไทย ใหม่สุดอยู่บน |
| แท็บ "ผลงาน" | ผลลัพธ์สุดท้ายของแต่ละโจทย์ คัดลอกได้ |

## ใช้งานกับโปรเจกต์อื่น (Project Pack)

ให้ทีม AI ทำงานให้โปรเจกต์ของคุณโดยอ่านเอกสารของโปรเจกต์นั้น (README/CLAUDE.md/docs) และเขียนผลงานกลับเข้าโฟลเดอร์โปรเจกต์ เริ่มจากแม่แบบ `.grock/` สำเร็จรูปตามประเภทโปรเจกต์ (generic, webapp, marketing, research, data, business):

```bash
node tools/grock.mjs templates                                        # ดูแม่แบบทั้งหมด
node tools/grock.mjs init "C:\Projects\MyShop" --id myshop --template webapp
node tools/grock.mjs doctor myshop                                    # ตรวจว่า brief/ไฟล์/งบ พร้อมหรือยัง
```

แก้ `C:\Projects\MyShop\.grock\brief.md` ให้ตรงกับโปรเจกต์ (แม่แบบตั้งตำแหน่งที่ใช้ โมเดล QA งบ และทักษะเฉพาะประเภทให้แล้ว) แล้วสั่งงาน (จากโฟลเดอร์ไหนก็ได้ หรือจาก Claude Code ที่เปิดอยู่ในโปรเจกต์นั้น):

```bash
node tools/grock.mjs run "เขียนแผนทดสอบสำหรับโมดูลชำระเงิน" --project myshop --wait
```

ผลงานอยู่ที่ `<โปรเจกต์>/.grock/out/<jobId>/result.md` (และ `latest.md`) หรือเลือกโปรเจกต์จากช่องข้างปุ่ม "มอบหมายงาน" บนหน้าเว็บ รายละเอียดการตั้งค่าต่อโปรเจกต์ (ไฟล์ที่ให้อ่าน ตำแหน่งที่ใช้ได้ โมเดล/หน้าที่/ทักษะเฉพาะโปรเจกต์ งบ) อยู่ใน [docs/07-projects.md](docs/07-projects.md) และวิธีประยุกต์กับโปรเจกต์แต่ละประเภททีละขั้น (เลือกแม่แบบ ปรับ brief จำกัดตำแหน่ง ตั้งงบ สั่งจาก Claude Code อ่านผล) อยู่ใน [docs/08-playbook.md](docs/08-playbook.md)

### ให้ Developer แก้ไฟล์จริง (ผ่าน Claude Code headless + ด่านอนุมัติ)

ค่าเริ่มต้นทีมแค่ "เสนอ" ไม่แตะไฟล์ ถ้าต้องการให้ Developer (`dev-1`) แก้โค้ดในโปรเจกต์จริง ให้เพิ่มสิทธิ์ใน `.grock/project.json` ของโปรเจกต์นั้น:

```json
"permissions": { "dev-1": { "write": ["src/**", "tests/**"], "deny": [".env*"], "tools": ["Edit", "Write", "Bash(npm test)"], "maxUsd": 5 } }
```

- งานของ Developer จะรัน `claude -p` ใน **สำเนา** ของโปรเจกต์ (sandbox ใน temp ไม่มี .git/node_modules/ไฟล์ค่าลับ) โดยจำกัดเครื่องมือ/งบ/เวลา แล้วสรุปเป็น patch ที่ `.grock/out/<jobId>/patches/` — ไฟล์จริงยังไม่ถูกแตะ
- การ์ดงานบน dashboard ขึ้น "🩹 รออนุมัติ" พร้อมปุ่ม **Apply เข้าโปรเจกต์** / **ปฏิเสธ** (หรือ `node tools/grock.mjs patches` · `apply <taskId>` · `reject <taskId>`) ตอน apply ระบบตรวจ sha256 ของ patch, สิทธิ์ล่าสุด, ทุก path, `git apply --check` และเทียบบรรทัดต้นฉบับแบบไบต์ต่อไบต์ก่อนเขียน
- ทุกขั้นมีบันทึกใน `task.history`, `logs/events.jsonl`, `job.json` และ `patches/*.json` · โหมด `sim` จำลอง patch ที่ apply ได้จริงเพื่อทดสอบ flow โดยไม่เสียเงิน · ไม่มี `claude` CLI หรือไม่ให้สิทธิ์ → ทำแบบข้อเสนอเหมือนเดิมพร้อม log บอกเหตุผล (ตั้ง `CLAUDE_BIN` ใน `.env` ถ้า `claude` ไม่อยู่ใน PATH)
- รายละเอียดสิทธิ์ ด่านอนุมัติ audit และข้อจำกัด: [docs/07-projects.md §5](docs/07-projects.md)

ทดสอบทั้งชุด (unit + e2e ในโหมด sim กับโปรเจกต์ชั่วคราวใน temp ไม่เรียก API จริง): `npm test` — เฉพาะ unit: `npm run test:unit` · เฉพาะ e2e: `npm run test:e2e` · บางไฟล์: `node tools/tests/run.mjs templates` (ทุกชุดรวมเทสต์แม่แบบ `test-templates`/`e2e-templates` ด้วย)

## เปิดใช้งานจากอินเทอร์เน็ต (Cloudflare Tunnel)

รันเซิร์ฟเวอร์บนเครื่องคุณตามเดิม แล้วให้ Cloudflare Tunnel เปิดทางเข้าจากอินเทอร์เน็ตพร้อม HTTPS โดยไม่ต้องเปิดพอร์ตที่เราเตอร์ — โปรเจกต์บนดิสก์และ Developer แก้ไฟล์จริงยังใช้ได้เหมือนเดิม ตั้งใน `.env` ก่อน:

```ini
AUTH_PASSWORD=รหัสผ่านของคุณ        # ทุกหน้า/API/SSE ถามรหัส (HTTP Basic Auth, ผู้ใช้ AUTH_USER ค่าเริ่มต้น admin)
ALLOWED_HOSTS=.trycloudflare.com    # โดเมนที่ยอมให้เรียกเข้ามา (คั่นด้วย ,) ขึ้นต้นด้วย . = ทุกโดเมนย่อย
JOB_RATE_LIMIT=20                   # โจทย์จากภายนอกสูงสุดต่อ 10 นาที
```

แล้วเปิด 2 เทอร์มินัล:

```bash
npm start
```

```bash
npm run tunnel   # = cloudflared tunnel --url http://127.0.0.1:3789 → พิมพ์ https://<คำสุ่ม>.trycloudflare.com ให้
```

คำขอจากภายนอกลงทะเบียนโปรเจกต์ใหม่ไม่ได้ (ทำที่เครื่องเท่านั้น) ใช้โดเมนของตัวเอง, รันเป็น Windows service, เพิ่มชั้นล็อกอิน Cloudflare Access และข้อควรระวัง: [docs/10-deploy-tunnel.md](docs/10-deploy-tunnel.md)

### ใช้งานออนไลน์เต็มรูปแบบ: ล็อกอินด้วยโทเคน · ผลงานขึ้นคลาวด์ · สถานะถาวร · branch ขึ้น GitHub

```ini
AUTH=token
DASHBOARD_TOKEN=<node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))">   # หน้า /login → คุกกี้ HttpOnly หรือ Authorization: Bearer
STORAGE_PROVIDER=s3            # Cloudflare R2 / S3 / MinIO — ผลงานทุกโจทย์ขึ้น <S3_PREFIX>/<projectId>/<jobId>/ (ลองใหม่ 3 ครั้ง ไม่บล็อกทีม)
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_BUCKET=grock-results
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
```

- **ล็อกอิน** (`server/auth.js`): ทุกหน้า/API/SSE ต้องมีคุกกี้จากหน้า `/login` หรือ Bearer `DASHBOARD_TOKEN`; เดาผิดเกิน `LOGIN_MAX_FAILS` ต่อ IP → 429; `HOST` ไม่ใช่ localhost หรือมี `ALLOWED_HOSTS` โดยไม่มีล็อกอิน → **ไม่ยอมสตาร์ต**; Basic Auth เดิมยังใช้ได้
- **ผลงานบนคลาวด์** (`server/storage.js`): SigV4 เขียนเองด้วย `node:crypto` (ไม่เพิ่ม dependency) ผลอยู่ใน `job.json` → `storage: { uploaded, url, error }` และชิป ☁️ + ลิงก์บนแท็บผลงาน; โจทย์ไม่มีโปรเจกต์ขึ้นใต้ `workspace/`
- **สถานะถาวร** (`server/state-db.js`): SQLite `data/state.db` (node:sqlite) write-through — รีสตาร์ตแล้วโจทย์เก่า/ผลงาน/ตัวชี้วัดยังอยู่ โจทย์ที่ค้างถูกทำเครื่องหมายล้มเหลวพร้อมเหตุผล
- **โค้ดขึ้น GitHub** (`server/gitpush.js`): โปรเจกต์ที่ตั้ง `"git": { "pushBranch": true, "remote": "origin" }` ใน `.grock/project.json` → โจทย์เสร็จแล้วรอคุณกด **Push** บนแท็บผลงาน → branch `grock/<jobId>` (เฉพาะไฟล์ผลงาน หรือ HEAD + patch ที่อนุมัติแล้ว) push ด้วย git ของเครื่อง ไม่เก็บโทเคน
- รันบน VPS/Railway ด้วย `Dockerfile` + `docker-compose.yml` (volume `/app/data`) — ทั้งหมดใน [docs/10-online.md](docs/10-online.md)

## สั่งงานทาง Telegram ผ่าน Hermes Agent

ให้ [Hermes Agent](https://github.com/NousResearch/hermes-agent) เป็น "ผู้จัดการใหญ่": คุณสั่งใน Telegram → Hermes ส่งโจทย์ (พร้อมแผนก็ได้) เข้าศูนย์ควบคุมผ่าน MCP server (`npm run mcp`, `tools/mcp-server.mjs`) ด้วยโทเคนสิทธิ์จำกัด (`API_TOKENS=hermes:โทเคน:jobs`) → ทีมทำงาน กัปตันเลือกคน/QA/รวมผล → โจทย์เสร็จแล้วศูนย์ควบคุมยิง webhook (`JOB_WEBHOOK_URL`, ลายเซ็น HMAC `WEBHOOK_SECRET`) กลับ Hermes → สรุปเข้า Telegram งบรายวันต่อโทเคน `TOKEN_DAILY_USD` (ค่าเริ่มต้น $5) ไม่ใช้ Hermes ก็มี `npm run telegram` (บอทต่อตรง) ขั้นตอนทั้งหมด: [docs/11-hermes.md](docs/11-hermes.md)

## REST API (ใช้ต่อกับระบบอื่นได้)

การยืนยันตัว: คุกกี้จากหน้า `/login` หรือ `Authorization: Bearer <DASHBOARD_TOKEN>` (โหมด `AUTH=token`), HTTP Basic Auth (`AUTH_USER`/`AUTH_PASSWORD`) หรือ `Authorization: Bearer <โทเคน>` จาก `API_TOKENS=ชื่อ:โทเคน:สิทธิ์` (สิทธิ์ `jobs` = สั่ง/ดูโจทย์ + `/api/state` `/api/projects` `/api/projects/:id/context` `/api/agents` เท่านั้น, `admin` = ทุกอย่าง; บังคับแม้เรียกจาก localhost)

| Method | Path | ใช้ทำอะไร |
|---|---|---|
| GET | `/api/state` | snapshot ทั้งระบบ |
| GET | `/api/events` | SSE stream เหตุการณ์สด |
| GET | `/api/logs?limit=200` | บันทึกย้อนหลัง |
| GET | `/api/health` | สถานะเซิร์ฟเวอร์/โหมด |
| POST | `/api/jobs` `{goal, project?, files?, plan?, requestedBy?, webhookUrl?}` | มอบหมายโจทย์ใหม่ (ตอบ 202 ทันที กัปตันวางแผนต่อเบื้องหลัง; `project` = id ของ Project Pack; `plan` = แผนจากภายนอก ≤ 12 งาน `[{title, role\|agentId, brief, dependsOn?}]` กัปตันใช้แทนวางแผนเองแต่ยังเติม QA/เลือกคน; `requestedBy` แสดงบนการ์ด; `webhookUrl` ปลายทางแจ้งผลเฉพาะโจทย์ — host ต้องอยู่ใน `WEBHOOK_ALLOWED_HOSTS`) · เกินงบรายวันของโทเคน → 429 |
| GET | `/api/jobs?limit=50&status=done` | รายการโจทย์ล่าสุด (ไม่รวมผลลัพธ์เต็ม) |
| GET | `/api/agents` | รายชื่อทีม + ตำแหน่ง + หน้าที่ + สถานะ (เลือก `role`/`agentId` ตอนส่งแผน) |
| — | webhook ขาออก | โจทย์เสร็จ/ล้มเหลว → POST `{jobId, status, goal, project, summary, resultPath, costUsd, durationSec, requestedBy, …}` ไป `JOB_WEBHOOK_URL` หัว `X-Grock-Signature: sha256=<HMAC>` (+ `X-Webhook-Signature-V2` แบบ Hermes) ลองใหม่ 3 ครั้ง — [docs/11](docs/11-hermes.md) |
| POST | `/api/demo` | มอบหมายโจทย์ตัวอย่าง |
| POST | `/api/tasks/:id/handoff` `{agentId, reason}` | ส่งต่องาน |
| POST | `/api/tasks/:id/retry` · `/cancel` | ทำใหม่ / ยกเลิก |
| POST | `/api/tasks/:id/apply` `{note}` · `/reject` `{reason}` | อนุมัติ (git apply --check → เขียนไฟล์จริง) / ปฏิเสธ patch ของ Developer |
| POST | `/api/jobs/:id/push` `{note}` · `/push/reject` `{reason}` | อนุมัติ push ผลงานเป็น branch `grock/<jobId>` ไป remote ของโปรเจกต์ (202, ผลมาทาง event `job.git`) / ไม่ push — สิทธิ์ `admin` เท่านั้น — [docs/10-online](docs/10-online.md) |
| GET/POST | `/login` · POST `/logout` | หน้าล็อกอินโหมด `AUTH=token` (ฟอร์มหรือ JSON `{token}` → คุกกี้ `grock_session`) / ลบคุกกี้ |
| GET | `/api/tasks/:id/patch` | diff ฉบับเต็มของ patch |
| POST | `/api/agents/:id/pause` · `/resume` | หยุด / ให้กลับมาทำงาน |
| POST | `/api/agents/:id/config` `{name, nick, duties, model, effort, toolsEnabled}` | ตั้งค่าต่อคน (หน้าที่/โมเดล/ความลึก/เครื่องมือ) บันทึกลง `data/team.json` |
| GET | `/api/jobs/:id` | รายละเอียดโจทย์ + งานย่อย (สคริปต์ภายนอกใช้ติดตามผล) |
| GET/POST | `/api/projects` | รายชื่อ / ลงทะเบียนโปรเจกต์ (Project Pack) `{id, path}` |
| GET | `/api/projects/:id/context?role=coder&tokens=1` | ดูบริบทที่เอเจนต์จะเห็น (ใช้ได้ในโหมด sim, `tokens=1` นับโทเคนจริงเมื่อมี key) |
| POST | `/api/projects/reload` | โหลด .grock/ ของทุกโปรเจกต์ใหม่ |
| POST | `/api/settings` `{speed, autoAssign}` | ความเร็วจำลอง / เปิด-ปิดการมอบหมายอัตโนมัติ |
| POST | `/api/mode` `{mode}` | สลับ `sim` / `live` |

## โครงสร้างโปรเจกต์

```
server/   orchestrator (กัปตัน), executor (sim/live), llm (Anthropic SDK), projects (Project Pack), apply (Developer แก้ไฟล์จริง + ด่านอนุมัติ), tokens (โทเคน Bearer + งบรายวัน), webhook (แจ้งผลขาออก), metrics, bus, state, index (HTTP+SSE)
tools/    grock.mjs (CLI), mcp-server.mjs (MCP stdio สำหรับ Hermes/Claude Code), telegram-bot.mjs (บอท Telegram ต่อตรง), tests/ (npm test: unit + e2e โหมด sim)
public/   index.html, styles.css, app.js (แดชบอร์ด + แผงควบคุม), office3d/ (ฉากออฟฟิศ 3 มิติ: office3d.js, bridge.js, workscreen.js, config.js)
docs/     01-grok-architecture.md (Grok ทำงานอย่างไร), 02-multi-agent-design.md (ออกแบบระบบนี้และแนวทางขยาย)
logs/     events.jsonl (สร้างอัตโนมัติ)
```

## เอกสาร

- [docs/01-grok-architecture.md](docs/01-grok-architecture.md) — Grok 4 Heavy, Grok 4.20 (4 agents), Agent Tools API, Grok Build, Macrohard และสิ่งที่เรานำมาใช้
- [docs/02-multi-agent-design.md](docs/02-multi-agent-design.md) — โมเดลข้อมูล วงจรชีวิตงาน กลไก handoff เหตุการณ์ ตัวชี้วัด และแนวทางขยายสู่การใช้งานจริง
- [docs/07-projects.md](docs/07-projects.md) — Project Pack: ใช้ทีม AI กับโปรเจกต์อื่น (.grock/, CLI, ความปลอดภัยของไฟล์, ต้นทุน)
- [docs/08-playbook.md](docs/08-playbook.md) — Playbook: ประยุกต์โมเดลต้นแบบกับโปรเจกต์ประเภทต่าง ๆ ด้วยแม่แบบ .grock/ (ตารางประเภท → ตำแหน่ง → งบ)
- [docs/09-office3d.md](docs/09-office3d.md) — ออฟฟิศ 3 มิติ: การฝังในแดชบอร์ด, event → การเคลื่อนไหว, `config.js`, API `window.Office3D`, เพิ่มตัวละคร Mixamo
- [docs/10-online.md](docs/10-online.md) — ใช้งานออนไลน์: ผลงานขึ้นคลาวด์ (R2/S3 ผ่าน SigV4 ไม่เพิ่ม dependency), ล็อกอิน `AUTH=token` + หน้า `/login` + rate limit, สถานะถาวร SQLite (`data/state.db`), branch `grock/<jobId>` ขึ้น GitHub พร้อมด่านอนุมัติ, ตาราง "ชนิดข้อมูล → ที่เก็บ", Dockerfile/docker-compose, ข้อควรระวังเรื่องคีย์
- [docs/10-deploy-tunnel.md](docs/10-deploy-tunnel.md) — เปิดใช้งานจากอินเทอร์เน็ตด้วย Cloudflare Tunnel: รหัสผ่าน, `ALLOWED_HOSTS`, quick/named tunnel, Windows service, Cloudflare Access
- [docs/11-hermes.md](docs/11-hermes.md) — สั่งงานทาง Telegram ผ่าน Hermes Agent: โทเคนสิทธิ์จำกัด + งบรายวัน, แผนจากภายนอก, webhook แจ้งผล + ลายเซ็น, MCP server, ฝั่ง Hermes สองทาง (เสริมตัวเดิมด้วย MCP + ทักษะ `tools/hermes/skills/grock-workforce` / โปรไฟล์แยก), webhook route, cron, บอท Telegram ต่อตรง
