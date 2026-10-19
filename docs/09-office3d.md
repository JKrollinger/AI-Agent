# ออฟฟิศ 3 มิติ (Office3D) — ทีม AI ในร่างคนจริง

หน้าเว็บแสดงทีม AI ทั้ง 7 คนเป็นคน 3 มิติในออฟฟิศ ตำแหน่งและท่าทางของแต่ละคนเปลี่ยนตามสถานะงานจริงที่ส่งมาจากเซิร์ฟเวอร์ (SSE `/api/events` ชุดเดียวกับ dashboard หลัก)
เช่น ได้รับงานแล้วเดินไปรับจากกัปตัน กลับมานั่งพิมพ์ที่โต๊ะ ส่งผลงานแล้วเดินไปหากัปตัน และเมื่อว่างก็ลุกไปพักกาแฟหรือนั่งโซฟา

- **ในแดชบอร์ดหลัก:** เปิด http://127.0.0.1:3789 แล้วกดปุ่ม **🏢 ออฟฟิศ 3D** มุมขวาบนของเวที (สลับกลับด้วย **🏜️ มอร็อค 2D**) เบราว์เซอร์จำมุมมองที่เลือกไว้ (`localStorage` คีย์ `grock.view`) ฉาก 3 มิติโหลดเมื่อเลือกครั้งแรกเท่านั้น และหยุดแอนิเมชันเมื่อสลับกลับไป 2 มิติเพื่อประหยัดเครื่อง
  แตะตัวละคร → เปิด drawer รายละเอียดของคนนั้น (ตัวเดียวกับที่คลิกในแผนที่ 2 มิติ/แผงรายชื่อ) · เลือกคนจากแผงรายชื่อ/การ์ด → วงเลือกในฉากตามไป
- หน้าเดี่ยว: `npm start` แล้วเข้า **http://127.0.0.1:3789/office3d/index.html** (มีนาฬิกา + สถานะการเชื่อมต่อมุมขวาบน และการ์ดข้อมูลเมื่อแตะตัวละคร)
- ดูแบบไม่ต่อเซิร์ฟเวอร์ (โหมดสาธิต): `/office3d/index.html?demo=1`
- ถ้าเซิร์ฟเวอร์ไม่ตอบภายใน 4 วินาที หน้าเว็บจะเปลี่ยนเป็นโหมดสาธิตเอง และแสดงสถานะในกล่องนาฬิกา
- พารามิเตอร์ของ `index.html`: `?embed=1` ซ่อนนาฬิกา/การ์ดข้อมูล/คำใบ้ (แดชบอร์ดใช้) · `?theme=dark|light` บังคับธีม (ปกติตาม `prefers-color-scheme`) · `?events=<url>` ใช้ SSE อื่น

## 1. ไฟล์

| ไฟล์ | หน้าที่ | ใครแก้ |
|---|---|---|
| `public/office3d/index.html` | โครงหน้า, CSS, นาฬิกา/สถานะ, การ์ดข้อมูล, ลำดับการโหลดสคริปต์ (ไม่มีแผงปุ่มควบคุม — สั่งผ่าน API แทน) | แก้เมื่อเปลี่ยนหน้าตา |
| `public/office3d/config.js` | **ทีม, โต๊ะ, โมเดล, พฤติกรรม** — แก้ที่นี่เป็นหลัก | ผู้ใช้/AI |
| `public/office3d/office3d.js` | ฉาก 3 มิติทั้งหมด + ระบบเดิน + ผู้กำกับ (director) + `window.Office3D` API | แก้เมื่อเพิ่มความสามารถใหม่ |
| `public/office3d/bridge.js` | แปลง event จากเซิร์ฟเวอร์เป็นคำสั่ง `Office3D.*` | แก้เมื่อเพิ่ม/เปลี่ยน event ในระบบ |
| `public/office3d/models/*.json, *.jpg, *.png` | ตัวละคร Mixamo ที่แปลงแล้ว (glTF แบบ JSON + ภาพพื้นผิว) — **ไม่อยู่ใน git** (ดู §5) | สร้างด้วย `tools/office3d` |
| `public/office3d/vendor/*` | three.js r128 + OrbitControls + GLTFLoader + SkeletonUtils (ใช้ได้แบบออฟไลน์) | ไม่ต้องแก้ |
| `tools/office3d/convert-mixamo.mjs` | แปลงโฟลเดอร์ FBX จาก Mixamo เป็นไฟล์ใน `models/` | — |

