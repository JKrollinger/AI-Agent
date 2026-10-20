# ลงทะเบียน Task Scheduler "Grock Agent Server": รัน npm start แบบซ่อนหน้าต่างทุกครั้งที่ผู้ใช้ปัจจุบันล็อกอิน (ไม่ต้องสิทธิ์ผู้ดูแล)
#   ติดตั้ง : powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\install-task.ps1
#   เริ่มเลย: Start-ScheduledTask -TaskName "Grock Agent Server"
#   หยุด    : Stop-ScheduledTask -TaskName "Grock Agent Server"
#   ถอน     : Unregister-ScheduledTask -TaskName "Grock Agent Server" -Confirm:$false
# ล็อกของเซิร์ฟเวอร์อยู่ที่ logs\server.log · ถ้าต้องการให้รันตั้งแต่บูตโดยไม่ต้องล็อกอิน ให้เปิด Task Scheduler แล้วติ๊ก
# "Run whether user is logged on or not" (ต้องใส่รหัสผ่าน Windows ของคุณเอง)
$ErrorActionPreference = "Stop"
$taskName = "Grock Agent Server"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$vbs = Join-Path $PSScriptRoot "server-autostart.vbs"
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = "PT15S"   # รอ 15 วิ หลังล็อกอินให้ระบบพร้อมก่อน
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "AI Workforce Control Center: npm start in $root (hidden window, log: logs\server.log)" -Force | Out-Null
Write-Host "ลงทะเบียน task '$taskName' แล้ว — รันตอนล็อกอินของ $user ในโฟลเดอร์ $root"
