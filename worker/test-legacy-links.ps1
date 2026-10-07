$ErrorActionPreference = 'Stop'
# Same pattern as LEGACY_PAGE_URL_RE in worker/emails.js, minus the JS literal
# delimiters (/ ... /g) - this is a .NET string, and Replace already replaces all.
$RE = '\/(organizer-dashboard|organizer-events|organizer-settings|owner-dashboard|owner-events|owner-login|owner-orders|owner-organizers|owner-settings|payment-failed|payment-success|sell-your-tickets|ticket-types|create-event|edit-event|check-in|forgot-password|attendees|checkout|contact|events|index|login|orders|organizer|owner|privacy|register|terms|ticket|event)\.html(?=[?#]|$)'

function Fold-Legacy([string]$v) {
  if ([string]::IsNullOrEmpty($v) -or $v -notlike '*.html*') { return $v }
  return [regex]::Replace($v, $RE, { param($m) if ($m.Groups[1].Value -eq 'index') { '/' } elseif ($m.Groups[1].Value -eq 'owner-login') { '/login/' } else { '/' + $m.Groups[1].Value + '/' } })
}

$cases = @(
  @('https://tickethub.princealex.digital/ticket.html?ticket=PAT-1001A', 'https://tickethub.princealex.digital/ticket/?ticket=PAT-1001A', 'core: ticket + query'),
  @('https://tickethub.princealex.digital/event.html?slug=summer-fest',    'https://tickethub.princealex.digital/event/?slug=summer-fest',    'core: event + query'),
  @('https://tickethub.princealex.digital/index.html',                     'https://tickethub.princealex.digital/',                          'index.html -> root'),
  @('https://h/organizer-dashboard.html',                                    'https://h/organizer-dashboard/',                                   'longest-first: organizer-dashboard'),
  @('https://h/organizer.html',                                              'https://h/organizer/',                                             'prefix: organizer alone'),
  @('https://h/owner-settings.html',                                         'https://h/owner-settings/',                                        'owner-settings'),
  @('https://h/owner-login.html',                                            'https://h/login/',                                                 'retired owner-login -> login'),
  @('https://h/terms.html#ref',                                              'https://h/terms/#ref',                                              'anchor form'),
  @('https://h/ticket.html',                                                 'https://h/ticket/',                                                 'no query, end of string'),
  @('https://princealextickethub.princealexdigital.workers.dev/ticket.html?ticket=X', 'https://princealextickethub.princealexdigital.workers.dev/ticket/?ticket=X', 'worker-origin legacy link'),
  @('https://h/ticket/?ticket=PAT-1',                                        'https://h/ticket/?ticket=PAT-1',                                    'already clean: untouched'),
  @('https://h/attachments/receipt.html',                                    'https://h/attachments/receipt.html',                                'non-page .html: untouched'),
  @('https://h/report.html?page=1',                                          'https://h/report.html?page=1',                                      'non-page .html w/ query: untouched'),
  @('https://h/api/tickets/PAT-1/qr.png',                                    'https://h/api/tickets/PAT-1/qr.png',                                'qr_url: untouched'),
  @('',                                                                     '',                                                                  'empty: untouched')
)

$pass = 0; $fail = 0
foreach ($c in $cases) {
  $got = Fold-Legacy $c[0]
  if ($got -ceq $c[1]) { $pass++; "  PASS  {0,-22} {1}" -f $c[2], $got }
  else { $fail++; "  FAIL  {0,-22} expected {1}  got {2}" -f $c[2], $c[1], $got }
}

# --- mergeEmailLinks: fresh wins only where it has a value (event:"" must not blank) ---
function Merge-Links($stored, $fresh) {
  $out = @{}
  foreach ($k in $stored.Keys) { $out[$k] = $stored[$k] }
  foreach ($k in $fresh.Keys) { if ($fresh[$k]) { $out[$k] = $fresh[$k] } }
  $folded = @{}
  foreach ($k in $out.Keys) { $folded[$k] = if ($out[$k] -is [string]) { Fold-Legacy $out[$k] } else { $out[$k] } }
  return $folded
}
$stored = [ordered]@{ event = 'https://h/event.html?slug=old'; order = 'https://h/ticket.html?order=PAT-9'; events = 'https://h/events.html'; junk = 'https://h/other.html' }
$fresh  = [ordered]@{ event = ''; events = 'https://h/events/'; support = 'https://h/contact/' }
$m = Merge-Links $stored $fresh
$expect = [ordered]@{ event = 'https://h/event/?slug=old'; order = 'https://h/ticket/?order=PAT-9'; events = 'https://h/events/'; junk = 'https://h/other.html'; support = 'https://h/contact/' }
foreach ($k in $expect.Keys) {
  if ($m[$k] -ceq $expect[$k]) { $pass++; "  PASS  merge[{0}] = {1}" -f $k, $m[$k] }
  else { $fail++; "  FAIL  merge[{0}] expected {1} got {2}" -f $k, $expect[$k], $m[$k] }
}

""
"merge: fresh event:"" kept stored value (not blanked) -> $($m['event'])"
""
"RESULT: $pass passed, $fail failed"
if ($fail -gt 0) { exit 1 }
