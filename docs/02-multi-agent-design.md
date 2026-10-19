# การออกแบบระบบ AI Workforce Control Center

เอกสารนี้อธิบายว่าระบบต้นแบบในโปรเจกต์นี้ทำงานอย่างไร เพื่อให้นำไปปรับใช้กับโครงสร้างองค์กรจริงได้

## 1. แนวคิดหลัก: องค์กร = ทีมพนักงาน AI ที่มีกัปตันประสานงาน

```
ผู้ใช้ (มนุษย์) ──โจทย์──▶ กัปตัน (PM) ──แตกงาน/มอบหมาย──▶ นักการตลาด, นักวิจัย, นักการเงิน/กลยุทธ์, วิศวกร AI, นักพัฒนา, QA & Compliance
                            ▲                                   │
                            └────────── ส่งผลงานกลับ ◀──────────┘
                                   QA ไม่ผ่าน → ส่งกลับให้คนเดิมแก้ (handoff)
                            กัปตันรวบรวมผลลัพธ์สุดท้าย ──▶ ผู้ใช้
```

- **1 พนักงาน = 1 งาน ณ เวลาหนึ่ง** (เหมือนคนจริง) จึงเห็นชัดว่าใครกำลังทำอะไร ใครว่าง ใครคอขวด
- **งานมี dependency** งานที่ไม่รอกันทำพร้อมกัน (คู่ขนาน) งานปลายน้ำได้ผลงานต้นน้ำเป็น input อัตโนมัติ
- **QA เป็นด่านคุณภาพ** ให้คะแนน 0–100 ต่ำกว่า 70 ส่งกลับแก้ ไม่เกิน 3 รอบ (ปรับได้ที่ `MAX_ATTEMPTS`)
- **ทุกการเปลี่ยนแปลงเป็น event** → แสดงสดบน dashboard และบันทึกลง `logs/events.jsonl` เพื่อวัดผลย้อนหลัง

## 2. ส่วนประกอบ (server/)

| ไฟล์ | หน้าที่ |
|---|---|
| `agents.js` | ทะเบียนตำแหน่ง (role) system prompt ชุด server tools ประจำตำแหน่ง (`tools` + `toolHint`) ทีมเริ่มต้น และตารางราคาโมเดล/ค่าเครื่องมือ |
| `state.js` | สถานะกลาง in-memory: agents / tasks / jobs + ฟังก์ชัน snapshot และตัวชี้วัดที่คำนวณสด |
| `orchestrator.js` | สมองของกัปตัน: รับโจทย์ วางแผน จัดคิว มอบหมาย ติดตาม handoff ตรวจ QA รวบรวมผล และคำสั่งควบคุมด้วยมือ |
| `executor.js` | การ "ลงมือทำ" ของพนักงานแต่ละคน มี 2 โหมด: `live` (เรียก Claude) และ `sim` (จำลองเป็นเฟส ๆ) |
| `llm.js` | ตัวกลางเรียก Anthropic SDK แบบ streaming + structured output + server-side fallback + server tools (จับ event เครื่องมือระหว่าง stream และต่อ turn เมื่อ `pause_turn`) |
| `metrics.js` | บันทึกตัวชี้วัดต่อคน (งานเสร็จ เวลาที่ใช้ โทเคน ต้นทุน ส่งต่อ คุณภาพ จำนวนครั้งที่ใช้เครื่องมือ) |
| `bus.js` | Event bus กลาง + history + บันทึกไฟล์ JSONL |
| `index.js` | HTTP server: หน้าเว็บ, REST API, SSE |

## 3. โมเดลข้อมูล

