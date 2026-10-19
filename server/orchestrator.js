// orchestrator.js — "กัปตัน" ผู้ประสานงาน
// รับโจทย์ → วางแผน → มอบหมายงานตามตำแหน่งและคิว → ติดตามความคืบหน้า
// → รับงานกลับ/ส่งต่อ (handoff) → ตรวจคุณภาพ → รวบรวมผลลัพธ์สุดท้าย
import { bus } from "./bus.js";
import { state, createJob as newJob, createTask, getAgent, getTask, getJob, workers, captain, agentView, snapshot } from "./state.js";
import { planJob, runTask, synthesizeJob, isLive } from "./executor.js";
import { recordUsage, recordDone, recordFailed, recordInterrupted, recordHandoff, recordQuality, recordToolUse, fmtDuration } from "./metrics.js";
import { ROLES, estimateCost, ALLOWED_MODELS, ALLOWED_EFFORTS, MAX_DUTIES_LENGTH } from "./agents.js";
import { liveAvailable } from "./llm.js";
import { saveTeamOverrides } from "./team-store.js";

const MAX_ATTEMPTS = 3;
const TERMINAL = new Set(["done", "cancelled"]);
const running = new Map(); // taskId | "job:<id>" -> AbortController
const progressStamp = new Map(); // taskId -> { ts, phase }

const now = () => Date.now();
const shorten = (s, n = 40) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const emitAgent = (agent) => bus.publish("agent.updated", { agent: agentView(agent) });
const emitTask = (type, task, extra = {}) => bus.publish(type, { task, ...extra });
const emitJob = (type, job) => bus.publish(type, { job });

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ====================================================================
// รับโจทย์ใหม่
// ====================================================================
export async function submitJob(goal) {
  goal = String(goal || "").trim();
  if (!goal) throw new HttpError(400, "กรุณาระบุโจทย์งาน");
  if (goal.length > 2000) throw new HttpError(400, "โจทย์ยาวเกิน 2000 ตัวอักษร");

  const job = newJob(goal);
  emitJob("job.created", job);
  bus.log(`📥 รับโจทย์ใหม่: "${goal}"`, { jobId: job.id });

  const cap = captain();
  cap.status = "working";
  cap.currentLabel = `วางแผน: ${shorten(goal)}`;
  cap.phase = "กำลังอ่านโจทย์";
  emitAgent(cap);

  const t0 = now();
  const ac = new AbortController();
  running.set(`job:${job.id}`, ac);
  try {
    const plan = await planJob(job, {
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
    job.planCostUsd = recordUsage(cap, null, plan.usage);
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
    cap.status = "idle";
    cap.currentLabel = "";
    cap.phase = "";
    emitAgent(cap);
  }
  tick();
  return job;
}

// ====================================================================
// ตัวจัดคิว: มอบหมายงานที่พร้อมทำให้คนที่ว่างและตรงตำแหน่ง
// ====================================================================
export function tick() {
  if (!state.settings.autoAssign) return;
  for (const task of state.tasks.values()) {
    if (task.status !== "queued") continue;
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
    bus.log(`📨 กัปตันมอบหมาย "${task.title}" ให้ ${agent.name} (${agent.nick && agent.nick !== agent.name ? `${agent.nick} · ` : ""}${agent.roleLabel})${byDuty}`, { agentId: agent.id, taskId: task.id });
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
      agentName: getAgent(t.assignedTo)?.name || "ทีม",
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
        agentName: getAgent(p.assignedTo)?.name || "ทีม",
        roleLabel: ROLES[p.role]?.label || p.role,
        output: p.output,
        attempts: p.attempts,
      };
    }
  }
  return { goal: job?.goal || "", inputs, reviewTarget };
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
  task.history.push({ t: now(), type: "started", agentId: agent.id, note: `เริ่มทำ (รอบที่ ${task.attempts})` });
  emitTask("task.started", task);

  const context = buildContext(task);
  try {
    const result = await runTask({
      agent,
      task,
      context,
      signal: ac.signal,
      onProgress: (p) => progress(task, agent, p),
    });
    if (ac.signal.aborted) return;
    finish(task, agent, result);
  } catch (err) {
    if (ac.signal.aborted || err?.name === "AbortError") return;
    fail(task, agent, err);
  } finally {
    running.delete(task.id);
    progressStamp.delete(task.id);
  }
}

function progress(task, agent, { phase, progress: p, text, tool, toolStarted }) {
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
  if (!phaseChanged && !toolChanged && !toolStarted && now() - last < 180) return;
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
  recordUsage(agent, task, result.usage);
  recordDone(agent, task);
  const toolNote = result.toolCalls ? `, ใช้เครื่องมือ ${result.toolCalls} ครั้ง` : "";
  task.history.push({ t: now(), type: "done", agentId: agent.id, note: `เสร็จใน ${fmtDuration(task.durationMs)}${toolNote}` });

  agent.status = "idle";
  agent.currentTaskId = null;
  agent.phase = "";
  agent.activeTool = null;
  agent.lastOutput = task.output.slice(-1500);

  emitTask("task.completed", task, { from: agent.id, to: "captain" });
  emitAgent(agent);
  bus.log(
    `✅ ${agent.name} ทำ "${task.title}" เสร็จใน ${fmtDuration(task.durationMs)} (ต้นทุน $${task.usage.costUsd.toFixed(4)}${toolNote})`,
    { agentId: agent.id, taskId: task.id },
  );

  if (task.reviewOfId && task.review) handleReview(task, agent);
  void checkJob(task.jobId);
  tick();
}

