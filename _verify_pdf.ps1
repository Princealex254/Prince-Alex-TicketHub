# PDF validation report
$ErrorActionPreference = "Stop"
$repo = "C:\Users\Alex\Desktop\Ticket hub"
$pdf = Join-Path $repo "payment-setup-guide.pdf"
$html = Join-Path $repo "docs\payment-setup-guide.html"

Write-Host "PDF_EXISTS ($pdf)"
if (Test-Path $pdf) {
  $bytes = [System.IO.File]::ReadAllBytes($pdf)
  Write-Host "PDF_SIZE ($($bytes.Length))"
  Write-Host "PDF_SIG " -NoNewline
  for ($i=0; $i -lt 8; $i++) { Write-Host "$('{0:X2}' -f $bytes[$i])" -NoNewline }
  Write-Host
  $s = [System.Text.Encoding]::ASCII.GetString($bytes)
  $pages = @(Select-String -InputString $s -Pattern "/Type\s*/Page[^s]" -AllMatches).Count
  $streams = @(Select-String -InputString $s -Pattern "stream\r?$" -AllMatches).Count
  Write-Host "PDF_PAGE_OBJECTS ($pages)"
  Write-Host "PDF_STREAMS ($streams)"
  # Look for text-ish content markers
  if ($s -match "payment\s*setup\s*guide|Paystack|Pesapal|PayHero") {
    Write-Host "PDF_CONTAINS_GUIDE_CONTENT: True"
  } else {
    Write-Host "PDF_CONTAINS_GUIDE_CONTENT: False"
  }
}