ฝั่งระบบเดิมแตะน้อยมาก: `server/index.js` เพิ่มชนิดไฟล์ `.jpg` (ภาพพื้นผิว) และแดชบอร์ด (`public/index.html` + `app.js` + `styles.css`) เพิ่ม iframe `#office3d`, ปุ่มสลับมุมมอง `#viewSwitch` และตัวรับ/ส่ง `postMessage` (ดู §4) — ตรรกะของเซิร์ฟเวอร์ไม่เปลี่ยน

## 2. ระบบขับตัวละครอย่างไร

### สถานะเอเจนต์ → พฤติกรรม (ทุกคน ทุกเวลา)

| `agent.status` จากเซิร์ฟเวอร์ | สิ่งที่เห็นในฉาก |
|---|---|
| `working` | เดินกลับโต๊ะ (ถ้าไม่อยู่) แล้วนั่งพิมพ์ ป้ายเหนือหัวแสดงชื่องาน เฟส เครื่องมือที่ใช้ และ % ความคืบหน้า |
| `idle` | ป้ายขึ้น "ว่าง" นั่งพักที่โต๊ะ และลุกไปพักกาแฟ/โซฟา/คุยโทรศัพท์/เครื่องพิมพ์เป็นครั้งคราว (ปรับความถี่ที่ `idleBreaks`) |
| `paused` | ไปนั่งพักที่โซฟา ป้ายขึ้น "หยุดพัก" แถบสีเทา |

ถ้าได้งานใหม่ระหว่างกำลังเดินไปพัก จะหันกลับไปโต๊ะทันที

### Event → การเคลื่อนไหว (`bridge.js`)

| Event | ฉาก |
|---|---|
| `snapshot` | ตั้งสถานะทุกคนตามระบบ |
| `agent.updated`, `task.progress` | อัปเดตชื่องาน เฟส % และเครื่องมือ (🔎 ค้นเว็บ, 🌐 อ่านหน้าเว็บ, ⚙️ รันโค้ด, 🛠️ Claude Code) |
| `task.assigned` | ผู้รับงานเดินไปหาคนมอบงาน (ปกติคือกัปตัน) คุยสั้น ๆ แล้วกลับมาทำงาน + บับเบิล "รับงาน: …" |
| `task.completed` | คนทำเดินไปส่งผลงานให้กัปตัน + บับเบิล "ส่งผลงาน ✓" |
| `task.handoff` | ผู้รับงานส่งต่อเดินไปหาผู้ส่ง + บับเบิลพร้อมคะแนน QA |
| `task.review` | บับเบิล "QA ผ่าน 92" หรือ "QA ให้แก้ 61" เหนือคนทำงาน |
| `task.failed` (ไม่ retry) | บับเบิล "งานล้มเหลว" |
| `job.created` | กัปตันเข้าห้องประชุมไปวางแผน (ค้างจนกว่าจะ `job.planned`) |
| `job.planned`, `job.completed`, `job.failed` | กัปตันออกจากห้องประชุม; งานเสร็จมีบับเบิล "🎉 งานเสร็จสมบูรณ์" |

เปิด/ปิดแต่ละพฤติกรรมได้ที่ `reactions` ใน `config.js`

## 3. ปรับแต่งด้วย `config.js`

- `team` — หนึ่งรายการต่อเอเจนต์ **`id` ต้องตรงกับ id ใน `server/agents.js` (`DEFAULT_TEAM`)** เช่น `captain`, `mkt-1`
  ลำดับในรายการ = ลำดับโต๊ะใน `desks`; `model` ชี้ไปที่ไฟล์ใน `models/`; `look` คือสีของตัวละครสำรอง (ใช้ระหว่างโหลดหรือเมื่อไม่มีโมเดล)
- `desks` — ตำแหน่งโต๊ะ `[x, z, ฝั่งที่นั่ง]` หน่วยเมตร พื้นออฟฟิศอยู่ที่ x −13…13, z −9…9 ทางเดินหลักอยู่ที่ z = 0 และทางเดินขวางที่ x = −12, −8, −4, 0, 2 จึงควรวางโต๊ะระหว่างทางเดินเหล่านี้
- `idleBreaks` — โอกาสที่คนว่างจะลุกไปพักแต่ละแบบ (ตั้งเป็น 0 ทั้งหมด = นั่งที่โต๊ะตลอด)
- `reactions` — เปิด/ปิดการเดินตาม event
- `clock` — `"real"` ใช้เวลาจริงคำนวณแสงแดด (09:00–18:00), `"sim"` ใช้นาฬิกาเร่ง
- `visitor.enabled` — แขกที่ขึ้นลิฟต์มาติดต่อ (เปิด/ปิด)
- `allowedOrigins` — จำกัดว่าหน้าไหนส่งคำสั่งผ่าน `postMessage` ได้ (เมื่อฝังใน iframe)

