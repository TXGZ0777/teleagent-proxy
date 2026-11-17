' teleagent-proxy silent background launcher
' Double-click to run (no console window); PID is written by server.mjs to runtime\proxy.pid
' Stop with stop.cmd in the same folder. Logs: runtime\proxy.log / proxy-launch.log / admin web UI
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
    If IsNumeric(oldPid) Then
      If CLng(oldPid) > 0 Then
        If IsProcessAlive(CLng(oldPid)) Then
            WriteLog logFile, "Already running PID=" & oldPid & ", skip."
            MsgBox "Proxy is ALREADY RUNNING (PID " & oldPid & ")." & vbCrLf & _
                   "Open http://127.0.0.1:" & GetPort() & "/admin", 64, "teleagent-proxy"
            WScript.Quit 0
        End If
      End If
    End If
End If

' ---- Locate node ----
nodeExe = FindNode()
If nodeExe = "" Then
    MsgBox "Node.js NOT FOUND. Install Node.js 20+: https://nodejs.org", 16, "teleagent-proxy"
    WriteLog logFile, "FAILED: Node.js not found"
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

' ---- Wait for readiness (poll /healthz up to ~180s) and popup result ----
Dim port, ok, waited
port = GetPort()
ok = False
waited = 0
Do While waited < 180
    WScript.Sleep 2000
    waited = waited + 2
    ok = HealthOK(port)
    If ok Then Exit Do
    ' bail early if the process died
    Dim curPid
    curPid = ""
    If fso.FileExists(pidFile) Then
        Set ts = fso.OpenTextFile(pidFile, 1, True)
        curPid = Trim(ts.ReadAll)
        ts.Close
    End If
    If curPid <> "" And IsNumeric(curPid) Then
        If Not IsProcessAlive(CLng(curPid)) Then Exit Do
    End If
Loop

If ok Then
    WriteLog logFile, "STARTUP OK after " & waited & "s. http://127.0.0.1:" & port & "/admin"
    MsgBox "STARTUP OK (" & waited & "s)" & vbCrLf & _
           "Admin: http://127.0.0.1:" & port & "/admin", 64, "teleagent-proxy"
Else
    WriteLog logFile, "STARTUP FAILED after " & waited & "s. Check runtime\proxy.log"
    MsgBox "STARTUP FAILED / TIMEOUT (" & waited & "s)" & vbCrLf & _
           "Check runtime\proxy.log" & vbCrLf & _
           "Admin: http://127.0.0.1:" & port & "/admin", 48, "teleagent-proxy"
End If

' ---- Helpers ----
Function GetPort()
    Dim p
    p = Trim(shell.ExpandEnvironmentStrings("%TA_PORT%"))
    GetPort = "8787"
    ' VBScript And does NOT short-circuit, so nest the CLng to avoid converting a non-number
    If IsNumeric(p) Then
        If CLng(p) > 0 Then GetPort = CStr(CLng(p))
    End If
End Function

Function HealthOK(ByVal port)
    On Error Resume Next
    Dim http, url
    Set http = CreateObject("MSXML2.XMLHTTP")
    url = "http://127.0.0.1:" & port & "/healthz"
    http.Open "GET", url, False
    http.Send
    If Err.Number <> 0 Then
        HealthOK = False
        Err.Clear
        Exit Function
    End If
    ' healthz returns {"ok":true,...}; tolerate spaces by just checking status + "ok"
    HealthOK = (http.Status = 200 And InStr(http.responseText, "ok") > 0)
    If Err.Number <> 0 Then HealthOK = False
    On Error GoTo 0
End Function

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
