@echo off
rem เปิด AI Workforce Control Center จากโฟลเดอร์โปรเจกต์ — Task Scheduler "Grock Agent Server" เรียกผ่าน server-autostart.vbs ตอนล็อกอิน (ดู install-task.ps1)
rem รัน node ตรง ๆ ด้วยคำสั่งเดียวกับ "npm start" ใน package.json (ไม่ผ่าน npm) ให้ process tree ตื้น: wscript → cmd → node
rem และ --import pidfile.mjs ให้ node เขียน PID ตัวเองลง logs\server.pid เพื่อให้ restart-task.ps1 หาโปรเซสได้แน่นอน
rem stdout/stderr ลง logs\server.log (หมุนไฟล์เป็น server.log.1 เมื่อเกิน ~5 MB) · node โหลด .env เองผ่าน --env-file-if-exists
cd /d "%~dp0..\.."
if not exist logs mkdir logs
if exist logs\server.log for %%A in (logs\server.log) do if %%~zA gtr 5000000 move /y logs\server.log logs\server.log.1 >nul
echo [%date% %time%] server-autostart: node server/index.js (cwd %cd%) >> logs\server.log
node --import ./tools/autostart/pidfile.mjs --env-file-if-exists=.env server/index.js >> logs\server.log 2>&1
set code=%errorlevel%
echo [%date% %time%] server-autostart: exited with code %code% >> logs\server.log
exit /b %code%