**เพิ่มคนในทีม:** เพิ่มรายการใน `team` และเพิ่มตำแหน่งโต๊ะใน `desks` ให้จำนวนเท่ากัน เอเจนต์ที่มีในเซิร์ฟเวอร์แต่ไม่มีใน `team` จะไม่แสดงในฉาก

## 4. API สำหรับสั่งงานเอง (`window.Office3D`)

ใช้จาก console ของเบราว์เซอร์ จากสคริปต์ในหน้าเดียวกัน หรือจากหน้าแม่ผ่าน `postMessage` เมื่อฝังใน iframe
`id` รับได้ทั้ง agent id (`mkt-1`), jobId (`sniper`) หรือชื่อ (`Sniper`)

| คำสั่ง | ความหมาย |
|---|---|
| `setMode('live' \| 'demo')` | live = ทำตามสถานะจริง, demo = เดินเล่นเอง |
| `setAgent(id, {status, task, progress, phase, tool, name, role, stats:{done,cost}})` | อัปเดตสถานะหนึ่งคน (`progress` 0–1) |
| `visit(fromId, toId, secs=4)` | เดินไปที่โต๊ะอีกคน คุย `secs` วินาที แล้วกลับไปทำต่อ |
| `goTo(id, place)` | ส่งไปที่ `desk` · `meeting` · `coffee` · `printer` · `lounge` · `phone` |
| `hold(id, place, secs=null)` / `release(id)` | ให้อยู่ที่จุดนั้นตามเวลา (`null` = จนกว่าจะ release) |
| `gather([ids], secs=30)` | เรียกหลายคนเข้าห้องประชุม (ทยอยเดินทีละคน) |
| `say(id, text, secs=3)` | บับเบิลข้อความเหนือป้ายชื่อ |
| `agents()` | รายชื่อพร้อมสถานะและตำแหน่งปัจจุบัน |
| `select(id)` | เปิดการ์ดข้อมูลของคนนั้น |
| `on('select', fn)` | ถูกเรียกเมื่อผู้ใช้แตะตัวละคร `fn({agentId, name})` (แตะพื้นว่าง = `null`) |
| `on('ready', fn)` | ฉากพร้อมแล้ว `fn({version, mode, agents:[ids]})` — หน้าแม่เริ่มส่งคำสั่งได้ |
| `setSpeed(1–4)`, `pause(true/false)` | ความเร็ว/หยุดแอนิเมชัน (แดชบอร์ดสั่ง `pause(true)` เมื่อซ่อนฉาก) |
| `setAutoRotate(on)`, `showRings(on)`, `showTags(on)` | หมุนกล้องอัตโนมัติ · วงสถานะที่พื้น · ป้ายชื่อ (แทนปุ่มบนหน้าที่เอาออกแล้ว — ถ้าอยากได้ปุ่มคืน ใส่ element id `b-pause`, `[data-speed]`, `b-rotate`, `b-rings`, `b-tags` แล้ว `office3d.js` จะผูกให้เอง) |

ตัวอย่าง: `Office3D.gather(['captain','mkt-1','res-1'], 45); Office3D.say('captain', 'ประชุมสรุปแคมเปญ');`

### การฝังในแดชบอร์ดหลัก (ทำไว้แล้วใน `public/app.js`)

แดชบอร์ดฝังหน้านี้เป็น `<iframe id="office3d">` ซ้อนบน canvas ของฉาก 2 มิติในเวทีเดียวกัน แล้วคุยกันด้วย `postMessage`:

