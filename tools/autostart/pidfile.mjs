// เขียน PID ของเซิร์ฟเวอร์ลง logs/server.pid — server-autostart.cmd โหลดไฟล์นี้ผ่าน `node --import ./tools/autostart/pidfile.mjs ...`
// เพื่อให้ restart-task.ps1 หาโปรเซส node ตัวจริงได้แน่นอนแม้เปลี่ยน PORT (ไม่ต้องไล่จาก process tree ของ Task Scheduler)
// ลบไฟล์ให้เมื่อโปรเซสจบเอง (ถูก kill แบบ /F ไฟล์จะค้าง — restart-task.ps1 ตรวจก่อนว่า PID นั้นยังเป็น node ของโปรเจกต์นี้อยู่)
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const file = resolve("logs/server.pid"); // สัมพันธ์กับ cwd = โฟลเดอร์โปรเจกต์ (server-autostart.cmd cd ไปก่อน)
try {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${process.pid}\n`);
} catch (err) {
  console.error(`pidfile: เขียน ${file} ไม่ได้ (${err.message})`);
}
process.on("exit", () => {
  try {
    if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
  } catch {}
});
