# เปิดใช้งานจากอินเทอร์เน็ตด้วย Cloudflare Tunnel (รันจากเครื่องของคุณ)

ศูนย์ควบคุมเป็นเซิร์ฟเวอร์ Node ที่ต้องรันค้างไว้ (SSE สด, สถานะทีมในหน่วยความจำ, เขียนไฟล์ `data/` `logs/` และโฟลเดอร์โปรเจกต์บนดิสก์) วิธีที่ง่ายและได้ฟีเจอร์ครบที่สุดคือ **รันบนเครื่องคุณตามเดิม แล้วให้ Cloudflare Tunnel เปิดทางเข้าจากอินเทอร์เน็ต** — ได้ URL จริงพร้อม HTTPS โดยไม่ต้องเปิดพอร์ตที่เราเตอร์ โปรเจกต์บนดิสก์และ Developer แก้ไฟล์จริง (Claude Code) ยังใช้ได้เหมือนเดิม ข้อแลกคือเครื่องต้องเปิดอยู่ตลอดเวลาที่ให้คนอื่นใช้

## 1. ตั้งค่าความปลอดภัยใน `.env` (ทำครั้งเดียว)

```ini
# โดเมนที่ยอมให้เรียกเข้ามา (คั่นด้วย ,) ขึ้นต้นด้วย . = ทุกโดเมนย่อย
ALLOWED_HOSTS=.trycloudflare.com,ai.example.com
# รหัสผ่านเข้าใช้ทั้งหน้าเว็บและ API (HTTP Basic Auth) — ใช้อักษรอังกฤษ/ตัวเลข 16 ตัวขึ้นไป
AUTH_USER=admin
AUTH_PASSWORD=เปลี่ยนเป็นรหัสของคุณ
# โจทย์ใหม่จากภายนอกสูงสุดต่อ 10 นาที (กันสั่งงานรัวจนเสียเงิน API ในโหมด live)
JOB_RATE_LIMIT=20
```

สิ่งที่เซิร์ฟเวอร์ทำเมื่อตั้งค่าเหล่านี้ (`server/index.js`):

| กลไก | ผล |
|---|---|
| `AUTH_PASSWORD` | ทุก path (หน้าเว็บ, API, SSE, ไฟล์โมเดล 3 มิติ) ต้องผ่าน HTTP Basic Auth — เบราว์เซอร์ถามครั้งเดียวแล้วจำให้จนปิดแท็บ ไม่ตั้ง = ไม่ถาม (ใช้ในเครื่องเท่านั้น) |
| `ALLOWED_HOSTS` | รับคำขอเฉพาะ `Host` ที่เป็น localhost หรืออยู่ในรายการ (กัน DNS rebinding) ถ้าเปิดผ่านโดเมนที่ไม่ได้ใส่ไว้จะได้ 403 พร้อมข้อความบอกวิธีแก้ |
| คำขอจากภายนอก (มีหัว `cf-connecting-ip`/`x-forwarded-for` หรือ Host ไม่ใช่ localhost) | `POST /api/projects` และ `/api/projects/reload` ถูกปิด (403) — ลงทะเบียนโปรเจกต์ใหม่ได้เฉพาะจาก localhost · ส่งโจทย์ (`/api/jobs`, `/api/demo`) ไม่เกิน `JOB_RATE_LIMIT` ต่อ 10 นาที (429) |
| ส่วนหัวความปลอดภัย | `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` (ฉาก 3 มิติเป็น iframe โดเมนเดียวกัน จึงใช้ได้), `Referrer-Policy: same-origin` |

หลังแก้ `.env` ต้องรีสตาร์ต `npm start` ทุกครั้ง

## 2. ลองแบบเร็ว: Quick Tunnel (ไม่ต้องมีบัญชี Cloudflare)

ติดตั้ง `cloudflared` ครั้งเดียว (Windows): `winget install --id Cloudflare.cloudflared -e` หรือดาวน์โหลด `cloudflared-windows-amd64.exe` จาก https://github.com/cloudflare/cloudflared/releases แล้วเปลี่ยนชื่อเป็น `cloudflared.exe` ไว้ในโฟลเดอร์ที่อยู่ใน PATH

เปิด 2 หน้าต่างเทอร์มินัลในโฟลเดอร์โปรเจกต์:

```bash
npm start
```

```bash
npm run tunnel
```

`npm run tunnel` = `cloudflared tunnel --url http://127.0.0.1:3789` จะพิมพ์ URL แบบ `https://<คำสุ่ม>.trycloudflare.com` ออกมา เปิดจากมือถือ/เครื่องอื่นได้ทันที (ถามรหัสผ่านตาม `.env`) ข้อจำกัด: URL เปลี่ยนทุกครั้งที่รันใหม่ และ Cloudflare ไม่รับประกันความเสถียรของ quick tunnel — เหมาะกับทดลอง/โชว์ชั่วคราว

## 3. ใช้โดเมนของตัวเองถาวร (Named Tunnel)

ต้องมีบัญชี Cloudflare และโดเมนที่ย้าย DNS มาที่ Cloudflare แล้ว