| ทิศทาง | ข้อความ | ความหมาย |
|---|---|---|
| แม่ → ลูก | `{type:"office3d", cmd:"<ชื่อเมธอด>", args:[…]}` | เรียก `Office3D[cmd](...args)` ได้ทุกเมธอดในตารางข้างบน |
| ลูก → แม่ | `{type:"office3d:ready", data:{version, mode, agents}}` | ฉากพร้อม — `app.js` ตั้ง `ready` แล้วส่ง `pause` ตามว่ามุมมอง 3 มิติแสดงอยู่ไหม |
| ลูก → แม่ | `{type:"office3d:select", data:{agentId, name}}` หรือ `data:null` | ผู้ใช้แตะตัวละคร → `openDrawer("agent", agentId)` · แตะพื้นว่าง (`null`) → ปิด drawer |

สิ่งที่ `app.js` ทำ: `setView("2d"|"3d")` สลับ class `view-3d` ของ `#stage` (ซ่อน canvas/legend 2 มิติด้วย `visibility` เพื่อให้ขนาด iframe คงที่), ตั้ง `src` ของ iframe เป็น `office3d/index.html?embed=1&theme=dark` เมื่อเลือกครั้งแรก, จำค่าลง `localStorage["grock.view"]`, ส่ง `pause(true/false)` ตอนสลับ; `focusAgent(id)` (คลิกแผงรายชื่อ/การ์ด) เปิด drawer แล้วส่ง `select(id)` ให้ฉากวงเลือกตาม; `closeDrawer()` ส่ง `select(null)` ล้างวง (มี `S.sceneSel` กันคำสั่งวนไปมา)
หน้าแม่รับเฉพาะข้อความที่ `e.source` คือ iframe ของตัวเองและ `e.origin === location.origin`; ฝั่งลูกรับคำสั่งเฉพาะจาก origin เดียวกัน (ค่าเริ่มต้นเมื่อ `allowedOrigins` ว่าง) — ถ้าจะฝังจากโดเมนอื่น ให้ใส่ origin นั้นใน `config.js`

iframe เชื่อม `/api/events` ของตัวเองอยู่แล้ว จึงไม่ต้องส่งสถานะจาก `app.js` เข้าไป

### ฝังในหน้าอื่น

```html
<iframe id="office3d" src="/office3d/index.html?embed=1&theme=dark" style="width:100%;height:520px;border:0"></iframe>
<script>
  const frame = document.getElementById("office3d");
  const send = (cmd, ...args) => frame.contentWindow.postMessage({ type: "office3d", cmd, args }, location.origin);
  addEventListener("message", (e) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    if (e.data?.type === "office3d:ready") send("say", "captain", "สวัสดีทีม");
    if (e.data?.type === "office3d:select" && e.data.data) console.log("แตะ", e.data.data.agentId);
  });
</script>
```

## 5. เพิ่มหรือเปลี่ยนตัวละคร (Mixamo)

1. เข้า mixamo.com เลือกตัวละคร โหลดท่าแรกแบบ **FBX Binary · With Skin · 30 fps** ท่าที่เหลือโหลดได้ทั้งแบบ With Skin หรือ Without Skin
   ท่าเดินให้ติ๊ก **In Place** ก่อนโหลด แล้วเก็บไฟล์ทั้งหมดในโฟลเดอร์เดียว เช่น `public/sprites/png/<jobId>/`
2. แปลงไฟล์:
   ```
   cd tools/office3d
   npm install
   node convert-mixamo.mjs ../../public/sprites/png/<jobId> <jobId>
   ```
   ชื่อไฟล์ท่าเป็นตัวกำหนดว่าใช้ตอนไหน: `Typing` → ทำงาน · `Walking`/`Happy Walk`/`Texting And Walking` → เดิน · `Having A Meeting`/`Sitting Talking`/`Asking Question` → ประชุม · `Sitting Idle` → โซฟา · `Sitting` / `Sitting Drinking` → ย่อตัวนั่ง · `Drinking` → กาแฟ · `Talking On Phone`/`Talking Phone Pacing` → โทรศัพท์ · `Talking` → คุยงาน · `…Idle` → ยืนรอ
   ท่าที่ขาด ระบบใช้ท่าใกล้เคียงแทนเอง (ดู `CLIP_FOR` ใน `office3d.js`)
3. แก้ `config.js` ให้คนนั้นชี้ไปที่ไฟล์ใหม่: `model: { file: "<jobId>.json", height: 1.75 }` (`height` คือส่วนสูงจริงเป็นเมตร ระบบใช้ปรับขนาดตัวและความสูงตอนนั่ง)

