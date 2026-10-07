@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0run-check.ps1" -Page payhero-check.html -TimeoutSec 180 > "%TEMP%\payhero-check.log" 2>&1
echo done >> "%TEMP%\payhero-check.log"
