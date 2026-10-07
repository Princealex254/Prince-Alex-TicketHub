# ============================================================================
#  Move the free-ticket group so it runs BEFORE the harness restores
#  console.error/warn - otherwise a Worker error inside the group would not be
#  reported in R.errors and a failure would be harder to diagnose.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$path = Join-Path $root 'payhero-check.html'
$NL = "`r`n"
$t = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

$marker = 'try {' + $NL + '  step("free tickets");'
$start = $t.IndexOf($marker)
if($start -lt 0){ throw 'the free-ticket group was not found' }

$endAnchor = '  R.sql_tail = SQL_LOG.slice(-14);'
$end = $t.IndexOf($endAnchor, $start)
if($end -lt 0){ throw 'the end anchor was not found' }
$block = $t.Substring($start, $end - $start).TrimEnd([char]13, [char]10)
$t = $t.Remove($start, $end - $start)

$after = '  } catch(e){ ck("group 10 (owner payment mode)", false, (e && e.stack) || String(e)); }'
$at = $t.IndexOf($after)
if($at -lt 0){ throw 'the last-group anchor was not found' }
if($t.IndexOf($after, $at + 1) -ge 0){ throw 'the last-group anchor is not unique' }
$t = $t.Insert($at + $after.Length, $NL + $NL + $block)

$t = ($t -replace "`r`n", "`n") -replace "`r", "`n"
[System.IO.File]::WriteAllText($path, ($t -replace "`n", $NL), (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'The free-ticket group now runs while console.error is still captured.'