@echo off
rem Compatibility alias. For a completely windowless double-click entry use start-studio-hidden.vbs.
rem Reuse the same readiness and ownership checks; never open additional console windows.
wscript.exe //B "%~dp0start-studio-hidden.vbs"
exit /b
