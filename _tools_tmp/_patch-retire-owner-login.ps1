param([switch]$Apply)
$ErrorActionPreference = 'Stop'
# ============================================================================
#  Prince Alex TicketHub - retire the separate /owner-login/ page
#  ----------------------------------------------------------------------------
#  Owners now sign in at /login/ (the one door) and the Worker routes each role
#  to its own dashboard - owner -> owner-dashboard, event_staff -> check-in,
#  organizer -> organizer-dashboard. This patch removes every remaining trace of
#  the old page:
#    - _redirects: /owner-login(.html|/) now 301s to /login/
#    - owner-settings sign-out goes to /login/
#    - the Worker's legacy-page fold maps owner-login onto /login/
#    - the Turnstile harness stops probing the deleted page
#    - README / worker README stop listing it
#  Run with no arguments for a dry run, -Apply to write. CRLF and BOM state are
#  preserved per file.
# ============================================================================
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$CRLF = "`r`n"
$script:ok = 0; $script:done = 0; $script:fail = 0

function Patch-File([string]$rel, [string[]]$oldLines, [string[]]$newLines, [string]$label){
  $old = ($oldLines -join $CRLF)
  $new = ($newLines -join $CRLF)
  $f = Join-Path $root $rel
  $bytes = [System.IO.File]::ReadAllBytes($f)
  $bom = ($bytes.Length -gt 2 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $t = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
  # The new shape is checked first: some patches extend a line (a comment), so the
  # old text survives inside the new one and a naive "old must be gone" check would
  # re-apply and duplicate the tail.
  if($new.Length -gt 0 -and $t.Contains($new)){
    Write-Host ("DONE  {0,-30} {1} (already applied)" -f $rel, $label) -ForegroundColor DarkCyan
    $script:done++; return
  }
  $n = ([regex]::Matches($t, [regex]::Escape($old))).Count
  if($n -eq 1){
    if($Apply){ [System.IO.File]::WriteAllText($f, $t.Replace($old, $new), (New-Object System.Text.UTF8Encoding($bom))) }
    Write-Host ("OK    {0,-30} {1}" -f $rel, $label) -ForegroundColor Green
    $script:ok++; return
  }
  # A deletion patch has an empty new shape: no match left means the row is gone.
  if($new.Length -eq 0 -and $n -eq 0){
    Write-Host ("DONE  {0,-30} {1} (already applied)" -f $rel, $label) -ForegroundColor DarkCyan
    $script:done++; return
  }
  Write-Host ("FAIL  {0,-30} {1} (matches={2})" -f $rel, $label, $n) -ForegroundColor Red
  $script:fail++
}
# 1) _redirects: the old .html rule and the old folder URL both land on /login/
Patch-File '_redirects' @(
  '/owner-login.html            /owner-login/        301'
) @(
  '/owner-login.html            /login/              301',
  '/owner-login/                /login/              301'
) 'owner-login 301 -> /login/'

# 2) owner sign-out returns to the one sign-in page
Patch-File 'owner-settings\index.html' @(
  '$("#signOutBtn").addEventListener("click", async () => { try { await Auth.signOut(); } catch(err){} location.href = "/owner-login/"; });'
) @(
  '$("#signOutBtn").addEventListener("click", async () => { try { await Auth.signOut(); } catch(err){} location.href = "/login/"; });'
) 'sign out -> /login/'

# 3) the Turnstile harness must stop probing a page that no longer exists
Patch-File 'turnstile-check.html' @(
  'const PAGES = [["register/index.html", "register"], ["login/index.html", "login"], ["owner-login/index.html", "login"],'
) @(
  'const PAGES = [["register/index.html", "register"], ["login/index.html", "login"],'
) 'drop owner-login probe'

# 4) Worker: the turnstile comment no longer names the page
Patch-File 'worker\index.js' @(
  '   login, owner-login and forgot-password pages therefore verify the challenge'
) @(
  '   login and forgot-password pages therefore verify the challenge'
) 'turnstile comment'
# 5) Worker: legacy /owner-login links fold onto /login/ (301/302 logic untouched)
Patch-File 'worker\index.js' @(
  'function legacyPageTarget(pathname){',
  '  if(pathname === "/index.html") return "/";',
  '  if(!/\.html$/.test(pathname)) return pathname.replace(/\/+$/, "") + "/";',
  '  return pathname.replace(/\.html$/, "") + "/";',
  '}'
) @(
  'function legacyPageTarget(pathname){',
  '  if(pathname === "/index.html") return "/";',
  '  /* The separate /owner-login/ page was retired: owners sign in at /login/',
  '     like everyone else and the Worker routes them by role. Keeping the name',
  '     in LEGACY_PAGE_RE above means old bookmarks and emails are still caught',
  '     and folded onto the one sign-in page instead of a dead folder. */',
  '  if(pathname === "/owner-login" || pathname === "/owner-login.html") return "/login/";',
  '  if(!/\.html$/.test(pathname)) return pathname.replace(/\/+$/, "") + "/";',
  '  return pathname.replace(/\.html$/, "") + "/";',
  '}'
) 'legacy owner-login -> /login/'

# 6) emails.js: same fold for links already sitting in outbox rows
Patch-File 'worker\emails.js' @(
  '   links are touched - never a filename that merely ends in .html.'
) @(
  '   links are touched - never a filename that merely ends in .html. owner-login',
  '   is the one exception: that page was retired, so it folds onto /login/.'
) 'fold comment'

Patch-File 'worker\emails.js' @(
  '  return s.replace(LEGACY_PAGE_URL_RE, (m, name) => name === "index" ? "/" : "/" + name + "/");'
) @(
  '  return s.replace(LEGACY_PAGE_URL_RE, (m, name) => name === "index" ? "/" : (name === "owner-login" ? "/login/" : "/" + name + "/"));'
) 'fold owner-login -> /login/'

# 7) the PowerShell mirror of that fold, plus a case that proves it
Patch-File 'worker\test-legacy-links.ps1' @(
  "  return [regex]::Replace(`$v, `$RE, { param(`$m) if (`$m.Groups[1].Value -eq 'index') { '/' } else { '/' + `$m.Groups[1].Value + '/' } })"
) @(
  "  return [regex]::Replace(`$v, `$RE, { param(`$m) if (`$m.Groups[1].Value -eq 'index') { '/' } elseif (`$m.Groups[1].Value -eq 'owner-login') { '/login/' } else { '/' + `$m.Groups[1].Value + '/' } })"
) 'test fold owner-login'

Patch-File 'worker\test-legacy-links.ps1' @(
  "  @('https://h/owner-settings.html',                                         'https://h/owner-settings/',                                        'owner-settings'),"
) @(
  "  @('https://h/owner-settings.html',                                         'https://h/owner-settings/',                                        'owner-settings'),",
  "  @('https://h/owner-login.html',                                            'https://h/login/',                                                 'retired owner-login -> login'),"
) 'test case owner-login'
# 8) worker README: six protected pages, not seven
Patch-File 'worker\README.md' @(
  '- **Turnstile must be wired on both sides.** The seven protected pages',
  '  (`register/`, `login/`, `owner-login/`, `forgot-password/`, `contact/`,',
  '  `checkout/`, `create-event/`) carry the real site key'
) @(
  '- **Turnstile must be wired on both sides.** The six protected pages',
  '  (`register/`, `login/`, `forgot-password/`, `contact/`,',
  '  `checkout/`, `create-event/`) carry the real site key'
) 'protected page list'

# 9) README: public page row, protected-key list, checklist line, owner table row
Patch-File 'README.md' @(
  '| `login/index.html` | Organizer/staff sign in, role routing |'
) @(
  '| `login/index.html` | The one sign-in door for organizers, event staff and the platform owner; the Worker role decides the dashboard |'
) 'login page purpose'

Patch-File 'README.md' @(
  '`owner-login/`, `forgot-password/`, `contact/`, `checkout/`, `create-event/`).'
) @(
  '`forgot-password/`, `contact/`, `checkout/`, `create-event/`).'
) 'protected key list'

Patch-File 'README.md' @(
  '- [x] `login/`, `owner-login/` and `forgot-password/` verify the challenge at `POST /api/auth/turnstile` before any Firebase call'
) @(
  '- [x] `login/` and `forgot-password/` verify the challenge at `POST /api/auth/turnstile` before any Firebase call'
) 'checklist line'

# The owner table keeps its rows; only the retired sign-in row goes away. The
# trailing '' makes the joined search string include the row's own newline, so
# the row is deleted outright rather than left as a blank line.
Patch-File 'README.md' @(
  '| `owner-login/index.html` | Restricted owner sign in |',
  ''
) @(
  ''
) 'drop owner-login table row'
# Point the owner area at the one sign-in door.
Patch-File 'README.md' @(
  'Platform owner area:'
) @(
  'Platform owner area (sign in at `login/` with the owner account):'
) 'owner area heading'

Write-Host ""
Write-Host ("mode={0}  patched={1}  already-applied={2}  failed={3}" -f $(if($Apply){'APPLY'}else{'DRY'}), $script:ok, $script:done, $script:fail)
if($script:fail -gt 0){ exit 1 }
exit 0