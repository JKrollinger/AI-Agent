// state.js — สถานะกลางของระบบ (in-memory) + snapshot สำหรับ dashboard
import { DEFAULT_TEAM, makeAgent, ALLOWED_MODELS, ALLOWED_EFFORTS } from "./agents.js";
import { loadTeamOverrides, applyTeamOverrides } from "./team-store.js";

let counter = 0;
export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++counter).toString(36)}`;

export const state = {
  mode: "sim", // sim | live  (ตั้งใน index.js หลังตรวจ credentials)
  startedAt: Date.now(),
  settings: {
    speed: 1, // ตัวคูณความเร็วโหมดจำลอง
    autoAssign: true, // กัปตันมอบหมายงานอัตโนมัติ
  },
  agents: new Map(),
  tasks: new Map(),
  jobs: new Map(),
};

// สร้างทีมจากค่าเริ่มต้น + การตั้งค่าที่ผู้ใช้บันทึกไว้ (data/team.json: โมเดล ความลึก เครื่องมือ หน้าที่)
const teamOverrides = loadTeamOverrides();
for (const def of DEFAULT_TEAM) {
  const merged = applyTeamOverrides(def, teamOverrides);
  if (!ALLOWED_MODELS.includes(merged.model)) merged.model = def.model;
  if (merged.effort && !ALLOWED_EFFORTS.includes(merged.effort)) merged.effort = def.effort;
  state.agents.set(def.id, makeAgent(merged));
}

export const getAgent = (id) => state.agents.get(id);
export const getTask = (id) => state.tasks.get(id);
export const getJob = (id) => state.jobs.get(id);
export const workers = () => [...state.agents.values()].filter((a) => a.role !== "captain");
export const captain = () => state.agents.get("captain");

/**
 * สร้าง Task ใหม่
 * status: queued | assigned | running | review | done | failed | cancelled
 */
export function createTask({ jobId, seq, title, description, role, dependsOn = [], preferredAgentId = null }) {
  const task = {
    id: uid("task"),
    jobId,
    seq,
    title,
    description,
    role,
    status: "queued",
    assignedTo: null,
    pinnedAgentId: null, // บังคับให้คนนี้ทำ (จากการส่งต่อด้วยมือ)
    preferredAgentId, // คนที่กัปตันเลือกตามหน้าที่ตอนวางแผน (รอคนนี้ถ้ากำลังยุ่ง, ข้ามถ้าหยุดพัก)
    dependsOn,
    attempts: 0,
    progress: 0,
    phase: "",
    output: "",
    review: null, // { approved, score, feedback, reviewerId }
    feedback: "", // feedback จาก QA ที่ต้องนำไปแก้ในรอบถัดไป
    createdAt: Date.now(),
    assignedAt: null,
    startedAt: null,
    finishedAt: null,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    toolCalls: 0, // จำนวนครั้งที่ใช้เครื่องมือ (server tools) รวมทุกรอบ
    activeTool: null, // เครื่องมือที่กำลังใช้อยู่ตอนนี้ เช่น web_search (null = ไม่ได้ใช้)
    history: [{ t: Date.now(), type: "created", note: "สร้างงานโดยกัปตัน" }],
  };
  state.tasks.set(task.id, task);
  return task;
}

export function createJob(goal) {
  const job = {
    id: uid("job"),
    goal,
    status: "planning", // planning | running | synthesizing | done | failed
    createdAt: Date.now(),
    finishedAt: null,
    taskIds: [],
    result: "",
    costUsd: 0,
    durationMs: 0,
  };
  state.jobs.set(job.id, job);
  return job;
}

/** ตัวชี้วัดที่คำนวณสด ๆ จาก metrics ดิบ */
export function agentView(agent) {
  const m = agent.metrics;
  const uptime = Math.max(1, Date.now() - agent.createdAt);
  const busyNow =
    agent.status === "working" && agent.currentTaskId
      ? Math.max(0, Date.now() - (getTask(agent.currentTaskId)?.startedAt || Date.now()))
      : 0;
  const avgQuality = m.qualityScores.length
    ? Math.round(m.qualityScores.reduce((a, b) => a + b, 0) / m.qualityScores.length)
    : null;
  return {
    ...agent,
    currentTaskTitle:
      agent.currentLabel ||
      (agent.currentTaskId ? getTask(agent.currentTaskId)?.title || "" : ""),
    computed: {
      utilization: Math.min(1, (m.busyMs + busyNow) / uptime),
      avgDurationMs: m.tasksDone ? Math.round(m.totalDurationMs / m.tasksDone) : 0,
      successRate: m.tasksDone + m.tasksFailed ? m.tasksDone / (m.tasksDone + m.tasksFailed) : null,
      avgQuality,
    },
  };
}

export function snapshot() {
  const tasks = [...state.tasks.values()];
  const jobs = [...state.jobs.values()];
  const agents = [...state.agents.values()].map(agentView);
  const totals = {
    queued: tasks.filter((t) => t.status === "queued" || t.status === "assigned").length,
    running: tasks.filter((t) => t.status === "running").length,
    done: tasks.filter((t) => t.status === "done").length,
    failed: tasks.filter((t) => t.status === "failed").length,
    costUsd: agents.reduce((s, a) => s + a.metrics.costUsd, 0),
    toolCalls: agents.reduce((s, a) => s + (a.metrics.toolCalls || 0), 0),
    workersBusy: agents.filter((a) => a.role !== "captain" && a.status === "working").length,
    workersTotal: agents.filter((a) => a.role !== "captain").length,
    jobsDone: jobs.filter((j) => j.status === "done").length,
  };
  return {
    mode: state.mode,
    startedAt: state.startedAt,
    settings: state.settings,
    agents,
    tasks,
    jobs,
    totals,
    now: Date.now(),
  };
}
