# รีสตาร์ตเซิร์ฟเวอร์ผ่าน Task Scheduler "Grock Agent Server" ในคำสั่งเดียว (ไม่ต้องสิทธิ์ผู้ดูแล) — ใช้ทุกครั้งหลังแก้ .env หรืออัปเดตโค้ด
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\restart-task.ps1
# ทำไมต้องมี: Stop-ScheduledTask หยุดได้แค่ wscript.exe/cmd.exe แต่ node ลูกของมันยังอยู่และยังจองพอร์ต → Start-ScheduledTask ได้ node ใหม่
# ที่ bind พอร์ตไม่ได้ (EADDRINUSE) ต้องไปหา PID จาก netstat แล้ว Stop-Process เองทุกครั้ง — สคริปต์นี้ทำให้ครบ:
#   Stop-ScheduledTask → หา node จาก logs\server.pid และ/หรือที่ LISTENING บนพอร์ต (PORT ใน .env ค่าเริ่มต้น 3789) → ปิดทั้ง process tree ถ้ายังอยู่
#   → รอพอร์ตว่าง → Start-ScheduledTask → รอ /api/health ตอบ 200 (ใส่ Basic Auth จาก AUTH_USER/AUTH_PASSWORD ใน .env ถ้ามี ไม่พิมพ์รหัสออกหน้าจอ)
#   → สรุป PID เดิม/ใหม่, mode, codeMode
# ใช้ได้แม้เซิร์ฟเวอร์เดิมถูกเปิดด้วยมือ (npm start) ไม่ใช่ผ่าน task — ขอแค่เป็น node ที่จองพอร์ตนั้น
# exit code: 0 สำเร็จ · 1 อ่าน .env ไม่ได้ · 2 ไม่พบ task (รัน install-task.ps1 ก่อน) · 3 ปิดโปรเซสเดิมไม่ได้/พอร์ตไม่ว่าง
#            4 เริ่ม task ไม่ได้ · 5 เซิร์ฟเวอร์ไม่ตอบ /api/health = 200 ในเวลาที่กำหนด (พิมพ์ท้าย logs\server.log ให้ดู)
param(
  [string]$TaskName = "Grock Agent Server",
  [int]$StopTimeoutSec = 15,    # รอโปรเซสเดิมปิดและพอร์ตว่าง
  [int]$HealthTimeoutSec = 30   # รอ /api/health ตอบ 200 หลัง Start-ScheduledTask
)
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$envFile = Join-Path $root ".env"
$pidFile = Join-Path $root "logs\server.pid"
$logFile = Join-Path $root "logs\server.log"
$t0 = Get-Date

function Fail([int]$code, [string]$msg) {
  Write-Host "❌ $msg" -ForegroundColor Red
  if ($code -ge 3 -and (Test-Path -LiteralPath $logFile)) {
    Write-Host "--- logs\server.log (15 บรรทัดท้าย) ---" -ForegroundColor DarkGray
    Get-Content -LiteralPath $logFile -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  }
  exit $code
}

