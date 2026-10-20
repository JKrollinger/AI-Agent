// orchestrator.js — "กัปตัน" ผู้ประสานงาน
// รับโจทย์ → วางแผน → มอบหมายงานตามตำแหน่งและคิว → ติดตามความคืบหน้า
// → รับงานกลับ/ส่งต่อ (handoff) → ตรวจคุณภาพ → รวบรวมผลลัพธ์สุดท้าย
import { bus } from "./bus.js";
import { state, createJob as newJob, createTask, getAgent, getTask, getJob, workers, captain, agentView, snapshot } from "./state.js";
import { planJob, runTask, synthesizeJob, isLive } from "./executor.js";
import { recordUsage, recordDone, recordFailed, recordInterrupted, recordHandoff, recordQuality, recordToolUse, fmtDuration } from "./metrics.js";
import { ROLES, estimateCost, ALLOWED_MODELS, ALLOWED_EFFORTS, MAX_DUTIES_LENGTH, MAX_NAME_LENGTH, MAX_NICK_LENGTH } from "./agents.js";
import { liveAvailable } from "./llm.js";
import { saveTeamOverrides } from "./team-store.js";
import { loadPack, buildProjectContext, effectiveAgent, setJobContext, getJobContext, readProjectFiles, jobOutputDir } from "./projects.js";
import { applyPatchToProject, rejectPatchOfProject, markPatch, readPatch } from "./apply.js";

const MAX_ATTEMPTS = 3;
const TERMINAL = new Set(["done", "cancelled"]);
const running = new Map(); // taskId | "job:<id>" -> AbortController
const progressStamp = new Map(); // taskId -> { ts, phase }

