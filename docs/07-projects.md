# Project Pack: ใช้ทีม AI กับโปรเจกต์อื่น

ศูนย์ควบคุมทำงานให้ "โปรเจกต์" ใดก็ได้ในเครื่อง โดยไม่ต้องย้ายโค้ดหรือเอกสารมาไว้ที่นี่ แค่เพิ่มโฟลเดอร์ `.grock/` ในโปรเจกต์นั้นแล้วลงทะเบียน

```
<โปรเจกต์ของคุณ>/
  README.md, CLAUDE.md, docs/ ...        ← ของเดิม ไม่ต้องแตะ
  .grock/
    project.json                          ← การตั้งค่า (ไฟล์ที่ให้อ่าน ตำแหน่งที่ใช้ได้ โมเดล/หน้าที่ งบ)
    brief.md                              ← สรุปโปรเจกต์ 1 หน้า (คำสั่งของคุณถึงทีม)
    skills/<ตำแหน่ง>.md                   ← ทักษะเพิ่มเฉพาะโปรเจกต์ (ไม่บังคับ)
    out/<jobId>/result.md, tasks/, job.json   ← ผลงานที่ระบบเขียนกลับ
    out/<jobId>/patches/NN-<งาน>.diff(.json)  ← patch ของ Developer ที่รอคุณอนุมัติ (เมื่อให้สิทธิ์ใน permissions)
    out/latest.md                         ← ผลงานล่าสุด
```

## 1. เริ่มใช้ใน 3 ขั้น

```bash
# 1) สร้าง .grock/ จากแม่แบบตามประเภทโปรเจกต์ แล้วลงทะเบียน (รันจากโฟลเดอร์ศูนย์ควบคุม; ดูแม่แบบทั้งหมด: node tools/grock.mjs templates)
node tools/grock.mjs init "C:\Projects\MyShop" --id myshop --template webapp

# 2) แก้ C:\Projects\MyShop\.grock\brief.md ให้ตรงกับโปรเจกต์ ตรวจความพร้อม แล้วดูว่าทีมจะเห็นอะไร (ไม่เสียเงิน ใช้ได้ในโหมด sim)
node tools/grock.mjs doctor myshop
node tools/grock.mjs context myshop --role coder

# 3) สั่งงาน แล้วรอผล
node tools/grock.mjs run "ออกแบบระบบคูปองส่วนลดและเขียนต้นแบบ API" --project myshop --wait
```

แม่แบบ (`--template generic|webapp|marketing|research|data|business`) ตั้ง `plan.roles`, `roles.*`, `qa`, `budget` และ `skills/<ตำแหน่ง>.md` ให้เหมาะกับประเภทโปรเจกต์ล่วงหน้า คุณแก้เฉพาะ `brief.md` ก็ใช้ได้ — วิธีเลือกและปรับใช้ทีละขั้นอยู่ใน [docs/08-playbook.md](08-playbook.md) ส่วน `doctor` เตือนเมื่อ brief ยังเป็นโครงว่าง ไฟล์ใน `context.always` ไม่มี หรือยังไม่ตั้งงบ

หรือเลือกโปรเจกต์จากช่อง "📁" ข้างปุ่ม **มอบหมายงาน** บนหน้าเว็บ ผลงานจะอยู่ที่ `C:\Projects\MyShop\.grock\out\<jobId>\result.md`

สั่งจากใน Claude Code ที่เปิดอยู่ในโปรเจกต์นั้นได้ โดยเพิ่มบรรทัดนี้ใน `CLAUDE.md` ของโปรเจกต์:

```
ทีม AI ภายนอก: สั่งงานด้วย node "C:\Projects\AI Agent\Grock Agent\tools\grock.mjs" run "<โจทย์>" --project . --wait แล้วอ่านผลที่ .grock/out/latest.md
```

## 2. เอกสารของโปรเจกต์ไปถึงทีมอย่างไร