```bash
cloudflared tunnel login                    # เปิดเบราว์เซอร์ให้ล็อกอินและเลือกโดเมน
cloudflared tunnel create grock             # ได้ไฟล์ credentials <UUID>.json ใน %USERPROFILE%\.cloudflared\
cloudflared tunnel route dns grock ai.example.com
```

สร้าง `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: grock
credentials-file: C:\Users\<คุณ>\.cloudflared\<UUID>.json
ingress:
  - hostname: ai.example.com
    service: http://127.0.0.1:3789
  - service: http_status:404
```

เพิ่ม `ai.example.com` ใน `ALLOWED_HOSTS` แล้วรีสตาร์ต `npm start` จากนั้น

```bash
cloudflared tunnel run grock
```

ให้รันเองตอนเปิดเครื่อง: `cloudflared service install` (ติดตั้งเป็น Windows service) และตั้ง `npm start` ให้รันอัตโนมัติตามข้อ 3.1

### 3.1 ให้ `npm start` รันเองตอนล็อกอิน (Task Scheduler — ไม่ต้องติดตั้งอะไรเพิ่ม)

สคริปต์อยู่ใน `tools/autostart/`: `install-task.ps1` ลงทะเบียน task ชื่อ **Grock Agent Server** (ทริกเกอร์ตอนล็อกอินของผู้ใช้ปัจจุบัน หน่วง 15 วินาที) ให้รัน `server-autostart.vbs` → `server-autostart.cmd` ซึ่งเปิด `npm start` แบบซ่อนหน้าต่างในโฟลเดอร์โปรเจกต์ (โหลด `.env` ตามปกติ) บันทึก stdout/stderr ลง `logs/server.log` (หมุนไฟล์เมื่อเกิน ~5 MB) และคืน exit code ให้ Task Scheduler รีสตาร์ตให้เองสูงสุด 3 ครั้งถ้าเซิร์ฟเวอร์ล้ม

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\install-task.ps1   # ลงทะเบียน (ไม่ต้องสิทธิ์ผู้ดูแล)
Start-ScheduledTask -TaskName "Grock Agent Server"   # เริ่มทันทีโดยไม่ต้องล็อกอินใหม่ (ปิด npm start ที่รันค้างอยู่ก่อน ไม่งั้นพอร์ตชน)
Stop-ScheduledTask -TaskName "Grock Agent Server"    # หยุดเซิร์ฟเวอร์
Unregister-ScheduledTask -TaskName "Grock Agent Server" -Confirm:$false   # ถอน
```

task ทำงานเฉพาะเมื่อผู้ใช้ล็อกอินแล้ว — ถ้าต้องการให้ขึ้นตั้งแต่บูตโดยไม่ต้องล็อกอิน ให้เปิด Task Scheduler → Properties ของ task → ติ๊ก "Run whether user is logged on or not" แล้วใส่รหัสผ่าน Windows ของคุณเอง (ต้องเป็นบัญชีเดียวกับที่ติดตั้ง Claude Code เพราะ Developer โหมดเรียก `claude` CLI ที่อ่าน credentials จากโปรไฟล์ของคุณ) หรือเปิด auto sign-in ของ Windows

**ชั้นล็อกอินเพิ่ม (แนะนำเมื่อใช้โดเมนจริง):** ใน Cloudflare Zero Trust → Access → Applications เพิ่ม `ai.example.com` แล้วกำหนดให้เฉพาะอีเมลของคุณ/ทีมเข้าได้ (ส่งรหัส OTP ทางอีเมล) คำขอที่ไม่ผ่าน Access จะไม่ถึงเครื่องคุณเลย ส่วนรหัสผ่าน Basic Auth ยังเป็นชั้นที่สอง

## 4. ข้อควรรู้

- โหมด `live` ใช้เงินจริงทุกโจทย์ ถ้าแชร์ลิงก์ให้คนอื่น ให้ตั้ง `JOB_RATE_LIMIT` ต่ำ ๆ และ `MAX_USD_PER_JOB` ใน `.env`
- เครื่องต้องไม่หลับ (Windows → Power → ปิด Sleep) ไม่งั้นลิงก์จะเงียบ
- ไฟล์โมเดล 3 มิติ (~40 MB) อยู่ในเครื่องคุณอยู่แล้ว ผู้ใช้ภายนอกโหลดผ่าน tunnel ครั้งแรกอาจช้า 10–30 วินาทีตามอินเทอร์เน็ตขาขึ้นของคุณ
- SSE (`/api/events`) ผ่าน Cloudflare ได้ปกติ ถ้าหลุดจะต่อใหม่เองและมีหัวใจเต้นทุก 15 วินาที
- ปุ่ม "⚙ ตั้งค่า AI", Apply/ปฏิเสธ patch และการสั่งงานทำได้จากภายนอก (หลังใส่รหัสผ่าน) — ลงทะเบียนโปรเจกต์ใหม่ต้องทำที่เครื่อง
- ถ้าเจอ 403 "Host … ไม่ได้รับอนุญาต" = ลืมใส่โดเมนใน `ALLOWED_HOSTS`; 401 = รหัสผ่านไม่ตรงกับ `.env`; 429 = ส่งโจทย์เกินโควตา
