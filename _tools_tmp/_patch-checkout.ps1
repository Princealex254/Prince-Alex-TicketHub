# ============================================================================
#  One-shot patch: wire the free-ticket email OTP flow into checkout/index.html
#  ----------------------------------------------------------------------------
#  The editor tool cannot rewrite multi-line regions of this CRLF file, so the
#  additions are kept in small companion files and stitched in here with literal
#  (non-regex) replacements, then the whole file is re-normalised to CRLF.
#
#  Every anchor below is asserted to exist and to be unique BEFORE anything is
#  written, so a partial or wrong patch is impossible - the script throws first.
# ============================================================================
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$page = Join-Path $root 'checkout\index.html'
$NL = "`r`n"

function Read-Block([string]$name){
  $p = Join-Path $root ('tools\_patch-' + $name)
  if(-not (Test-Path $p)){ throw "Missing patch block: $p" }
  $text = [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
  $text = $text -replace "`r`n", "`n"
  $text = $text -replace "`r", "`n"
  return ($text.TrimEnd("`n") -replace "`n", $NL)
}

$htmlBlock = Read-Block 'otp.html'
$jsBlock = @()
foreach($part in @('otp1.js','otp2.js','otp3.js','otp4.js')){ $jsBlock += (Read-Block $part) }
$jsBlock = $jsBlock -join ($NL + $NL)
$wireBlock = Read-Block 'wire.js'

$original = [System.IO.File]::ReadAllText($page, [System.Text.Encoding]::UTF8)
$t = $original

function Replace-Once([string]$text, [string]$anchor, [string]$replacement, [string]$label){
  $first = $text.IndexOf($anchor)
  if($first -lt 0){ throw "anchor not found [$label]: $anchor" }
  $second = $text.IndexOf($anchor, $first + 1)
  if($second -ge 0){ throw "anchor is not unique [$label]: $anchor" }
  return $text.Substring(0, $first) + $replacement + $text.Substring($first + $anchor.Length)
}

# 1. the verification + success blocks, and the wrapper that hides the payment UI
$t = Replace-Once $t '      </form>' ('      </form>' + $NL + $htmlBlock) 'form close'

# 2. close the payment wrapper just before the M-Pesa panel
$t = Replace-Once $t '<div id="stkPanel" class="hidden"' ('      </div>' + $NL + '      <div id="stkPanel" class="hidden"') 'pay wrapper close'

# 3. ids the free flow toggles
$t = Replace-Once $t '<p class="tiny faint" style="margin:12px 0 0">By paying' '<p class="tiny faint" id="termsLine" style="margin:12px 0 0">By paying' 'terms line'
$t = Replace-Once $t '<p class="tiny faint" style="margin:10px 0 0">The final amount' '<p class="tiny faint" id="summaryNote" style="margin:10px 0 0">The final amount' 'summary note'

# 4. event wiring (the single primary button now dispatches to both flows)
$t = Replace-Once $t '  $("#payBtn").addEventListener("click", pay);' ('  ' + $wireBlock) 'wiring'

# 5. free mode is entered as soon as availability is known
$t = Replace-Once $t '    reconcile();' ('    reconcile();' + $NL + '    if(isFreeSelection()) enterFreeMode();') 'reconcile hook'

# 6. the whole free-ticket flow, in front of pay()
$t = Replace-Once $t 'async function pay(){' ($jsBlock + $NL + $NL + 'async function pay(){') 'pay definition'

# 7. one consistent line ending across the file
$t = $t -replace "`r`n", "`n"
$t = $t -replace "`r", "`n"
$t = $t -replace "`n", $NL

[System.IO.File]::WriteAllText($page, $t, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ("Patched {0} ({1:N0} -> {2:N0} bytes)" -f $page, $original.Length, $t.Length)