```
Job   { id, goal, status: planning|running|synthesizing|done|failed, taskIds[], result, costUsd, durationMs }
Task  { id, jobId, seq, title, description, role, status: queued|assigned|running|done|failed|cancelled,
        assignedTo, pinnedAgentId, preferredAgentId, dependsOn[], reviewOfId, attempts, progress, phase,
        toolCalls, activeTool,            // จำนวนครั้งที่ใช้เครื่องมือ (รวมทุกรอบ) และเครื่องมือที่กำลังใช้ (เช่น "web_search" | null)
        output, review{approved, score, summary, feedback}, feedback, usage{inputTokens, outputTokens, costUsd}, history[] }
Agent { id, name, nick, role, model, effort, toolsEnabled, duties, tools[], status: idle|working|paused, currentTaskId, phase, activeTool, lastOutput,
        metrics{tasksDone, tasksFailed, handoffsIn, handoffsOut, toolCalls, busyMs, totalDurationMs, inputTokens, outputTokens, costUsd, qualityScores[]} }
```

- `Agent.tools` = ชื่อเครื่องมือที่ตำแหน่งนี้ใช้ได้ (เช่น `["web_search","web_fetch"]`) ใช้แสดงบน dashboard
- `Agent.duties` = "หน้าที่" ของคนนั้น (ข้อความไทย แก้ได้จาก dashboard, บันทึกใน `data/team.json`) — ดูหัวข้อ 11
- `Task.preferredAgentId` = คนที่กัปตันเลือกตามหน้าที่ตอนวางแผน (ต่างจาก `pinnedAgentId` ที่มาจากการส่งต่อด้วยมือ/QA ส่งกลับ ซึ่งบังคับกว่า)
- ชื่อเครื่องมือใน `activeTool` ตรงกับ `name` ของ block `server_tool_use` ที่ Claude ส่งกลับ: `web_search`, `web_fetch`, `bash_code_execution`, `text_editor_code_execution` (โหมด sim ใช้ชื่อชุดเดียวกัน)

## 4. วงจรชีวิตของงาน

1. `POST /api/jobs {goal}` → สร้าง Job → กัปตันสถานะ `working` เฟส "กำลังวางแผน"
2. **วางแผน**: live → Claude ตอบ JSON ตาม schema (`PLAN_SCHEMA`) / sim → เทมเพลตตามคำสำคัญในโจทย์
   แล้วผ่าน `normalizePlan()` เพื่อบังคับว่า role ถูกต้อง, dependency ไม่วนลูป, มี QA ปิดท้าย, งานปลายน้ำรอผล QA
3. **จัดคิว** (`tick()` ทุก 500ms และหลังทุกเหตุการณ์): งาน `queued` ที่ dependency เสร็จครบ → เลือกคนตามลำดับ: คนที่ถูก "pin" (ส่งต่อด้วยมือ/QA ส่งกลับ) → คนที่กัปตันเลือกตามหน้าที่ (`preferredAgentId`: ว่าง = ให้เลย, กำลังทำงานอื่น = รอ, หยุดพัก = ข้าม) → ใครก็ได้ในตำแหน่งเดียวกันที่ `idle` → `assign`
4. **ทำงาน** (`start` → `runTask`): ส่ง progress ทุก ~180ms (เฟส, %, ข้อความที่กำลังพิมพ์) → `finish` หรือ `fail`
5. **QA**: ถ้างานเป็นของ reviewer และมี `reviewOfId` → `handleReview()`
   - ผ่าน → บันทึกคะแนนคุณภาพให้เจ้าของงาน
   - ไม่ผ่าน และยังไม่ครบ 3 รอบ → งานต้นทางกลับเป็น `queued` + pin คนเดิม + แนบ feedback; งาน QA กลับเป็น `queued` รอตรวจซ้ำ
6. เมื่อทุกงานใน Job จบ → กัปตัน **สังเคราะห์ผลลัพธ์สุดท้าย** → Job `done`

## 5. การส่งต่องาน (Handoff) 2 แบบ

| แบบ | ผู้สั่ง | กลไก |
|---|---|---|
| อัตโนมัติ | QA | ไม่ผ่านเกณฑ์ → ส่งกลับให้คนเดิม พร้อม feedback ในพรอมป์ตรอบถัดไป |
| ด้วยมือ | ผู้ควบคุมบน dashboard | `POST /api/tasks/:id/handoff {agentId, reason}` → ยกเลิกงานที่กำลังทำ (AbortController) → pin ให้คนใหม่ → มอบหมายทันทีถ้าว่าง |