const now = () => Date.now();
const shorten = (s, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const emitAgent = (agent) => bus.publish("agent.updated", { agent: agentView(agent) });
const emitTask = (type, task, extra = {}) => bus.publish(type, { task, ...extra });
const emitJob = (type, job) => bus.publish(type, { job });
/** แทนที่ task.patch และอัปเดตรายการเดียวกัน (rel เดิม) ใน task.patches — ประวัติทุกรอบที่ลง job.json ต้องได้สถานะ/ผู้ตัดสินใจ/หมายเหตุตามการตัดสินใจ ไม่ใช่ค้างเป็น pending */
const setPatch = (task, next) => {
  task.patch = next;
  task.patches = (task.patches || []).map((p) => (p.rel === next.rel ? next : p));
};

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ====================================================================
// รับโจทย์ใหม่
// ====================================================================
/** กัปตันรับได้หลายโจทย์พร้อมกัน (หลายโปรเจกต์) → นับจำนวนงานที่ถืออยู่ ไม่ใช่สลับสถานะทีละงาน */
function captainBusy(cap, label, phase) {
  cap.activeJobs = (cap.activeJobs || 0) + 1;
  cap.status = "working";
  cap.currentLabel = label;
  cap.phase = phase;
  emitAgent(cap);
}
function captainFree(cap) {
  cap.activeJobs = Math.max(0, (cap.activeJobs || 1) - 1);
  if (!cap.activeJobs) {
    cap.status = "idle";
    cap.currentLabel = "";
    cap.phase = "";
  }
  emitAgent(cap);
}

/** จำนวนรอบสูงสุดของงาน (ปรับได้ต่อโปรเจกต์ใน project.json qa.maxAttempts) */
function maxAttemptsFor(job) {
  return getJobContext(job?.id)?.pack?.config?.qa?.maxAttempts || MAX_ATTEMPTS;
}

/** ชื่อที่ใช้เรียกคนนี้ใน log/ผลงานของโจทย์นั้น: ชื่อเฉพาะโปรเจกต์ (project.json) ถ้าโจทย์ผูกกับโปรเจกต์ ไม่งั้นชื่อกลาง */
function dn(agent, jobId) {
  if (!agent) return "ทีม";
  const pack = getJobContext(jobId)?.pack;
  return pack ? effectiveAgent(agent, pack).name : agent.name;
}

/** ข้อมูลโปรเจกต์สำหรับ executor: { pack, name, system, data, qa, files } หรือ null */
function projectFor(jobId, role = "captain") {
  const jc = getJobContext(jobId);
  if (!jc) return null;
  if (!jc.roleData.has(role)) jc.roleData.set(role, buildProjectContext(jc.pack, { role }));
  const pc = jc.roleData.get(role);
  if (jc.files?.length && !jc.filesRead) jc.filesRead = readProjectFiles(jc.pack, jc.files);
  return { pack: jc.pack, name: jc.pack.name, system: pc.system, brief: pc.brief, roleInstructions: pc.roleInstructions, placement: pc.placement, data: pc.data, qa: jc.pack.config.qa, files: jc.filesRead || [] };
}

/**
 * รับโจทย์ใหม่ (คืน job ทันที สถานะ planning แล้วกัปตันวางแผนต่อเบื้องหลัง — ติดตามผ่าน SSE หรือ GET /api/jobs/:id)
 * @param {object} [opts]
 * @param {string|null} [opts.projectId]  id ของ Project Pack ที่ลงทะเบียนไว้
 * @param {string[]} [opts.files]         ไฟล์ในโปรเจกต์ที่ให้ทีมอ่านประกอบ (path สัมพัทธ์)
 */
export function submitJob(goal, { projectId = null, files = [] } = {}) {
  goal = String(goal || "").trim();
  if (!goal) throw new HttpError(400, "กรุณาระบุโจทย์งาน");
  if (goal.length > 2000) throw new HttpError(400, "โจทย์ยาวเกิน 2000 ตัวอักษร");
  let pack = null;
  if (projectId) {
    try {
      pack = loadPack(String(projectId));
    } catch (err) {
      throw new HttpError(err.status || 400, err.message);
    }
  }

  const job = newJob(goal, { project: pack ? pack.id : null, files: pack ? files : [] });
  if (pack) {
    let out;
    try {
      out = jobOutputDir(pack, job.id);
    } catch (err) {
      state.jobs.delete(job.id); // อย่าทิ้งโจทย์ค้างสถานะ planning ไว้ใน snapshot
      throw new HttpError(500, `สร้างโฟลเดอร์ผลงานในโปรเจกต์ไม่ได้: ${err.message}`);
    }
    job.outputDir = `${pack.rootPosix}/${out.rel}`;
    setJobContext(job.id, { pack, files, outDir: out.abs, outDirRel: out.rel, tasks: new Map(), roleData: new Map(), filesRead: null, job });
  }
  emitJob("job.created", job);
  bus.log(`📥 รับโจทย์ใหม่: "${goal}"${pack ? ` (โปรเจกต์ ${pack.name})` : ""}`, { jobId: job.id });
  if (pack) {
    const ctx = projectFor(job.id, "captain");
    const included = buildProjectContext(pack, { role: "captain" }).files.filter((f) => !f.skippedReason).length;
    bus.log(`📚 โหลดบริบทโปรเจกต์ "${pack.name}": ${included} ไฟล์, ${(ctx.system.length + ctx.data.length).toLocaleString()} ตัวอักษร → ผลงานจะเขียนที่ ${job.outputDir}`, { jobId: job.id });
    for (const w of pack.warnings) bus.log(`⚠️ โปรเจกต์ ${pack.name}: ${w}`, { jobId: job.id, level: "warn" });
  }
  void planAndStart(job);
  return job;
}

async function planAndStart(job) {
  const goal = job.goal;
  const cap = captain();
  captainBusy(cap, `วางแผน: ${shorten(goal)}`, "กำลังอ่านโจทย์");

  const t0 = now();
  const ac = new AbortController();
  running.set(`job:${job.id}`, ac);
  try {
    const plan = await planJob(job, {
      project: projectFor(job.id, "captain"),
      signal: ac.signal,
      onPhase: (phase) => {
        cap.phase = phase;
        emitAgent(cap);
      },
    });
    if (!plan.tasks.length) throw new Error("กัปตันวางแผนไม่สำเร็จ (ไม่มีงานย่อย)");

    const created = plan.tasks.map((t, i) =>
      createTask({ jobId: job.id, seq: i + 1, title: t.title, description: t.description, role: t.role, preferredAgentId: t.assignee || null }),
    );
    created.forEach((t) => {
      const pref = t.preferredAgentId ? getAgent(t.preferredAgentId) : null;
      if (pref) t.history.push({ t: now(), type: "planned", agentId: pref.id, note: `กัปตันเลือก ${pref.name} ตามหน้าที่` });
    });
    plan.tasks.forEach((t, i) => {
      created[i].dependsOn = (t.dependsOn || []).map((idx) => created[idx]?.id).filter(Boolean);
      created[i].reviewOfId = t.reviewOf !== null && t.reviewOf !== undefined ? created[t.reviewOf]?.id || null : null;
    });
    job.taskIds = created.map((t) => t.id);
    job.status = "running";
    job.planCostUsd = recordUsage(cap, null, plan.usage, plan.model || cap.model);
    cap.metrics.tasksDone += 1;
    cap.metrics.busyMs += now() - t0;
    cap.metrics.totalDurationMs += now() - t0;

    created.forEach((t) => emitTask("task.created", t));
    emitJob("job.planned", job);
    bus.log(`🧭 กัปตันแตกโจทย์เป็น ${created.length} งานย่อย และเริ่มมอบหมาย`, { jobId: job.id });
  } catch (err) {
    if (ac.signal.aborted) return job;
    job.status = "failed";
    job.finishedAt = now();
    emitJob("job.failed", job);
    bus.log(`❌ วางแผนงานไม่สำเร็จ: ${err.message}`, { jobId: job.id, level: "error" });
  } finally {
    running.delete(`job:${job.id}`);
    captainFree(cap);
  }
  tick();
  return job;
}

/** งบต่อโจทย์: project.json budget.maxUsdPerJob (0 = ไม่จำกัดชัดเจน) ถ้าโปรเจกต์ไม่ได้ตั้ง (null) ใช้ env MAX_USD_PER_JOB — คืน 0 = ไม่จำกัด */
function budgetFor(job) {
  const fromPack = getJobContext(job?.id)?.pack?.config?.budget?.maxUsdPerJob;
  const v = fromPack === null || fromPack === undefined ? Number(process.env.MAX_USD_PER_JOB) || 0 : Number(fromPack) || 0;
  return v > 0 ? v : 0;
}
/** ถ้าโจทย์ที่กำลังวิ่งใช้เงินเกินงบ → ปิดโจทย์ (คืน true) */
function enforceBudget(job) {
  if (!job || (job.status !== "running" && job.status !== "planning")) return false;
  const max = budgetFor(job);
  if (!(max > 0)) return false;
  const spent = spentSoFar(job);
  if (spent <= max) return false;
  failJobForBudget(job, spent, max);
  return true;
}
function spentSoFar(job) {
  return (job.planCostUsd || 0) + job.taskIds.map(getTask).filter(Boolean).reduce((s, t) => s + (t.usage?.costUsd || 0), 0);
}
function failJobForBudget(job, spent, max) {
  for (const t of job.taskIds.map(getTask).filter(Boolean)) {
    if (t.status === "queued" || t.status === "assigned" || t.status === "running") {
      if (t.status !== "queued") interrupt(t); // ยกเลิกการเรียก API ที่ค้างอยู่ทันที
      t.status = "cancelled";
      t.finishedAt = now();
      t.phase = "ยกเลิก: เกินงบ";
      t.assignedTo = null;
      t.history.push({ t: now(), type: "cancelled", note: `ยกเลิกเพราะโจทย์ใช้เงินเกินงบ ($${spent.toFixed(4)} > $${max.toFixed(2)})` });
      emitTask("task.updated", t);
    }
  }
  job.status = "failed";
  job.finishedAt = now();
  job.costUsd = spent;
  emitJob("job.failed", job);
  bus.log(`💸 โจทย์ "${shorten(job.goal, 50)}" ใช้เงินเกินงบ ($${spent.toFixed(4)} > $${max.toFixed(2)}) — หยุดมอบหมายงานที่เหลือ ผลงานที่เสร็จแล้วยังถูกบันทึก`, { jobId: job.id, level: "error" });
}

// ====================================================================
// ตัวจัดคิว: มอบหมายงานที่พร้อมทำให้คนที่ว่างและตรงตำแหน่ง
// ====================================================================
export function tick() {
  if (!state.settings.autoAssign) return;
  for (const job of state.jobs.values()) enforceBudget(job); // รวมโจทย์ที่เหลือแต่งานที่กำลังวิ่ง (reviewer ชิ้นสุดท้าย) ด้วย
  for (const task of state.tasks.values()) {
    if (task.status !== "queued") continue;
    const job = getJob(task.jobId);
    if (!job || job.status !== "running") continue; // งานของโจทย์ที่จบ/ล้มเหลว/กำลังวางแผนไม่มอบหมาย
    if (!depsSatisfied(task)) continue;
    const agent = pickAgent(task);
    if (agent) assign(task, agent);
  }
}

function depsSatisfied(task) {
  return task.dependsOn.every((id) => {
    const dep = getTask(id);
    return !dep || TERMINAL.has(dep.status);
  });
}

function pickAgent(task) {
  if (task.pinnedAgentId) {
    const a = getAgent(task.pinnedAgentId);
    return a && a.status === "idle" ? a : null;
  }
  // คนที่กัปตันเลือกตามหน้าที่: ว่าง → ให้เลย, กำลังทำงานอื่น → รอ, หยุดพัก/ไม่มีแล้ว → เลือกคนอื่นในตำแหน่งเดียวกัน
  if (task.preferredAgentId) {
    const p = getAgent(task.preferredAgentId);
    if (p && p.role !== "captain") {
      if (p.status === "idle") return p;
      if (p.status === "working") return null;
    }
  }
  const all = workers();
  const sameRole = all.filter((a) => a.role === task.role);
  const pool = sameRole.length ? sameRole : all; // ไม่มีตำแหน่งนี้ในทีม → ใครว่างก็ทำ
  const idle = pool.filter((a) => a.status === "idle");
  idle.sort((a, b) => a.metrics.tasksDone - b.metrics.tasksDone || a.metrics.busyMs - b.metrics.busyMs);
  return idle[0] || null;
}

function assign(task, agent) {
  const from = task.handoffFrom || "captain";
  task.handoffFrom = null;
  task.pinnedAgentId = null;
  task.status = "assigned";
  task.assignedTo = agent.id;
  task.assignedAt = now();
  task.history.push({ t: now(), type: "assigned", agentId: agent.id, note: `มอบหมายให้ ${agent.name}` });

  agent.status = "working";
  agent.currentTaskId = task.id;
  agent.phase = "รับงานแล้ว";
  agent.lastOutput = "";

  emitTask("task.assigned", task, { from, to: agent.id });
  emitAgent(agent);
  if (from === "captain") {
    const byDuty = task.preferredAgentId === agent.id ? " ตามหน้าที่" : task.preferredAgentId ? ` (แทน ${getAgent(task.preferredAgentId)?.name || "คนที่เลือกไว้"} ที่หยุดพัก)` : "";
    bus.log(`📨 กัปตันมอบหมาย "${task.title}" ให้ ${dn(agent, task.jobId)} (${agent.roleLabel})${byDuty}`, { agentId: agent.id, taskId: task.id });
  }
  void start(task, agent);
}

function buildContext(task) {
  const job = getJob(task.jobId);
  const inputs = [];
  const pushInput = (t) => {
    if (!t || t.status !== "done" || t.role === "reviewer" || inputs.some((i) => i.id === t.id)) return;
    inputs.push({
      id: t.id,
      title: t.title,
      role: t.role,
      roleLabel: ROLES[t.role]?.label || t.role,
      agentName: dn(getAgent(t.assignedTo), t.jobId),
      output: t.output,
      attempts: t.attempts,
    });
  };
  for (const depId of task.dependsOn) {
    const dep = getTask(depId);
    pushInput(dep);
    if (dep?.role === "reviewer" && dep.reviewOfId) pushInput(getTask(dep.reviewOfId));
  }
  let reviewTarget = null;
  if (task.reviewOfId) {
    const p = getTask(task.reviewOfId);
    if (p) {
      reviewTarget = {
        title: p.title,
        agentName: dn(getAgent(p.assignedTo), p.jobId),
        roleLabel: ROLES[p.role]?.label || p.role,
        output: p.output,
        attempts: p.attempts,
      };
    }
  }
  const project = projectFor(task.jobId, task.role);
  return { goal: job?.goal || "", inputs, reviewTarget, project, files: project?.files || [] };
}

async function start(task, agent) {
  const ac = new AbortController();
  running.set(task.id, ac);
  task.status = "running";
  task.startedAt = now();
  task.finishedAt = null;
  task.attempts += 1;
  task.progress = 0;
  task.phase = "เริ่มทำงาน";
  task.activeTool = null;
  agent.activeTool = null;
  if (task.patch?.status === "pending") { // ทำรอบใหม่ (QA ส่งกลับ/สั่งทำใหม่) → patch เดิมที่ยังไม่ตัดสินใจถือว่าตกไป
    setPatch(task, { ...task.patch, status: "superseded", decidedAt: now(), decidedBy: "system", note: `ถูกแทนที่โดยรอบที่ ${task.attempts}` });
    try { markPatch(task.patch, "superseded", task.patch.note); } catch {}
    task.history.push({ t: now(), type: "patch", note: `patch ${task.patch.rel} ตกไป (ทำรอบใหม่)` });
    emitTask("task.patch", task, { action: "superseded" });
  }
  task.history.push({ t: now(), type: "started", agentId: agent.id, note: `เริ่มทำ (รอบที่ ${task.attempts})` });
  emitTask("task.started", task);

  const context = buildContext(task);
  // ค่าเฉพาะโปรเจกต์ (โมเดล/ความลึก/เครื่องมือ/หน้าที่) ใช้กับงานชิ้นนี้ โดยไม่แก้ตัวพนักงานจริง
  const eff = context.project ? effectiveAgent(agent, context.project.pack) : agent;
  if (eff.projectOverrides?.length) {
    task.history.push({ t: now(), type: "override", agentId: agent.id, note: `ใช้ค่าเฉพาะโปรเจกต์: ${eff.projectOverrides.join(", ")}` });
  }
  try {
    const result = await runTask({
      agent: eff,
      task,
      context,
      signal: ac.signal,
      onProgress: (p) => progress(task, agent, p),
    });
    if (ac.signal.aborted || running.get(task.id) !== ac) return; // ถูกยกเลิก/ส่งต่อ/หยุดไปแล้ว — รอบนี้ไม่ใช่เจ้าของงานอีกต่อไป
    finish(task, agent, result);
  } catch (err) {
    if (ac.signal.aborted || err?.name === "AbortError" || running.get(task.id) !== ac) return;
    fail(task, agent, err);
  } finally {
    if (running.get(task.id) === ac) { // ลบเฉพาะตัวควบคุมของรอบตัวเอง (รอบใหม่หลัง handoff ต้องยังหยุดได้)
      running.delete(task.id);
      progressStamp.delete(task.id);
    }
  }
}

function progress(task, agent, { phase, progress: p, text, tool, toolStarted, toolStep, toolInput, toolResult, toolOk, note, level }) {
  if (note) { // ข้อความจาก executor/adapter ที่ต้องเข้า log และประวัติงาน (เช่น ถอยไปทำแบบข้อเสนอเพราะไม่มี claude CLI)
    task.history.push({ t: now(), type: "note", agentId: agent.id, note });
    bus.log(`ℹ️ ${note}`, { taskId: task.id, agentId: agent.id, ...(level ? { level } : {}) });
    if (!phase && p === undefined && text === undefined && tool === undefined) return;
  }
  const phaseChanged = phase && phase !== task.phase;
  const toolChanged = tool !== undefined && tool !== task.activeTool;
  if (phase) {
    task.phase = phase;
    agent.phase = phase;
  }
  if (typeof p === "number") task.progress = Math.max(task.progress, Math.min(0.99, p));
  if (typeof text === "string") agent.lastOutput = text;
  // เครื่องมือที่กำลังใช้ (server tools): string = ชื่อเครื่องมือ, null = เลิกใช้แล้ว, undefined = ไม่เปลี่ยน
  if (tool !== undefined) {
    task.activeTool = tool;
    agent.activeTool = tool;
  }
  if (toolStarted) recordToolUse(agent, task);

  const last = progressStamp.get(task.id) || 0;
  if (!phaseChanged && !toolChanged && !toolStarted && !toolStep && now() - last < 180) return;
  progressStamp.set(task.id, now());
  bus.publish("task.progress", {
    taskId: task.id,
    agentId: agent.id,
    phase: task.phase,
    progress: task.progress,
    text: (agent.lastOutput || "").slice(-1500),
    tool: task.activeTool,
    toolCalls: task.toolCalls,
    agentToolCalls: agent.metrics.toolCalls,
    // รายละเอียดการใช้เครื่องมือครั้งนี้ (มีเฉพาะ event ที่เป็นขั้นของเครื่องมือ): start → input (คำค้น/URL/คำสั่ง) → result (สรุปผล)
    ...(toolStep ? { toolStep, toolInput, toolResult, toolOk } : {}),
  });
}

function finish(task, agent, result) {
  task.status = "done";
  task.finishedAt = now();
  task.durationMs = task.finishedAt - task.startedAt;
  task.progress = 1;
  task.phase = "เสร็จแล้ว";
  task.output = result.output || "";
  task.activeTool = null;
  if (result.review) task.review = { ...result.review, reviewerId: agent.id };
  recordUsage(agent, task, result.usage, result.model || agent.model);
  recordDone(agent, task);
  const jobOfTask = getJob(task.jobId);
  if (jobOfTask && jobOfTask.status === "failed") { // โจทย์ถูกปิดไปแล้ว (เช่น เกินงบ) แต่ชิ้นนี้เสร็จพอดี → อัปเดตต้นทุนรวมและไฟล์ job.json
    jobOfTask.costUsd = spentSoFar(jobOfTask);
    emitJob("job.updated", jobOfTask);
  }
  const toolNote = result.toolCalls ? `, ใช้เครื่องมือ ${result.toolCalls} ครั้ง` : "";
  task.history.push({ t: now(), type: "done", agentId: agent.id, note: `เสร็จใน ${fmtDuration(task.durationMs)}${toolNote}` });
  // งานแก้ไฟล์จริง: patch ถูกเขียนไว้ใน .grock/out แล้ว แต่ยังไม่แตะไฟล์ของโปรเจกต์ → รอผู้ควบคุมอนุมัติ (สถานะงานยัง done เพื่อให้ QA ตรวจต่อได้)
  const patch = result.patch || null;
  if (patch) {
    task.patch = patch;
    task.patches = [...(task.patches || []), patch];
    task.phase = "รออนุมัติ patch";
    task.history.push({ t: now(), type: "patch", agentId: agent.id, note: `ส่ง patch ${patch.files.length} ไฟล์ (+${patch.stats.add} −${patch.stats.del}) รออนุมัติ: ${patch.rel}${patch.rejected?.length ? ` · ตัดไฟล์นอกสิทธิ์ ${patch.rejected.length} ไฟล์` : ""}` });
  }

  agent.status = "idle";
  agent.currentTaskId = null;
  agent.phase = "";
  agent.activeTool = null;
  agent.lastOutput = task.output.slice(-1500);

  emitTask("task.completed", task, { from: agent.id, to: "captain" });
  emitAgent(agent);
  bus.log(
    `✅ ${dn(agent, task.jobId)} ทำ "${task.title}" เสร็จใน ${fmtDuration(task.durationMs)} (ต้นทุน $${task.usage.costUsd.toFixed(4)}${toolNote})`,
    { agentId: agent.id, taskId: task.id },
  );
  if (patch) {
    emitTask("task.patch", task, { action: "pending" });
    bus.log(`🩹 ${dn(agent, task.jobId)} ส่ง patch ${patch.files.length} ไฟล์ รออนุมัติ (${patch.mode === "sim" ? "จำลอง" : "Claude Code"}) → ${patch.rel}${patch.rejected?.length ? ` — ตัดไฟล์นอกสิทธิ์ออก ${patch.rejected.length} ไฟล์: ${patch.rejected.map((r) => r.path).join(", ")}` : ""}`, { agentId: agent.id, taskId: task.id, jobId: task.jobId, level: patch.rejected?.length ? "warn" : undefined });
  }

  if (task.reviewOfId && task.review) handleReview(task, agent);
  void checkJob(task.jobId);
  tick();
}

function handleReview(reviewTask, reviewer) {
  const producer = getTask(reviewTask.reviewOfId);
  if (!producer || producer.status !== "done") return; // งานถูกยกเลิก/ทำใหม่ไประหว่างตรวจ → ผลตรวจนี้ไม่มีผล
  const r = reviewTask.review;
  const producerAgent = getAgent(producer.assignedTo);

  if (r.approved) {
    producer.review = { ...r };
    recordQuality(producerAgent, r.score);
    emitTask("task.review", producer, { approved: true, score: r.score });
    bus.log(`🏅 ${dn(reviewer, producer.jobId)} ให้ "${producer.title}" ${r.score}/100 — ผ่าน`, { taskId: producer.id });
    return;
  }
  const maxA = maxAttemptsFor(getJob(producer.jobId));
  if (producer.attempts >= maxA) {
    producer.review = { ...r, acceptedWithNotes: true };
    recordQuality(producerAgent, r.score);
    emitTask("task.review", producer, { approved: false, score: r.score, accepted: true });
    bus.log(`⚠️ "${producer.title}" ไม่ผ่าน QA ครบ ${maxA} รอบ — กัปตันรับงานพร้อมหมายเหตุ`, { taskId: producer.id, level: "warn" });
    return;
  }

  // ส่งกลับให้คนเดิมแก้ตาม feedback (handoff อัตโนมัติ) แล้ว QA ตรวจซ้ำ
  producer.review = { ...r };
  producer.feedback = r.feedback || r.summary || "";
  producer.status = "queued";
  producer.progress = 0;
  producer.phase = "รอแก้ตาม feedback";
  producer.pinnedAgentId = producer.assignedTo;
  producer.handoffFrom = reviewer.id;
  producer.assignedTo = null;
  producer.history.push({ t: now(), type: "handoff", from: reviewer.id, to: producer.pinnedAgentId, note: `QA ส่งกลับแก้ (คะแนน ${r.score}/100)` });

  reviewTask.status = "queued";
  reviewTask.progress = 0;
  reviewTask.phase = "รอตรวจรอบใหม่";
  reviewTask.pinnedAgentId = reviewer.id;
  reviewTask.assignedTo = null;
  reviewTask.history.push({ t: now(), type: "requeued", note: "รอตรวจรอบใหม่หลังแก้" });

  recordHandoff(reviewer, producerAgent);
  emitTask("task.handoff", producer, { from: reviewer.id, to: producer.pinnedAgentId, reason: producer.feedback, manual: false, score: r.score });
  emitTask("task.updated", reviewTask);
  bus.log(`🔁 ${dn(reviewer, producer.jobId)} ส่ง "${producer.title}" กลับให้ ${dn(producerAgent, producer.jobId)} แก้ (คะแนน ${r.score}/100)`, { taskId: producer.id });
}

function fail(task, agent, err) {
  const msg = (err?.message || String(err)).slice(0, 300);
  recordFailed(agent, task);
  agent.status = "idle";
  agent.currentTaskId = null;
  agent.phase = "";
  agent.activeTool = null;
  task.activeTool = null;
  task.history.push({ t: now(), type: "error", agentId: agent.id, note: msg });
  task.assignedTo = null;

  const maxA = maxAttemptsFor(getJob(task.jobId));
  if (task.attempts < maxA) {
    task.status = "queued";
    task.progress = 0;
    task.phase = `ล้มเหลว จะลองใหม่ (${task.attempts}/${maxA})`;
    emitTask("task.failed", task, { retry: true, error: msg });
    bus.log(`⚠️ ${dn(agent, task.jobId)} ทำ "${task.title}" ไม่สำเร็จ: ${msg} — กัปตันจะมอบหมายใหม่`, { taskId: task.id, level: "warn" });
  } else {
    task.status = "failed";
    task.finishedAt = now();
    task.phase = "ล้มเหลว";
    emitTask("task.failed", task, { retry: false, error: msg });
    bus.log(`❌ "${task.title}" ล้มเหลวถาวร: ${msg}`, { taskId: task.id, level: "error" });
    const job = getJob(task.jobId);
    if (job && job.status !== "failed") {
      job.status = "failed";
      job.finishedAt = now();
      emitJob("job.failed", job);
    }
  }
  emitAgent(agent);
  tick();
}

async function checkJob(jobId) {
  const job = getJob(jobId);
  if (!job || job.status !== "running") return;
  const tasks = job.taskIds.map(getTask).filter(Boolean);
  if (!tasks.length || !tasks.every((t) => TERMINAL.has(t.status))) return;
  if (enforceBudget(job)) return; // การสังเคราะห์เป็นการเรียกที่ใหญ่ที่สุด ต้องอยู่ในงบด้วย

  job.status = "synthesizing";
  emitJob("job.updated", job);
  const cap = captain();
  captainBusy(cap, `รวบรวมผล: ${shorten(job.goal)}`, "กำลังรวบรวมผลงานจากทีม");

  const t0 = now();
  const ac = new AbortController();
  running.set(`job:${job.id}`, ac);
  try {
    const { text, usage, model } = await synthesizeJob(job, tasks, {
      project: projectFor(job.id, "captain"),
      signal: ac.signal,
      onPhase: (p) => {
        cap.phase = p;
        emitAgent(cap);
      },
    });
    job.result = text;
    job.status = "done";
    job.finishedAt = now();
    job.durationMs = job.finishedAt - job.createdAt;
    const synthCost = recordUsage(cap, null, usage, model || cap.model);
    cap.metrics.tasksDone += 1;
    cap.metrics.busyMs += now() - t0;
    cap.metrics.totalDurationMs += now() - t0;
    job.costUsd = tasks.reduce((s, t) => s + t.usage.costUsd, 0) + (job.planCostUsd || 0) + synthCost;
    emitJob("job.completed", job);
    bus.log(`🎉 งาน "${shorten(job.goal, 60)}" เสร็จสมบูรณ์ใน ${fmtDuration(job.durationMs)} ต้นทุนรวม $${job.costUsd.toFixed(4)}${job.outputDir ? ` → ผลงานที่ ${job.outputDir}` : ""}`, { jobId: job.id });
  } catch (err) {
    if (ac.signal.aborted) return;
    job.status = "failed";
    job.finishedAt = now();
    emitJob("job.failed", job);
    bus.log(`❌ รวบรวมผลงานไม่สำเร็จ: ${err.message}`, { jobId: job.id, level: "error" });
  } finally {
    running.delete(`job:${job.id}`);
    captainFree(cap);
  }
}

/** รายละเอียดโจทย์ 1 รายการสำหรับ API (job + งานย่อย) */
export function getJobDetail(jobId) {
  const job = getJob(jobId);
  if (!job) throw new HttpError(404, "ไม่พบโจทย์");
  return { job, tasks: job.taskIds.map(getTask).filter(Boolean) };
}

// ====================================================================
// การควบคุมด้วยมือจาก dashboard
// ====================================================================
function interrupt(task) {
  const ac = running.get(task.id);
  if (ac) {
    ac.abort();
    running.delete(task.id);
  }
  task.activeTool = null;
  const agent = task.assignedTo ? getAgent(task.assignedTo) : null;
  if (agent && agent.currentTaskId === task.id) {
    if (task.status === "running") recordInterrupted(agent, task);
    agent.currentTaskId = null;
    agent.phase = "";
    agent.activeTool = null;
    if (agent.status === "working") agent.status = "idle";
    emitAgent(agent);
  }
}

function assertJobActive(task) {
  const job = getJob(task.jobId);
  if (!job || !["running", "planning"].includes(job.status)) {
    throw new HttpError(409, "งานหลักนี้จบไปแล้ว ไม่สามารถแก้ไขงานย่อยได้");
  }
}

/** ส่งต่องานให้พนักงานคนอื่น (ดึงคืนกลางคันได้) */
export function handoff(taskId, toAgentId, reason = "") {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "ไม่พบงาน");
  const to = getAgent(toAgentId);
  if (!to || to.role === "captain") throw new HttpError(400, "ต้องเลือกพนักงานที่ไม่ใช่กัปตัน");
  assertJobActive(task);
  const fromId = task.assignedTo;
  const from = fromId ? getAgent(fromId) : null;
  if (to.id === fromId && ["running", "assigned"].includes(task.status)) throw new HttpError(400, "งานนี้อยู่กับคนนี้อยู่แล้ว");

  interrupt(task);
  task.pinnedAgentId = to.id;
  task.handoffFrom = fromId || "captain";
  task.status = "queued";
  task.progress = 0;
  task.assignedTo = null;
  task.phase = "รอรับงานต่อ";
  const maxA = maxAttemptsFor(getJob(task.jobId));
  if (task.attempts >= maxA) task.attempts = maxA - 1;
  if (reason) task.feedback = [task.feedback, `หมายเหตุจากผู้ควบคุม: ${reason}`].filter(Boolean).join("\n");
  task.history.push({ t: now(), type: "handoff", from: fromId, to: to.id, note: reason || "ส่งต่องานโดยผู้ควบคุม" });
  recordHandoff(from, to);
  emitTask("task.handoff", task, { from: fromId || "captain", to: to.id, reason, manual: true });
  bus.log(`🔁 ผู้ควบคุมส่งต่อ "${task.title}" จาก ${from ? dn(from, task.jobId) : "กัปตัน"} ไปยัง ${dn(to, task.jobId)}${reason ? ` — ${reason}` : ""}`, { taskId: task.id });
  tick();
  return task;
}

