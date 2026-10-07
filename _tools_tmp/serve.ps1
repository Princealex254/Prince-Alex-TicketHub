# ============================================================================
#  Prince Alex TicketHub - tiny static file server for the browser test harness
#  ---------------------------------------------------------------------------
#  The repository has no build system and no Node dependency; the check pages
#  (cors-check.html, rate-limit-check.html, turnstile-check.html, payhero-check.html)
#  load the real Worker as an ES module, which browsers refuse to do over
#  file://. This script serves the repository over http://127.0.0.1:<port> so a
#  headless browser can run a check page and print RESULTS_JSON.
#
#  Usage:
#      powershell -ExecutionPolicy Bypass -File tools\serve.ps1 -Port 8137
#  Stop with Ctrl+C, or let tools\run-check.ps1 start and stop it for you.
# ============================================================================
param(
  [int]$Port = 8137,
  [string]$Root
)

$ErrorActionPreference = 'Stop'
if(-not $Root){ $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path $Root).Path

$MIME = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "Serving $Root on http://127.0.0.1:$Port/"

try {
  while($listener.IsListening){
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response
    try {
      $path = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath)
      # A check page POSTs its RESULTS_JSON here when it finishes, so the
      # runner does not have to guess when the page is done.
      if($path -eq '/__result' -and $request.HttpMethod -eq 'POST'){
        $reader = New-Object System.IO.StreamReader($request.InputStream, $request.ContentEncoding)
        $payload = $reader.ReadToEnd()
        $reader.Close()
        $target = Join-Path $env:TEMP 'tickethub-check-result.json'
        [System.IO.File]::WriteAllText($target, $payload, (New-Object System.Text.UTF8Encoding($false)))
        $response.StatusCode = 204
        $response.ContentLength64 = 0
        $response.OutputStream.Close()
        continue
      }
      if($path -eq '/' -or $path -eq ''){ $path = '/index.html' }
      $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $full = Join-Path $Root $relative
      $full = [System.IO.Path]::GetFullPath($full)
      $body = $null
      if($full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $full -PathType Leaf)){
        $body = [System.IO.File]::ReadAllBytes($full)
      }
      $response.Headers['Cache-Control'] = 'no-store'
      $response.Headers['Access-Control-Allow-Origin'] = '*'
      if($null -eq $body){
        $response.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('Not found')
        $response.ContentType = 'text/plain; charset=utf-8'
        $response.ContentLength64 = $bytes.Length
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        $type = if($MIME.ContainsKey($ext)){ $MIME[$ext] } else { 'application/octet-stream' }
        $response.StatusCode = 200
        $response.ContentType = $type
        $response.ContentLength64 = $body.Length
        if($request.HttpMethod -ne 'HEAD'){ $response.OutputStream.Write($body, 0, $body.Length) }
      }
    } catch {
      try {
        $response.StatusCode = 500
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('Server error')
        $response.OutputStream.Write($bytes, 0, $bytes.Length)
      } catch { }
    } finally {
      try { $response.OutputStream.Close() } catch { }
      try { $response.Close() } catch { }
    }
  }
} finally {
  try { $listener.Stop() } catch { }
  try { $listener.Close() } catch { }
}
