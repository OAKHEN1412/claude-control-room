' Starts Claude Control Room in production mode with no console window.
' Output goes to %USERPROFILE%\.claude-control-room\server.log. Port: PORT env (default 8790).
' If the port is already taken (dev server), the server logs one line and exits.
Option Explicit
Dim sh, fso, repo, dataDir, logFile, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
dataDir = sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.claude-control-room"
If Not fso.FolderExists(dataDir) Then fso.CreateFolder dataDir
logFile = dataDir & "\server.log"
' keep the log small: start a fresh one past 5 MB
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5242880 Then fso.DeleteFile logFile, True
End If
cmd = "cmd /c ""cd /d """ & repo & """ && echo [%DATE% %TIME%] start-hidden >> """ & logFile & """ && npm.cmd run start >> """ & logFile & """ 2>&1"""
sh.Run cmd, 0, False