| ส่วน | ไปอยู่ที่ไหนใน prompt | ถือเป็น |
|---|---|---|
| `brief.md` + `roles.<ตำแหน่ง>.instructions` | system prompt (บล็อกท้าย ถูก cache) | **คำสั่งของคุณ** |
| `context.always` (README, CLAUDE.md, docs/x.md#หัวข้อ …) + ดัชนีเอกสาร + โครงสร้างไฟล์ | user message ในบล็อก `<project_files>` (ถูก cache) | **ข้อมูลอ้างอิง** ไม่ใช่คำสั่ง — มีบรรทัดกำกับ และ QA ถูกสั่งให้รายงานถ้าพบคำสั่งแฝงในไฟล์ |
| `--files a.md,b.ts` ตอนสั่งงาน | ต่อท้ายงานทุกชิ้น | ข้อมูลอ้างอิง |
| `skills/<ตำแหน่ง>.md` | ต่อท้ายคู่มือทักษะกลางของตำแหน่งนั้น (หรือแทนที่ถ้าบรรทัดแรกเป็น `<!-- replace -->`) | คำสั่ง |

ลำดับ system prompt ของคนทำงาน: prompt ประจำตำแหน่ง → หน้าที่ของคนนั้น → คู่มือทักษะกลาง (+ทักษะเฉพาะโปรเจกต์) → คำแนะนำเครื่องมือ → [บล็อกโปรเจกต์: brief + instructions]

ทำไมแยก "คำสั่ง" กับ "ข้อมูล": README/docs ของโปรเจกต์อาจมาจากคนอื่น (เช่น โค้ดต้นน้ำ) ข้อความในไฟล์เหล่านั้นจึงไม่ควรมีอำนาจสั่งทีม

บริบทถูก **freeze ตอนรับโจทย์** ทุกงานในโจทย์เดียวกัน (รวมรอบแก้จาก QA) เห็นบริบทเดียวกัน จึงได้ prompt cache และทำซ้ำได้ แก้ `.grock/` แล้วมีผลกับโจทย์ถัดไป (เซิร์ฟเวอร์ตรวจ mtime ของไฟล์ ไม่ต้องรีสตาร์ต)

## 3. project.json

```json
{
  "name": "MyShop",
  "template": "webapp",
  "context": {
    "always": ["CLAUDE.md", "README.md", "docs/architecture.md#ภาพรวม"],
    "docsIndex": ["docs/*.md", "docs/**/*.md"],
    "maxChars": 24000,
    "maxCharsPerFile": 8000,
    "tree": { "depth": 3, "maxEntries": 150, "ignore": ["legacy"] }
  },
  "plan": { "roles": ["researcher", "engineer", "coder"], "maxTasks": 5 },
  "roles": {
    "coder": { "model": "claude-sonnet-5-5", "effort": "high", "instructions": "ใช้ TypeScript strict", "maxTokens": 24000, "name": "ทีม Backend" },
    "reviewer": { "instructions": "ตรวจว่ามี unit test ครบทุก endpoint" }
  },
  "agents": { "dev-1": { "duties": "เขียน API และ migration ของ MyShop" } },
  "qa": { "maxAttempts": 2, "passScore": 75 },
  "budget": { "maxUsdPerJob": 1.5 },
  "output": { "dir": ".grock/out" }
}
```

| คีย์ | ความหมาย |
|---|---|
| `template` | ชื่อแม่แบบที่ใช้สร้าง `.grock/` (`init --template`) แสดงใน `context`/`doctor` ไม่มีผลต่อการทำงาน |
| `context.always` | ไฟล์ที่ใส่ให้ทุกครั้ง `path` หรือ `path#หัวข้อ` (เอาเฉพาะหัวข้อ markdown นั้น เหมาะกับ README ยาว ๆ) ไฟล์ที่ไม่มีจะถูกข้ามเงียบ ๆ |
| `context.docsIndex` | แพตเทิร์นไฟล์ที่ทำดัชนี (ชื่อ + หัวข้อแรก + ขนาด ไม่ใส่เนื้อหา) ให้กัปตันรู้ว่ามีเอกสารอะไรบ้าง |
| `context.maxChars` / `maxCharsPerFile` | งบตัวอักษรรวม / ต่อไฟล์ (ไทย ≈ 1 โทเคนต่อ 1–3 ตัวอักษร) |
| `context.placement` | `"user"` (ค่าเริ่มต้น) = ไฟล์โปรเจกต์อยู่ใน user message เป็นข้อมูลอ้างอิง แคชได้เฉพาะคนเดิม · `"system"` = ใส่ใน system ก่อนส่วนเฉพาะคน ทั้งทีมอ่านแคชร่วมกัน (ถูกกว่ามากเมื่อหลายคนทำงานในโจทย์เดียว) ดู §6 |
| `context.tree` | โครงสร้างไฟล์แบบกว้างก่อนลึก (ข้าม node_modules, .git, dist ฯลฯ ให้เอง) |
| `plan.roles` | ตำแหน่งที่กัปตันใช้ได้ในโปรเจกต์นี้ (`[]` = ทุกตำแหน่ง) reviewer ใช้ได้เสมอ — ตัวลดต้นทุนที่ได้ผลที่สุด · โหมด sim: กัปตันจำลองสร้างงานจากแม่แบบของตำแหน่งที่อนุญาตเท่านั้น ตามลำดับที่ตั้งไว้ (เช่น `["coder"]` → งาน "เขียนโค้ด: <โจทย์>" ไม่ใช่งานค้นข้อมูลที่เปลี่ยนตำแหน่ง) แล้ว QA ปิดท้าย |
| `plan.maxTasks` | งานผลิตสูงสุดต่อโจทย์ (1–8) ไม่นับงานตรวจ (reviewer) ที่ระบบเติมปิดท้ายให้เสมอ 1 ชิ้น — ตั้ง 2 จะได้ 2 งาน + QA 1 งาน |
| `roles.<ตำแหน่ง>` | `model`, `effort`, `toolsEnabled`, `duties`, `instructions`, `maxTokens`, `skillMode: "replace"`, `name`, `nick` เฉพาะโปรเจกต์นี้ |
| `agents.<id>` | เหมือน roles แต่เจาะจงคน (id เช่น `dev-1`) มาก่อน roles |
| `roles.<ตำแหน่ง>.name` / `nick` | **ชื่อเรียกเฉพาะโปรเจกต์** (เช่น `"name": "ทีมคอนเทนต์"`) ใช้ใน prompt ของ AI (รายชื่อทีมที่กัปตันเห็น + ประโยคแนะนำตัวของคนทำ), ไฟล์ผลงานใน `.grock/out/` (บรรทัด "ผู้ทำ:") และบรรทัด log ของโจทย์โปรเจกต์นี้ — หน้าเว็บ/ฉาก 3 มิติยังแสดงชื่อกลางของทีม (ตั้งที่ ⚙ ตั้งค่า AI) การมอบหมายใช้ `id` จึงไม่กระทบ |
| `permissions.<id>` | สิทธิ์ **แก้ไฟล์จริง** ของเอเจนต์นั้น (`write` glob, `deny`, `tools` ของ Claude Code, `maxUsd`, `timeoutSec`) ไม่ตั้ง = ไม่มีสิทธิ์ ทีมได้แค่เสนอ — ดูข้อ 5 |
| `qa.maxAttempts` / `passScore` | จำนวนรอบแก้สูงสุด / คะแนนผ่าน |
| `budget.maxUsdPerJob` | เมื่อใช้เงินเกิน ระบบหยุดงานที่กำลังทำและที่เหลือ แล้วปิดโจทย์เป็น failed (ผลงานที่เสร็จแล้วยังถูกบันทึก) `0` = ไม่จำกัด · ไม่ตั้ง = ใช้ `MAX_USD_PER_JOB` ใน .env |
| `cache.ttl` | อายุ prompt cache `"5m"` (ค่าเริ่มต้น) หรือ `"1h"` (เขียนแคชแพงกว่า แต่คุ้มเมื่อสั่งงานโปรเจกต์เดิมห่างกันเกิน 5 นาที) |
| `output.dir` | โฟลเดอร์ผลงาน ต้องอยู่ใต้ `.grock/` (ยกเว้น `.grock/skills`) ค่าเริ่มต้น `.grock/out` — ระบบไม่เขียนไฟล์นอกโฟลเดอร์นี้ |

ลำดับการผสานค่า: ค่าในโค้ด → `data/team.json` (ตั้งจากหน้าเว็บ) → `roles.<ตำแหน่ง>` → `agents.<id>` ค่าที่ไม่ผ่านการตรวจ (โมเดลที่ไม่รู้จัก ฯลฯ) ถูกข้ามพร้อมคำเตือนใน log

## 4. ผลงานที่เขียนกลับ

`<โปรเจกต์>/.grock/out/<jobId>/`

- `result.md` ผลสรุปจากกัปตัน (เขียนเมื่อโจทย์จบ ไม่ว่าสำเร็จหรือล้มเหลว)
- `tasks/NN-<ตำแหน่ง>-<ชื่องาน>.md` ผลงานรายชิ้น (เขียนทันทีที่แต่ละงานเสร็จ จึงไม่หายถ้าเซิร์ฟเวอร์ล้มกลางคัน)
- `plan.json`, `job.json` แผนงานและสถานะ/ต้นทุนล่าสุด
- `../latest.md` สำเนาของ result.md ล่าสุด

ค่าเริ่มต้นทีม **ไม่แก้ไฟล์ของโปรเจกต์เอง** โค้ดและข้อเสนอทั้งหมดเป็นไฟล์ใน `out/` ให้คุณตรวจแล้วนำไปใช้ ถ้าต้องการให้ตำแหน่ง Developer แก้ไฟล์จริง ต้องให้สิทธิ์เป็นรายเอเจนต์และผ่านด่านอนุมัติ — ดูข้อ 5

## 5. ให้ Developer แก้ไฟล์จริง (Phase 2: Claude Code headless + ด่านอนุมัติ)

ตำแหน่ง Developer (role `coder`, เอเจนต์ `dev-1`) แก้ไฟล์ในโปรเจกต์ได้จริงผ่าน **Claude Code แบบ headless** (`claude -p`) แต่ไฟล์จริงจะเปลี่ยนก็ต่อเมื่อคุณกด **Apply** เท่านั้น ลำดับงาน:

```
กัปตันมอบหมายงาน coder ──► มีสิทธิ์? ──ไม่──► ทำแบบข้อเสนอ (Phase 1) + log บอกเหตุผล
                               │ ใช่
                               ▼
   sandbox = สำเนาโปรเจกต์ใน temp (ตัด .git/node_modules/.grock/.claude/ไฟล์ค่าลับ)
   claude -p ใน sandbox โดยจำกัด --tools/--allowedTools/--permission-mode dontAsk/--max-budget-usd/timeout
   (+ --strict-mcp-config --disable-slash-commands: ไม่โหลด MCP/skill ของผู้ใช้ — ดู 5.5)
                               ▼
   diff sandbox ↔ โปรเจกต์ → ไฟล์นอกสิทธิ์ถูกตัดทิ้ง (บันทึกเป็น rejected)
   เขียน .grock/out/<jobId>/patches/NN-<งาน>.diff (+ .json audit)   ← ไฟล์จริงยังไม่ถูกแตะ
                               ▼
   งานขึ้นป้าย "🩹 รออนุมัติ" บน dashboard · QA ตรวจ patch ต่อได้ตามปกติ
                               ▼
   คุณกด Apply (หรือ grock apply) → ตรวจ sha256 ของ patch + สิทธิ์ล่าสุด + ทุก path
   → git apply --check (ปิดการแปลงท้ายบรรทัด) → เทียบบรรทัดต้นฉบับแบบไบต์ต่อไบต์ → เขียนไฟล์
   หรือกดปฏิเสธ → ไม่แตะไฟล์
```

### 5.1 ให้สิทธิ์ (project.json → `permissions`)

```json
"permissions": {
  "dev-1": {
    "write": ["src/**", "tests/**"],
    "deny": [".env*", "**/*.pem", "src/generated/**"],
    "tools": ["Edit", "Write", "Bash(npm test)"],
    "maxUsd": 5,
    "timeoutSec": 900,
    "model": "claude-sonnet-5-5",
    "sandboxIgnore": ["data", "assets"],
    "linkDeps": true
  }
}
```

| คีย์ | ความหมาย |
|---|---|
| `write` | glob (posix) ของไฟล์ที่แก้ได้ `**` = ข้ามโฟลเดอร์, `*`/`?` ในชื่อ, ชื่อโฟลเดอร์เฉย ๆ = ทุกอย่างใต้โฟลเดอร์นั้น **ว่าง = ไม่มีสิทธิ์** (ค่าเริ่มต้นของทุกโปรเจกต์) |
| `deny` | glob ที่ห้ามแตะ เพิ่มจาก deny-list กลาง (ไฟล์ค่าลับ) ไฟล์เหล่านี้ไม่ถูกคัดลอกเข้า sandbox ด้วย (Claude ไม่เห็น) |
| `tools` | เครื่องมือของ Claude Code ที่อนุญาต: `Read` `Glob` `Grep` `Edit` `Write` `NotebookEdit` และ `Bash(<คำสั่ง>)` (ห้ามมี `; & \| $ \` < >`) ค่าเริ่มต้น `["Edit", "Write"]` ต้องมี `Edit` หรือ `Write` อย่างน้อย 1 ตัว อ่าน/ค้นหาไฟล์ได้เสมอ |
| `maxUsd` | งบของ Claude Code ต่องาน (`--max-budget-usd`) ค่าเริ่มต้น 5, `0` = ไม่จำกัดฝั่ง CLI (งบต่อโจทย์ `budget.maxUsdPerJob` ยังนับรวมต้นทุนจริงที่ CLI รายงาน) |
| `timeoutSec` | เวลาสูงสุดต่องาน 30–3600 (ค่าเริ่มต้น 900) เกินแล้วหยุดโปรเซสและงานล้มเหลว |
| `model` | โมเดลของ Claude Code สำหรับงานนี้ (ไม่ตั้ง = โมเดลของ dev-1 ที่ตั้งไว้/override ของโปรเจกต์) |
| `sandboxIgnore` | โฟลเดอร์เพิ่มเติมที่ไม่คัดลอกเข้า sandbox (นอกจาก `.git node_modules .grock .claude dist build coverage .venv …`) ใช้กับโปรเจกต์ใหญ่ |
| `linkDeps` | junction `node_modules` ของโปรเจกต์เข้า sandbox เมื่ออนุญาต `Bash(...)` เพื่อให้รันเทสต์ได้ (ค่าเริ่มต้น true) |

สิทธิ์เป็น **รายเอเจนต์** (คีย์คือ id เช่น `dev-1`) ไม่ใช่รายตำแหน่ง — ทีมที่มีนักพัฒนาหลายคนให้สิทธิ์ต่างกันได้ ค่าที่ไม่ผ่านการตรวจ (glob มี `..`, เครื่องมือที่ไม่อนุญาต, id แปลก) ถูกข้ามพร้อมคำเตือนใน log ตอนรับโจทย์ และ `.grock/`, `.git/`, `.claude/`, `node_modules/`, ไฟล์ค่าลับ **ห้ามเขียนเสมอ** ไม่ว่า `write` จะกว้างแค่ไหน

สิทธิ์จะถูกใช้เมื่อ: งานเป็นตำแหน่ง coder · โจทย์ผูกกับโปรเจกต์ · `permissions.<id>` ของคนที่ได้รับงานมี `write` · คนนั้นไม่ได้ถูกปิดเครื่องมือใน ⚙ ตั้งค่า AI · (โหมด LIVE หรือ `CODE_MODE=live` — ดู 5.4) หาคำสั่ง `claude` เจอ (PATH, `%APPDATA%\npm\claude.cmd`, `~/.local/bin/claude` หรือ `CLAUDE_BIN` ใน `.env`) — ไม่ครบข้อใดข้อหนึ่ง → ทำแบบข้อเสนอเหมือน Phase 1 และ log บอกเหตุผล

### 5.2 ด่านอนุมัติ

- **dashboard**: การ์ดงานขึ้นชิป "🩹 รออนุมัติ" พร้อมปุ่ม **✅ Apply เข้าโปรเจกต์** / **✖ ปฏิเสธ** (ใส่หมายเหตุได้) เปิดการ์ดเพื่อดูรายชื่อไฟล์ ไฟล์ที่ถูกตัดออกเพราะนอกสิทธิ์ คำสั่งที่ Claude Code ถูกปฏิเสธ และ diff (ปิดบังค่าลับ) แท็บ "งาน" มีตัวเลขจำนวน patch ที่รอ
- **CLI**: `node tools/grock.mjs patches` (รายการ) · `patch <taskId>` (diff ฉบับเต็ม) · `apply <taskId> --note "..."` · `reject <taskId> --reason "..."` และ `run --wait` จะสรุป patch ที่ยังรอเมื่อโจทย์จบ
- **API**: `POST /api/tasks/:id/apply {note}` · `POST /api/tasks/:id/reject {reason}` · `GET /api/tasks/:id/patch` — รับเฉพาะ `Host` localhost + `Content-Type: application/json` เหมือน endpoint อื่น
- ตอน apply ระบบตรวจซ้ำทุกครั้ง: ไฟล์ patch ต้องมี sha256 ตรงกับตอนสร้าง (แก้ไฟล์ patch เอง = ถูกปฏิเสธ) · โหลด `project.json` ล่าสุดแล้วตรวจทุก path กับสิทธิ์อีกรอบ (ถอนสิทธิ์ก่อน apply ได้) · ทุก path ต้องอยู่ในโปรเจกต์จริง (realpath) · `git apply --check` (ปิด autocrlf) · บรรทัดต้นฉบับของทุก hunk ต้องตรงกับไฟล์ปัจจุบันแบบไบต์ต่อไบต์ (ไฟล์เปลี่ยนไปหลังสร้าง patch → ปฏิเสธ ให้สั่งทำใหม่)
- ตัวเขียนไฟล์เป็นของระบบเอง (ไม่ให้ git เขียน) เพื่อคงรูปแบบท้ายบรรทัดเดิม (CRLF/LF) — `core.autocrlf` หรือ `.gitattributes text=auto` จะทำให้ `git apply` แปลงท้ายบรรทัดหรือปฏิเสธ patch ที่ตรงไบต์ ผล `git apply --check` ถูกบันทึกไว้ใน audit เป็นคำเตือนถ้าไม่ตรงกัน
- โจทย์จบได้โดยไม่ต้องรอตัดสินใจ (patch ค้างสถานะ pending ได้) ถ้า QA ส่งงานกลับแก้หรือสั่งทำใหม่ patch เดิมที่ยังไม่ตัดสินใจจะกลายเป็น `superseded` และได้ patch ใหม่ (`NN-<งาน>-r2.diff`)

### 5.3 audit

ทุกขั้นถูกบันทึก 4 ที่: `task.history` (เห็นในไทม์ไลน์ของการ์ดงาน) · `logs/events.jsonl` (event `task.patch` action `pending|applied|rejected|superseded|error` + log) · `.grock/out/<jobId>/job.json` (ต่องาน: `patch` ล่าสุด + `patches` ทุกรอบ: ไฟล์, ไฟล์ที่ถูกตัด, สถานะ, ผู้ตัดสินใจ, เวลา, หมายเหตุ, ต้นทุน/รอบ/เวอร์ชันของ CLI) · `patches/NN-<งาน>.diff.json` (sidecar ข้าง patch พร้อม `decisions[]`) ผลงาน `tasks/NN-coder-*.md` ของงานนั้นมี diff ให้ QA และคุณอ่านด้วย

### 5.4 โหมด sim และ `CODE_MODE`

ไม่เรียก `claude` และไม่เสียเงิน: งาน coder ที่มีสิทธิ์จะได้ patch จำลองที่ **apply ได้จริง** (สร้าง `GROCK-SIM-NN.md` ในโฟลเดอร์แรกของ `write` + ต่อท้ายไฟล์เดิมที่อยู่ในสิทธิ์ 1 บรรทัดคอมเมนต์) เพื่อทดสอบ UI/flow/สิทธิ์/audit ให้ครบก่อนเปิด LIVE ไฟล์เหล่านี้ลบทิ้งได้

**`CODE_MODE` ใน `.env`** (`auto` | `live` | `sim`, ค่าเริ่มต้น `auto` = ตามโหมดระบบ) คุมเฉพาะขั้นนี้แยกจากโหมดระบบ:
- `CODE_MODE=live` — Developer เรียก `claude` จริงแม้ระบบอยู่โหมด SIM สำหรับคนที่ใช้ Claude Code ด้วยบัญชี claude.ai (Pro/Max ที่ `claude auth status` บอก `loggedIn: true`) และ**ไม่มี** `ANTHROPIC_API_KEY` — โหมด LIVE ของระบบต้องมี key เพราะกัปตัน/QA เรียก API ตรง จึงสลับเป็น LIVE ไม่ได้ ในโหมดนี้กัปตันวางแผนและ QA ยังจำลอง (เร็ว ไม่เสียเงิน) ส่วนงาน coder ที่มีสิทธิ์ได้ patch จาก Claude Code จริง ต้นทุนที่ CLI รายงาน (`total_cost_usd`) ยังขึ้น dashboard/`job.json` แต่เป็น**ค่าประเมิน** — แผน claude.ai ไม่เรียกเก็บเป็นเงิน แต่หักโควตาการใช้งานของแผน (เห็น `rate_limit_event` ใน stream) `/api/health` บอก `codeMode`/`codeLive` และ log ตอนเปิดเซิร์ฟเวอร์เตือนไว้
- `CODE_MODE=sim` — ไม่เรียก `claude` เลย (patch จำลอง) แม้ระบบอยู่โหมด LIVE ใช้ตอนซ้อม flow กับ API จริงของตำแหน่งอื่นโดยไม่ให้ Developer แตะไฟล์

### 5.5 ข้อจำกัดและความเสี่ยงที่ต้องรู้

- `Bash(...)` ของ Claude Code **ไม่ถูกจำกัดพาธ** — คำสั่งที่อนุญาตรันในเครื่องคุณจริง (ใน sandbox แต่ออกไปอ่านที่อื่นได้) ให้อนุญาตเฉพาะคำสั่งที่จำเป็นและระบุให้แคบ (เช่น `Bash(npm test)` ไม่ใช่ `Bash(npm *)`) ถ้าไม่จำเป็นอย่าให้ Bash เลย
- sandbox ไม่คัดลอก `.git` (Claude ไม่เห็นประวัติ/commit ไม่ได้) และไม่คัดลอก `.claude/` ของโปรเจกต์ (hook/permission ของโปรเจกต์ไม่ถูกใช้) ตั้งค่าผู้ใช้ (`~/.claude/settings.json`) ยังถูกโหลด (`--setting-sources user`) รวม hook/plugin ที่เปิดไว้ (hook `SessionStart` ของ plugin รันใน sandbox ก่อนเริ่มงาน) แต่ **MCP ของผู้ใช้ (`~/.claude.json`, connector ของ claude.ai, MCP ของ plugin) และ skill/slash command ไม่ถูกโหลด** (`--strict-mcp-config --disable-slash-commands`) — ทดสอบกับ `claude` 2.1.157 แล้ว: MCP ระดับผู้ใช้ (เช่น เซิร์ฟเวอร์ที่มีเครื่องมือหลายร้อยตัว) ทำให้ prompt บวม ~380K tokens ในเทิร์นที่ 2 (งานเล็ก ๆ บน haiku กลายเป็น $2.48 และชน `maxUsd: 1`) และยังเปิดเครื่องมือนอกสิทธิ์ (Google Drive/Figma ฯลฯ) ให้ Developer ด้วย ต้องการ MCP เฉพาะงานให้ใส่ `GROCK_CLAUDE_ARGS=--mcp-config <ไฟล์>` (ยัง strict: โหลดเฉพาะที่ระบุ) ใช้ `GROCK_CLAUDE_ARGS=--bare` ถ้าต้องการตัด hook/plugin ด้วย — แต่ `--bare` ใช้ได้เฉพาะ `ANTHROPIC_API_KEY`/`apiKeyHelper` (ไม่อ่าน OAuth ของ claude.ai)
- การเปลี่ยนแปลงในโฟลเดอร์ที่ไม่ถูกคัดลอก (`dist/`, `node_modules/` ฯลฯ), ไฟล์ไบนารี, ไฟล์ที่ไม่ใช่ UTF-8, ไฟล์เกิน 2 MB และการ rename จะไม่อยู่ใน patch (ถูกบันทึกเป็น rejected พร้อมเหตุผล) patch รวมเกิน 4 MB = งานล้มเหลว (ให้แบ่งงาน)
- โปรเจกต์ใหญ่: การคัดลอกเข้า sandbox จำกัด 20,000 ไฟล์ / 400 MB (`GROCK_SANDBOX_MAX_FILES`, `GROCK_SANDBOX_MAX_MB`) ใช้ `sandboxIgnore` ตัดโฟลเดอร์ข้อมูล
- ต้นทุนของ Claude Code (`total_cost_usd`) ถูกนับเข้าต้นทุนของงาน/คน/โจทย์ และถูกตรวจกับ `budget.maxUsdPerJob` **หลัง** งานจบ ใช้ `maxUsd` เป็นเพดานฝั่ง CLI
- **ทดสอบกับ `claude` จริงแล้ว** (2026-10-20, Claude Code 2.1.157 บน Windows, บัญชี claude.ai Max ไม่มี API key → `CODE_MODE=live`): โปรเจกต์ทดลอง 5 ไฟล์ โจทย์ "เพิ่มฟังก์ชัน add(a, b) ใน src/math.js" ด้วย `permissions.dev-1 = {write: ["src/**"], tools: ["Edit","Write"], maxUsd: 1}` → Claude Code (sonnet ค่าเริ่มต้น) 5 เทิร์น 14.6 วินาที ต้นทุนที่ CLI รายงาน $0.16 (job รวม $0.23 เพราะมีค่าประเมินของ QA จำลอง) ได้ patch 1 ไฟล์ (+4) รออนุมัติ · `.env` ไม่ถูกคัดลอกเข้า sandbox · กด Apply บน dashboard → ไฟล์จริงเปลี่ยน, `job.json`/sidecar/`logs/events.jsonl` บันทึก `applied` ครบ งานเดียวกันบน haiku ≈ $0.07–0.11 สิ่งที่พบและแก้แล้ว: (1) ต้องมี `--strict-mcp-config` (ข้อข้างบน) (2) เมื่อ CLI หยุดเพราะงบ/ข้อผิดพลาด (`is_error`, subtype เช่น `error_max_budget_usd`) จะไม่มี field `result` แต่มี `errors[]` และ `usage` เป็นแค่เทิร์นแรก — ระบบใช้ `modelUsage` (ยอดรวม) และไฟล์ที่แก้ไปแล้วยังได้ patch พร้อมหัวข้อ "⚠️ Claude Code หยุดก่อนเสร็จ" ให้ตรวจก่อน apply (3) `fake-claude.mjs` ถูกปรับให้ตรงรูปแบบ event ของรุ่นนี้ (hook_started/hook_response → init → thinking → tool_use → rate_limit_event → user tool_result → result) ลองงานเล็ก ๆ ที่ `maxUsd: 1` ก่อนเสมอ

## 6. ความปลอดภัย

- ทุก path ถูกตรวจว่าอยู่ในโฟลเดอร์โปรเจกต์จริง (ตาม realpath กัน `..`, ไดรฟ์อื่น, junction/symlink ที่ชี้ออกนอก, ชื่อสงวนของ Windows, alternate data stream)
- API ทั้งหมดรับเฉพาะคำขอที่ `Host` เป็น localhost (กัน DNS rebinding จากหน้าเว็บอื่นแม้เป็น GET) และห้ามลงทะเบียนรากไดรฟ์ โฟลเดอร์ผู้ใช้ ศูนย์ควบคุม หรือโฟลเดอร์ที่ครอบสิ่งเหล่านั้น
- ไฟล์ค่าลับถูกห้ามอ่าน (`.env*`, `*.pem/*.key/*.pfx/*.ppk`, `*.tfvars`, `*.ovpn`, `*.env`, `id_rsa*`, `.npmrc`, `credentials*.json`, `.git/`, `.aws/`, `.ssh/` ฯลฯ) และข้อความที่ดูเหมือนคีย์/โทเคน/รหัสผ่านใน URL ถูกแทนด้วย `[REDACTED]` ก่อนส่งเข้าโมเดลหรือเขียน log
- ไฟล์ UTF-16/BOM ที่ PowerShell สร้างถูกถอดรหัสให้ถูก ไฟล์ไบนารีถูกข้าม
- API ที่แตะดิสก์รับเฉพาะคำขอจากเครื่องนี้ (`Host` ต้องเป็น localhost) และต้องเป็น `Content-Type: application/json` (กันหน้าเว็บอื่นยิงข้ามมา) การลงทะเบียนต้องชี้ไปยังโฟลเดอร์ที่มี `.grock/project.json` อยู่แล้ว ห้ามรากไดรฟ์/โฟลเดอร์ผู้ใช้/ศูนย์ควบคุมเอง
- การแก้ไฟล์จริง (ข้อ 5) ต้องให้สิทธิ์เป็นรายเอเจนต์ ทำงานใน sandbox ไม่แตะไฟล์จริงจนกว่าจะอนุมัติ ตอน apply ตรวจ sha256/สิทธิ์ล่าสุด/ทุก path อีกครั้ง และ `.grock/ .git/ .claude/ node_modules/` + ไฟล์ค่าลับห้ามเขียนเสมอ
- ถ้าจะเปิดให้เครื่องอื่นในแลนใช้ (`HOST=0.0.0.0`) ต้องเพิ่มการยืนยันตัวตนก่อน — เวอร์ชันนี้ออกแบบสำหรับ localhost

## 7. ต้นทุนและการตรวจสอบ

- `node tools/grock.mjs context <id> --tokens` นับโทเคนจริงของบริบท (ฟรี ต้องมี key) ก่อนรันจริง
- prompt cache: บล็อก brief ของโปรเจกต์อยู่หน้าสุดของ system จึงอ่านแคชร่วมกันได้ทั้งทีม ส่วน `<project_files>` (ก้อนใหญ่) อยู่ใน user message ของแต่ละคน → อ่านแคชได้เมื่อคนเดิมทำงานชิ้นถัดไป/รอบแก้ QA/กัปตันสังเคราะห์ ภายใน 5 นาที (อ่านถูกกว่า 10 เท่า แต่เขียนแพงกว่า 1.25 เท่า) ถ้าโจทย์ส่วนใหญ่ให้แต่ละคนทำคนละชิ้นเดียว ตั้ง `context.placement: "system"` จะถูกกว่า เพราะทั้งทีมอ่านก้อนเดียวกัน (แลกกับการที่ข้อมูลไฟล์ไปอยู่ใน system ซึ่งมีน้ำหนักเหมือนคำสั่งมากขึ้น — ยังมีบรรทัดกำกับว่าเป็นข้อมูล) ดูเปอร์เซ็นต์แคชได้ในแท็บตัวชี้วัด (ช่อง "โทเคนเข้า")
- ขั้นตอนก่อนใช้จริง: ทดสอบในโหมด sim ให้ครบ → `npm run smoke:live` (คำขอเล็กบน haiku) → โจทย์สั้น 1 โจทย์กับ `budget.maxUsdPerJob: 0.5` → ค่อยเพิ่ม
- ทุกเหตุการณ์ (รวมโปรเจกต์ที่ทำให้ ไฟล์ที่ถูกอ่าน/ข้าม การใช้เครื่องมือ) อยู่ใน `logs/events.jsonl` และ `job.json` ตรวจย้อนหลังได้

## 8. ข้อจำกัดที่รู้

- โหมด LIVE ของตำแหน่งอื่น (กัปตัน/QA/นักวิจัย ผ่าน Anthropic SDK) ยังไม่ได้ทดสอบกับ API จริง (เครื่องที่พัฒนาไม่มี key — มีแต่บัญชี claude.ai ของ Claude Code) — ใช้ `npm run smoke:live` ก่อน
- โปรเจกต์ที่เอกสารใหญ่มาก: เลือกหัวข้อด้วย `path#หัวข้อ` และพึ่งดัชนีเอกสาร อย่าใส่ทั้งโฟลเดอร์ใน `always`
- งานโค้ดเป็น "ข้อเสนอ" เว้นแต่ให้สิทธิ์ใน `permissions` (ข้อ 5): แบบข้อเสนอ นักพัฒนาทดสอบใน sandbox ของ API ซึ่งไม่มีไฟล์โปรเจกต์ จึงไม่ได้รันเทสต์จริงของโปรเจกต์ · แบบแก้ไฟล์จริง ทดสอบกับ `claude` จริงแล้ว 1 โจทย์เล็ก (ดู 5.5) ถ้าไม่ให้ `Bash(...)` Claude Code จะรันเทสต์ของโปรเจกต์ไม่ได้ (มันจะบอกไว้ในสรุปงาน)
- สถานะอยู่ในหน่วยความจำ รีสตาร์ตเซิร์ฟเวอร์แล้วโจทย์ที่ค้างหาย (ไฟล์ใน `out/` ที่เขียนแล้วยังอยู่)
