' Aroomo standalone: run the launcher without a console window (used by shortcuts and login autostart).
' Usage: wscript aroomo-launch.vbs <action> [delay-seconds]
Option Explicit
Dim sh, fso, here, ps, action, delay, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
action = "open"
delay = "0"
If WScript.Arguments.Count > 0 Then action = WScript.Arguments(0)
If WScript.Arguments.Count > 1 Then delay = WScript.Arguments(1)
cmd = """" & ps & """ -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\aroomo-standalone.ps1"" -Action " & action & " -Delay " & delay
' 0 = hidden window; False = do not wait
sh.Run cmd, 0, False
