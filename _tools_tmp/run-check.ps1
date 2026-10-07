# ============================================================================
#  Prince Alex TicketHub - run a browser check page headlessly
#  ---------------------------------------------------------------------------
#  Starts tools\serve.ps1, opens the check page in headless Chrome, prints the
#  RESULTS_JSON it produced and stops the server. Used by payhero-check.html
#  (three-provider payment flow) and by the existing cors/rate-limit/turnstile
#  check pages.
#
#      powershell -ExecutionPolicy Bypass -File tools\run-check.ps1
#      powershell -ExecutionPolicy Bypass -File tools\run-check.ps1 -Page cors-check.html
#
#  Exit code 0 when every check passed, 1 otherwise.
# ============================================================================
param(
  [string]$Page = 'payhero-check.html',
  [int]$Port = 8137,
  [int]$TimeoutSec = 240,
  [int]$BudgetMs = 120000
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$resultFile = Join-Path $env:TEMP 'tickethub-check-result.json'
if(Test-Path $resultFile){ Remove-Item $resultFile -Force }

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if(-not $chrome){ Write-Host 'No Chrome or Edge found.'; exit 2 }

$server = Start-Process powershell -PassThru -WindowStyle Hidden -ArgumentList `
  '-ExecutionPolicy', 'Bypass', '-File', "`"$here\serve.ps1`"", '-Port', "$Port"
$browser = $null
try {
  $ready = $false
  for($i = 0; $i -lt 40; $i++){
    Start-Sleep -Milliseconds 250
    try { Invoke-WebRequest -Uri "http://127.0.0.1:$Port/$Page" -UseBasicParsing -TimeoutSec 3 | Out-Null; $ready = $true; break } catch { }
  }
  if(-not $ready){ Write-Host 'The static server did not start.'; exit 2 }

  # No --virtual-time-budget: it dumps the DOM before real async work (WebCrypto
  # key generation) has finished. The page POSTs its result instead.
  # A throwaway profile per run, so a previous run can never hold a lock on it.
  $profile = Join-Path $env:TEMP ("th-profile-" + [guid]::NewGuid().ToString('N'))
  $browser = Start-Process $chrome -PassThru -WindowStyle Hidden -ArgumentList `
    '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    "--user-data-dir=$profile", "http://127.0.0.1:$Port/$Page"

  $result = $null
  for($i = 0; $i -lt ($TimeoutSec * 4); $i++){
    Start-Sleep -Milliseconds 250
    if(Test-Path $resultFile){
      $raw = Get-Content $resultFile -Raw
      if($raw -and $raw.Length -gt 20){
        try { $result = $raw | ConvertFrom-Json; break } catch { }
      }
    }
  }
  if(-not $result){
    # Fallback for the older check pages, which only write RESULTS_JSON into the
    # page instead of posting it. They finish synchronously, so a virtual time
    # budget is enough for them.
    $dump = Join-Path $env:TEMP ("th-dump-" + [guid]::NewGuid().ToString('N') + '.html')
    & $chrome --headless=new --disable-gpu --no-sandbox --virtual-time-budget=$BudgetMs --dump-dom `
        "http://127.0.0.1:$Port/$Page" 2>$null | Out-File -Encoding utf8 $dump
    $html = Get-Content $dump -Raw
    Remove-Item $dump -ErrorAction SilentlyContinue
    $out = ''
    if($html -match '(?s)<div id="out">(.*?)</div>'){ $out = $Matches[1] }
    if($out -match '^RESULTS_JSON:(.*)$'){
      $json = $Matches[1] -replace '&quot;', '"' -replace '&lt;', '<' -replace '&gt;', '>' -replace '&amp;', '&'
      try { $result = $json | ConvertFrom-Json } catch { }
    }
    if($result -and -not $result.summary){
      # Older pages report a flat {tests:[...]} shape.
      $passed = @($result.tests | Where-Object { $_.pass }).Count
      $result | Add-Member -NotePropertyName summary -NotePropertyValue ([pscustomobject]@{
        total = @($result.tests).Count; passed = $passed; failed = @($result.tests).Count - $passed })
    }
  }
  if(-not $result){
    Write-Host "The page did not report a result within $TimeoutSec seconds."
    exit 2
  }

  $failed = @($result.tests | Where-Object { -not $_.pass })
  foreach($t in $result.tests){
    if($t.pass){ Write-Host ("  PASS  " + $t.name) }
    else { Write-Host ("  FAIL  " + $t.name + "`n        ==> " + $t.detail) }
  }
  if($result.errors){ Write-Host "`n--- Worker console.error (first 12) ---"; $result.errors | ForEach-Object { Write-Host ("  " + $_) } }
  if($result.mock_errors){ Write-Host "`n--- Mock database errors (first 15) ---"; $result.mock_errors | Select-Object -Unique | ForEach-Object { Write-Host ("  " + $_) } }
  if($result.sql_tail){ Write-Host "`n--- Last statements executed ---"; $result.sql_tail | ForEach-Object { Write-Host ("  " + $_) } }
  if($result.notes){ Write-Host "`n--- Harness notes ---"; $result.notes | ForEach-Object { Write-Host ("  " + $_) } }
  Write-Host ""
  Write-Host ("RESULT: " + $result.summary.passed + " passed, " + $result.summary.failed + " failed, " + $result.summary.total + " total")
  if($failed.Count -gt 0){ exit 1 }
} finally {
  if($browser){ Stop-Process -Id $browser.Id -Force -ErrorAction SilentlyContinue }
  Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $resultFile -Force -ErrorAction SilentlyContinue
  if($profile){ Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue }
}
