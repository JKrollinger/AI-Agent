# ติดตั้ง cloudflared เป็น Windows service (รันตั้งแต่บูต ไม่ต้องล็อกอิน) โดยใช้ %USERPROFILE%\.cloudflared\config.yml ของคุณ
# ต้องสิทธิ์ผู้ดูแล — สคริปต์จะเปิดตัวเองใหม่แบบยกสิทธิ์ (กด Yes ที่ UAC) รันซ้ำได้ (ใช้ซ่อม/รีสตาร์ต service ก็ได้)
#   ติดตั้ง/ซ่อม: powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\install-cloudflared-service.ps1
#   สถานะ     : Get-Service cloudflared        ล็อก: %USERPROFILE%\.cloudflared\cloudflared.log (ตาม logfile ใน config.yml)
#   รีสตาร์ต  : Restart-Service cloudflared    (PowerShell แบบ Run as administrator)
#   ถอน       : cloudflared service uninstall  (PowerShell แบบ Run as administrator)
# ทำไมต้องชี้ --config เอง: service รันเป็นบัญชี SYSTEM จึงไม่เห็น config.yml ในโปรไฟล์ผู้ใช้ (cloudflared service install
# ไม่ใส่ --config ให้ และสตาร์ต service ทันทีด้วย args เปล่า) — สคริปต์นี้แก้ ImagePath ของ service เป็น
# "cloudflared.exe --config <config.yml ของคุณ> tunnel run" แล้วหยุด/สตาร์ตใหม่ให้ใช้ args ใหม่ และรอจน tunnel ต่อ Cloudflare ได้จริง
$ErrorActionPreference = "Stop"
$exe = (Get-Command cloudflared -ErrorAction Stop).Source
$config = Join-Path $env:USERPROFILE ".cloudflared\config.yml"
if (-not (Test-Path $config)) { throw "ไม่พบ $config — ทำขั้น cloudflared tunnel create/route dns และเขียน config.yml ก่อน (docs/10 §3)" }
$log = Join-Path $env:TEMP "install-cloudflared-service.log"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Remove-Item $log -ErrorAction SilentlyContinue
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  if (Test-Path $log) { Get-Content $log }
  if ($p.ExitCode -ne 0) { throw "ติดตั้ง service ไม่สำเร็จ (exit $($p.ExitCode)) — ดู $log" }
  exit 0
}

# --- ส่วนนี้รันแบบยกสิทธิ์แล้ว ---
function Wait-ServiceState([string]$name, [string]$state, [int]$seconds) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if ((Get-Service $name).Status -eq $state) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

Start-Transcript -Path $log -Force | Out-Null
try {
  & $exe --config $config tunnel ingress validate
  if ($LASTEXITCODE -ne 0) { throw "config.yml ไม่ผ่าน validate" }

  $svc = Get-Service cloudflared -ErrorAction SilentlyContinue
  if (-not $svc) {
    & $exe service install
    $svc = Get-Service cloudflared -ErrorAction Stop
  }
  $name = $svc.Name
  $imagePath = "`"$exe`" --config `"$config`" tunnel run"
  Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -Name ImagePath -Value $imagePath
  Set-Service -Name $name -StartupType Automatic
  & sc.exe failure $name reset= 86400 actions= restart/5000/restart/30000/restart/60000 | Out-Null

  # หยุด service เดิมให้สนิท (ตัวติดตั้งสตาร์ตมันไว้ด้วย args เก่า) — รอพ้น StartPending ก่อน ไม่งั้น stop จะถูกปฏิเสธ
  if ((Get-Service $name).Status -ne "Stopped") {
    Wait-ServiceState $name "Running" 15 | Out-Null
    & sc.exe stop $name | Out-Null
    if (-not (Wait-ServiceState $name "Stopped" 20)) {
      $m = (& sc.exe queryex $name | Select-String "PID\s*:\s*(\d+)")
      $svcPid = if ($m) { [int]$m.Matches[0].Groups[1].Value } else { 0 }
      if ($svcPid -gt 0) { Write-Host "service ไม่หยุดใน 20 วิ — บังคับปิด PID $svcPid"; Stop-Process -Id $svcPid -Force }
      if (-not (Wait-ServiceState $name "Stopped" 10)) { throw "หยุด service $name ไม่ได้" }
    }
  }

  # สตาร์ตด้วย args ใหม่ แล้วรอจน cloudflared.log มี "Registered tunnel connection" (ต่อ Cloudflare ได้จริง)
  $tunnelLog = Join-Path (Split-Path $config) "cloudflared.log"
  $linesBefore = if (Test-Path $tunnelLog) { @(Get-Content $tunnelLog).Count } else { 0 }
  & sc.exe start $name | Out-Null
  if (-not (Wait-ServiceState $name "Running" 20)) { throw "service ไม่สตาร์ต — ดู Event Viewer (Application, source cloudflared) และ $tunnelLog" }
  $registered = $false
  for ($i = 0; $i -lt 40 -and -not $registered; $i++) {
    Start-Sleep -Milliseconds 750
    if (Test-Path $tunnelLog) {
      $fresh = @(Get-Content $tunnelLog | Select-Object -Skip $linesBefore)
      if ($fresh -match 'Registered tunnel connection') { $registered = $true }
    }
  }
  Write-Host "service $name : $((Get-Service $name).Status) (StartType $((Get-Service $name).StartType))"
  Write-Host "ImagePath: $imagePath"
  if (-not $registered) { throw "service รันอยู่แต่ยังไม่เห็น 'Registered tunnel connection' ใน $tunnelLog ภายใน 30 วิ — ดู log นั้น" }
  Write-Host "tunnel ต่อ Cloudflare แล้ว (Registered tunnel connection) — เปิดโดเมนตาม ingress ใน config.yml ได้เลย"
} finally { Stop-Transcript | Out-Null }
