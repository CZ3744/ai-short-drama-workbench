' AI Studio - one-click launcher (no console window pops up).
' Double-click this, or its desktop shortcut, to start the app.
'
' This file is a thin shim on purpose: ALL the real logic lives in
' start-studio.ps1 sitting next to it. The old version duplicated the
' start-up logic here in VBScript and it drifted out of sync with the
' .ps1 twin. One brain, two doors.
'
' Note: the folder is derived from this script's own location, so the
' repo can be moved or renamed without editing anything.
Option Explicit

Dim fso, sh, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & here & "\start-studio.ps1"" -Quiet"

' 0 = hidden window, False = don't block; start-studio.ps1 reports via popups.
sh.Run cmd, 0, False
