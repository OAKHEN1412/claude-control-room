' Opens Claude Control Room as ONE app window across all monitors (runs open-wide.ps1 hidden).
' If the server is not answering on 127.0.0.1:8790 yet, starts it first (start-hidden.vbs)
' and waits up to ~30 s for it to come up. Optional argument 1: a different base URL.
Option Explicit
Dim URL, sh, fso, here, i, ps

URL = "http://127.0.0.1:8790/"
If WScript.Arguments.Count > 0 Then URL = WScript.Arguments(0)

Function IsUp()
  Dim http
  IsUp = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.open "GET", URL, False
  http.send
  If Err.Number = 0 Then
    If http.status = 200 Then IsUp = True
  End If
  On Error GoTo 0
End Function

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)

If Not IsUp() Then
  sh.Run "wscript.exe """ & here & "\start-hidden.vbs""", 0, False
  For i = 1 To 30
    WScript.Sleep 1000
    If IsUp() Then Exit For
  Next
End If

ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\open-wide.ps1"""
If WScript.Arguments.Count > 0 Then ps = ps & " -Url """ & URL & "?ui=v2"""
sh.Run ps, 0, False
