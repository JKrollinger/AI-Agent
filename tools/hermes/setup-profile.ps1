# setup-profile.ps1 - wire an existing Hermes Agent profile to the AI Workforce Control Center (docs/11-hermes.md, path B).
# Run once, by the user, after `hermes profile create <name> --no-alias`:
#   powershell -NoProfile -ExecutionPolicy Bypass -File "tools\hermes\setup-profile.ps1" -Profile grock [-CopyOpenAIKey] [-Port 8645]
# What it does (never prints secret values):
#   1. generates an API token + webhook secret
#   2. appends API_TOKENS / TOKEN_DAILY_USD / JOB_WEBHOOK_URL / WEBHOOK_SECRET to the control center .env (refuses if already present)
#   3. appends TELEGRAM_* / OPENAI_API_KEY / WEBHOOK_* lines to <profile>\.env (bot token left blank for you to paste)
#   4. writes <profile>\config.yaml from the embedded template (model copied from the default profile) and <profile>\SOUL.md from SOUL.grock.md
# It never touches the default profile's files (read-only: model block, TELEGRAM_ALLOWED_USERS / TELEGRAM_HOME_CHANNEL, optionally OPENAI_API_KEY).
# -Repo overrides the control center folder (default: the repo this script lives in); HERMES_HOME env overrides the Hermes home.
param(
  [string]$Profile = "grock",
  [int]$Port = 8645,
  [string]$GrockUrl = "http://127.0.0.1:3789",
  [double]$DailyUsd = 5,
  [string]$Repo = "",
  [switch]$CopyOpenAIKey,
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding $false
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = if ($Repo) { (Resolve-Path $Repo).Path.TrimEnd("\") } else { (Resolve-Path (Join-Path $here "..\..")).Path.TrimEnd("\") }
$repoPosix = $repo -replace "\\", "/"
$ccEnv = Join-Path $repo ".env"
$hermesHome = if ($env:HERMES_HOME) { $env:HERMES_HOME } else { Join-Path $env:LOCALAPPDATA "hermes" }
$profileDir = Join-Path $hermesHome ("profiles\" + $Profile)
$nodeExe = (Get-Command node -ErrorAction Stop).Source -replace "\\", "/"

function Read-Text($p) { if (Test-Path $p) { [System.IO.File]::ReadAllText($p, $utf8) } else { "" } }
function Write-Text($p, $t) { [System.IO.File]::WriteAllText($p, $t, $utf8) }
function Append-Text($p, $t) { [System.IO.File]::AppendAllText($p, $t, $utf8) }
function Env-Value($text, $name) { $m = [regex]::Match($text, "(?m)^" + [regex]::Escape($name) + "=(.*)$"); if ($m.Success) { $m.Groups[1].Value.Trim() } else { "" } }
function Rand-Bytes($n) { $b = New-Object byte[] $n; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $b }

if (-not (Test-Path $profileDir)) { throw "Profile folder not found: $profileDir  (run: hermes profile create $Profile --no-alias)" }
if (-not (Test-Path $ccEnv)) { throw "Control center .env not found: $ccEnv (copy .env.example to .env first)" }
$defaultEnv = Read-Text (Join-Path $hermesHome ".env")
$defaultCfg = Read-Text (Join-Path $hermesHome "config.yaml")

# ---- 1. secrets (kept in memory only) ----
$token = [Convert]::ToBase64String((Rand-Bytes 24)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
$secret = -join ((Rand-Bytes 32) | ForEach-Object { $_.ToString("x2") })

# ---- 2. control center .env ----
$cc = Read-Text $ccEnv
foreach ($k in @("API_TOKENS", "JOB_WEBHOOK_URL", "WEBHOOK_SECRET")) {
  if ($cc -match "(?m)^$k=" -and -not $Force) { throw "$ccEnv already has $k - remove it or rerun with -Force (then the old token stops working)" }
}
$nl = if ($cc.Length -gt 0 -and -not $cc.EndsWith("`n")) { "`n" } else { "" }
Append-Text $ccEnv ($nl + @"

# ---------- Hermes Agent profile "$Profile" (docs/11-hermes.md path B) - written by tools/hermes/setup-profile.ps1 $(Get-Date -Format yyyy-MM-dd) ----------
API_TOKENS=hermes:${token}:jobs
TOKEN_DAILY_USD=$DailyUsd
JOB_WEBHOOK_URL=http://127.0.0.1:$Port/webhooks/grock
WEBHOOK_SECRET=$secret
"@ + "`n")
Write-Host "[ok] $ccEnv  <- API_TOKENS (hermes, jobs), TOKEN_DAILY_USD=$DailyUsd, JOB_WEBHOOK_URL (port $Port), WEBHOOK_SECRET"

# ---- 3. profile .env ----
$allowed = Env-Value $defaultEnv "TELEGRAM_ALLOWED_USERS"
$homeChat = Env-Value $defaultEnv "TELEGRAM_HOME_CHANNEL"; if (-not $homeChat) { $homeChat = $allowed }
$openai = if ($CopyOpenAIKey) { Env-Value $defaultEnv "OPENAI_API_KEY" } else { "" }
$pEnvPath = Join-Path $profileDir ".env"
$pEnv = Read-Text $pEnvPath
if ($pEnv -match "(?m)^WEBHOOK_SECRET=" -and -not $Force) { throw "$pEnvPath already configured - rerun with -Force to append again" }
Append-Text $pEnvPath (@"

# ===== profile $Profile : AI Workforce Control Center (see $repoPosix/docs/11-hermes.md) =====
# [YOU] bot token for a NEW Telegram bot from @BotFather (/newbot) - must differ from the default profile's bot
TELEGRAM_BOT_TOKEN=
# user ids allowed to command the bot (copied from the default profile) and the chat that receives webhook results
TELEGRAM_ALLOWED_USERS=$allowed
TELEGRAM_HOME_CHANNEL=$homeChat
# model key for this profile (copied from the default profile when -CopyOpenAIKey was given; otherwise paste it here)
OPENAI_API_KEY=$openai
# webhook ingress of THIS profile's gateway (standalone, port $Port - separate from the default profile)
WEBHOOK_ENABLED=true
WEBHOOK_PORT=$Port
WEBHOOK_SECRET=$secret
"@ + "`n")
Write-Host ("[ok] {0}  <- TELEGRAM_BOT_TOKEN (blank, paste yours), TELEGRAM_ALLOWED_USERS ({1}), TELEGRAM_HOME_CHANNEL, OPENAI_API_KEY ({2}), WEBHOOK_ENABLED/PORT/SECRET" -f $pEnvPath, $(if ($allowed) { "copied" } else { "EMPTY - fill it" }), $(if ($openai) { "copied" } else { "blank - paste yours" }))

# ---- 4. profile config.yaml + SOUL.md ----
$model = "gpt-5.4-mini"; $provider = "openai-api"; $baseUrl = "https://api.openai.com/v1"
$mb = [regex]::Match($defaultCfg, "(?ms)^model:\s*\n(.*?)(?=^\S|\z)")
if ($mb.Success) {
  $m = [regex]::Match($mb.Groups[1].Value, "(?m)^\s+default:\s*(\S+)"); if ($m.Success) { $model = $m.Groups[1].Value }
  $m = [regex]::Match($mb.Groups[1].Value, "(?m)^\s+provider:\s*(\S+)"); if ($m.Success) { $provider = $m.Groups[1].Value }
  $m = [regex]::Match($mb.Groups[1].Value, "(?m)^\s+base_url:\s*(\S+)"); if ($m.Success) { $baseUrl = $m.Groups[1].Value }
}
$cfgPath = Join-Path $profileDir "config.yaml"
if ((Test-Path $cfgPath) -and -not $Force) { throw "$cfgPath already exists - rerun with -Force to overwrite" }
$tpl = @'
# config.yaml of Hermes profile "{{PROFILE}}" - chief manager for the AI Workforce Control Center
# written by tools/hermes/setup-profile.ps1 (docs/11-hermes.md, path B); unspecified keys use Hermes defaults
model:
  default: {{MODEL}}
  provider: {{PROVIDER}}
  base_url: {{BASE_URL}}

skills:
  external_dirs:
    - "{{REPO}}/tools/hermes/skills"   # skill grock-workforce: when to (not) use the mcp_grock_* tools

mcp_servers:
  grock:
    command: "{{NODE}}"
    args: ["{{REPO}}/tools/mcp-server.mjs"]
    env:
      GROCK_URL: "{{GROCK_URL}}"
      GROCK_TOKEN: "{{TOKEN}}"   # = token "hermes" in API_TOKENS of the control center (scope jobs)
    timeout: 900
    connect_timeout: 30
    enabled: true

platforms:
  webhook:
    enabled: true
    extra:
      port: {{PORT}}
      host: "127.0.0.1"               # loopback only (the control center runs on this machine); drop for LAN senders
      secret: "{{SECRET}}"
      routes:
        grock:   # control center POSTs to http://127.0.0.1:{{PORT}}/webhooks/grock (JOB_WEBHOOK_URL) with X-Webhook-Signature-V2
          secret: "{{SECRET}}"
          deliver: "telegram"            # to TELEGRAM_HOME_CHANNEL of this profile
          deliver_only: true             # send the rendered prompt as-is, no model call
          prompt: |
            {event} - {goal}
            {summary}
            ${costUsd} USD / {durationSec} s / requested by {requestedBy}
            {resultPath}
'@
$cfg = $tpl.Replace("{{PROFILE}}", $Profile).Replace("{{MODEL}}", $model).Replace("{{PROVIDER}}", $provider).Replace("{{BASE_URL}}", $baseUrl).Replace("{{REPO}}", $repoPosix).Replace("{{NODE}}", $nodeExe).Replace("{{GROCK_URL}}", $GrockUrl).Replace("{{TOKEN}}", $token).Replace("{{SECRET}}", $secret).Replace("{{PORT}}", "$Port")
Write-Text $cfgPath $cfg
Write-Host "[ok] $cfgPath  <- model $model ($provider), skills.external_dirs, mcp_servers.grock (node $nodeExe), platforms.webhook route grock on port $Port"
$soulPath = Join-Path $profileDir "SOUL.md"
$soulNow = Read-Text $soulPath
if ($soulNow.Length -gt 0 -and $soulNow.Length -ne 513 -and -not $Force) { Write-Host "[skip] $soulPath already customised (keep it, or rerun with -Force)" }
else { Write-Text $soulPath (Read-Text (Join-Path $here "SOUL.grock.md")); Write-Host "[ok] $soulPath  <- SOUL.grock.md" }

Write-Host ""
Write-Host "Next:"
Write-Host ("  1. paste the new bot token into $pEnvPath  (TELEGRAM_BOT_TOKEN=...)" + $(if (-not $openai) { " and OPENAI_API_KEY=..." } else { "" }))
Write-Host "  2. restart the control center so it loads API_TOKENS/JOB_WEBHOOK_URL (Task Scheduler 'Grock Agent Server' or npm start)"
Write-Host "  3. hermes -p $Profile gateway install   (Scheduled Task Hermes_Gateway_$Profile, starts at logon)  or  hermes -p $Profile gateway start"
Write-Host "  4. message the new bot: it should call mcp_grock_create_job; results come back via http://127.0.0.1:$Port/webhooks/grock"