export function retryTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "ไม่พบงาน");
  if (!["failed", "cancelled", "done"].includes(task.status)) throw new HttpError(409, "งานนี้ยังไม่จบ ใช้ 'ส่งต่อ' แทน");
  const job = getJob(task.jobId);
  if (job?.project && !getJobContext(job.id)) throw new HttpError(409, "บริบทโปรเจกต์ของโจทย์นี้ถูกเก็บกวาดไปแล้ว (โจทย์เก่า) — ส่งโจทย์ใหม่แทน");
  if (job && job.status === "failed") {
    const max = budgetFor(job);
    if (max > 0 && spentSoFar(job) > max) {
      throw new HttpError(409, `โจทย์นี้ใช้เงินเกินงบแล้ว ($${spentSoFar(job).toFixed(4)} > $${max.toFixed(2)}) — เพิ่ม budget.maxUsdPerJob ใน .grock/project.json แล้วส่งโจทย์ใหม่`);
    }
    job.status = "running";
    job.finishedAt = null;
    emitJob("job.updated", job);
  } else {
    assertJobActive(task);
  }
  task.status = "queued";
  task.progress = 0;
  task.attempts = 0;
  task.assignedTo = null;
  task.pinnedAgentId = null;
  task.phase = "รอมอบหมายใหม่";
  task.history.push({ t: now(), type: "requeued", note: "ผู้ควบคุมสั่งทำใหม่" });
  emitTask("task.updated", task);
  bus.log(`🔄 ผู้ควบคุมสั่งทำ "${task.title}" ใหม่`, { taskId: task.id });
  tick();
  return task;
}