# --- .env: ให้ node แปลงเอง (กติกาเดียวกับ --env-file-if-exists: คอมเมนต์, เครื่องหมายคำพูด, export) เอาเฉพาะคีย์ที่ต้องใช้ ---
$dotenv = @{}
if (Test-Path -LiteralPath $envFile) {
  # ใช้เฉพาะ single quote ใน JS — PowerShell 5.1 ส่ง double quote ที่ซ้อนในอาร์กิวเมนต์ให้โปรแกรมภายนอกไม่ครบ
  $js = "const u=require('util'),f=require('fs');const e=u.parseEnv(f.readFileSync(process.argv[1],'utf8'));" +
        "process.stdout.write(JSON.stringify({PORT:e.PORT||'',HOST:e.HOST||'',AUTH_USER:e.AUTH_USER||'',AUTH_PASSWORD:e.AUTH_PASSWORD||'',DASHBOARD_TOKEN:e.DASHBOARD_TOKEN||''}))"
  try {
    $json = & node -e $js $envFile
    if ($LASTEXITCODE -ne 0 -or -not $json) { throw "node คืน exit code $LASTEXITCODE" }
    $obj = $json | ConvertFrom-Json
    foreach ($k in "PORT", "HOST", "AUTH_USER", "AUTH_PASSWORD", "DASHBOARD_TOKEN") { $dotenv[$k] = [string]$obj.$k }
  } catch { Fail 1 "อ่าน .env ไม่ได้: $($_.Exception.Message)" }
}
$port = 3789
if ($dotenv.PORT) { $parsed = 0; if ([int]::TryParse($dotenv.PORT, [ref]$parsed) -and $parsed -gt 0) { $port = $parsed } }
$bindHost = $dotenv.HOST
if (-not $bindHost -or $bindHost -in "0.0.0.0", "::", "*") { $bindHost = "127.0.0.1" }
$urlHost = if ($bindHost.Contains(":")) { "[$bindHost]" } else { $bindHost }
$healthUrl = "http://${urlHost}:${port}/api/health"
$authUser = if ($dotenv.AUTH_USER) { $dotenv.AUTH_USER } else { "admin" }
$headers = @{}
if ($dotenv.DASHBOARD_TOKEN) {
  # AUTH=token (docs/10-online.md): /api/health รับ Authorization: Bearer <DASHBOARD_TOKEN>
  $headers["Authorization"] = "Bearer " + $dotenv.DASHBOARD_TOKEN
} elseif ($dotenv.AUTH_PASSWORD) {
  $headers["Authorization"] = "Basic " + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($authUser):$($dotenv.AUTH_PASSWORD)"))
}

# --- ตัวช่วยหาโปรเซส ---
function Get-ListenPids([int]$p) {
  # PID ที่ LISTENING บนพอร์ต (Get-NetTCPConnection ใช้ได้โดยไม่ต้องสิทธิ์ผู้ดูแล; ถ้าไม่มี cmdlet ใช้ netstat)
  $found = @()
  try { $found = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess) }
  catch {
    foreach ($line in (& netstat.exe -ano -p TCP)) {
      if ($line -match "^\s*TCP\s+\S+:$p\s+\S+\s+LISTENING\s+(\d+)\s*$") { $found += [int]$Matches[1] }
    }
  }
  return @($found | Sort-Object -Unique)
}
function Get-Proc([int]$id) { Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue }
function Describe-Proc($proc) { "$($proc.Name) PID $($proc.ProcessId)" }

# --- 1) task ---
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Fail 2 "ไม่พบ task '$TaskName' — ลงทะเบียนก่อน: powershell -NoProfile -ExecutionPolicy Bypass -File tools\autostart\install-task.ps1" }

# --- 2) จำโปรเซสเดิมไว้ก่อนหยุด: จาก PID file และจากพอร์ต ---
$fromPidFile = $null
if (Test-Path -LiteralPath $pidFile) {
  $raw = Get-Content -LiteralPath $pidFile -TotalCount 1
  if ($raw -and $raw.Trim() -match '^\d+$') { $fromPidFile = [int]$raw.Trim() }
}
$fromPort = Get-ListenPids $port
$oldPids = @(@($fromPidFile) + $fromPort | Where-Object { $_ } | Sort-Object -Unique)
if ($oldPids.Count) {
  $desc = ($oldPids | ForEach-Object { $p = Get-Proc $_; if ($p) { Describe-Proc $p } else { "PID $_ (ไม่มีแล้ว)" } }) -join ", "
  $pf = if ($fromPidFile) { $fromPidFile } else { "-" }
  $pp = if ($fromPort.Count) { $fromPort -join "," } else { "ว่าง" }
  Write-Host "โปรเซสเดิม: $desc  [logs\server.pid: $pf · พอร์ต ${port}: $pp]"
} else { Write-Host "ไม่พบเซิร์ฟเวอร์เดิม (พอร์ต $port ว่าง ไม่มี logs\server.pid) — จะเริ่มใหม่อย่างเดียว" }

