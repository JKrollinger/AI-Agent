# สเปกฉาก "เมืองมอร็อค" แบบไอโซเมตริกบน dashboard — Scene Spec

อ้างอิงจากวีดีโอตัวอย่างของผู้ใช้ (ระบบ Command Center แบบออฟฟิศไอโซเมตริก: มีห้อง/แผนก ตัวละครประจำโต๊ะ
ป้ายชื่อ+สถานะลอยเหนือหัว) แต่เปลี่ยนเป็น **เมืองมอร็อค (Morroc) ในทะเลทราย** และตัวละครเป็นอาชีพ Hi-class สไตล์ Ragnarok
พฤติกรรมเดิมของ dashboard ต้องครบ: คลิกตัวละครเปิด drawer, hover ไฮไลต์, เห็นชื่องาน/เฟส/% ของทุกคน, แอนิเมชันส่งงาน/ส่งต่อ/ส่งผลงาน, เอฟเฟกต์ตอนโจทย์เสร็จ

## 1. ไฟล์ (ขอบเขตของทีม scene)

- **ใหม่** `public/scene.js` — ES module `export function createScene(canvas, S, hooks)` คืน
  `{ ready, layout(), spawnPacket(fromId,toId,label,color,kind), emote(agentId,type), fx(agentId,type), burst(agentId), hit(x,y), setHover(id), spriteDataUrl(jobId, anim, frame, scale), destroy() }`
  - `S` = state ของ app.js (อ่าน `S.agents` Map, `S.tasks` Map, `S.totals`) — อ่านอย่างเดียว
  - `hooks.onClick(agentId|null)`, `hooks.onHover(agentId|null)`
- **ใหม่** `public/morroc-map.js` — ข้อมูลแผนที่ (ขนาด, ground, props, zones, spots) แยกจากโค้ดวาด แก้ผังเมืองได้โดยไม่แตะ engine
- **ใหม่** `public/scene-test.html` — หน้าทดสอบ standalone: mock `S` ที่มีพนักงาน 7 คน (captain + 6) สถานะวนเปลี่ยน idle→working→paused, งานที่ progress วิ่ง, เรียก `spawnPacket/emote/fx/burst` เป็นระยะ, ปุ่มกดทดสอบแต่ละเอฟเฟกต์ — เปิดที่ `http://127.0.0.1:3789/scene-test.html` ได้โดยไม่ต้องแก้ app.js
- **ห้ามแก้** `public/app.js`, `public/styles.css`, `public/index.html`, `server/*`, `public/sprites/*` (ทีมอื่นทำพร้อมกัน) — การต่อเข้า app.js จะทำทีหลังตามข้อ 7

## 2. สไปรต์ที่ใช้ (รูปแบบใน `docs/03-sprite-spec.md`)

- ตัวละคร `public/sprites/<jobId>.js` (24x32, anchor เท้า, `frames.idle/work/sit`, `station`, `effect`) ; `common.js` (items/emotes/fx) ; tileset โหลดและรวม `tiles`/`props` จาก 3 ไฟล์: `morroc-ground.js` (tiles + props เล็ก), `morroc-buildings.js` (well, wall, wallCorner, gate, palm, pyramid, stall) และ `morroc-buildings2.js` (tower, domeHouse, house, forge, temple, shelf) — ไฟล์ไหนยังไม่มีให้ข้ามและใช้ fallback
- `jobId` จาก `agent.jobId` ถ้าไม่มี map จาก role: captain→`lord-knight`, researcher→`sniper` (คนแรก)/`stalker` (คนถัดไป), analyst→`high-wizard`, writer→`professor`, coder→`whitesmith`, reviewer→`high-priest`
- โหลด `import("./sprites/<id>.js")` lazy; ล้มเหลว → ตัวละครใช้ `_base.js`, tileset/common ใช้ fallback วาดด้วยโค้ด (สี่เหลี่ยมขนมเปียกปูนสีทราย, วงกลม, ตัวอักษร) เพื่อให้ฉากทำงานได้ก่อนสไปรต์จริงจะมา
- พรีเรนเดอร์ทุกเฟรมเป็น offscreen canvas ต่อ (layer, anim, frame, scale) จาก `ImageData`; `ctx.imageSmoothingEnabled=false`; วาดที่พิกัดจำนวนเต็ม

## 3. ไอโซเมตริก