ทั้งสองแบบยิง event `task.handoff` (บันทึก/แจ้งเตือน) และเมื่อมอบหมายจริงยิง `task.assigned {from, to}` ซึ่ง dashboard ใช้วาด "ก้อนงาน" วิ่งจากคนหนึ่งไปอีกคน

## 6. เหตุการณ์ (SSE `/api/events`)

| event | ความหมาย | ใช้ทำอะไรบน dashboard |
|---|---|---|
| `snapshot` | สถานะทั้งระบบตอนเชื่อมต่อ | วาดทุกอย่างใหม่ |
| `agent.updated` | สถานะ/เฟส/ตัวชี้วัดของพนักงานเปลี่ยน | สีวงแหวน, ข้อความใต้ชื่อ |
| `task.created/started/updated/review/failed` | สถานะงานเปลี่ยน | การ์ดงาน, drawer |
| `task.assigned {from,to}` | มอบหมาย/ส่งต่อถึงมือแล้ว | แอนิเมชันก้อนงานวิ่ง |
| `task.progress` | เฟส, %, ข้อความสด, `tool` (เครื่องมือที่กำลังใช้หรือ null), `toolCalls` (ของงาน), `agentToolCalls` (ของคน) | วงแหวนความคืบหน้า, กล่องข้อความสด, ไอคอนเครื่องมือใต้ป้ายงาน, ชิป "🔎 ค้นเว็บ" บนการ์ดงาน |
| `task.handoff {from,to,reason}` | เกิดการส่งต่อ | toast + log |
| `task.completed` | งานเสร็จ | ก้อนงานวิ่งกลับกัปตัน |
| `job.*` | สถานะโจทย์ | แท็บผลงาน, KPI, เอฟเฟกต์ฉลอง |
| `metrics.updated` | ตัวชี้วัดรวมทุก 2 วิ | KPI บนหัว, แท็บตัวชี้วัด |
| `log` | ข้อความภาษาไทยอ่านง่าย | แท็บบันทึก |

## 7. ตัวชี้วัด (วัดผลพนักงาน AI)

| ตัวชี้วัด | นิยาม | ใช้ตัดสินใจอะไร |
|---|---|---|
| งานเสร็จ / ล้มเหลว | นับต่อคน | ใครรับงานได้มาก ใครมีปัญหา |
| เวลาเฉลี่ยต่องาน | `totalDurationMs / tasksDone` | ตำแหน่งไหนช้า ควรแยกงานหรือเพิ่มคน |
| อัตราใช้งาน (utilization) | เวลาที่ busy / เวลาที่ระบบเปิด | เพิ่ม/ลดจำนวนพนักงานในตำแหน่ง |
| โทเคน เข้า/ออก และต้นทุน | จาก `usage` ของ API คูณราคาโมเดล | ต้นทุนต่องาน/ต่อโจทย์ เลือกโมเดลให้คุ้ม |
| คุณภาพ (QA) | คะแนนเฉลี่ยที่ QA ให้ | ปรับพรอมป์ต/โมเดลของตำแหน่งที่คะแนนต่ำ |
| ส่งต่อ เข้า/ออก | จำนวน handoff | งานถูกเด้งไปมามากแปลว่าแตกงานไม่ดีหรือเกณฑ์ QA แข็งเกิน |
| ใช้เครื่องมือ | จำนวนครั้งที่เรียก server tools (`metrics.toolCalls` ต่อคน, `task.toolCalls` ต่องาน) | ตำแหน่งไหนพึ่งการค้นเว็บ/รันโค้ดมาก คุ้มกับคุณภาพที่ได้หรือไม่ (web search คิดเงินต่อครั้ง) |
| อัตราสำเร็จ | `done / (done+failed)` | ความน่าเชื่อถือของตำแหน่ง |