export function cancelTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "ไม่พบงาน");
  if (TERMINAL.has(task.status) || task.status === "failed") throw new HttpError(409, "งานนี้จบไปแล้ว");
  interrupt(task);
  task.status = "cancelled";
  task.finishedAt = now();
  task.phase = "ยกเลิก";
  task.assignedTo = null;
  task.history.push({ t: now(), type: "cancelled", note: "ผู้ควบคุมยกเลิก" });
  emitTask("task.updated", task);
  bus.log(`🚫 ยกเลิกงาน "${task.title}"`, { taskId: task.id });
  for (const t of state.tasks.values()) { // งานตรวจที่รอตรวจชิ้นนี้ไม่มีอะไรให้ตรวจแล้ว
    if (t.reviewOfId === task.id && t.status === "queued") {
      t.status = "cancelled";
      t.finishedAt = now();
      t.phase = "ยกเลิก: งานที่ต้องตรวจถูกยกเลิก";
      t.history.push({ t: now(), type: "cancelled", note: `ยกเลิกเพราะ "${shorten(task.title, 40)}" ถูกยกเลิก` });
      emitTask("task.updated", t);
    }
  }
  void checkJob(task.jobId);
  tick();
  return task;
}

export function pauseAgent(agentId) {
  const a = getAgent(agentId);
  if (!a || a.role === "captain") throw new HttpError(400, "ไม่พบพนักงาน หรือเป็นกัปตัน");
  if (a.status === "paused") return agentView(a);
  const task = a.currentTaskId ? getTask(a.currentTaskId) : null;
  if (task) {
    interrupt(task);
    task.status = "queued";
    task.progress = 0;
    task.assignedTo = null;
    task.pinnedAgentId = null;
    task.phase = "รอมอบหมายใหม่";
    task.history.push({ t: now(), type: "requeued", note: `${a.name} หยุดชั่วคราว` });
    emitTask("task.updated", task);
    bus.log(`⏸️ ${a.name} หยุดชั่วคราว — งาน "${task.title}" กลับเข้าคิว`, { agentId: a.id });
  } else {
    bus.log(`⏸️ ${a.name} หยุดชั่วคราว`, { agentId: a.id });
  }
  a.status = "paused";
  emitAgent(a);
  tick();
  return agentView(a);
}