**ไฟล์โมเดลไม่อยู่ใน git** — `public/office3d/models/*` ถูก ignore (ไฟล์ละ 3–6 MB รวม ~40 MB และอยู่ภายใต้เงื่อนไขของ Adobe) เหมือนภาพจากเกมใน `public/sprites/png/` มีแค่ `models/README.md` ที่ตามไปใน git พร้อมตารางชื่อไฟล์ที่ต้องมี
เครื่องใหม่ให้คัดลอกโฟลเดอร์ `models/` จากเครื่องเดิมมาวาง หรือแปลงใหม่ตามขั้นตอนข้างบน (ตัวแปลง FBX2glTF ที่โหลดมาอยู่ที่ `tools/office3d/.bin/` ซึ่งถูก ignore เช่นกัน) ส่วน `vendor/` (three.js r128 ~730 KB) อยู่ใน git ตามปกติ
ถ้าไม่มีไฟล์โมเดล ฉากยังเปิดได้ด้วยตัวละครสำรองที่สร้างในโค้ด (สีตาม `look`) แต่จะมี 404 + warning `Model failed, keeping the built-in figure` ใน console ต่อคน

## 6. หมายเหตุสำหรับ AI ที่จะแก้ไขต่อ

- **เริ่มที่ `config.js` เสมอ** การเปลี่ยนทีม ตำแหน่งโต๊ะ ความถี่การพัก และการเปิด/ปิดพฤติกรรม ไม่ต้องแตะโค้ด
- ผังห้อง (โต๊ะประชุม แพนทรี โซฟา จุดยืน) อยู่ใน `office3d.js` หมวด `Meeting room`, `Pantry`, `Lounge corner` และจุดยืน `coffeeSpots`, `printSpots`, `loungeSpots`, `phoneSpots`, `meetSeats`
  ถ้าย้ายเฟอร์นิเจอร์ ต้องย้ายจุดยืนที่เกี่ยวข้องและตรวจเส้นทางใน `route()` ด้วย (ทุกเส้นทางผ่านทางเดินหลัก z = 0)
- สถานะในฉาก (`w.state`): `work` · `rest` · `meet` · `coffee` · `print` · `lounge` · `phone` · `visit` · `walk` (และ `guest` สำหรับแขก)
  ถ้าเพิ่มสถานะใหม่ ต้องเพิ่มที่ `CLIP_FOR` (ท่าที่ใช้), `STATE_TH` / `DEST_TH` / `TAG_ST` (ข้อความ), `STATE_COL` (สี) และเวลาค้างใน `step()`
- ผู้กำกับคือ `decide(w)` ลำดับความสำคัญ: `goLater` → `pin` (hold) → `queue` (visit/goTo) → สถานะจาก live → พฤติกรรมว่าง
- ระบบเดินอยู่ที่ `walkStep()`: เดินชิดซ้าย หลบโดยเลือกฝั่งครั้งเดียวต่อการเจอกัน (ไม่หมุนกลับไปมา) และถ้าไม่คืบหน้าเกิน 2 วินาทีจะเดินทะลุไปก่อน จึงไม่มีวันติด
- event ใหม่จากเซิร์ฟเวอร์ → เพิ่ม `case` ใน `bridge.js` แล้วเรียก `Office3D.*` อย่าแก้ `office3d.js` เพื่อรู้จัก event โดยตรง
- ทดสอบเร็ว: เปิด `?demo=1` แล้วใช้ console สั่ง `Office3D.setMode('live'); Office3D.setAgent('mkt-1',{status:'working',task:'ทดสอบ',progress:0.4})`

## 7. ข้อจำกัด

- ฉากมีโต๊ะสำหรับ 7 คน ถ้าเพิ่มคน ต้องเพิ่มตำแหน่งโต๊ะใน `desks` ด้วย
- ใช้ WebGL เครื่องรุ่นเก่ามากอาจกระตุกเมื่อมีโมเดล 7 ตัว ถ้ากระตุกให้ลดขนาดหน้าต่าง หรือสลับกลับไปมุมมอง 2 มิติ (ฉาก 3 มิติจะหยุดแอนิเมชันเมื่อถูกซ่อน)
- ฉาก 3 มิติในแดชบอร์ดเปิด SSE `/api/events` เส้นที่สองของตัวเอง (เห็นเป็น 2 clients ใน `/api/health`)
- ตัวละครและท่าทางจาก Mixamo อยู่ภายใต้เงื่อนไขการใช้งานของ Adobe ถ้าจะเผยแพร่โปรเจกต์สู่สาธารณะ ควรตรวจเงื่อนไขก่อน
