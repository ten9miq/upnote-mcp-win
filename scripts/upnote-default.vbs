Option Explicit
Dim fso, shell, scriptPath, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "launch.ps1")
command = "powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File """ & scriptPath & """"
If WScript.Arguments.Count > 0 Then
    If LCase(WScript.Arguments(0)) = "--background" Then command = command & " -Background"
End If
shell.Run command, 0, False