export function resumeAgent(agentId) {
  const a = getAgent(agentId);
  if (!a || a.role === "captain") throw new HttpError(400, "ไม่พบพนักงาน หรือเป็นกัปตัน");
  if (a.status !== "paused") return agentView(a);
  a.status = "idle";
  emitAgent(a);
  bus.log(`▶️ ${a.name} กลับมาทำงาน`, { agentId: a.id });
  tick();
  return agentView(a);
}

export function updateSettings({ speed, autoAssign } = {}) {
  if (speed !== undefined) {
    const s = Number(speed);
    if (!Number.isFinite(s)) throw new HttpError(400, "speed ไม่ถูกต้อง");
    state.settings.speed = Math.min(6, Math.max(0.25, s));
  }
  if (autoAssign !== undefined) state.settings.autoAssign = Boolean(autoAssign);
  bus.publish("settings.updated", { settings: state.settings });
  if (state.settings.autoAssign) tick();
  return state.settings;
}

/** ตั้งค่าโมเดล/ความลึกการคิด/เครื่องมือ ต่อพนักงาน (มีผลกับงานถัดไป) */
export function configureAgent(agentId, { model, effort, toolsEnabled, duties, name, nick } = {}) {
  const a = getAgent(agentId);
  if (!a) throw new HttpError(404, "ไม่พบพนักงาน");
  const changes = [];
  const clean = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  if (name !== undefined) { // ชื่อที่แสดงทุกที่ (roster, การ์ดงาน, ป้ายในฉาก 3 มิติ, prompt) — การมอบหมายใช้ id/ตำแหน่ง/หน้าที่ จึงเปลี่ยนได้อิสระ
    const n = clean(name);
    if (!n) throw new HttpError(400, "ชื่อต้องไม่ว่าง");
    if (n.length > MAX_NAME_LENGTH) throw new HttpError(400, `ชื่อยาวเกิน ${MAX_NAME_LENGTH} ตัวอักษร`);
    if (a.name !== n) { changes.push(`ชื่อ "${a.name}" → "${n}"`); if (a.nick === a.name) a.nick = n; a.name = n; }
  }
  if (nick !== undefined) { // ชื่อเล่น (ว่าง = ใช้ชื่อหลัก)
    const k = clean(nick);
    if (k.length > MAX_NICK_LENGTH) throw new HttpError(400, `ชื่อเล่นยาวเกิน ${MAX_NICK_LENGTH} ตัวอักษร`);
    const v = k || a.name;
    if (a.nick !== v) { a.nick = v; changes.push(`ชื่อเล่น → "${v}"`); }
  }
  if (duties !== undefined) {
    const d = String(duties || "").replace(/\s+/g, " ").trim();
    if (!d) throw new HttpError(400, "หน้าที่ต้องไม่ว่าง");
    if (d.length > MAX_DUTIES_LENGTH) throw new HttpError(400, `หน้าที่ยาวเกิน ${MAX_DUTIES_LENGTH} ตัวอักษร`);
    if (a.duties !== d) { a.duties = d; changes.push(`หน้าที่ → "${shorten(d, 60)}"`); }
  }
  if (model !== undefined) {
    if (!ALLOWED_MODELS.includes(model)) throw new HttpError(400, `model ต้องเป็นหนึ่งใน ${ALLOWED_MODELS.join(", ")}`);
    if (a.model !== model) { a.model = model; changes.push(`โมเดล → ${model}`); }
  }
  if (effort !== undefined) {
    if (!ALLOWED_EFFORTS.includes(effort)) throw new HttpError(400, `effort ต้องเป็นหนึ่งใน ${ALLOWED_EFFORTS.join(", ")}`);
    if (a.effort !== effort) { a.effort = effort; changes.push(`effort → ${effort}`); }
  }
  if (toolsEnabled !== undefined) {
    const v = Boolean(toolsEnabled);
    if (a.toolsEnabled !== v) { a.toolsEnabled = v; changes.push(v ? "เปิดเครื่องมือ" : "ปิดเครื่องมือ"); }
  }
  if (changes.length) {
    emitAgent(a);
    bus.log(`⚙️ ตั้งค่า ${a.name}: ${changes.join(", ")}`, { agentId: a.id });
    try {
      saveTeamOverrides(state.agents.values()); // บันทึกลง data/team.json ให้คงอยู่หลังรีสตาร์ต
    } catch (err) {
      bus.log(`⚠️ บันทึกการตั้งค่าทีมลงไฟล์ไม่สำเร็จ: ${err.message}`, { level: "warn" });
    }
  }
  return agentView(a);
}