function handleReview(reviewTask, reviewer) {
  const producer = getTask(reviewTask.reviewOfId);
  if (!producer) return;
  const r = reviewTask.review;
  const producerAgent = getAgent(producer.assignedTo);

  if (r.approved) {
    producer.review = { ...r };
    recordQuality(producerAgent, r.score);
    emitTask("task.review", producer, { approved: true, score: r.score });
    bus.log(`🏅 ${reviewer.name} ให้ "${producer.title}" ${r.score}/100 — ผ่าน`, { taskId: producer.id });
    return;
  }
  if (producer.attempts >= MAX_ATTEMPTS) {
    producer.review = { ...r, acceptedWithNotes: true };
    recordQuality(producerAgent, r.score);
    emitTask("task.review", producer, { approved: false, score: r.score, accepted: true });
    bus.log(`⚠️ "${producer.title}" ไม่ผ่าน QA ครบ ${MAX_ATTEMPTS} รอบ — กัปตันรับงานพร้อมหมายเหตุ`, { taskId: producer.id, level: "warn" });
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
  bus.log(`🔁 ${reviewer.name} ส่ง "${producer.title}" กลับให้ ${producerAgent?.name || "ทีม"} แก้ (คะแนน ${r.score}/100)`, { taskId: producer.id });
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

  if (task.attempts < MAX_ATTEMPTS) {
    task.status = "queued";
    task.progress = 0;
    task.phase = `ล้มเหลว จะลองใหม่ (${task.attempts}/${MAX_ATTEMPTS})`;
    emitTask("task.failed", task, { retry: true, error: msg });
    bus.log(`⚠️ ${agent.name} ทำ "${task.title}" ไม่สำเร็จ: ${msg} — กัปตันจะมอบหมายใหม่`, { taskId: task.id, level: "warn" });
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

  job.status = "synthesizing";
  emitJob("job.updated", job);
  const cap = captain();
  cap.status = "working";
  cap.currentLabel = `รวบรวมผล: ${shorten(job.goal)}`;
  cap.phase = "กำลังรวบรวมผลงานจากทีม";
  emitAgent(cap);

  const t0 = now();
  const ac = new AbortController();
  running.set(`job:${job.id}`, ac);
  try {
    const { text, usage } = await synthesizeJob(job, tasks, {
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
    const synthCost = recordUsage(cap, null, usage);
    cap.metrics.tasksDone += 1;
    cap.metrics.busyMs += now() - t0;
    cap.metrics.totalDurationMs += now() - t0;
    job.costUsd = tasks.reduce((s, t) => s + t.usage.costUsd, 0) + (job.planCostUsd || 0) + synthCost;
    emitJob("job.completed", job);
    bus.log(`🎉 งาน "${shorten(job.goal, 60)}" เสร็จสมบูรณ์ใน ${fmtDuration(job.durationMs)} ต้นทุนรวม $${job.costUsd.toFixed(4)}`, { jobId: job.id });
  } catch (err) {
    if (ac.signal.aborted) return;
    job.status = "failed";
    job.finishedAt = now();
    emitJob("job.failed", job);
    bus.log(`❌ รวบรวมผลงานไม่สำเร็จ: ${err.message}`, { jobId: job.id, level: "error" });
  } finally {
    running.delete(`job:${job.id}`);
    cap.status = "idle";
    cap.currentLabel = "";
    cap.phase = "";
    emitAgent(cap);
  }
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
  if (task.attempts >= MAX_ATTEMPTS) task.attempts = MAX_ATTEMPTS - 1;
  if (reason) task.feedback = [task.feedback, `หมายเหตุจากผู้ควบคุม: ${reason}`].filter(Boolean).join("\n");
  task.history.push({ t: now(), type: "handoff", from: fromId, to: to.id, note: reason || "ส่งต่องานโดยผู้ควบคุม" });
  recordHandoff(from, to);
  emitTask("task.handoff", task, { from: fromId || "captain", to: to.id, reason, manual: true });
  bus.log(`🔁 ผู้ควบคุมส่งต่อ "${task.title}" จาก ${from?.name || "กัปตัน"} ไปยัง ${to.name}${reason ? ` — ${reason}` : ""}`, { taskId: task.id });
  tick();
  return task;
}

export function retryTask(taskId) {
  const task = getTask(taskId);
  if (!task) throw new HttpError(404, "ไม่พบงาน");
  if (!["failed", "cancelled", "done"].includes(task.status)) throw new HttpError(409, "งานนี้ยังไม่จบ ใช้ 'ส่งต่อ' แทน");
  const job = getJob(task.jobId);
  if (job && job.status === "failed") {
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
export function configureAgent(agentId, { model, effort, toolsEnabled, duties } = {}) {
  const a = getAgent(agentId);
  if (!a) throw new HttpError(404, "ไม่พบพนักงาน");
  const changes = [];
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
