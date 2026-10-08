@echo off
setlocal

rem Path is derived from this script's own location, so moving/renaming the
rem repo needs no edit here. %~dp0 ends with a backslash - strip it.
set ROOT=%~dp0
if "%ROOT:~-1%"=="\" set ROOT=%ROOT:~0,-1%
cd /d "%ROOT%"

echo ============================================================
echo  video-generate dev start
echo ============================================================
echo.

rem [1/2] Stop leftovers from a previous run.
rem
rem This used to be "netstat for whoever listens on the port, then taskkill it".
rem On 2026-07-22 that turned out to kill completely unrelated programs: the
rem backend port was occupied by another app (codexpro) and this line murdered
rem it without a word. Occupying a port does not make you ours.
rem
rem stop-studio.ps1 does it properly: it only stops this repo's own dev-server
rem process tree, and never touches a process it cannot attribute to us.
echo [1/2] Stopping leftover dev servers (only ours) ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\stop-studio.ps1" >nul 2>&1
rem ping instead of `timeout`: timeout aborts with "Input redirection is not
rem supported" whenever stdin is redirected (i.e. when this .bat is run from a
rem script rather than double-clicked), which printed a scary ERROR line.
ping -n 2 127.0.0.1 >nul 2>&1

echo [2/2] Launching server (8788) and web (5173) in two windows ...
start "video-generate-server-8788" cmd /k "cd /d "%ROOT%" && npm run dev:server"
start "video-generate-web-5173"    cmd /k "cd /d "%ROOT%" && npm run dev:web"

echo.
echo ============================================================
echo  Two new cmd windows opened.
echo  Wait ~10s, then open http://127.0.0.1:5173/ in browser.
echo  Close either window to stop that service.
echo.
echo  Prefer the desktop shortcut "AI shortdrama studio" for daily use -
echo  it waits until the app is really ready before opening the browser,
echo  and tells you who is squatting the port if startup fails.
echo  This launcher window auto-closes in 5 seconds.
echo ============================================================
ping -n 6 127.0.0.1 >nul 2>&1
endlocal
