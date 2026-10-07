# ============================================================================
#  One-shot patch: organizer controls for free tickets + the frontend check
#  ----------------------------------------------------------------------------
#  Same approach as _patch-checkout.ps1: the pages are CRLF files the editor
#  tool cannot rewrite in place, so each addition lives in a small companion
#  file and is stitched in with literal (non-regex) replacements. Every anchor
#  is asserted to exist AND to be unique before anything is written.
#
#  A companion file may hold several snippets separated by a line that is
#  exactly <<<SPLIT>>>; Get-Part picks one of them.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NL = "`r`n"

function Normalise([string]$text){
  $t = $text.TrimStart([char]0xFEFF)
  $t = $t -replace "`r`n", "`n"
  $t = $t -replace "`r", "`n"
  return $t
}
function Read-Block([string]$name){
  $p = Join-Path $root ('tools\_patch-' + $name)
  if(-not (Test-Path $p)){ throw "Missing patch block: $p" }
  $text = Normalise ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8))
  return (($text.TrimEnd("`n")) -replace "`n", $NL)
}
function Get-Part([string]$name, [int]$index){
  $p = Join-Path $root ('tools\_patch-' + $name)
  if(-not (Test-Path $p)){ throw "Missing patch block: $p" }
  $text = Normalise ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8))
  $parts = $text -split "(?m)^<<<SPLIT>>>[ `t]*$"
  if($index -ge $parts.Count){ throw "part $index is missing in $name (has $($parts.Count))" }
  return (($parts[$index].TrimEnd("`n")) -replace "`n", $NL)
}
function Replace-Once([string]$text, [string]$anchor, [string]$replacement, [string]$label){
  $first = $text.IndexOf($anchor)
  if($first -lt 0){ throw "anchor not found [$label]: $anchor" }
  if($text.IndexOf($anchor, $first + 1) -ge 0){ throw "anchor is not unique [$label]: $anchor" }
  return $text.Substring(0, $first) + $replacement + $text.Substring($first + $anchor.Length)
}
function Normalise-File([string]$text){
  $t = $text -replace "`r`n", "`n"
  $t = $t -replace "`r", "`n"
  return ($t -replace "`n", $NL)
}
function Patch([string]$relative, [scriptblock]$body){
  $path = Join-Path $root $relative
  $before = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  $after = & $body $before
  if($after -eq $before){ throw "nothing changed in $relative" }
  [System.IO.File]::WriteAllText($path, (Normalise-File $after), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ("  patched {0} ({1:N0} -> {2:N0} bytes)" -f $relative, $before.Length, $after.Length)
}

$freeSectionEdit = Read-Block 'freesec-edit.html'
$freeSectionCreate = Read-Block 'freesec-create.html'
$freeAside = Get-Part 'free-misc.js' 0
$freeCreateCollect = Get-Part 'free-misc.js' 1
$freeHelper = Get-Part 'free-event.js' 0
$freeFill = Get-Part 'free-event.js' 1
$freeCollect = Get-Part 'free-event.js' 2
$freeStats = Get-Part 'free-event.js' 3
$frontendFree = Get-Part 'frontend-free.js' 0

Write-Host 'edit-event/index.html'
Patch 'edit-event\index.html' {
  param($t)
  $t = Replace-Once $t '            <div class="sticky-footer" style="margin:0 -18px -18px">' ($freeSectionEdit + $NL + '            <div class="sticky-footer" style="margin:0 -18px -18px">') 'free settings section'
  $t = Replace-Once $t '        <div class="panel danger">' ($freeAside + $NL + '        <div class="panel danger">') 'free stats panel'
  $t = Replace-Once $t 'function fill(ev){' ($freeHelper + $NL + $NL + 'function fill(ev){') 'helpers'
  $t = Replace-Once $t '  $("#payment_mode").value = ev.payment_mode === "owner" ? "owner" : (ev.payment_mode === "own" ? "own" : "");' ('  $("#payment_mode").value = ev.payment_mode === "owner" ? "owner" : (ev.payment_mode === "own" ? "own" : "");' + $NL + $freeFill) 'fill settings'
  $t = Replace-Once $t '    payment_mode: $("#payment_mode") ? $("#payment_mode").value : "",' ('    payment_mode: $("#payment_mode") ? $("#payment_mode").value : "",' + $NL + $freeCollect) 'collect settings'
  $t = Replace-Once $t '  const st = ev.stats || {};' ($freeStats + $NL + '  const st = ev.stats || {};') 'free stats paint'
  return $t
}

Write-Host 'create-event/index.html'
Patch 'create-event\index.html' {
  param($t)
  $t = Replace-Once $t '          <hr class="divider" />' ('          <hr class="divider" />' + $NL + $freeSectionCreate) 'free defaults section'
  $t = Replace-Once $t '    payment_mode: $("#payment_mode") ? $("#payment_mode").value : ""' ('    payment_mode: $("#payment_mode") ? $("#payment_mode").value : ""' + $NL + $freeCreateCollect) 'collect defaults'
  return $t
}

Write-Host 'frontend-check.html'
Patch 'frontend-check.html' {
  param($t)
  return (Replace-Once $t '    ck("checkout has no duplicate element ids", coDups.length === 0, coDups.join(", "));' ('    ck("checkout has no duplicate element ids", coDups.length === 0, coDups.join(", "));' + $NL + $frontendFree) 'free-ticket assertions')
}
Write-Host 'done'