// e2e-apply.mjs — รันเซิร์ฟเวอร์จริงในโหมด sim: โปรเจกต์ที่ให้สิทธิ์ dev-1 ได้ patch รออนุมัติ → apply แล้วไฟล์เปลี่ยนจริง + job.json มีบันทึก,
// โจทย์ถัดไป → reject แล้วไฟล์ไม่เปลี่ยน, โปรเจกต์ที่ไม่ให้สิทธิ์ได้แค่ข้อเสนอเหมือนเดิม, guard ของ API apply/reject
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const freePort = (start) => new Promise((resolve) => { const tryPort = (p) => { const s = net.createServer(); s.once("error", () => tryPort(p + 1)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(p))); }; tryPort(start); });
const PORT = await freePort(3794); // พอร์ตแรกที่ว่าง (เซิร์ฟเวอร์ทดสอบที่ค้างจากรอบก่อนทำให้พอร์ตคงที่ชนกัน)
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-e2e-apply-"));
const DATA = path.join(TMP, "data");
process.env.GROCK_DATA_DIR = DATA;
process.env.LOG_EVENTS = "0";
const P = await import(new URL("../../server/projects.js", import.meta.url).href);

function makeProject(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n\nระบบ ${name} สำหรับทดสอบ e2e apply\n`, "utf8");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=shh\n", "utf8");
  return root;
}
const rootA = makeProject("GrantA"); // ให้สิทธิ์ dev-1
const rootB = makeProject("NoGrantB"); // ไม่ให้สิทธิ์
P.initPack(rootA, { id: "granta", register: true });
P.initPack(rootB, { id: "nograntb", register: true });
const cfgA = JSON.parse(fs.readFileSync(path.join(rootA, ".grock", "project.json"), "utf8"));
Object.assign(cfgA, { name: "Grant A", plan: { roles: ["coder"], maxTasks: 1 }, qa: { maxAttempts: 1 }, permissions: { "dev-1": { write: ["src/**"], deny: [".env*"], tools: ["Edit", "Write", "Bash(npm test)"] } } });
fs.writeFileSync(path.join(rootA, ".grock", "project.json"), JSON.stringify(cfgA, null, 2), "utf8");
const cfgB = JSON.parse(fs.readFileSync(path.join(rootB, ".grock", "project.json"), "utf8"));
Object.assign(cfgB, { name: "No Grant B", plan: { roles: ["coder"], maxTasks: 1 }, qa: { maxAttempts: 1 } });
fs.writeFileSync(path.join(rootB, ".grock", "project.json"), JSON.stringify(cfgB, null, 2), "utf8");

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MODE: "sim", CODE_MODE: "auto", LOG_EVENTS: "0", GROCK_DATA_DIR: DATA }, // CODE_MODE=auto กัน .env/shell ของผู้ใช้ที่ตั้ง live ไว้ไม่ให้เทสต์เรียก claude จริง
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
const json = (p, init) => fetch(`${BASE}${p}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (p, body) => json(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }
  await post("/api/settings", { speed: 6 });

  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let stop = false;
  const pump = (async () => {
    while (!stop) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2); const l = chunk.split("\n").find((x) => x.startsWith("data: ")); if (l) events.push(JSON.parse(l.slice(6))); }
    }
  })().catch(() => {});
  const waitFor = async (pred, ms = 120_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await sleep(150); } return null; };
  const taskOf = async (id) => (await json("/api/state")).body.tasks.find((t) => t.id === id);

  // ---------- A: โปรเจกต์ที่ให้สิทธิ์ → patch รออนุมัติ → apply ----------
  const jA = await post("/api/jobs", { goal: "เขียนโค้ดเพิ่มฟีเจอร์คูปองส่วนลด (e2e apply)", project: "granta" });
  assert.equal(jA.status, 202);
  const jobA = jA.body.job;
  const pend = await waitFor((e) => e.type === "task.patch" && e.data.action === "pending" && e.data.task.jobId === jobA.id, 60_000);
  assert.ok(pend, "ต้องมี event task.patch (pending) ของโจทย์ A");
  const tA = pend.data.task;
  assert.equal(tA.role, "coder");
  // plan.roles ["coder"] + maxTasks 1 → กัปตันจำลองต้องตั้งชื่อ/คำอธิบายงานแบบนักพัฒนา (ไม่ใช่แม่แบบนักวิจัยที่ถูกเปลี่ยน role) และชื่อไฟล์ patch ตามชื่องานนั้น
  assert.ok(tA.title.startsWith("เขียนโค้ด:") && !tA.title.startsWith("ค้นข้อมูลพื้นฐาน"), `งานของ coder ต้องใช้ชื่อของนักพัฒนา: ${tA.title}`);
  assert.ok(tA.description.includes("แก้ไฟล์ในโปรเจกต์") && !tA.description.includes("รวบรวมข้อเท็จจริง"), `คำอธิบายต้องเป็นของนักพัฒนา: ${tA.description}`);
  assert.ok(tA.patch.rel.includes("เขียนโค้ด"), `ชื่อไฟล์ patch ต้องมาจากชื่องานใหม่: ${tA.patch.rel}`);
  assert.equal(tA.assignedTo === null || tA.assignedTo === "dev-1", true);
  assert.equal(tA.status, "done", "งานยัง done เพื่อให้ QA ตรวจต่อ");
  assert.equal(tA.phase, "รออนุมัติ patch");
  assert.equal(tA.patch.status, "pending");
  assert.equal(tA.patch.mode, "sim");
  assert.equal(tA.patch.agentId, "dev-1");
  assert.deepEqual(tA.patch.files.map((f) => f.path), ["src/GROCK-SIM-01.md", "src/app.js"]);
  assert.ok(tA.patch.preview.includes("diff --git a/src/app.js") && tA.patch.rel.startsWith(".grock/out/"));
  assert.ok(tA.output.includes("Patch รออนุมัติ") && tA.output.includes("```diff"), "ผลงานของ coder ต้องมี patch ให้ QA ตรวจ");
  assert.ok(tA.history.some((h) => h.type === "patch" && h.note.includes("รออนุมัติ")));
  const patchAbs = path.join(rootA, ...tA.patch.rel.split("/"));
  assert.ok(fs.existsSync(patchAbs) && fs.existsSync(`${patchAbs}.json`), "ไฟล์ patch + sidecar ต้องอยู่ใน .grock/out");
  assert.equal(fs.readFileSync(path.join(rootA, "src", "app.js"), "utf8"), "export const x = 1;\n", "ก่อน apply ไฟล์จริงต้องไม่เปลี่ยน");
  assert.ok(!fs.existsSync(path.join(rootA, "src", "GROCK-SIM-01.md")));
  const st1 = (await json("/api/state")).body;
  assert.equal(st1.totals.pendingPatches, 1);
  const logPend = events.find((e) => e.type === "log" && e.data.taskId === tA.id && e.data.message.includes("รออนุมัติ"));
  assert.ok(logPend, "ต้องมี log 🩹 patch รออนุมัติ");
  // GET patch ฉบับเต็ม
  const gp = await json(`/api/tasks/${tA.id}/patch`);
  assert.equal(gp.status, 200);
  assert.ok(gp.body.diff.includes("+// grock sim") && gp.body.patch.sha256);
  // รอโจทย์จบก่อน (QA อาจส่งกลับ → patch ใหม่แทนที่) แล้วค่อยตัดสินใจกับ patch ล่าสุด
  const endA = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jobA.id);
  assert.equal(endA?.type, "job.completed", `โจทย์ A ต้องสำเร็จ: ${JSON.stringify(endA?.data?.job?.status)}`);
  let cur = await taskOf(tA.id);
  assert.equal(cur.patch.status, "pending", "หลังโจทย์จบ patch ล่าสุดยังรออนุมัติ");
  if (cur.attempts > 1) {
    assert.ok(cur.patches.length >= 2 && cur.patches[0].status === "superseded", "patch รอบแรกต้องถูกแทนที่เมื่อ QA ส่งกลับ");
    console.log(`   (QA ส่งกลับ ${cur.attempts - 1} ครั้ง → patch ถูกแทนที่ ตรวจ supersede ผ่าน)`);
  }
  // guard: งานที่ไม่มี patch → 409, body ไม่ใช่ JSON → 400
  const other = (await json("/api/state")).body.tasks.find((t) => t.jobId === jobA.id && t.role === "reviewer");
  assert.equal((await post(`/api/tasks/${other.id}/apply`, {})).status, 409);
  assert.equal((await post(`/api/tasks/nope/apply`, {})).status, 404);
  // apply
  const ap = await post(`/api/tasks/${tA.id}/apply`, { note: "ตรวจแล้ว ok" });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.task.patch.status, "applied");
  assert.equal(ap.body.task.patch.note, "ตรวจแล้ว ok");
  assert.deepEqual(ap.body.task.patch.appliedFiles, cur.patch.files.map((f) => f.path));
  const appJs = fs.readFileSync(path.join(rootA, "src", "app.js"), "utf8");
  assert.ok(appJs.startsWith("export const x = 1;\n") && appJs.includes("// grock sim:"), "apply แล้ว src/app.js ต้องเปลี่ยนจริง");
  const simFile = cur.patch.files.find((f) => f.kind === "added")?.path;
  assert.ok(simFile && fs.existsSync(path.join(rootA, ...simFile.split("/"))), "ไฟล์ใหม่จาก patch ต้องถูกสร้าง");
  assert.equal(fs.readFileSync(path.join(rootA, ".env"), "utf8"), "SECRET=shh\n");
  assert.ok(await waitFor((e) => e.type === "task.patch" && e.data.action === "applied" && e.data.task.id === tA.id, 5000));
  assert.equal((await post(`/api/tasks/${tA.id}/apply`, {})).status, 409, "apply ซ้ำ → 409");
  assert.equal((await post(`/api/tasks/${tA.id}/reject`, {})).status, 409, "reject หลัง apply → 409");
  await sleep(400);
  const jobJson = JSON.parse(fs.readFileSync(path.join(rootA, ".grock", "out", jobA.id, "job.json"), "utf8"));
  const jt = jobJson.tasks.find((t) => t.id === tA.id);
  assert.equal(jt.patch.status, "applied", "job.json ต้องบันทึกว่า applied");
  assert.equal(jt.patch.decidedBy, "dashboard");
  assert.equal(jt.patch.note, "ตรวจแล้ว ok");
  assert.ok(jt.patch.files.length >= 1 && jt.patches.length >= 1);
  assert.equal(jt.patches.at(-1).status, "applied", "ประวัติ patches[] ใน job.json ต้องอัปเดตตามการตัดสินใจ ไม่ค้างเป็น pending");
  assert.equal(jt.patches.at(-1).decidedBy, "dashboard");
  const side = JSON.parse(fs.readFileSync(`${path.join(rootA, ...cur.patch.rel.split("/"))}.json`, "utf8"));
  assert.equal(side.status, "applied");
  assert.deepEqual(side.decisions.map((d) => d.event), ["created", "applied"]);
  const taskMd = fs.readdirSync(path.join(rootA, ".grock", "out", jobA.id, "tasks")).find((f) => f.includes("coder"));
  assert.ok(fs.readFileSync(path.join(rootA, ".grock", "out", jobA.id, "tasks", taskMd), "utf8").includes("- Patch: "));
  assert.equal((await json("/api/state")).body.totals.pendingPatches, 0);
  console.log("✅ A: patch รออนุมัติ (สถานะ/preview/ไฟล์ใน .grock/out/patches, ไฟล์จริงยังไม่เปลี่ยน) → apply → ไฟล์เปลี่ยนจริง + job.json/sidecar/task.md มี audit + guard 409");

  // ---------- A2: โจทย์ถัดไป → reject → ไฟล์ไม่เปลี่ยน ----------
  const snapApp = fs.readFileSync(path.join(rootA, "src", "app.js"), "utf8");
  const jA2 = await post("/api/jobs", { goal: "เขียนโค้ดแก้บั๊กหน้าชำระเงิน (e2e reject)", project: "granta" });
  assert.equal(jA2.status, 202);
  const end2 = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jA2.body.job.id);
  assert.equal(end2?.type, "job.completed");
  const t2 = (await json("/api/state")).body.tasks.find((t) => t.jobId === jA2.body.job.id && t.role === "coder");
  assert.equal(t2.patch?.status, "pending");
  const rj = await post(`/api/tasks/${t2.id}/reject`, { reason: "ยังไม่ต้องการ" });
  assert.equal(rj.status, 200, JSON.stringify(rj.body));
  assert.equal(rj.body.task.patch.status, "rejected");
  assert.equal(rj.body.task.patch.note, "ยังไม่ต้องการ");
  assert.equal(fs.readFileSync(path.join(rootA, "src", "app.js"), "utf8"), snapApp, "reject แล้วไฟล์ต้องไม่เปลี่ยน");
  assert.equal((await post(`/api/tasks/${t2.id}/apply`, {})).status, 409);
  await sleep(300);
  const jj2 = JSON.parse(fs.readFileSync(path.join(rootA, ".grock", "out", jA2.body.job.id, "job.json"), "utf8"));
  assert.equal(jj2.tasks.find((t) => t.id === t2.id).patch.status, "rejected");
  assert.equal(jj2.tasks.find((t) => t.id === t2.id).patches.at(-1).status, "rejected", "patches[] ต้องเป็น rejected ด้วย");
  assert.ok(events.some((e) => e.type === "log" && e.data.taskId === t2.id && e.data.message.includes("ปฏิเสธ patch")));
  console.log("✅ A2: reject → ไฟล์ไม่เปลี่ยน + job.json บันทึก rejected + apply หลัง reject → 409");

  // ---------- B: ไม่ให้สิทธิ์ → ข้อเสนอเหมือนเดิม ----------
  const jB = await post("/api/jobs", { goal: "เขียนโค้ดระบบแจ้งเตือนทางอีเมล (e2e no grant)", project: "nograntb" });
  assert.equal(jB.status, 202);
  const endB = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jB.body.job.id);
  assert.equal(endB?.type, "job.completed");
  const tB = (await json("/api/state")).body.tasks.find((t) => t.jobId === jB.body.job.id && t.role === "coder");
  assert.equal(tB.patch, null, "โปรเจกต์ที่ไม่ให้สิทธิ์ต้องไม่มี patch");
  assert.ok(tB.output.includes("ต้นแบบ") && !tB.output.includes("Patch รออนุมัติ"));
  assert.ok(!events.some((e) => e.type === "task.patch" && e.data.task.jobId === jB.body.job.id));
  assert.ok(!fs.existsSync(path.join(rootB, ".grock", "out", jB.body.job.id, "patches")));
  assert.equal(fs.readFileSync(path.join(rootB, "src", "app.js"), "utf8"), "export const x = 1;\n");
  console.log("✅ B: ไม่ให้สิทธิ์ → ได้แค่ข้อเสนอ ไม่มี patch ไม่แตะไฟล์");

  stop = true; ac.abort(); await pump;
  assert.ok(!/Error|TypeError|ReferenceError/.test(stderr), `เซิร์ฟเวอร์มี error ใน stderr:\n${stderr.slice(0, 2000)}`);
  console.log("E2E APPLY ALL PASSED");
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}
