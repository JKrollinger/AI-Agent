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
| `API_TOKENS` (ไม่บังคับ) | โทเคนสิทธิ์จำกัดสำหรับระบบภายนอก (Hermes Agent, บอท, สคริปต์) ส่งเป็น `Authorization: Bearer` แทน Basic Auth — สิทธิ์ `jobs` สั่ง/ดูโจทย์ได้เท่านั้น มีงบรายวัน `TOKEN_DAILY_USD` และนับ `JOB_RATE_LIMIT` เสมอ — ดู [docs/11-hermes.md](11-hermes.md) |

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
logfile: C:\Users\<คุณ>\.cloudflared\cloudflared.log   # ล็อกของ tunnel (service ก็เขียนที่นี่)
ingress:
  - hostname: ai.example.com
    service: http://127.0.0.1:3789
  - service: http_status:404
```

เพิ่ม `ai.example.com` ใน `ALLOWED_HOSTS` แล้วรีสตาร์ต `npm start` จากนั้น

```bash
cloudflared tunnel run grock
```

ให้รันเองตอนเปิดเครื่อง: ตั้ง `npm start` ให้รันอัตโนมัติตามข้อ 3.1 และติดตั้ง cloudflared เป็น Windows service ตามข้อ 3.2 (ลำดับนี้สำคัญ)

### 3.1 ให้เซิร์ฟเวอร์รันเองตอนล็อกอิน (Task Scheduler — ไม่ต้องติดตั้งอะไรเพิ่ม)

สคริปต์อยู่ใน `tools/autostart/`: `install-task.ps1` ลงทะเบียน task ชื่อ **Grock Agent Server** (ทริกเกอร์ตอนล็อกอินของผู้ใช้ปัจจุบัน หน่วง 15 วินาที) ให้รัน `server-autostart.vbs` → `server-autostart.cmd` ซึ่งเปิด `node server/index.js` แบบซ่อนหน้าต่างในโฟลเดอร์โปรเจกต์ (คำสั่งเดียวกับ `npm start` แต่เรียก node ตรง ๆ ไม่ผ่าน npm ให้ process tree ตื้น โหลด `.env` ตามปกติ) บันทึก stdout/stderr ลง `logs/server.log` (หมุนไฟล์เมื่อเกิน ~5 MB) เขียน PID ของ node ลง `logs/server.pid` (ผ่าน `--import tools/autostart/pidfile.mjs`) และคืน exit code ให้ Task Scheduler รีสตาร์ตให้เองสูงสุด 3 ครั้งถ้าเซิร์ฟเวอร์ล้ม

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\install-task.ps1   # ลงทะเบียน (ไม่ต้องสิทธิ์ผู้ดูแล)
powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\restart-task.ps1   # รีสตาร์ต — ใช้ทุกครั้งหลังแก้ .env หรืออัปเดตโค้ด (ดูย่อหน้าถัดไป)
Start-ScheduledTask -TaskName "Grock Agent Server"   # เริ่มทันทีโดยไม่ต้องล็อกอินใหม่ — เฉพาะเมื่อยังไม่มีเซิร์ฟเวอร์รันอยู่ ไม่งั้นพอร์ตชน
Stop-ScheduledTask -TaskName "Grock Agent Server"    # หยุด task (node ที่เหลืออยู่ต้องปิดเอง — ดูย่อหน้าถัดไป)
Unregister-ScheduledTask -TaskName "Grock Agent Server" -Confirm:$false   # ถอน
```