// ====================================================================
// ด่านอนุมัติ patch (งานแก้ไฟล์จริงของ Developer) — ทุกขั้นลง task.history + job.json (ผ่าน task.patch event) + logs/events.jsonl
// ====================================================================
function pendingPatchTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "ไม่พบงาน");
  if (!task.patch || task.patch.status !== "pending") throw new HttpError(409, "งานนี้ไม่มี patch ที่รออนุมัติ");
  if (task.patch.applying) throw new HttpError(409, "กำลัง apply patch นี้อยู่");
  const jc = getJobContext(task.jobId);
  if (!jc) throw new HttpError(409, "บริบทโปรเจกต์ของโจทย์นี้ถูกเก็บกวาดไปแล้ว (โจทย์เก่า) — ใช้ไฟล์ patch ใน .grock/out กับ git apply เอง");
  let pack = jc.pack;
  try { pack = loadPack(jc.pack.id); } catch {} // ใช้สิทธิ์ล่าสุดจาก project.json (ผู้ใช้ถอนสิทธิ์ก่อน apply ได้)
  return { task, pack };
}

/** นำ patch เข้าโปรเจกต์จริง (git apply --check → git apply) */
export function applyPatch(taskId, { note = "" } = {}) {
  const { task, pack } = pendingPatchTask(taskId);
  const n = String(note || "").replace(/\s+/g, " ").trim().slice(0, 300);
  task.patch.applying = true;
  try {
    const r = applyPatchToProject({ pack, patch: task.patch, note: n, by: "dashboard" });
    setPatch(task, { ...task.patch, status: "applied", decidedAt: now(), decidedBy: "dashboard", note: n, appliedFiles: r.files, gitCheck: r.gitCheck?.note || null, lastError: null });
    task.phase = "apply patch แล้ว";
    task.history.push({ t: now(), type: "patch", note: `ผู้ควบคุมอนุมัติ → apply ${r.files.length} ไฟล์เข้าโปรเจกต์แล้ว${n ? ` — ${n}` : ""} (${r.gitCheck?.note || "ตรวจแล้ว"})` });
    emitTask("task.updated", task);
    emitTask("task.patch", task, { action: "applied", files: r.files });
    bus.log(`✅ apply patch ของ "${task.title}" เข้าโปรเจกต์ ${pack.name} แล้ว (${r.files.length} ไฟล์: ${r.files.join(", ")})${n ? ` — ${n}` : ""}`, { taskId: task.id, jobId: task.jobId });
  } catch (err) {
    const msg = (err.message || String(err)).slice(0, 400);
    setPatch(task, { ...task.patch, lastError: msg });
    task.history.push({ t: now(), type: "patch", note: `apply ไม่สำเร็จ: ${msg}` });
    emitTask("task.patch", task, { action: "error", error: msg });
    bus.log(`⚠️ apply patch ของ "${task.title}" ไม่สำเร็จ: ${msg}`, { taskId: task.id, jobId: task.jobId, level: "warn" });
    throw new HttpError(409, msg);
  } finally {
    delete task.patch.applying;
  }
  return task;
}

