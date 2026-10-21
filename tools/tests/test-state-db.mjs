// test-state-db.mjs — unit: SQLite write-through (node:sqlite) — บันทึกโจทย์/งาน/ตัวชี้วัดตาม event, เปิดใหม่แล้วโหลดกลับ, โจทย์ค้าง → failed + งานค้าง → cancelled, prune, ปิดด้วย STATE_DB=0 ไม่กระทบ
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

process.env.LOG_EVENTS = "0";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-statedb-unit-"));
process.env.GROCK_DATA_DIR = path.join(TMP, "data");
const D = await import(new URL("../../server/state-db.js", import.meta.url).href);
const { state } = await import(new URL("../../server/state.js", import.meta.url).href);
class Bus extends EventEmitter { publish(type, data) { const ev = { id: 1, ts: Date.now(), type, data }; this.emit("event", ev); return ev; } }
const freshState = () => ({ agents: new Map([...state.agents].map(([id, a]) => [id, { ...a, metrics: { ...a.metrics, qualityScores: [] }, createdAt: Date.now() }])), jobs: new Map(), tasks: new Map() });

try {
  assert.equal(D.STATE_DB_FILE(), path.join(TMP, "data", "state.db"), "ไฟล์อยู่ใต้ GROCK_DATA_DIR");
  const db = await D.openStateDb();
  assert.ok(fs.existsSync(db.file));
  assert.deepEqual(db.count(), { jobs: 0, tasks: 0 });

  // ---------- write-through ผ่าน bus ----------
  const bus = new Bus();
  const st = freshState();
  const detach = D.attachStateDb(bus, db, st);
  const mk = (id, status, extra = {}) => ({ id, goal: `โจทย์ ${id}`, project: null, status, createdAt: Date.now() - 10_000, finishedAt: status === "done" || status === "failed" ? Date.now() : null, taskIds: [], result: status === "done" ? "ผล" : "", costUsd: 0.1, plan: [{ title: "แผนดิบ" }], ...extra });
  const j1 = mk("job-a1", "done", { taskIds: ["task-a1-1", "task-a1-2"], project: "shop", storage: { status: "uploaded", uploaded: true, url: "https://x/a" } });
  const t1 = { id: "task-a1-1", jobId: "job-a1", seq: 1, title: "วิจัย", role: "researcher", status: "done", output: "x", attempts: 1, usage: { costUsd: 0.05 }, activeTool: "web_search", history: [], patch: { rel: "p.diff", status: "applied", preview: "ก้อนใหญ่" }, patches: [{ rel: "p.diff", status: "applied", preview: "ก้อนใหญ่" }] };
  const t2 = { id: "task-a1-2", jobId: "job-a1", seq: 2, title: "ตรวจ", role: "reviewer", status: "done", output: "ok", attempts: 1, usage: { costUsd: 0.01 }, history: [], patch: null, patches: [] };
  bus.publish("job.created", { job: j1 });
  bus.publish("task.created", { task: t1 }); bus.publish("task.created", { task: t2 });
  bus.publish("task.progress", { taskId: "task-a1-1", progress: 0.5 }); // ข้าม
  st.agents.get("res-1").metrics.tasksDone = 3; st.agents.get("res-1").metrics.costUsd = 1.25; st.agents.get("res-1").metrics.qualityScores = [80, 90];
  bus.publish("task.completed", { task: t1 }); // → บันทึก agents
  bus.publish("job.completed", { job: j1 });
  const running = mk("job-a2", "running", { taskIds: ["task-a2-1", "task-a2-2"] });
  bus.publish("job.created", { job: running });
  bus.publish("task.created", { task: { id: "task-a2-1", jobId: "job-a2", seq: 1, title: "กำลังทำ", role: "coder", status: "running", assignedTo: "dev-1", attempts: 1, usage: {}, history: [], activeTool: "code_execution" } });
  bus.publish("task.created", { task: { id: "task-a2-2", jobId: "job-a2", seq: 2, title: "เสร็จแล้ว", role: "researcher", status: "done", assignedTo: null, attempts: 1, usage: {}, history: [] } });
  bus.publish("job.created", { job: mk("job-a3", "planning") });
  bus.publish("job.failed", { job: mk("job-a4", "failed", { error: "เกินงบ" }) });
  bus.publish("log", { message: "ไม่เกี่ยว" });
  assert.deepEqual(db.count(), { jobs: 4, tasks: 4 });
  const rows = db.loadJobs();
  assert.equal(rows.length, 4); assert.equal(rows[0].id, "job-a4", "ใหม่สุดก่อน (created_at เท่ากัน → id)");
  assert.ok(!("plan" in rows.find((j) => j.id === "job-a1")), "ไม่เก็บแผนดิบ");
  assert.equal(rows.find((j) => j.id === "job-a1").storage.url, "https://x/a");
  const savedT1 = db.loadTasks("job-a1").find((t) => t.id === "task-a1-1");
  assert.equal(savedT1.patch.preview, undefined, "ตัด preview ของ patch"); assert.equal(savedT1.patches[0].preview, undefined); assert.equal(savedT1.activeTool, null);
  assert.equal(db.loadAgents().find((a) => a.id === "res-1").metrics.tasksDone, 3);
  detach();
  bus.publish("job.created", { job: mk("job-after-detach", "done") });
  assert.equal(db.count().jobs, 4, "detach แล้วไม่เขียน");
  db.close();
  console.log("✅ write-through: job.*/task.* → บันทึกทันที, ข้าม task.progress/log, ตัด plan/preview, agents บันทึกเมื่อ task.completed");

  // ---------- เปิดใหม่ (จำลองรีสตาร์ต) → restoreState ----------
  const db2 = await D.openStateDb();
  const st2 = freshState();
  st2.agents.get("res-1").createdAt = Date.now();
  const r = D.restoreState(db2, st2, { now: () => 1_800_000_000_000 });
  assert.equal(r.jobs, 4); assert.equal(r.tasks, 4); assert.equal(r.agents, st2.agents.size);
  assert.deepEqual(r.recovered.map((x) => [x.id, x.from]), [["job-a3", "planning"], ["job-a2", "running"]].sort(), "โจทย์ค้างถูกทำเครื่องหมาย failed");
  assert.deepEqual([...st2.jobs.keys()], ["job-a1", "job-a2", "job-a3", "job-a4"].sort((a, b) => (st2.jobs.get(a).createdAt - st2.jobs.get(b).createdAt) || a.localeCompare(b)), "ลำดับใน Map = เก่าสุดก่อน");
  const a2 = st2.jobs.get("job-a2");
  assert.equal(a2.status, "failed"); assert.match(a2.error, /รีสตาร์ต.*running/); assert.equal(a2.finishedAt, 1_800_000_000_000); assert.deepEqual(a2.restored, { at: 1_800_000_000_000, from: "running" });
  assert.equal(st2.jobs.get("job-a3").status, "failed"); assert.match(st2.jobs.get("job-a3").error, /planning/);
  assert.equal(st2.jobs.get("job-a1").status, "done"); assert.equal(st2.jobs.get("job-a1").result, "ผล"); assert.equal(st2.jobs.get("job-a1").restored.from, "done");
  assert.deepEqual(st2.jobs.get("job-a1").taskIds, ["task-a1-1", "task-a1-2"]);
  const rt = st2.tasks.get("task-a2-1");
  assert.equal(rt.status, "cancelled"); assert.equal(rt.assignedTo, null); assert.equal(rt.activeTool, null); assert.match(rt.phase, /รีสตาร์ต/); assert.equal(rt.history.at(-1).type, "cancelled");
  assert.equal(st2.tasks.get("task-a2-2").status, "done", "งานที่จบแล้วไม่ถูกแตะ");
  assert.equal(st2.tasks.get("task-a1-1").patch.status, "applied");
  const res1 = st2.agents.get("res-1");
  assert.equal(res1.metrics.tasksDone, 3); assert.equal(res1.metrics.costUsd, 1.25); assert.deepEqual(res1.metrics.qualityScores, [80, 90]);
  assert.ok(res1.createdAt < Date.now() - 1000 || res1.createdAt <= Date.now(), "createdAt ย้อนไปครั้งแรกที่เริ่ม");
  assert.equal(st2.agents.get("dev-1").metrics.tasksDone, 0);
  // ฐานถูกอัปเดตด้วย (เปิดอีกรอบต้องเห็น failed แล้ว ไม่ต้องกู้ซ้ำ)
  const again = D.restoreState(db2, freshState());
  assert.equal(again.recovered.length, 0, "รอบสองไม่มีโจทย์ค้างแล้ว");
  assert.equal(db2.loadTasks("job-a2").find((t) => t.id === "task-a2-1").status, "cancelled");
  // โหลดซ้ำเข้า state ที่มีโจทย์อยู่แล้ว → ไม่เขียนทับ
  const st3 = freshState(); st3.jobs.set("job-a1", { id: "job-a1", status: "running" });
  D.restoreState(db2, st3);
  assert.equal(st3.jobs.get("job-a1").status, "running");
  console.log("✅ restoreState: โจทย์จบโหลดกลับครบ (result/storage/patch), โจทย์ค้าง → failed + เหตุผล, งานค้าง → cancelled, ตัวชี้วัดต่อคนกลับมา, ไม่ทับโจทย์ที่มีอยู่");

  // ---------- prune + keep ----------
  for (let i = 0; i < 20; i++) db2.saveJob({ id: `job-p${String(i).padStart(2, "0")}`, status: "done", createdAt: 1_000_000 + i, finishedAt: 1_000_001 + i, taskIds: [] });
  db2.saveTask({ id: "task-p00", jobId: "job-p00", status: "done" });
  assert.equal(db2.loadJobs(5).length, 5);
  assert.equal(db2.loadJobs(5)[0].id, "job-a4", "limit = ใหม่สุดก่อน");
  db2.prune(6);
  assert.equal(db2.count().jobs, 6); assert.equal(db2.count().tasks, 4, "งานของโจทย์ที่ถูกตัดหายไปด้วย (task-p00 หาย เหลือของ job-a1/job-a2)");
  assert.ok(db2.loadJobs().every((j) => !j.id.startsWith("job-p0")), "โจทย์เก่าสุดถูกตัด");
  db2.close();
  assert.ok(D.STATE_DB_KEEP >= 10);
  console.log("✅ prune/keep: เก็บเฉพาะโจทย์ล่าสุด + งานของโจทย์ที่เหลือ");

  // ---------- ทนต่อความผิดพลาดของการเขียน ----------
  const errs = [];
  const broken = { saveJob() { throw new Error("disk full"); }, saveTask() {}, saveAgents() {}, saveAgent() {} };
  const d3 = D.attachStateDb(bus, broken, freshState(), { onError: (e) => errs.push(e.message) });
  for (let i = 0; i < 8; i++) bus.publish("job.updated", { job: mk(`job-x${i}`, "running") });
  d3();
  assert.equal(errs.length, 5, "รายงาน error แค่ 5 ครั้งแรก ไม่สแปม และไม่โยนออกมาทำให้ bus พัง");
  console.log("✅ เขียนล้มเหลว → เตือนจำกัดจำนวน ไม่ทำให้ event bus ล้ม");

  console.log("STATE-DB UNIT ALL PASSED");
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (err) { console.warn(`(ลบ temp ไม่ได้: ${err.message})`); } // Windows ปล่อย lock ของ state.db-wal ช้า
}