**รีสตาร์ตหลังแก้ `.env` หรืออัปเดตโค้ด = รัน `restart-task.ps1` คำสั่งเดียว** — `Stop-ScheduledTask` อย่างเดียวหยุดได้แค่ `wscript.exe`/`cmd.exe` แต่ `node` ลูกของมันยังอยู่และยังจองพอร์ต พอ `Start-ScheduledTask` จะได้ node ใหม่ที่ bind พอร์ตไม่ได้ (`EADDRINUSE`) จนต้องไปหา PID จาก `netstat -ano | findstr :3789` แล้ว `Stop-Process` เองทุกครั้ง สคริปต์ทำให้ครบ: หยุด task → ปิด wrapper ที่ค้าง (wscript/cmd ของ `server-autostart.*` ในโฟลเดอร์นี้) และ node ที่พบจาก `logs/server.pid` หรือที่ LISTENING บนพอร์ต (`PORT` ใน `.env` ค่าเริ่มต้น 3789 — ถ้าพอร์ตถูกจองโดยโปรแกรมอื่นที่ไม่ใช่ node จะไม่ปิดให้และบอกเหตุ) → รอพอร์ตว่าง → `Start-ScheduledTask` → รอ `/api/health` ตอบ 200 (ใส่ Basic Auth จาก `AUTH_USER`/`AUTH_PASSWORD` ใน `.env` ให้เอง ไม่พิมพ์รหัสออกหน้าจอ) → สรุป PID เดิม/ใหม่, mode, codeMode ทั้งหมดราว 6–8 วินาที ล้มเหลวได้ exit code ≠ 0 พร้อมเหตุผลและท้าย `logs/server.log` ใช้ได้แม้เซิร์ฟเวอร์เดิมถูกเปิดด้วยมือ (`npm start`) ไม่ใช่ผ่าน task พารามิเตอร์: `-StopTimeoutSec 15 -HealthTimeoutSec 30`

task ทำงานเฉพาะเมื่อผู้ใช้ล็อกอินแล้ว — ถ้าต้องการให้ขึ้นตั้งแต่บูตโดยไม่ต้องล็อกอิน ให้เปิด Task Scheduler → Properties ของ task → ติ๊ก "Run whether user is logged on or not" แล้วใส่รหัสผ่าน Windows ของคุณเอง (ต้องเป็นบัญชีเดียวกับที่ติดตั้ง Claude Code เพราะ Developer โหมดเรียก `claude` CLI ที่อ่าน credentials จากโปรไฟล์ของคุณ) หรือเปิด auto sign-in ของ Windows

### 3.2 ให้ tunnel รันเองตั้งแต่บูต (Windows service)