# --- 3) Stop-ScheduledTask (หยุดได้แค่ wscript/cmd — node ลูกมักยังอยู่ ดูข้อ 4) ---
if ($task.State -eq "Running") {
  Stop-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds($StopTimeoutSec)
  while ((Get-ScheduledTask -TaskName $TaskName).State -eq "Running" -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
  $state = (Get-ScheduledTask -TaskName $TaskName).State
  if ($state -eq "Running") { Fail 3 "Stop-ScheduledTask แล้ว task ยังอยู่ในสถานะ Running เกิน $StopTimeoutSec วิ" }
  Write-Host "หยุด task แล้ว (สถานะ: $state)"
} else { Write-Host "task ไม่ได้รันอยู่ (สถานะ: $($task.State))" }

# --- 4) ปิด wrapper ของ autostart ที่ค้าง (wscript/cmd ที่รัน server-autostart.* ของโฟลเดอร์นี้ — ถ้า cmd ค้างอยู่ตอน node ตาย
#        มันจะอ่านไฟล์ .cmd ต่อแล้วอาจเปิด node ใหม่ซ้อน) แล้วค่อยปิด node ที่ค้าง (ทั้ง tree ด้วย taskkill /T เผื่อมี claude CLI/sandbox ลูกอยู่) ---
$wrapperMark = Join-Path $PSScriptRoot "server-autostart."
$wrappers = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($wrapperMark, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
foreach ($w in $wrappers) {
  if (-not (Get-Proc $w.ProcessId)) { continue }
  Write-Host "ปิด $(Describe-Proc $w) (wrapper ของ task ที่ยังค้าง) พร้อมลูกทั้งหมด"
  $out = & taskkill.exe /PID $w.ProcessId /T /F 2>&1
  if ($LASTEXITCODE -ne 0 -and (Get-Proc $w.ProcessId)) { Fail 3 "ปิด wrapper PID $($w.ProcessId) ไม่สำเร็จ: $out" }
}
foreach ($id in $oldPids) {
  $proc = Get-Proc $id
  if (-not $proc) { continue }  # ปิดไปพร้อม task แล้ว
  $onPort = $fromPort -contains $id
  if ($proc.Name -ne "node.exe") {
    if ($onPort) { Fail 3 "พอร์ต $port ถูกจองโดย $(Describe-Proc $proc) ซึ่งไม่ใช่ node — ไม่ปิดให้ ตรวจเองก่อน (netstat -ano | findstr :$port)" }
    Write-Host "ข้าม PID $id จาก logs\server.pid: ตอนนี้เป็น $($proc.Name) ไม่ใช่ node (PID ถูกนำกลับมาใช้)" -ForegroundColor Yellow
    continue
  }
  if (-not $onPort) {
    # มาจาก PID file อย่างเดียว: ต้องเป็น server/index.js และไม่ได้จองพอร์ตอื่น (กันไปปิด node ของโปรเจกต์อื่นที่ได้ PID ซ้ำ)
    $otherPorts = @(Get-NetTCPConnection -OwningProcess $id -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort)
    if ($proc.CommandLine -notmatch 'server[\\/]index\.js' -or $otherPorts.Count) {
      Write-Host "ข้าม PID $id จาก logs\server.pid: ไม่ใช่เซิร์ฟเวอร์ของพอร์ต $port (คำสั่ง: $($proc.CommandLine))" -ForegroundColor Yellow
      continue
    }
  }
  Write-Host "ปิด $(Describe-Proc $proc) ที่ยังค้างอยู่หลังหยุด task (taskkill /T /F)"
  $out = & taskkill.exe /PID $id /T /F 2>&1
  if ($LASTEXITCODE -ne 0 -and (Get-Proc $id)) { Fail 3 "ปิด PID $id ไม่สำเร็จ: $out" }
}

# --- 5) รอพอร์ตว่างจริง ---
$deadline = (Get-Date).AddSeconds($StopTimeoutSec)
$busy = Get-ListenPids $port
while ($busy.Count -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300; $busy = Get-ListenPids $port }
if ($busy.Count) { Fail 3 "พอร์ต $port ยังถูกจองโดย PID $($busy -join ',') หลังรอ $StopTimeoutSec วิ" }
if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue }

# --- 6) Start-ScheduledTask ---
try { Start-ScheduledTask -TaskName $TaskName } catch { Fail 4 "Start-ScheduledTask ไม่สำเร็จ: $($_.Exception.Message)" }
$authNote = if ($dotenv.DASHBOARD_TOKEN) { " · Bearer DASHBOARD_TOKEN" } elseif ($headers.Count) { " · Basic Auth ผู้ใช้ '$authUser'" } else { "" }
Write-Host "เริ่ม task แล้ว — รอ $healthUrl ตอบ 200 (สูงสุด $HealthTimeoutSec วิ)$authNote"

# --- 7) รอ /api/health ---
$health = $null; $lastErr = "ยังไม่ได้รับคำตอบ"
$tStart = Get-Date; $seenRunning = $false
$deadline = $tStart.AddSeconds($HealthTimeoutSec)
while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -Uri $healthUrl -Headers $headers -UseBasicParsing -TimeoutSec 5
    if ($resp.StatusCode -eq 200) { $health = $resp.Content | ConvertFrom-Json; break }
    $lastErr = "HTTP $($resp.StatusCode)"
  } catch {
    $code = $null
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 401) { $lastErr = "HTTP 401 — เซิร์ฟเวอร์ขึ้นแล้วแต่ไม่รับ DASHBOARD_TOKEN / AUTH_USER+AUTH_PASSWORD ที่อ่านจาก .env"; break }
    $lastErr = if ($code) { "HTTP $code" } else { $_.Exception.Message }
  }
  $taskState = (Get-ScheduledTask -TaskName $TaskName).State
  if ($taskState -eq "Running") { $seenRunning = $true }
  elseif ($seenRunning -or ((Get-Date) - $tStart).TotalSeconds -gt 5) {  # ให้เวลา scheduler เปลี่ยนเป็น Running ก่อน 5 วิ
    $lastErr = "task หลุดเป็นสถานะ $taskState (เซิร์ฟเวอร์ล้มตอนเริ่ม?) — $lastErr"; break
  }
  Start-Sleep -Milliseconds 500
}
if (-not $health) { Fail 5 "เซิร์ฟเวอร์ไม่ตอบ /api/health = 200 ภายใน $HealthTimeoutSec วิ: $lastErr" }

