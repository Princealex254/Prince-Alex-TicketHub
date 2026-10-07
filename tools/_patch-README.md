# Free-ticket verification — patch scripts (scratch)

These files exist because the product pages and check pages are **CRLF HTML**:
the built-in editor cannot do a reliable multi-line replace on them, so every page
edit goes through a PowerShell driver that does a literal, unique-anchor replacement
and then re-normalises the file to CRLF.

Each driver reads the fragment from a `_patch-*.js` / `_patch-*.html` file, inserts it
at one unique anchor, and writes the page back. They are **idempotent where it
matters** (`_patch-payhero.ps1` removes any previous copy before inserting) but the
rest assume the anchor is present exactly once — re-running them on an already-patched
page will fail loudly rather than double-insert.

| Driver | Page it patches | Fragments it inserts |
| --- | --- | --- |
| `_patch-checkout.ps1` | `checkout/index.html` | `_patch-otp.html`, `_patch-otp1.js` … `_patch-otp4.js`, `_patch-wire.js` |
| `_patch-pages.ps1` | `create-event/index.html`, `edit-event/index.html`, `frontend-check.html` | `_patch-freesec-create.html`, `_patch-freesec-edit.html`, `_patch-free-event.js`, `_patch-free-misc.js`, `_patch-frontend-free.js` |
| `_patch-payhero.ps1` | `payhero-check.html` | `_patch-free-e2e.js` … `_patch-free-e2e5.js` |
| `_fix-payhero-order.ps1` | `payhero-check.html` | one-off: moves the free-ticket group above the harness's `console.error` restore |

`_patch-free-e2e*.js` is the **source of truth** for the free-ticket end-to-end group
in `payhero-check.html`. If an assertion has to change:

1. edit the `_patch-free-e2e*.js` part,
2. run `powershell -ExecutionPolicy Bypass -File tools\_patch-payhero.ps1`,
3. run `powershell -ExecutionPolicy Bypass -File tools\run-check.ps1 -Page payhero-check.html`.

`_run-all.ps1` runs every `*-check.html` page one after another (they all bind port
8137) and prints one `RESULT:` line per page.

Nothing here is imported by the Worker or by any page at runtime — the drivers are
run by hand during development only, and deleting them changes no behaviour.
