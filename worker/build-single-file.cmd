@echo off
REM Prince Alex TicketHub - rebuild the single-file Worker (worker\worker.js).
REM Use this when you deploy by pasting into the Cloudflare dashboard editor.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-single-file.ps1"
if errorlevel 1 (
  echo.
  echo Build FAILED.
) else (
  echo.
  echo Build OK - open worker\worker.js, copy everything, paste into the dashboard editor, then Deploy.
)
pause
