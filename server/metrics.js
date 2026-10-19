// metrics.js — บันทึกตัวชี้วัดการทำงานของพนักงาน AI แต่ละคน
// ตัวชี้วัดหลัก: งานเสร็จ/ล้มเหลว, เวลาเฉลี่ยต่องาน, อัตราใช้งาน (utilization),
// โทเคน/ต้นทุน, จำนวนครั้งที่ส่งต่องาน, จำนวนครั้งที่ใช้เครื่องมือ (server tools) และคะแนนคุณภาพจาก QA
import { estimateCost, priceFor } from "./agents.js";

const warnedModels = new Set();

/**
 * บันทึก usage ของการเรียก API 1 ครั้ง
 * @param {string} [model] โมเดลที่ตอบจริง (อาจต่างจาก agent.model เมื่อโปรเจกต์ override หรือ server-side fallback เปลี่ยนโมเดล) → คิดราคาตามนั้น
 */
export function recordUsage(agent, task, usage = {}, model = agent.model) {
  const cacheRead = usage.cache_read_input_tokens || 0;
  const inTok = (usage.input_tokens || 0) + cacheRead + (usage.cache_creation_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  const used = model || agent.model;
  if (!priceFor(used) && !warnedModels.has(used)) { // โมเดลที่ API ตอบกลับไม่อยู่ในตารางราคา → คิดตามโมเดลที่ตั้งใจเรียก และเตือนครั้งเดียว
    warnedModels.add(used);
    console.warn(`[metrics] ไม่รู้ราคาของโมเดล "${used}" → คิดตามราคาของ "${agent.model}" (เพิ่มใน PRICING ของ server/agents.js)`);
  }
  const cost = estimateCost(used, usage, agent.model); // รวมค่า web search ต่อครั้งแล้ว (ถ้ามี usage.server_tool_use)
  agent.metrics.inputTokens += inTok;
  agent.metrics.outputTokens += outTok;
  agent.metrics.cacheReadTokens = (agent.metrics.cacheReadTokens || 0) + cacheRead;
  agent.metrics.costUsd += cost;
  if (task) {
    task.usage.inputTokens += inTok;
    task.usage.outputTokens += outTok;
    task.usage.cacheReadTokens = (task.usage.cacheReadTokens || 0) + cacheRead;
    task.usage.costUsd += cost;
  }
  return cost;
}

/** นับการใช้เครื่องมือ (server tool) — เรียกทุกครั้งที่โมเดลเริ่มเรียกเครื่องมือ 1 ครั้ง */
export function recordToolUse(agent, task, n = 1) {
  agent.metrics.toolCalls = (agent.metrics.toolCalls || 0) + n;
  if (task) task.toolCalls = (task.toolCalls || 0) + n;
}

export function recordDone(agent, task) {
  const dur = Math.max(0, (task.finishedAt || Date.now()) - (task.startedAt || Date.now()));
  agent.metrics.tasksDone += 1;
  agent.metrics.busyMs += dur;
  agent.metrics.totalDurationMs += dur;
}

export function recordFailed(agent, task) {
  const dur = Math.max(0, Date.now() - (task.startedAt || Date.now()));
  agent.metrics.tasksFailed += 1;
  agent.metrics.busyMs += dur;
}

/** งานถูกยกเลิก/ดึงคืนกลางคัน — นับเวลาที่ใช้ไปเป็น busy แต่ไม่นับเป็นงานเสร็จ */
export function recordInterrupted(agent, task) {
  const dur = Math.max(0, Date.now() - (task.startedAt || Date.now()));
  agent.metrics.busyMs += dur;
}

export function recordHandoff(fromAgent, toAgent) {
  if (fromAgent) fromAgent.metrics.handoffsOut += 1;
  if (toAgent) toAgent.metrics.handoffsIn += 1;
}

export function recordQuality(agent, score) {
  if (typeof score === "number" && !Number.isNaN(score)) {
    agent.metrics.qualityScores.push(Math.max(0, Math.min(100, score)));
  }
}

export const fmtDuration = (ms) => {
  if (!ms || ms < 1000) return `${Math.round(ms || 0)} มิลลิวินาที`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} วินาที`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} นาที ${s} วินาที`;
};
