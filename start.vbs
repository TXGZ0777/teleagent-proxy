' teleagent-proxy silent background launcher
' Double-click to run (no console window); PID is written by server.mjs to runtime\proxy.pid
' Stop with stop.cmd in the same folder. Launch log: runtime\proxy-launch.log
Option Explicit

Dim fso, shell, here, nodeExe, script, pidFile, logFile, cmdLine
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
pidFile = fso.BuildPath(here, "runtime\proxy.pid")
logFile = fso.BuildPath(here, "runtime\proxy-launch.log")

' ---- Already running? (read pid file and verify the process exists) ----
If fso.FileExists(pidFile) Then
    Dim ts, oldPid
    Set ts = fso.OpenTextFile(pidFile, 1, True)
    oldPid = Trim(ts.ReadAll)
    ts.Close
    If IsNumeric(oldPid) And oldPid > 0 Then
        If IsProcessAlive(CLng(oldPid)) Then
            WriteLog logFile, "Already running PID=" & oldPid & ", skip."
            ' Silent exit; uncomment next line to show a popup instead
            ' MsgBox "Proxy already running (PID " & oldPid & ").", 64, "teleagent-proxy"
            WScript.Quit 0
        End If
    End If
End If

' ---- Locate node ----
nodeExe = FindNode()
If nodeExe = "" Then
    MsgBox "Node.js not found. Install Node.js 20+: https://nodejs.org", 16, "teleagent-proxy"
    WScript.Quit 1
End If

script = fso.BuildPath(here, "server.mjs")
cmdLine = """" & nodeExe & """ """ & script & """"

' ---- Ensure runtime dir ----
If Not fso.FolderExists(fso.BuildPath(here, "runtime")) Then
    fso.CreateFolder fso.BuildPath(here, "runtime")
End If

WriteLog logFile, "Launching: " & cmdLine
' 2nd arg 0 = hidden window; False = do not wait (script returns immediately)
shell.Run cmdLine, 0, False

' Wait briefly for server.mjs to write the pid file
WScript.Sleep 1500
Dim newPid
newPid = ""
If fso.FileExists(pidFile) Then
    Set ts = fso.OpenTextFile(pidFile, 1, True)
    newPid = Trim(ts.ReadAll)
    ts.Close
End If
WriteLog logFile, "Launch command sent, PID=" & newPid & " (kernel warm-up takes 1-2 min)"

' ---- Helpers ----
Function FindNode()
    Dim p, tryPath, parts, i
    On Error Resume Next
    p = shell.ExpandEnvironmentStrings("%PATH%")
    parts = Split(p, ";")
    For i = 0 To UBound(parts)
        tryPath = fso.BuildPath(Trim(parts(i)), "node.exe")
        If fso.FileExists(tryPath) Then
            FindNode = tryPath
            Exit Function
        End If
    Next
    tryPath = shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
    If fso.FileExists(tryPath) Then FindNode = tryPath : Exit Function
    tryPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe")
    If fso.FileExists(tryPath) Then FindNode = tryPath : Exit Function
    FindNode = ""
    On Error GoTo 0
End Function

Function IsProcessAlive(ByVal pid)
    On Error Resume Next
    Dim wmi, procs
    Set wmi = GetObject("winmgmts:\\.\root\cimv2")
    Set procs = wmi.ExecQuery("Select * from Win32_Process where ProcessId=" & pid)
    IsProcessAlive = (procs.Count > 0)
    If Err.Number <> 0 Then IsProcessAlive = False
    On Error GoTo 0
End Function

Sub WriteLog(ByVal path, ByVal msg)
    On Error Resume Next
    Dim f
    Set f = fso.OpenTextFile(path, 8, True)
    f.WriteLine Now & "  " & msg
    f.Close
    On Error GoTo 0
End Sub
