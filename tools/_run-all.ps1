# ============================================================================
#  Run every check page headlessly and print one RESULT line per page.
#  Pages share port 8137, so they run strictly one after another.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pages = @('cors-check.html','rate-limit-check.html','turnstile-check.html','bundle-check.html',
           'approval-check.html','orders-detail-check.html','order-lookup-check.html','frontend-check.html','payhero-check.html')
foreach($p in $pages){
  Write-Host "=== $p ==="
  & powershell -ExecutionPolicy Bypass -File (Join-Path $root 'tools\run-check.ps1') -Page $p |
    Select-String -Pattern 'RESULT:|^\s*FAIL' | ForEach-Object { "  " + $_.Line.Trim() }
}