param([switch]$Apply)
$ErrorActionPreference = 'Stop'
# ============================================================================
#  Prince Alex TicketHub - public page header/footer sweep
#  ----------------------------------------------------------------------------
#  Applied to the 17 public pages (index.html + 16 folders):
#    1. header nav gains a "Check Ticket" link after "For Organizers", before
#       the "Login" link (the "Sell Your Event" CTA stays last);
#    2. footer Platform column gains "Check Ticket" after "My Ticket";
#    3. footer Company column "Organizer Login" becomes "Sign in" - there is now
#       ONE sign-in door for organizers, staff and the platform owner;
#    4. footer Legal column drops the /owner-login/ "Platform Owner" entry - the
#       separate owner sign-in page was retired and its links point at /login/.
#  Run with no arguments for a dry run, -Apply to write the files (BOM state is
#  preserved per file: some pages are UTF-8 with BOM, some without).
# ============================================================================
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$names = @('index.html','about','check-ticket','checkout','contact','event','events','forgot-password',
  'login','organizer','payment-failed','payment-success','privacy','register','sell-your-tickets','terms','ticket')

# "For Organizers" and "Login" are adjacent inside <nav id="mainNav"> on every
# page - sometimes on one line, sometimes on separate lines. $2 keeps whatever
# whitespace sat between them so the inserted link lines up.
$navRe = [regex]'(?s)(<a href="/organizer/"[^>]*>For Organizers</a>)(\s*)(<a href="/login/">Login</a>)'
$checkLink = '<a href="/check-ticket/">Check Ticket</a>'

$rows = @()
foreach($n in $names){
  $rel = if($n -eq 'index.html'){ 'index.html' } else { Join-Path $n 'index.html' }
  $f = Join-Path $root $rel
  if(-not (Test-Path $f)){ throw "Missing page: $rel" }
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $bom = ($bytes.Length -gt 2 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
  $before = $text

  $navHits = $navRe.Matches($text).Count
  if($navHits -eq 1){ $text = $navRe.Replace($text, '$1$2' + $checkLink + '$2$3', 1) }

  # Platform column: add Check Ticket after My Ticket, but never twice - the
  # check-ticket and ticket pages already carry it.
  if($text.IndexOf('My Ticket</a><a href="/check-ticket/">') -eq -1){
    $text = $text.Replace('<a href="/ticket/">My Ticket</a></div>', '<a href="/ticket/">My Ticket</a>' + $checkLink + '</div>')
  }
  $text = $text.Replace('<a href="/login/">Organizer Login</a>', '<a href="/login/">Sign in</a>')
  $text = $text.Replace('<a href="/owner-login/">Platform Owner</a>', '')

  $changed = ($text -ne $before)
  if($Apply -and $changed){ [System.IO.File]::WriteAllText($f, $text, (New-Object System.Text.UTF8Encoding($bom))) }

  $rows += [pscustomobject]@{
    File       = $rel
    Mode       = $(if($Apply){ 'APPLY' } else { 'DRY' })
    Changed    = $changed
    NavHits    = $navHits
    Check      = ([regex]::Matches($text, [regex]::Escape('/check-ticket/')).Count)
    OwnerLogin = ([regex]::Matches($text, 'owner-login').Count)
    OrgLogin   = ([regex]::Matches($text, 'Organizer Login').Count)
    BOM        = $bom
  }
}
$rows | Format-Table -AutoSize | Out-String -Width 160
# NavHits is 1 before the link is inserted and 0 once it is there (the anchor
# disappears), so anything above 1 means the page has an unexpected extra pair.
$bad = ($rows | Where-Object { $_.NavHits -gt 1 -or $_.OwnerLogin -ne 0 -or $_.OrgLogin -ne 0 -or $_.Check -lt 2 }).Count
Write-Host ("pages: {0}  problems: {1}" -f $rows.Count, $bad)
if($bad -gt 0){ exit 1 }