ไฟล์ `logs/events.jsonl` เก็บทุกเหตุการณ์ (ยกเว้น progress) → ส่งเข้า BI / คลังข้อมูลเพื่อทำรายงานรายวัน/รายเดือนได้

## 8. โหมด LIVE: การเรียก Claude

- กัปตันและ QA ใช้ `claude-opus-5-5` ทีมงานใช้ `claude-sonnet-5-5` (ปรับใน `.env`)
- ใช้ streaming เสมอ, adaptive thinking (`display: summarized` เพื่อแสดง "กำลังคิด" บน dashboard), `output_config.effort` ตามตำแหน่ง (coder = high)
- แผนงานและผลตรวจ QA ใช้ **structured output** (`output_config.format = json_schema`) จึง parse ได้แน่นอน
- เปิด **server-side fallback** (`fallbacks: "default"`) ให้โมเดลที่รองรับ ถ้าถูก safety classifier ปฏิเสธ ระบบจะลองโมเดลสำรองให้เอง; ถ้ายังปฏิเสธ งานจะ `failed` พร้อมเหตุผล
- Prompt ของแต่ละงานประกอบจาก: system prompt ประจำตำแหน่ง (+ `toolHint` ถ้าตำแหน่งนั้นมีเครื่องมือ) + โจทย์หลัก + รายละเอียดงาน + ผลงานต้นน้ำ + feedback จาก QA (ถ้ามี)

### 8.1 เครื่องมือ (server tools ของ Claude)

พนักงาน AI ไม่ได้ตอบจากความรู้ในโมเดลอย่างเดียว แต่มี **server tools** ที่รันบนฝั่ง Anthropic ทั้งหมด
(เราแค่ส่ง `tools` ไปกับคำขอ ไม่ต้องเขียน tool loop เอง) กำหนดต่อตำแหน่งใน `ROLES[role].tools` ของ `server/agents.js`:

| ตำแหน่ง | เครื่องมือ | `type` ที่ส่งให้ API | ใช้ทำอะไร |
|---|---|---|---|
| researcher | `web_search` + `web_fetch` (`max_uses` 5 ต่อตัว ปรับด้วย `TOOL_MAX_USES`) | `web_search_20260209`, `web_fetch_20260209` | ค้นข้อมูลล่าสุด เปิดอ่านหน้าเว็บ อ้างอิง URL |
| analyst | `code_execution` | `code_execution_20260521` | คำนวณ/จำลองสถานการณ์ด้วย Python ใน sandbox |
| coder | `code_execution` | `code_execution_20260521` | ทดสอบว่าโค้ดต้นแบบรันได้จริงก่อนส่งมอบ |
| writer | — | — | เรียบเรียงจากผลงานของทีมอย่างเดียว |
| reviewer | `web_fetch` (`max_uses` 3) | `web_fetch_20260209` | เปิดตรวจ URL ที่ผลงานอ้างอิงว่ามีอยู่จริง |
| captain | — | — | วางแผน/สังเคราะห์ ไม่ใช้เครื่องมือ |

- ปิดทั้งหมดได้ด้วย `TOOLS_ENABLED=0` (มีผลกับการจำลองเครื่องมือในโหมด sim ด้วย)
- **ข้อจำกัดสำคัญ:** `web_search` ใส่ citations ในคำตอบเสมอ ซึ่งใช้ร่วมกับ structured output ไม่ได้ (API ตอบ 400)
  ตำแหน่งที่ตอบเป็น JSON (reviewer) จึงได้เฉพาะ `web_fetch` (citations ปิดเป็นค่าเริ่มต้น) และ `llm.js` จะตัด `web_search` ออกเองถ้ามี `outputSchema`
- `web_search_20260209` / `web_fetch_20260209` มี dynamic filtering (รันโค้ดกรองผลในตัว) จึง **ไม่** ประกาศ `code_execution` ซ้ำให้ researcher
- ต้นทุน: web search คิด $10 ต่อ 1,000 ครั้ง (`usage.server_tool_use.web_search_requests` → รวมใน `estimateCost`) web fetch และ code execution ไม่คิดเพิ่มเมื่อใช้คู่กับ web tools

