<#
  Claude Usage — Windows system-tray indicator
  ------------------------------------------------------------------
  Windows counterpart of the macOS SwiftBar plugin (claude-usage.180s.sh).
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

# ---- shared cache (optional; for accounts used from several machines) ----
# The rate limit is account-level, so N machines each polling every 180s means N
# times the requests against one budget. Point every machine at the same synced file
# (OneDrive / Dropbox / Syncthing) and whichever polls first pays for the fetch; the
# rest reuse it. Unset -> local-only, behaviour unchanged.
#   path from $env:TOKENBAR_SHARED_CACHE, else ~\.config\claude-usage-bar\shared-cache-path
# Format v1 is platform-neutral: {v,ts,sub,S,W,XL} - same shape all four surfaces use.
$SharedTtlMs = 150000   # < the 180s poll, so single-machine freshness is unchanged
function Get-SharedPath {
  if ($env:TOKENBAR_SHARED_CACHE -and $env:TOKENBAR_SHARED_CACHE.Trim()) { return $env:TOKENBAR_SHARED_CACHE.Trim() }
  $f = Join-Path $env:USERPROFILE '.config\claude-usage-bar\shared-cache-path'
  try { $p = (Get-Content -Raw -Path $f -ErrorAction Stop).Trim(); if ($p) { return $p } } catch {}
  return $null
}
function Read-Shared {
  $p = Get-SharedPath; if (-not $p) { return $null }
  try {
    $o = Get-Content -Raw -Path $p -ErrorAction Stop | ConvertFrom-Json
    if ($o.v -eq 1 -and $o.ts -ne $null) { return $o }
  } catch {}
  return $null
}
function Write-Shared($obj) {
  $p = Get-SharedPath; if (-not $p) { return }
  $t = "$p.tmp$PID"
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null
    $obj | ConvertTo-Json -Depth 8 | Set-Content -Path $t -Encoding UTF8
    # Swap in whole, so a syncing peer never reads a half-written file. Replace needs
    # an existing destination, so the first write is a plain move.
    if (Test-Path $p) { [System.IO.File]::Replace($t, $p, $null) }
    else { Move-Item -Force -Path $t -Destination $p }
  } catch {
    Remove-Item -Force -Path $t -ErrorAction SilentlyContinue   # never leave temp files behind
  }
}
# Another machine's clock may run ahead of ours; treat "written in the future" as fresh.
function Get-Age([double]$ts) { $a = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() - $ts; if ($a -lt 0) { return 0 } return $a }

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
# $bars is an array of @{ pct = <double>; col = <Color> } — session over weekly
# normally, plus a third row when a scoped weekly cap (a per-model limit such as
# Fable) is in play. Rows are shortened to fit the third into the same 32px icon.
function New-BarIcon($bars) {
  $sz  = 32
  $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
  $g   = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $rows = @($bars)
  $x = [single]3; $w = [single]26; $r = [single]4
  if ($rows.Count -ge 3) { $bh = [single]8;  $y0 = [single]2; $step = [single]10 }
  else                   { $bh = [single]10; $y0 = [single]6; $step = [single]12 }
  for ($i = 0; $i -lt $rows.Count; $i++) {
    $y   = [single]($y0 + $i * $step)
    $pct = [math]::Min(100, [double]$rows[$i].pct)
    # track
    $pt = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $pt $x $y $w $bh $r
    $bt = New-Object System.Drawing.SolidBrush($TRACK)
    $g.FillPath($bt, $pt); $bt.Dispose(); $pt.Dispose()
    # fill (min width = bar height so the rounded cap always shows)
    $fw = [single][math]::Max([double]$bh, [math]::Round($w * $pct / 100.0))
    $pf = New-Object System.Drawing.Drawing2D.GraphicsPath
    Add-RoundedRect $pf $x $y $fw $bh $r
    $bf = New-Object System.Drawing.SolidBrush($rows[$i].col)
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

# $XL holds the scoped weekly limits (per-model caps such as Fable). The icon has
# room for one row, so it gets the most-consumed — that's the one that will cut you
# off first — while the tooltip lists them all. Their lines are kept terse because
# NotifyIcon.Text is capped at 127 chars.
function Render($S, $W, $XL, $sub, $note) {
  $sp = [int][math]::Round([double]$S.percent)
  $wp = [int][math]::Round([double]$W.percent)
  $bars = @(
    @{ pct = $sp; col = (Get-Sev-Color $sp $S.severity) },
    @{ pct = $wp; col = (Get-Sev-Color $wp $W.severity) }
  )
  $tip = "Claude$(if ($sub) { " - $sub" })`n" +
         "Session $sp%  $(Get-Countdown $S.resets_at)  (resets $(Get-Clock $S.resets_at))`n" +
         "Weekly $wp%  $(Get-Countdown $W.resets_at)  (resets $(Get-Clock $W.resets_at))"

  $scoped = @(@($XL) | Where-Object { $_ } | Sort-Object { [double]$_.percent } -Descending)
  if ($scoped.Count -gt 0) {
    $xp = [int][math]::Round([double]$scoped[0].percent)
    $bars += @{ pct = $xp; col = (Get-Sev-Color $xp $scoped[0].severity) }
    foreach ($l in $scoped) {
      $tip += "`n$($l.name) $([int][math]::Round([double]$l.percent))%  $(Get-Countdown $l.resets_at)"
    }
  }

  $hicon = New-BarIcon $bars
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
  if ($cache -and ((Get-Age ([double]$cache.ts)) -lt 50000)) {
    Render $cache.S $cache.W $cache.XL $cache.sub $null
    return
  }

  # Another machine may have already paid for this data - reuse it rather than
  # spending a second request against the shared account-level limit. Its ts is kept
  # verbatim so "cached Ns ago" stays honest and the next poll re-evaluates correctly.
  $sh = Read-Shared
  if ($sh -and ((Get-Age ([double]$sh.ts)) -lt $SharedTtlMs)) {
    Write-Cache ([pscustomobject]@{ sub = $sh.sub; S = $sh.S; W = $sh.W; XL = $sh.XL; ts = $sh.ts })
    Render $sh.S $sh.W $sh.XL $sh.sub $null
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

    # Per-model weekly caps (Fable today, Opus before it). Flattened to a plain name
    # here so a cached copy stays renderable without re-reading the scope object.
    $XL = @($d.limits | Where-Object { $_.kind -eq 'weekly_scoped' } | ForEach-Object {
      $nm = $_.scope.model.display_name
      if (-not $nm) { $nm = $_.scope.surface }
      if (-not $nm) { $nm = 'scoped' }
      [pscustomobject]@{ percent = $_.percent; resets_at = $_.resets_at; severity = $_.severity; name = $nm }
    })

    Write-Cache ([pscustomobject]@{ sub = $oauth.subscriptionType; S = $S; W = $W; XL = $XL; ts = $nowMs })
    # Publish for the other machines/apps sharing this account's request budget.
    Write-Shared ([pscustomobject]@{ v = 1; ts = $nowMs; sub = $oauth.subscriptionType; S = $S; W = $W; XL = $XL })
    Render $S $W $XL $oauth.subscriptionType $null
  }
  catch {
    $code = $null
    try { if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode } } catch {}

    # newest of whatever we can still draw from - a peer's reading beats a blank icon,
    # including on a PC that was never signed in
    $fb = $null
    if ($cache) { $fb = [pscustomobject]@{ S = $cache.S; W = $cache.W; XL = $cache.XL; sub = $cache.sub; ts = [double]$cache.ts } }
    if ($sh -and ((-not $fb) -or ([double]$sh.ts -gt $fb.ts))) {
      $fb = [pscustomobject]@{ S = $sh.S; W = $sh.W; XL = $sh.XL; sub = $sh.sub; ts = [double]$sh.ts }
    }

    if ($fb) {
      $age = [int][math]::Round((Get-Age $fb.ts) / 1000)
      $note = if (-not (Test-Path $CredPath)) { "not signed in on this PC - cached ${age}s ago" }
              elseif ($code) { "API $code - cached ${age}s ago" }
              else { "offline - cached ${age}s ago" }
      Render $fb.S $fb.W $fb.XL $fb.sub $note
    }
    elseif (-not (Test-Path $CredPath)) { Show-Error 'Not logged in to Claude Code on this PC' }
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
$timer.Interval = 180000  # 180s, matches the other platforms
$timer.add_Tick({ Update-Bar })
$timer.Start()

Update-Bar
[System.Windows.Forms.Application]::Run()
