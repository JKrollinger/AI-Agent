@echo off
rem เปิด AI Workforce Control Center (npm start) จากโฟลเดอร์โปรเจกต์ — Task Scheduler เรียกผ่าน server-autostart.vbs ตอนล็อกอิน
rem stdout/stderr ลง logs\server.log (หมุนไฟล์เป็น server.log.1 เมื่อเกิน ~5 MB) · npm start โหลด .env เองผ่าน --env-file-if-exists
cd /d "%~dp0..\.."
if not exist logs mkdir logs
if exist logs\server.log for %%A in (logs\server.log) do if %%~zA gtr 5000000 move /y logs\server.log logs\server.log.1 >nul
echo [%date% %time%] server-autostart: npm start (cwd %cd%) >> logs\server.log
call npm start >> logs\server.log 2>&1
set code=%errorlevel%
echo [%date% %time%] server-autostart: exited with code %code% >> logs\server.log
exit /b %code%
