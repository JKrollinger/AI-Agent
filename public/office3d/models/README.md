# โมเดลตัวละคร 3 มิติ (โฟลเดอร์นี้ไม่เข้า git)

ที่นี่เก็บตัวละคร Mixamo ที่แปลงแล้ว: `<jobId>.json` (glTF + ท่าทาง, ~3–6 MB ต่อคน) และภาพพื้นผิว `*_tex*.jpg/.png`
ไฟล์ใหญ่และอยู่ภายใต้เงื่อนไขการใช้งานของ Adobe จึง **ไม่ถูก commit** (ดู `.gitignore`) เหมือนภาพจากเกมใน `public/sprites/png/`
มีแค่ README นี้ที่อยู่ใน git

ถ้าโฟลเดอร์ว่าง ฉาก 3 มิติยังเปิดได้ — ระบบใช้ตัวละครสำรองที่สร้างในโค้ด (สีตาม `look` ใน `config.js`)
และขึ้น console warning `Model failed, keeping the built-in figure` ต่อคน (กับ 404 ของไฟล์ที่หาไม่เจอ)

## ไฟล์ที่ต้องมี (ตาม `model.file` ใน `public/office3d/config.js`)

| คน | ไฟล์โมเดล | ภาพพื้นผิว |
|---|---|---|
| captain · Lord Knight | `lord-knight.json` | `lk_tex*.jpg` |
| mkt-1 · Sniper | `sniper.json` | `sn_tex*` |
| res-1 · Stalker | `stalker.json` | `st_tex*` |
| eng-1 · High Wizard | `high-wizard.json` | `hw_tex*` |
| fin-1 · Professor | `professor.json` | `pf_tex*` |
| dev-1 · Whitesmith | `whitesmith.json` | `ws_tex*` |
| qa-1 · High Priest | `high-priest.json` | `hp_tex*` |

## วิธีได้ไฟล์

1. **คัดลอกจากเครื่องที่มีอยู่แล้ว** — วางทุกไฟล์ลงโฟลเดอร์นี้ตรง ๆ แล้วรีเฟรชหน้าเว็บ (ไม่ต้องรีสตาร์ตเซิร์ฟเวอร์)
2. **สร้างเองจาก Mixamo** — โหลด FBX ของตัวละคร + ท่าทาง แล้วแปลงด้วย `tools/office3d/convert-mixamo.mjs`
   ขั้นตอนและชื่อไฟล์ท่าที่รองรับอยู่ใน [docs/09-office3d.md §5](../../../docs/09-office3d.md)