**ลำดับเหตุการณ์ระหว่าง stream** (`llm.streamText` → callback `onTool`):

```
content_block_start  server_tool_use (name=web_search)        → onTool { phase: "start" }   → executor: "กำลังค้นเว็บ", นับ toolCalls +1
content_block_delta  input_json_delta ... (สะสม JSON)
content_block_stop   (input ครบ)                                → onTool { phase: "input", summary: "<คำค้น>" } → "กำลังค้นเว็บ: <คำค้น>"
content_block_start  web_search_tool_result (มาครบในก้อนเดียว) → onTool { phase: "result", summary: "พบผลค้นหา n รายการ" }
content_block_delta  text_delta ...                             → onText → "กำลังเขียนผลงาน" (tool = null)
```

block ผลลัพธ์ที่รู้จัก: `web_search_tool_result`, `web_fetch_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`
(ผิดพลาดจะมาเป็น `content.error_code` ด้วย HTTP 200 ไม่ throw)

**การจัดการ `stop_reason: "pause_turn"`:** เมื่อโมเดลใช้เครื่องมือหลายรอบจนถึงลิมิตของ server-side loop API จะหยุดพักและตอบ `pause_turn`
`llm.js` จะ `messages.push({ role: "assistant", content: response.content })` (ทั้งก้อน รวม thinking / server_tool_use / ผลลัพธ์)
แล้วเรียกซ้ำด้วย `tools` ชุดเดิม **โดยไม่เพิ่ม user message** — API เห็น block ท้ายสุดเป็น server tool แล้วทำต่อให้เอง
ทำซ้ำได้สูงสุด `MAX_CONTINUATIONS` (5) รอบ, `usage` ของทุกรอบถูกรวมกัน, ข้อความต่อกันเป็นผลงานเดียว

**การไหลของข้อมูลไปยัง dashboard**

```
llm.onTool → executor.onProgress({ phase, tool, toolStarted }) → orchestrator.progress()
  → recordToolUse() เพิ่ม task.toolCalls / agent.metrics.toolCalls
  → publish task.progress { tool, toolCalls, agentToolCalls }  (และ agent.updated / metrics.updated พก metrics.toolCalls)
  → app.js: ไอคอนใต้ป้ายงานบน canvas, ชิปบนการ์ดงาน, ช่อง "ใช้เครื่องมือ" ใน KPI / การ์ดตัวชี้วัด / drawer
```

โหมด **sim** จำลองลำดับเดียวกัน (`simToolPhases` ใน `executor.js`): นักวิจัยค้นเว็บ 1 ครั้ง + อ่านหน้าเว็บ ~65%,
นักพัฒนารันโค้ด 1-2 ครั้ง, นักวิเคราะห์รันโค้ด ~70% จึงเห็นไอคอนและตัวนับได้โดยไม่ต้องมี API key

## 9. การขยายไปใช้งานจริงในองค์กร

| ด้าน | ต้นแบบนี้ | แนวทางขยาย |
|---|---|---|
| ตำแหน่ง/ทีม | 7 อาชีพใน `DEFAULT_TEAM` (captain, marketer, researcher, finance, engineer, coder, reviewer) + คู่มือทักษะ `server/skills/<role>.md` | ย้ายไปไฟล์/ฐานข้อมูล, เพิ่มตำแหน่งตามแผนก (ขาย, บัญชี, HR), หลายคนต่อตำแหน่ง |
| เครื่องมือ | server tools ของ Claude ต่อตำแหน่ง (web search, web fetch, code execution) | เพิ่ม MCP connector เชื่อมระบบภายใน (ERP, CRM, ไฟล์) และ custom tools ที่รันฝั่งเรา (ต้องเพิ่ม tool loop / tool runner) |
| ความจำ | บริบทต่อโจทย์ | เพิ่ม memory store / RAG ของความรู้องค์กร |
| คิวงาน | in-memory, 1 process | Redis/BullMQ หรือ Vercel Queues; หลาย worker process |
| สถานะ | in-memory | Postgres/SQLite + event sourcing จาก `events.jsonl` |
| สิทธิ์/อนุมัติ | ควบคุมทุกอย่างได้ | เพิ่ม "ด่านอนุมัติแผน" โดยมนุษย์ (แบบ Grok Build), สิทธิ์ตามบทบาท |
| สังเกตการณ์ | SSE + JSONL | ส่ง OpenTelemetry traces/metrics เข้า Grafana/Datadog |
| สภา/debate | QA 1 คน | เพิ่ม reviewer หลายคนให้คะแนนแล้วเฉลี่ย หรือให้ 2 agent ทำคู่ขนานแล้วกัปตันเลือก (แบบ Grok Heavy) |
| ความปลอดภัย | localhost | auth, rate limit, แยก sandbox ต่อ agent เมื่อให้รันโค้ด |

