' Starts the Claude Control Room agent (127.0.0.1:8791) with no console window.
' Output goes to %USERPROFILE%\.claude-control-room\agent.log (5 MB rotation).
' The agent's PID is written to agent.pid by scripts\run-agent.mjs (used by agent-setup.mjs autostart).
Option Explicit
Dim sh, fso, repo, dataDir, logFile, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
dataDir = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude-control-room"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
logFile = dataDir & "\agent.log"
' keep the log small: start a fresh one past 5 MB
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then fso.DeleteFile logFile, True
End If
cmd = "cmd /c ""cd /d """ & repo & """ && echo [%DATE% %TIME%] start-agent-hidden >> """ & logFile & """ && node scripts\run-agent.mjs >> """ & logFile & """ 2>&1"""
sh.Run cmd, 0, False
