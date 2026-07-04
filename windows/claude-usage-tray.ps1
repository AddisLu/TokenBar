<#
  Claude Usage — Windows system-tray indicator
  ------------------------------------------------------------------
  Windows counterpart of the macOS SwiftBar plugin (claude-usage.60s.sh).
  Shows REAL Claude usage from Anthropic's official oauth/usage endpoint
  (same data as Claude Code's /usage): session (5h) + weekly, with reset
  countdowns. Draws the same two-segment progress bar as a tray icon;
  hover for the numbers.

  Resilient to the endpoint's tight rate limit, exactly like the Mac version:
    - caches the last good result and keeps drawing the bar (countdowns
      recomputed live) when the API returns 429 / errors, and
    - skips the API entirely if the last success was < 50s ago.

  Credentials are read (read-only) from %USERPROFILE%\.claude\.credentials.json.
  Run:  powershell -ExecutionPolicy Bypass -File claude-usage-tray.ps1
  (The installer sets it to launch hidden at login.)
#>

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IconUtil {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

# ---- paths ----
$CredPath  = Join-Path $env:USERPROFILE '.claude\.credentials.json'
$CacheDir  = Join-Path $env:LOCALAPPDATA 'ClaudeUsageBar'
$CachePath = Join-Path $CacheDir 'cache.json'
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

# ---- palette (matches the Mac plugin) ----
$GREEN  = [System.Drawing.Color]::FromArgb(255, 46, 194, 126)
$ORANGE = [System.Drawing.Color]::FromArgb(255, 255, 120, 0)
$RED    = [System.Drawing.Color]::FromArgb(255, 224, 27, 36)
$TRACK  = [System.Drawing.Color]::FromArgb(90, 150, 150, 150)   # translucent grey track

function Get-Sev-Color([double]$p, [string]$sev) {
  if ($sev -eq 'critical' -or $p -ge 90) { return $RED }
  if ($sev -eq 'warning'  -or $p -ge 70) { return $ORANGE }
  return $GREEN
}

# live countdown "H:MM" / "Nm" from an ISO reset time
function Get-Countdown([string]$iso) {
  if ([string]::IsNullOrEmpty($iso)) { return 'n/a' }
  try { $t = [datetimeoffset]::Parse($iso) } catch { return 'n/a' }
  $mins = ($t - [datetimeoffset]::Now).TotalMinutes
  if ($mins -le 0) { return 'now' }
  $m = [int][math]::Floor($mins); $h = [int][math]::Floor($m / 60)
  if ($h -gt 0) { return ('{0}:{1:D2}' -f $h, ($m % 60)) }
  return "${m}m"
}
function Get-Clock([string]$iso) {
  if ([string]::IsNullOrEmpty($iso)) { return 'n/a' }
  try { return ([datetimeoffset]::Parse($iso)).LocalDateTime.ToString('ddd HH:mm') } catch { return 'n/a' }
}

# ---- icon drawing (two stacked rounded bars = session over weekly) ----
function Add-RoundedRect($path, [single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  if ($w -lt ($r * 2)) { $r = $w / 2 }
  if ($h -lt ($r * 2)) { $r = $h / 2 }
  $d = $r * 2
  $path.AddArc($x,          $y,          $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y,          $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d,   0, 90)
  $path.AddArc($x,          $y + $h - $d, $d, $d,  90, 90)
  $path.CloseFigure()
}

# returns an HICON handle (caller owns it, must DestroyIcon after swap)
function New-BarIcon([double]$sp, $sCol, [double]$wp, $wCol) {
  $sz  = 32
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $x = [single]3; $w = [single]26; $bh = [single]10; $r = [single]4
  $rows = @(
    @{ y = [single]6;  pct = [math]::Min(100, $sp); col = $sCol },
    @{ y = [single]18; pct = [math]::Min(100, $wp); col = $wCol }
  )
  foreach ($row in $rows) {
    # track
    $pt = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $pt $x $row.y $w $bh $r
    $bt = New-Object System.Drawing.SolidBrush($TRACK)
    $g.FillPath($bt, $pt); $bt.Dispose(); $pt.Dispose()
    # fill (min width = bar height so the rounded cap always shows)
    $fw = [single][math]::Max([double]$bh, [math]::Round($w * $row.pct / 100.0))
    $pf = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $pf $x $row.y $fw $bh $r
    $bf = New-Object System.Drawing.SolidBrush($row.col)
    $g.FillPath($bf, $pf); $bf.Dispose(); $pf.Dispose()
  }
  $g.Dispose()
  $hicon = $bmp.GetHicon()
  $bmp.Dispose()
  return $hicon
}

function New-DotIcon($color) {
  $sz  = 32
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $b = New-Object System.Drawing.SolidBrush($color)
  $g.FillEllipse($b, 8, 8, 16, 16); $b.Dispose(); $g.Dispose()
  $hicon = $bmp.GetHicon(); $bmp.Dispose(); return $hicon
}

# ---- cache ----
function Read-Cache {
  try { return (Get-Content -Raw -Path $CachePath -ErrorAction Stop | ConvertFrom-Json) } catch { return $null }
}
function Write-Cache($obj) {
  try { $obj | ConvertTo-Json -Depth 8 | Set-Content -Path $CachePath -Encoding UTF8 } catch {}
}

# ---- tray plumbing ----
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Visible = $true
$notify.Icon = [System.Drawing.SystemIcons]::Application

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miRefresh = $menu.Items.Add('Refresh')
$miQuit    = $menu.Items.Add('Quit')
$notify.ContextMenuStrip = $menu

$script:LastHicon = [IntPtr]::Zero
function Set-Tray([IntPtr]$hicon, [string]$tip) {
  $icon = [System.Drawing.Icon]::FromHandle($hicon)
  $notify.Icon = $icon
  if (-not [string]::IsNullOrEmpty($tip)) {
    if ($tip.Length -gt 127) { $tip = $tip.Substring(0, 127) }
    $notify.Text = $tip
  }
  if ($script:LastHicon -ne [IntPtr]::Zero) { [IconUtil]::DestroyIcon($script:LastHicon) | Out-Null }
  $script:LastHicon = $hicon
}

function Render($S, $W, $sub, $note) {
  $sp = [int][math]::Round([double]$S.percent)
  $wp = [int][math]::Round([double]$W.percent)
  $sCol = Get-Sev-Color $sp $S.severity
  $wCol = Get-Sev-Color $wp $W.severity
  $hicon = New-BarIcon $sp $sCol $wp $wCol
  $tip = "Claude$(if ($sub) { " - $sub" })`n" +
         "Session $sp%  $(Get-Countdown $S.resets_at)  (resets $(Get-Clock $S.resets_at))`n" +
         "Weekly $wp%  $(Get-Countdown $W.resets_at)  (resets $(Get-Clock $W.resets_at))"
  if ($note) { $tip = "$note`n$tip" }
  Set-Tray $hicon $tip
}

function Show-Error([string]$msg) {
  $hicon = New-DotIcon $TRACK
  Set-Tray $hicon ("Claude usage`n$msg")
}

function Update-Bar {
  $cache = Read-Cache
  $nowMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()

  # throttle guard: reuse a <50s-old success without hitting the API
  if ($cache -and (($nowMs - [double]$cache.ts) -lt 50000)) {
    Render $cache.S $cache.W $cache.sub $null
    return
  }

  try {
    $creds = Get-Content -Raw -Path $CredPath -ErrorAction Stop | ConvertFrom-Json
    $oauth = $creds.claudeAiOauth
    if (-not $oauth.accessToken) { throw 'no token' }
    $headers = @{
      Authorization        = "Bearer $($oauth.accessToken)"
      'anthropic-beta'     = 'oauth-2025-04-20'
      'anthropic-version'  = '2023-06-01'
      Accept               = 'application/json'
      'User-Agent'         = 'claude-cli/usage-bar'
    }
    $d = Invoke-RestMethod -Uri 'https://api.anthropic.com/api/oauth/usage' -Headers $headers -TimeoutSec 15

    $S = $d.limits | Where-Object { $_.kind -eq 'session' }     | Select-Object -First 1
    $W = $d.limits | Where-Object { $_.kind -eq 'weekly_all' }  | Select-Object -First 1
    if (-not $S -and $d.five_hour) { $S = [pscustomobject]@{ percent = $d.five_hour.utilization; resets_at = $d.five_hour.resets_at; severity = 'normal' } }
    if (-not $W -and $d.seven_day) { $W = [pscustomobject]@{ percent = $d.seven_day.utilization; resets_at = $d.seven_day.resets_at; severity = 'normal' } }

    Write-Cache ([pscustomobject]@{ sub = $oauth.subscriptionType; S = $S; W = $W; ts = $nowMs })
    Render $S $W $oauth.subscriptionType $null
  }
  catch {
    $code = $null
    try { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } } catch {}
    if (-not (Test-Path $CredPath)) {
      Show-Error 'Not logged in to Claude Code on this PC'
      return
    }
    if ($cache) {
      $age = [int][math]::Round(($nowMs - [double]$cache.ts) / 1000)
      $note = if ($code) { "API $code - cached ${age}s ago" } else { "offline - cached ${age}s ago" }
      Render $cache.S $cache.W $cache.sub $note
    }
    elseif ($code -eq 401 -or $code -eq 403) { Show-Error 'Token expired - run Claude Code once' }
    elseif ($code) { Show-Error "HTTP $code" }
    else { Show-Error 'Network error' }
  }
}

$miRefresh.add_Click({ Update-Bar })
$miQuit.add_Click({
  $notify.Visible = $false
  if ($script:LastHicon -ne [IntPtr]::Zero) { [IconUtil]::DestroyIcon($script:LastHicon) | Out-Null }
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 60000   # 60s, matches the Mac plugin's .60s cadence
$timer.add_Tick({ Update-Bar })
$timer.Start()

Update-Bar
[System.Windows.Forms.Application]::Run()