## 12. คู่มือทักษะต่อตำแหน่ง (server/skills/)

แต่ละตำแหน่งมีไฟล์ `server/skills/<role>.md` (captain, marketer, researcher, finance, engineer, coder, reviewer) เก็บ **หน้าที่หลัก ขั้นตอนทำงาน รูปแบบผลงาน เกณฑ์คุณภาพ และข้อห้าม**
แนวคิดเดียวกับ SKILL.md ของ Agent Skills แต่เป็นของระบบนี้เอง: `server/skills.js` โหลดไฟล์ (ไม่เกิน 6,000 ตัวอักษร) แล้ว `executor.js` ต่อท้าย system prompt ของคนในตำแหน่งนั้นในโหมด LIVE
ลำดับใน system prompt: prompt ประจำตำแหน่ง → หน้าที่ของคนนั้น (duties) → คู่มือทักษะ → คำแนะนำเครื่องมือ
แก้ไฟล์แล้วรีสตาร์ตเซิร์ฟเวอร์ (หรือเรียก `reloadSkills()`) ไม่ต้องแตะโค้ด โหมด sim ไม่ใช้ไฟล์นี้

## 11. หน้าที่ต่อคน (duties) และการมอบหมายตามหน้าที่

ทุกคนในทีมมี **หน้าที่** (`Agent.duties`) เป็นข้อความไทย 1 ย่อหน้า แก้ได้ที่ปุ่ม ⚙ ตั้งค่า AI บน dashboard (`POST /api/agents/:id/config {duties}`)
ค่าที่แก้ถูกบันทึกลง `data/team.json` (พร้อมโมเดล/ความลึก/เครื่องมือ) และโหลดกลับเมื่อรีสตาร์ต (`server/team-store.js`)

หน้าที่ถูกใช้ 3 จุด:

| จุด | ทำอย่างไร |
|---|---|
| กัปตันวางแผน (live) | `planPrompt` แนบรายชื่อทีม + หน้าที่ของทุกคน และ `PLAN_SCHEMA` บังคับให้ทุกงานระบุ `assignee` (id ของคนที่หน้าที่ตรง) — `normalizePlan` ตรวจว่า id มีจริงและตำแหน่งตรง ถ้าไม่ตรงจะเลือกให้ด้วย `suggestAssignee` |
| กัปตันวางแผน (sim) | `suggestAssignee(role, text)` นับคำในหน้าที่ของแต่ละคนที่ปรากฏในชื่อ/รายละเอียดงาน → คนที่ตรงที่สุด (เช่น งาน "ค้นข้อมูลพื้นฐาน" → ริน, งาน "คู่เทียบ" → ต้น) |
| คนทำงาน | system prompt ของแต่ละคน = prompt ประจำตำแหน่ง + "หน้าที่ประจำของคุณ: …" (+ คำแนะนำเครื่องมือ) จึงทำงานในขอบเขตหน้าที่และบอกเมื่อควรส่งต่อ |

