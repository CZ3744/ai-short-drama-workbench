' AI Studio - stop the running dev servers (no console window pops up).
'
' Thin shim: all the real logic lives in stop-studio.ps1 next to it.
' The old version decided success/failure here from an exit code and got
' it wrong (it announced "stopped" even when it had killed an unrelated
' program). The .ps1 now owns the message, because only it knows what it
' actually did.
Option Explicit

Dim fso, sh, here, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell -NoProfile -ExecutionPolicy Bypass -File """ & here & "\stop-studio.ps1"" -Announce"

' 0 = hidden window, False = don't block; stop-studio.ps1 reports via a popup.
sh.Run cmd, 0, False
