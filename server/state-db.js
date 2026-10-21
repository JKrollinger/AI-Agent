// state-db.js — สถานะถาวรด้วย SQLite (node:sqlite ของ Node 22.13+/24) ไฟล์ data/state.db
//   แบบ write-through: หน่วยความจำ (state.js) ยังเป็นแหล่งความจริงตอนรัน ทุก event ของโจทย์/งาน/ตัวชี้วัดถูกเขียนลงฐานทันที
//   รีสตาร์ตแล้ว restoreState() โหลดโจทย์ที่จบแล้ว (done/failed) + งานย่อย + ตัวชี้วัดต่อคนกลับมา ให้แท็บผลงาน/ตัวชี้วัดไม่หาย
//   โจทย์ที่ค้างอยู่ตอนรีสตาร์ต (planning/running/synthesizing) → failed พร้อมเหตุผล และงานย่อยที่ยังไม่จบ → cancelled
//   ปิดด้วย STATE_DB=0 (เช่นในเทสต์ที่ไม่ต้องการ) — เปิดไม่สำเร็จ (เช่น Node ไม่มี node:sqlite) จะเตือนแล้วทำงานในหน่วยความจำต่อ
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./projects.js";

export const STATE_DB_FILE = () => path.join(DATA_DIR, "state.db");
export const STATE_DB_KEEP = Math.max(10, Math.min(5000, Number(process.env.STATE_DB_KEEP) || 300)); // โจทย์ที่โหลดกลับมาสูงสุด (ใหม่สุดก่อน)
const ACTIVE_JOB = new Set(["planning", "running", "synthesizing"]);
const ACTIVE_TASK = new Set(["queued", "assigned", "running", "review"]);
const SKIP_EVENTS = new Set(["task.progress", "metrics.updated", "log", "log.history", "snapshot"]);
const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, project TEXT, created_at INTEGER NOT NULL, finished_at INTEGER, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_job ON tasks(job_id);
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, created_at INTEGER, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
`;

/** ส่วนของ job ที่เก็บลงฐาน (ตัดแผนดิบที่ใช้แล้ว) */
const jobRow = (job) => { const { plan, ...rest } = job; return rest; };
/** ส่วนของ task ที่เก็บลงฐาน (ตัด preview ก้อนใหญ่ของ patch) */
const taskRow = (task) => ({ ...task, activeTool: null, patch: task.patch ? { ...task.patch, preview: undefined } : null, patches: (task.patches || []).map((p) => ({ ...p, preview: undefined })) });

/**
 * เปิดฐานข้อมูล → { file, saveJob, saveTask, saveAgent, saveAgents, loadJobs, loadTasks, loadAgents, count, close } หรือโยน error
 * @param {object} [opts] { file } (ค่าเริ่มต้น data/state.db ใต้ GROCK_DATA_DIR)
 */
export async function openStateDb({ file = STATE_DB_FILE() } = {}) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  const stmts = {
    upJob: db.prepare("INSERT INTO jobs (id, status, project, created_at, finished_at, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, project = excluded.project, created_at = excluded.created_at, finished_at = excluded.finished_at, json = excluded.json"),
    upTask: db.prepare("INSERT INTO tasks (id, job_id, status, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET job_id = excluded.job_id, status = excluded.status, json = excluded.json"),
    upAgent: db.prepare("INSERT INTO agents (id, created_at, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, json = excluded.json"),
    jobs: db.prepare("SELECT json FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?"),
    tasksOf: db.prepare("SELECT json FROM tasks WHERE job_id = ?"),
    agents: db.prepare("SELECT id, created_at, json FROM agents"),
    countJobs: db.prepare("SELECT COUNT(*) AS n FROM jobs"),
    countTasks: db.prepare("SELECT COUNT(*) AS n FROM tasks"),
    prune: db.prepare("DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY created_at DESC, id DESC LIMIT ?)"),
    pruneTasks: db.prepare("DELETE FROM tasks WHERE job_id NOT IN (SELECT id FROM jobs)"),
  };
  const api = {
    file,
    saveJob(job) { stmts.upJob.run(job.id, job.status, job.project || null, job.createdAt || 0, job.finishedAt || null, JSON.stringify(jobRow(job))); },
    saveTask(task) { stmts.upTask.run(task.id, task.jobId, task.status, JSON.stringify(taskRow(task))); },
    saveAgent(agent) { stmts.upAgent.run(agent.id, agent.createdAt || null, JSON.stringify({ metrics: agent.metrics })); },
    saveAgents(agents) { for (const a of agents) api.saveAgent(a); },
    loadJobs(limit = STATE_DB_KEEP) { return stmts.jobs.all(limit).map((r) => JSON.parse(r.json)); },
    loadTasks(jobId) { return stmts.tasksOf.all(jobId).map((r) => JSON.parse(r.json)); },
    loadAgents() { return stmts.agents.all().map((r) => ({ id: r.id, createdAt: r.created_at, ...JSON.parse(r.json) })); },
    count() { return { jobs: stmts.countJobs.get().n, tasks: stmts.countTasks.get().n }; },
    /** เก็บเฉพาะโจทย์ล่าสุด keep รายการ (เรียกตอนเริ่ม) */
    prune(keep = STATE_DB_KEEP) { stmts.prune.run(keep); stmts.pruneTasks.run(); },
    close() { try { db.close(); } catch {} },
  };
  return api;
}

/**
 * โหลดสถานะจากฐานเข้า state (เรียกครั้งเดียวตอนเริ่ม ก่อนรับคำขอ)
 * @returns {{ jobs: number, tasks: number, recovered: Array<{id, goal, from}>, agents: number }}
 */
export function restoreState(db, state, { keep = STATE_DB_KEEP, now = Date.now } = {}) {
  const t = now();
  const recovered = [];
  let nTasks = 0;
  const jobs = db.loadJobs(keep);
  for (const job of jobs.reverse()) { // เก่าสุดก่อน เพื่อให้ลำดับใน Map ตรงกับเวลาสร้าง
    if (state.jobs.has(job.id)) continue;
    const tasks = db.loadTasks(job.id);
    if (ACTIVE_JOB.has(job.status)) {
      const from = job.status;
      job.status = "failed";
      job.finishedAt = job.finishedAt || t;
      job.durationMs = job.durationMs || Math.max(0, job.finishedAt - (job.createdAt || t));
      job.error = `เซิร์ฟเวอร์รีสตาร์ตขณะโจทย์ยังไม่เสร็จ (สถานะเดิม: ${from})`.slice(0, 300);
      job.restored = { at: t, from };
      recovered.push({ id: job.id, goal: job.goal, from });
      db.saveJob(job);
    } else job.restored = job.restored || { at: t, from: job.status };
    for (const task of tasks) {
      if (ACTIVE_TASK.has(task.status)) {
        task.status = "cancelled";
        task.finishedAt = task.finishedAt || t;
        task.phase = "ยกเลิก: เซิร์ฟเวอร์รีสตาร์ต";
        task.assignedTo = null;
        task.activeTool = null;
        (task.history ||= []).push({ t, type: "cancelled", note: "เซิร์ฟเวอร์รีสตาร์ตขณะงานยังไม่จบ" });
        db.saveTask(task);
      }
      task.activeTool = null;
      state.tasks.set(task.id, task);
      nTasks += 1;
    }
    job.taskIds = (job.taskIds || []).filter((id) => state.tasks.has(id));
    state.jobs.set(job.id, job);
  }
  let nAgents = 0;
  for (const row of db.loadAgents()) {
    const agent = state.agents.get(row.id);
    if (!agent || !row.metrics || typeof row.metrics !== "object") continue;
    for (const [k, v] of Object.entries(row.metrics)) {
      if (k === "qualityScores") agent.metrics.qualityScores = Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
      else if (typeof v === "number" && Number.isFinite(v)) agent.metrics[k] = v;
    }
    if (row.createdAt && row.createdAt < agent.createdAt) agent.createdAt = row.createdAt; // อัตราใช้งาน = busy / เวลาตั้งแต่ครั้งแรกที่เริ่ม
    nAgents += 1;
  }
  return { jobs: jobs.length, tasks: nTasks, recovered, agents: nAgents };
}

/**
 * สมัครรับ event จาก bus → เขียนลงฐานทันที (write-through) คืนฟังก์ชันถอด
 *   job.* → saveJob · task.* → saveTask · งาน/โจทย์จบ, ส่งต่อ, ตรวจ → saveAgents (ตัวชี้วัด)
 */
export function attachStateDb(bus, db, state, { onError = (err) => console.warn(`[state-db] เขียนฐานข้อมูลไม่สำเร็จ: ${err.message}`) } = {}) {
  let failures = 0;
  const handler = (ev) => {
    if (SKIP_EVENTS.has(ev.type)) return;
    const d = ev.data || {};
    try {
      if (ev.type.startsWith("job.") && d.job?.id) db.saveJob(d.job);
      if (ev.type.startsWith("task.") && d.task?.id) db.saveTask(d.task);
      if (["task.completed", "task.failed", "task.handoff", "task.review", "task.cancelled", "job.completed", "job.failed"].includes(ev.type)) db.saveAgents(state.agents.values());
      if (ev.type === "agent.updated" && d.agent?.id) { const a = state.agents.get(d.agent.id); if (a) db.saveAgent(a); }
    } catch (err) {
      if (failures++ < 5) onError(err);
    }
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