`cloudflared service install` ติดตั้ง service ที่รันเป็นบัญชี SYSTEM โดย**ไม่ใส่ `--config`** ให้ service จึงไปหา config ในโปรไฟล์ของ SYSTEM (`C:\Windows\System32\config\systemprofile\.cloudflared\`) ไม่ใช่ของคุณ และไม่เจอ tunnel สคริปต์ `tools/autostart/install-cloudflared-service.ps1` จัดการให้ครบ: ยกสิทธิ์เอง (กด Yes ที่ UAC) → validate `config.yml` → `cloudflared service install` (ถ้ายังไม่มี) → แก้ ImagePath ของ service เป็น `"cloudflared.exe" --config "%USERPROFILE%\.cloudflared\config.yml" tunnel run` → ตั้ง Automatic + รีสตาร์ตเองเมื่อล้ม → Restart-Service

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\install-cloudflared-service.ps1   # กด Yes ที่ UAC
Get-Service cloudflared                                               # ต้องเป็น Running
Get-Content "$env:USERPROFILE\.cloudflared\cloudflared.log" -Tail 20   # ล็อกของ service (ตาม logfile ใน config.yml)
```

**ลำดับสำคัญ:** ติดตั้ง service (หรือ `cloudflared tunnel run grock`) *หลังจาก* เซิร์ฟเวอร์ Node บนพอร์ต 3789 รันด้วย `.env` ที่มี `AUTH_PASSWORD` และโดเมนใน `ALLOWED_HOSTS` แล้วเท่านั้น — tunnel ส่งทุกคำขอจากโดเมนเข้า `127.0.0.1:3789` ทันทีที่ต่อได้ ถ้าเซิร์ฟเวอร์ยังเป็นโค้ด/ค่าเก่าที่ไม่ถามรหัส แดชบอร์ดจะเปิดสาธารณะ ขั้นตอนที่ปลอดภัย: รีสตาร์ตด้วย `tools\autostart\restart-task.ps1` (ข้อ 3.1 — ปิดตัวเดิมและเปิดใหม่ผ่าน task ให้ครบ) หรือหยุด `npm start` เดิมแล้วเปิดใหม่เอง → ดูบรรทัด `🔒 ต้องใส่รหัสผ่าน … เปิดรับโดเมน: …` → ค่อยติดตั้ง service

ข้อควรระวัง: `cloudflared tunnel run --url http://127.0.0.1:XXXX grock` **ไม่** เปลี่ยนปลายทางของ named tunnel ที่มี `ingress` ใน config.yml (cloudflared ใช้ ingress ต่อไป) ถ้าต้องการทดสอบชี้พอร์ตอื่นชั่วคราว ให้เขียน config อีกไฟล์แล้วรัน `cloudflared --config <ไฟล์นั้น> tunnel run grock`

**ชั้นล็อกอินเพิ่ม (แนะนำเมื่อใช้โดเมนจริง — Cloudflare Access ฟรีถึง 50 ผู้ใช้):** คำขอที่ไม่ผ่าน Access จะไม่ถึงเครื่องคุณเลย ส่วนรหัสผ่าน Basic Auth ยังเป็นชั้นที่สอง ขั้นตอน: one.dash.cloudflare.com → เลือกบัญชี (ครั้งแรกต้องตั้งชื่อทีมและเลือกแผน Free) → **Access → Applications → Add an application → Self-hosted** → Application name ตามใจ, Application domain = `ai.example.com` (โดเมนที่ชี้ tunnel) → Session duration เช่น 24 hours → Next → **Add a policy**: Action = Allow, Include → Selector = Emails → ใส่อีเมลของคุณ/ทีม → Next → Save ตั้งแต่นั้นเปิดโดเมนจะเจอหน้า Cloudflare ให้ใส่อีเมล รับรหัส OTP ทางอีเมล แล้วถึงจะเจอกล่องรหัสผ่านของแอป · SSE/`fetch` ของหน้าเว็บใช้คุกกี้ของ Access ได้เอง ไม่ต้องแก้โค้ด · ถ้าใช้ `curl` ต้องสร้าง Service Token (Access → Service Auth) แล้วส่งหัว `CF-Access-Client-Id/Secret`

## 4. ข้อควรรู้

- โหมด `live` ใช้เงินจริงทุกโจทย์ ถ้าแชร์ลิงก์ให้คนอื่น ให้ตั้ง `JOB_RATE_LIMIT` ต่ำ ๆ และ `MAX_USD_PER_JOB` ใน `.env`
- เครื่องต้องไม่หลับ (Windows → Power → ปิด Sleep) ไม่งั้นลิงก์จะเงียบ
- ไฟล์โมเดล 3 มิติ (~40 MB) อยู่ในเครื่องคุณอยู่แล้ว ผู้ใช้ภายนอกโหลดผ่าน tunnel ครั้งแรกอาจช้า 10–30 วินาทีตามอินเทอร์เน็ตขาขึ้นของคุณ
- SSE (`/api/events`) ผ่าน Cloudflare ได้ปกติ ถ้าหลุดจะต่อใหม่เองและมีหัวใจเต้นทุก 15 วินาที
- ปุ่ม "⚙ ตั้งค่า AI", Apply/ปฏิเสธ patch และการสั่งงานทำได้จากภายนอก (หลังใส่รหัสผ่าน) — ลงทะเบียนโปรเจกต์ใหม่ต้องทำที่เครื่อง
- เปิด **Always Use HTTPS** ใน Cloudflare (SSL/TLS → Edge Certificates) เพื่อให้ `http://` เด้งเป็น `https://` อัตโนมัติ — ไม่งั้นรหัสผ่าน Basic Auth อาจถูกส่งผ่าน http ธรรมดาถ้าใครพิมพ์โดเมนโดยไม่ใส่ https
- รีบูตเครื่อง: service cloudflared ขึ้นเองตั้งแต่บูต ส่วนเซิร์ฟเวอร์ Node ขึ้นเมื่อคุณล็อกอิน (task §3.1) ระหว่างนั้นโดเมนจะตอบ 502 จาก Cloudflare
- ถ้าเจอ 403 "Host … ไม่ได้รับอนุญาต" = ลืมใส่โดเมนใน `ALLOWED_HOSTS`; 401 = รหัสผ่านไม่ตรงกับ `.env`; 429 = ส่งโจทย์เกินโควตา
