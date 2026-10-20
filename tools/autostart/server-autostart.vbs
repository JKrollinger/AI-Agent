' เปิดเซิร์ฟเวอร์แบบซ่อนหน้าต่าง — Task Scheduler "Grock Agent Server" เรียกไฟล์นี้ตอนล็อกอิน (ดู install-task.ps1)
' รอจนเซิร์ฟเวอร์จบแล้วคืน exit code ให้ Task Scheduler (ล้ม = รีสตาร์ตให้เองตามที่ตั้งไว้)
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
cmdPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "server-autostart.cmd")
code = sh.Run("cmd.exe /c """ & cmdPath & """", 0, True)
WScript.Quit code