/** เนื้อหา patch ฉบับเต็ม (ต้นฉบับ ไม่ปิดบัง เพราะผู้ใช้บนเครื่องนี้ต้องใช้ตรวจ/apply เอง) */
export function getTaskPatch(taskId) {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "ไม่พบงาน");
  if (!task.patch) throw new HttpError(404, "งานนี้ไม่มี patch");
  const jc = getJobContext(task.jobId);
  let diff = null, error = null;
  if (!jc) error = "บริบทโปรเจกต์ของโจทย์นี้ถูกเก็บกวาดไปแล้ว — เปิดไฟล์ใน .grock/out ของโปรเจกต์เอง";
  else {
    try { diff = readPatch(jc.pack, task.patch).text; } catch (err) { error = err.message; }
  }
  return { taskId: task.id, patch: task.patch, diff, error };
}

/** ปฏิเสธ patch (ไม่แตะไฟล์) */
export function rejectPatch(taskId, { reason = "" } = {}) {
  const { task } = pendingPatchTask(taskId);
  const r = String(reason || "").replace(/\s+/g, " ").trim().slice(0, 300);
  try { rejectPatchOfProject({ patch: task.patch, reason: r, by: "dashboard" }); } catch (err) { throw new HttpError(409, err.message); }
  setPatch(task, { ...task.patch, status: "rejected", decidedAt: now(), decidedBy: "dashboard", note: r });
  task.phase = "ปฏิเสธ patch";
  task.history.push({ t: now(), type: "patch", note: `ผู้ควบคุมปฏิเสธ patch${r ? ` — ${r}` : ""}` });
  emitTask("task.updated", task);
  emitTask("task.patch", task, { action: "rejected" });
  bus.log(`🚫 ปฏิเสธ patch ของ "${task.title}"${r ? ` — ${r}` : ""} (ไฟล์ในโปรเจกต์ไม่ถูกแตะ)`, { taskId: task.id, jobId: task.jobId, level: "warn" });
  return task;
}

export function setMode(mode) {
  if (!["sim", "live"].includes(mode)) throw new HttpError(400, "mode ต้องเป็น sim หรือ live");
  if (mode === "live" && !liveAvailable()) {
    throw new HttpError(409, "ยังไม่มี ANTHROPIC_API_KEY — ตั้งค่าในไฟล์ .env แล้วรันใหม่");
  }
  state.mode = mode;
  bus.publish("mode.updated", { mode });
  bus.log(mode === "live" ? "🟢 สลับเป็นโหมด LIVE (เรียก Claude จริง)" : "🟡 สลับเป็นโหมดจำลอง (SIM)");
  return mode;
}

export { snapshot, isLive };
