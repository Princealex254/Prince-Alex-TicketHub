# ============================================================================
#  One-shot patch: the free-ticket end-to-end group in payhero-check.html
#  ----------------------------------------------------------------------------
#  payhero-check.html drives the REAL worker/worker.js against a mocked D1 and
#  mocked provider APIs. The new group is stitched in from the _patch-free-e2e*.js
#  parts (in order) just before the harness reports its results, so it runs after
#  every existing group and cannot disturb their shared database state.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$NL = "`r`n"

function Normalise([string]$text){
  $t = $text.TrimStart([char]0xFEFF)
  $t = $t -replace "`r`n", "`n"
  return ($t -replace "`r", "`n")
}
function Read-Part([string]$name){
  $p = Join-Path $root ('tools\_patch-' + $name)
  if(-not (Test-Path $p)){ throw "Missing patch part: $p" }
  $text = Normalise ([System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8))
  return ($text.TrimEnd("`n") -replace "`n", $NL)
}

$parts = @()
foreach($name in @('free-e2e.js','free-e2e2.js','free-e2e3.js','free-e2e4.js','free-e2e5.js')){
  $parts += (Read-Part $name)
}
$block = $parts -join ($NL + $NL)

$path = Join-Path $root 'payhero-check.html'
$before = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

# --- 1. remove any previous copy of the group so the script is idempotent ---
$groupStart = 'try {' + $NL + '  step("free tickets");'
$endAnchor  = '  R.sql_tail = SQL_LOG.slice(-14);'
$s = $before.IndexOf($groupStart)
if($s -ge 0){
  $e = $before.IndexOf($endAnchor, $s)
  if($e -lt 0){ throw 'the end anchor was not found after the existing group' }
  $before = $before.Remove($s, $e - $s)
}

# --- 2. stitch the fresh group in just before the harness collects results ---
$after = '  } catch(e){ ck("group 10 (owner payment mode)", false, (e && e.stack) || String(e)); }'
$at = $before.IndexOf($after)
if($at -lt 0){ throw "anchor not found: $after" }
if($before.IndexOf($after, $at + 1) -ge 0){ throw "anchor is not unique: $after" }

$out = $before.Substring(0, $at + $after.Length) + $NL + $NL + $block + $NL + $NL + $before.Substring($at + $after.Length)
$out = ($out -replace "`r`n", "`n") -replace "`r", "`n"
[System.IO.File]::WriteAllText($path, ($out -replace "`n", $NL), (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("Wrote {0} ({1:N0} -> {2:N0} bytes)" -f $path, $before.Length, $out.Length)