- กระเบื้องขนาดฐาน `TW=32, TH=16` (ที่ scale 1) ; แผนที่ `W=20 x H=20` กระเบื้อง (ค่าจริงใน `morroc-map.js`)
- **หมายเหตุการ implement จริง (scene.js):** `V.scale` เป็นทศนิยม 1.1–3 เพื่อให้แผนที่เต็มพื้นที่ ส่วนพื้นกระเบื้องเรนเดอร์ครั้งเดียวที่ scale จำนวนเต็ม `V.px` ลง offscreen แล้วย่อ/ขยายทั้งผืน จึงไม่มีรอยต่อ ; ตัวละคร/สถานี/เอฟเฟกต์วาดที่ `V.scale × 1.6` (CHAR_SCALE) ให้ใหญ่กว่ากระเบื้องแบบ RO
- กระเบื้อง `(tx,ty)` → จุดกึ่งกลางบนจอ `sx = ox + (tx - ty) * TW/2 * scale`, `sy = oy + (tx + ty) * TH/2 * scale`
- สไปรต์พื้น 32x16 วางให้กึ่งกลางของมันอยู่ที่ `(sx, sy)` ; วัตถุ/ตัวละครวาง `anchor` ที่ `(sx, sy)` (ฐานของวัตถุอยู่กลางกระเบื้อง)
- ลำดับวาด: พื้นทั้งหมดเรียงตาม `tx+ty` → แล้ววัตถุ+ตัวละคร+สถานี เรียงตาม `(tx+ty)` รอง `ty` (painter's algorithm) → เอฟเฟกต์/ไอเท็มบิน → UI ซ้อนทับ
- `scale` = จำนวนเต็มใหญ่สุดที่ทำให้แผนที่ทั้งผืน (กว้าง `W*TW`, สูง `(W+H)*TH/2 + 80` สำหรับตึกสูง) พอดี canvas (ขั้นต่ำ 1, สูงสุด 3) ; `ox,oy` จัดกึ่งกลาง ; รองรับ devicePixelRatio เหมือนเดิม
- นอกขอบแผนที่: ไล่สีทะเลทรายเข้ม (ท้องฟ้ายามเย็น #2b1d2e → ทราย #3a2a1c) + เงาปิรามิด/เนินทรายไกล ๆ (prop `pyramid`) ที่มุมบน

## 4. ผังเมือง (ใน `morroc-map.js`)

โซน = พื้นที่สี่เหลี่ยมของกระเบื้อง มีป้ายชื่อโซนลอย (pill สีประจำโซน ขอบดำ ตัวอักษรขาว เหมือนป้ายห้องในวีดีโอ) และ "spot" จุดยืนของพนักงาน

| zone id | ป้าย | ผู้ประจำ | พื้น | props รอบ ๆ |
|---|---|---|---|---|
| plaza | ลานกลางเมือง · บัญชาการ | lord-knight (กัปตัน) | หินปูพื้น + พรมแดงขอบทอง | น้ำพุ/บ่อน้ำ (well) กลางลาน, เสาไฟ (brazier) 4 มุม |
| gate | ประตูเมือง · หน่วยสอดแนม | sniper, stalker | ทราย | ประตูเมือง/กำแพงหิน (wall, gate), ลังไม้ (crates), ต้นปาล์ม |
| tower | หอเวทมนตร์ · วิเคราะห์ | high-wizard | ทรายเข้ม/หินวงกลม | หอคอย (tower), วงเวทบนพื้น (จาก station ของ wizard) |
| library | ห้องสมุด · เอกสาร | professor | หินปูพื้น | อาคารโดม (domeHouse), ชั้นม้วนกระดาษ (shelf) |
| forge | โรงตีเหล็ก · พัฒนา | whitesmith | ทรายเข้ม | โรงตีเหล็กมีเตา (forge), ทั่ง (จาก station), ลัง |
| temple | วิหาร · ตรวจสอบ | high-priest | หินอ่อนสว่าง | วิหารเล็ก (temple), เทียน/แท่นบูชา (จาก station) |
| oasis | โอเอซิส (ตกแต่ง) | – | น้ำ (animate 2 เฟรม) | ปาล์ม, กระบองเพชร |

- จัดโซนรอบ plaza ให้ทุก spot ห่างกันพอวางป้ายชื่อ (อย่างน้อย 4 กระเบื้อง) ; spot ของพนักงานอยู่ "หน้า" สถานีของเขา (สถานีจาก `sprite.station` วางที่กระเบื้องถัดไปด้านหลัง/ข้าง)
- ระบุ `spots: { "lord-knight":[tx,ty], "sniper":[..], "stalker":[..], "high-wizard":[..], "professor":[..], "whitesmith":[..], "high-priest":[..] }` และ `spareSpots` อีก 4 จุดสำหรับพนักงานที่เพิ่มภายหลัง
- ชื่อ tile/prop ที่ engine คาดหวังจาก tileset (ถ้าไม่มีให้ fallback): tiles `sand, sand2, sandDark, stone, stoneLight, carpet, carpetEdgeN/E/S/W, carpetCorner*, water[2 เฟรม]` ; props `well, brazier[2 เฟรม], wall, wallCorner, gate, crates, palm, cactus, tower, domeHouse, house, stall, forge[2 เฟรม], temple, shelf, pyramid, rug`

## 5. ตัวละครและ UI ซ้อนทับ

- idle → `frames.idle` (เฟรมเดียวให้โยก y ±1 px ทุก 500ms) ; working → `frames.work` สลับทุก 180ms + `effect` loop 150ms ซ้อน + สถานีเฟรม 2 (ถ้ามี) ; paused → `frames.sit` + อีโมต `sleep` ทุก 2.5 วิ
- กัปตันมีวงแหวนออร่าทองบนพื้นใต้เท้า pulsing ; hover → เรืองแสง (วาดซ้ำ `globalCompositeOperation="lighter"` alpha 0.25) + cursor pointer
- เงารีดำโปร่ง 35% ใต้เท้าทุกตัว
- **ป้ายชื่อแบบ RO** ใต้เท้า: ชื่อ (ขาว หนา 12px ขอบดำ `strokeText`), บรรทัดถัดไป `job` สีทอง `#ffd86b` 10px · ตำแหน่งไทย สีเทาอ่อน ; ใต้นั้น **HP bar** (เขียว = ความคืบหน้างาน, ไม่มีงาน = เต็ม) และ **SP bar** (น้ำเงิน = `computed.utilization`) กว้าง 60px สูง 5px ขอบดำ ; paused → เทา
- **ป้ายสถานะลอยเหนือหัว** (สไตล์วีดีโอ: pill มืดโปร่ง): `ชื่อ · ว่าง` / `ชื่อ · กำลังทำ 45%` / `ชื่อ · หยุดพัก` — อยู่สูงสุด
- **Cast bar** ตอน working ใต้ป้ายสถานะ: กล่องดำโปร่ง กว้าง ~84px สูง 12px ขอบเขียว ชื่องาน (ตัดที่ 18 ตัวอักษร) เติมสีเขียวตาม progress + "%"
- **กล่องแชต** (ขาวมุมมน มีหาง ตัวอักษรดำ 11px กว้างสุด 160px ตัด 2 บรรทัด): `agent.phase` + จุดวิ่ง ". .. ..." ; captain idle → "พร้อมรับโจทย์" / มีคิว → "คิวงาน N ชิ้น" (จาก `S.totals.queued`)
- **อีโมต** (`emote(agentId,type)` จาก `common.emotes`): `alert` รับงาน, `question` ถูกส่งต่อ, `dots` คิด, `sleep` พัก, `angry` QA ไม่ผ่าน, `heart` เสร็จ/ผ่าน — เด้งขึ้น 0.4s ค้างรวม 1.4s
- **ไอเท็มบิน** (`spawnPacket`): `items.scroll` (assign/handoff) หรือ `items.letter` (return) วิ่ง quadratic bezier จากหัวผู้ส่งไปหัวผู้รับ มีเงาเล็กบนพื้น + ป้าย label (handoff ใส่ 🔁 นำหน้า) ; ถึงปลายทาง → ripple + `alert` บนผู้รับ ; 1000ms (handoff 1400ms)
- **FX** (`fx(agentId,type)` จาก `common.fx` หรือวาดด้วยโค้ด): `levelup` ออร่าทองขยาย+ประกาย ~700ms, `bless` แสงลงจากบน ~600ms, `fail` กากบาทแดง ~500ms
- `burst("captain")`: ข้อความ "LEVEL UP!" ทองขอบดำลอยขึ้น + อนุภาคทองร่วง 1.5s + `fx levelup`

## 6. เหตุการณ์ (app.js จะเรียกแบบนี้ตอนต่อเข้า — scene ต้องรองรับ)

| เหตุการณ์ SSE | เรียก |
|---|---|
| `snapshot` | `layout()` + preload สไปรต์ของทุกคน |
| `task.assigned {from,to,task}` | `spawnPacket(from||"captain", to, trunc(title,26), color, from!=="captain"?"handoff":"assign")` |
| `task.completed {from}` | `spawnPacket(from,"captain","ส่งผลงาน ✓",color,"return")` + `emote(from,"heart")` |
| `task.handoff {from,to,manual}` | `emote(from, manual?"question":"angry")` |
| `task.review {approved,task}` | approved → `fx(task.assignedTo,"bless")` ; ไม่ผ่านรอบสุดท้าย → `fx(...,"fail")` |
| `task.failed {task}` | `fx(agent,"fail")` + `emote(agent,"question")` |
| `agent.updated` / `task.progress` | ไม่ต้องเรียก — scene อ่าน `S` ทุกเฟรม |
| `job.completed` | `burst("captain")` |

## 7. ต่อเข้า app.js (ทำทีหลังโดยทีมอื่น — scene ต้องเตรียม API ให้พร้อม)

- app.js จะลบโค้ด canvas เดิมแล้วเรียก `createScene(canvas, S, {onClick})` ; ใช้ `spriteDataUrl(jobId,"idle",0,2)` แทนอีโมจิใน drawer/การ์ด
- เลย์เอาต์ใหม่ตามวีดีโอ: แผงรายชื่อพนักงานซ้าย (ชื่อ · โซน · สถานะ · % · เสร็จวันนี้ N งาน), แผนที่กลาง, งาน/บันทึกขวา-ล่าง — **ไม่ใช่หน้าที่ของทีม scene**

## 8. คุณภาพ

- 60fps ที่ 1440x900 ; ไม่สร้าง object ใหม่ทุกเฟรมโดยไม่จำเป็น ; `node --check public/scene.js public/morroc-map.js` ผ่าน ; หน้า scene-test.html ไม่มี error ใน console
- โค้ดอังกฤษ คอมเมนต์ไทยสั้น ตามสไตล์เดิม ; ไม่ใช้ไลบรารีภายนอก
