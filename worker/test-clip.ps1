$ErrorActionPreference = 'Stop'
# Faithful port of clip() from event/index.html + ticket-types/index.html.
function Clip([string]$text, [int]$max) {
  $s = ($text -replace '\s+', ' ').Trim()
  if($max -le 0 -or $s.Length -le $max){ return $s }
  $cut = $s.Substring(0, $max)
  $sp = $cut.LastIndexOf(' ')
  $body = if($sp -gt ($max * 0.6)){ $cut.Substring(0, $sp) } else { $cut }
  $body = $body -replace '[\s.,;:!?-]+$', ''
  return $body + [char]0x2026
}
# True when clip() took the "back off to the last space" branch.
function TookSpaceBranch([string]$s, [int]$max) {
  if($max -le 0 -or $s.Length -le $max){ return $false }
  return ($s.Substring(0, $max).LastIndexOf(' ')) -gt ($max * 0.6)
}

$long  = 'Regular admission for the full day. Children under 12 years enter free with a paying adult. VIP upgrades available at the door only, not online, so buy early to guarantee your seat near the stage.'
$cases = @(
  @($long, 120, 'sentence cut at 120'),
  @($long, 70,  'tighter budget at 70'),
  @('Short and sweet', 120, 'fits: returned untouched'),
  @('', 120, 'empty'),
  @('Leading and trailing   spaces   collapse', 120, 'whitespace collapse'),
  @("Line one`n`nLine   two", 120, 'newlines from the textarea'),
  @('A B', 120, 'tiny but fits'),
  @('Donaudampfschifffahrtsgesellschaftskapitaen', 20, 'single huge token -> documented hard cut')
)

$pass = 0; $fail = 0
foreach($c in $cases){
  $got  = Clip $c[0] $c[1]
  $s    = ($c[0] -replace '\s+', ' ').Trim()
  $max  = $c[1]
  $label = $c[2]
  $truncated = $s.Length -gt $max

  if(-not $truncated){
    if($got -ceq $s){ $pass++; "  PASS  {0,-46} -> {1}" -f $label, $got }
    else { $fail++; "  FAIL  {0,-46} untouched text was altered" -f $label }
    continue
  }

  $body = $got.Substring(0, $got.Length - 1)          # strip the ellipsis
  $marked = $got.EndsWith([char]0x2026)
  $withinBudget = ($body.Length -le $max)
  # A word-boundary cut means the body is a strict prefix of the source AND the
  # next source character is whitespace - i.e. we stopped between words.
  $boundary = ($body.Length -lt $s.Length) -and ($s.Substring(0, $body.Length) -ceq $body) -and ([string]::IsNullOrWhiteSpace($s[$body.Length]))

  if(TookSpaceBranch $s $max){
    $ok = $marked -and $withinBudget -and $boundary
    $why = if(-not $marked){'no ellipsis'}elseif(-not $withinBudget){'over budget'}elseif(-not $boundary){'cut mid-word'}else{'ok'}
  } else {
    # Documented fallback: no space in range, hard cut, CSS breaks the token.
    $ok = $marked -and $withinBudget -and ($s.Substring(0, $body.Length) -ceq $body)
    $why = if(-not $ok){'not a clean prefix cut'}else{'ok (hard cut, expected)'}
  }

  if($ok){ $pass++; "  PASS  {0,-46} -> {1}" -f $label, $got }
  else { $fail++; "  FAIL  {0,-46} -> {1}  ({2})" -f $label, $got, $why }
}

""
"--- result never exceeds the budget (ellipsis excluded) ---"
foreach($m in @(70, 120)){
  $r = Clip $long $m
  $over = ($r.Length - 1) -gt $m
  if($over){ $fail++ } else { $pass++ }
  "  {0}  max={1} -> {2} chars ({3})" -f $(if($over){'FAIL'}else{'PASS'}), $m, ($r.Length - 1), $(if($over){'OVER BUDGET'}else{'within budget'})
}

""
"RESULT: $pass passed, $fail failed"
if($fail -gt 0){ exit 1 }