ผลของแผนเก็บใน `Task.preferredAgentId` → ตัวจัดคิวให้คนนั้นก่อน (รอถ้ากำลังยุ่ง ข้ามถ้าหยุดพัก) ไทม์ไลน์ของงานบันทึก "กัปตันเลือก … ตามหน้าที่" และ log มอบหมายระบุ "ตามหน้าที่"
การส่งต่อด้วยมือและ QA ส่งกลับ (`pinnedAgentId`) ยังมีลำดับความสำคัญสูงกว่าเสมอ

## 10. วิธีเพิ่มตำแหน่งใหม่ (ตัวอย่าง: "นักการตลาด")

1. เพิ่มใน `ROLES` ของ `server/agents.js`: `marketer: { label: "นักการตลาด", emoji: "📣", color: "#ff9f1c", system: "...", tools: [TOOL.webSearch], toolHint: "..." }`
   (`tools` = server tools ที่ใช้ได้, เว้นเป็น `[]` ถ้าไม่ใช้; `toolHint` ต่อท้าย system prompt เมื่อมีเครื่องมือ)
2. เพิ่มคนใน `DEFAULT_TEAM`: `{ id: "mkt-1", name: "เมย์", role: "marketer", model: WORKER_MODEL, duties: "วางแผนการตลาด …" }` (ถ้าตำแหน่งเดียวกันมีหลายคน ให้เขียนหน้าที่ให้ต่างกันชัด กัปตันจะได้แบ่งงานถูก)
3. เพิ่ม `"marketer"` ใน `VALID_ROLES` และ `SIM_PHASES` ของ `server/executor.js` (และเทมเพลตผลงานใน `simOutput`; ถ้าอยากให้โหมด sim จำลองการใช้เครื่องมือ เพิ่มใน `simToolPhases` ด้วย)
4. อัปเดต `planPrompt()` ให้กัปตันรู้ว่ามีตำแหน่งนี้

## 13. ใช้กับโปรเจกต์อื่น (Project Pack)

ระบบนี้เป็น "แม่แบบ" ที่ไม่ผูกกับโปรเจกต์ใด ส่วนที่เปลี่ยนตามโปรเจกต์ถูกแยกออกไปอยู่ในโฟลเดอร์ `.grock/` ของโปรเจกต์นั้น (brief, ไฟล์ที่ให้อ่าน, ตำแหน่งที่ใช้ได้, โมเดล/หน้าที่/ทักษะเฉพาะ, งบ) ส่วนกลไกกลาง (กัปตัน, คิว, QA, handoff, ตัวชี้วัด, เครื่องมือ) ใช้ร่วมกันทุกโปรเจกต์

- เอกสารของโปรเจกต์เข้า prompt ในฐานะ **ข้อมูลอ้างอิง** (บล็อก `<project_files>` ใน user message) ไม่ใช่คำสั่ง มีเพียง `brief.md` และ `roles.*.instructions` ที่เป็นคำสั่งใน system prompt
- บริบทถูก freeze ต่อโจทย์ ทุกงาน (รวมรอบแก้ของ QA) เห็นบริบทเดียวกัน และบล็อกบริบทถูก cache
- ค่าเริ่มต้นทีมไม่แก้ไฟล์ของโปรเจกต์ ผลงานทั้งหมดเป็นไฟล์ใน `.grock/out/<jobId>/` เมื่อโปรเจกต์ให้สิทธิ์ใน `permissions.<agentId>` ตำแหน่ง Developer จะแก้ไฟล์จริงได้ผ่าน adapter `server/apply.js` (Claude Code headless ใน sandbox → patch รออนุมัติ → apply/ปฏิเสธบน dashboard) — เป็นแบบอย่างของกติกา "เครื่องมือที่แตะไฟล์/ฐานข้อมูล/ระบบจริงต้องมี adapter กำหนดสิทธิ์เป็นรายเอเจนต์ และมีบันทึกตรวจสอบย้อนหลัง" (`task.history`, `logs/events.jsonl`, `job.json`, `patches/*.json`)

วิธีใช้ การตั้งค่า และข้อควรระวังด้านความปลอดภัยอยู่ใน [07-projects.md](07-projects.md)