# --- 8) สรุป ---
$newFromPort = Get-ListenPids $port
$newPid = $null
if (Test-Path -LiteralPath $pidFile) {
  $raw = Get-Content -LiteralPath $pidFile -TotalCount 1
  if ($raw -and $raw.Trim() -match '^\d+$') { $newPid = [int]$raw.Trim() }
}
if (-not $newPid -and $newFromPort.Count) { $newPid = $newFromPort[0] }
$elapsed = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
$oldLabel = if ($oldPids.Count) { $oldPids -join "," } else { "-" }
$newLabel = if ($newPid) { $newPid } else { "?" }
$portLabel = if ($newFromPort.Count) { " โดย PID $($newFromPort -join ',')" } else { "" }
Write-Host "✅ รีสตาร์ต '$TaskName' สำเร็จใน $elapsed วิ" -ForegroundColor Green
Write-Host "   PID เดิม: $oldLabel → PID ใหม่: $newLabel (LISTENING ${bindHost}:${port}$portLabel)"
Write-Host "   mode: $($health.mode) · codeMode: $($health.codeMode) · liveAvailable: $($health.liveAvailable) · codeLive: $($health.codeLive) · uptime: $([math]::Round($health.uptimeMs / 1000, 1)) วิ"
if ($newPid -and ($oldPids -contains $newPid)) {
  Write-Host "   ⚠️ PID ใหม่ซ้ำกับของเดิม — เซิร์ฟเวอร์อาจไม่ได้รีสตาร์ตจริง (ตรวจ logs\server.log)" -ForegroundColor Yellow
  exit 5
}
exit 0
