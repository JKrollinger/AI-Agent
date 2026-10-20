// tokens.js — โทเคนสิทธิ์จำกัดสำหรับระบบภายนอก (เช่น Hermes Agent / บอท Telegram) + งบรายวันต่อโทเคน
//   .env  API_TOKENS=ชื่อ:โทเคน:สิทธิ์[,ชื่อ2:โทเคน2:สิทธิ์2]   เช่น  hermes:Xk9...32ตัว:jobs
//   ส่งเป็นหัว  Authorization: Bearer <โทเคน>  แทน Basic Auth — ตรวจสิทธิ์ตาม scope เสมอ แม้คำขอมาจาก localhost
//   สิทธิ์ jobs  = POST /api/jobs, GET /api/jobs*, GET /api/state, GET /api/projects, GET /api/projects/:id/context, GET /api/agents, GET /api/health
//   สิทธิ์ admin = ทำได้ทุกอย่างเท่ากับรหัสผ่าน (AUTH_PASSWORD)
//   งบรายวัน TOKEN_DAILY_USD (ค่าเริ่มต้น 5, 0 = ไม่จำกัด) — ยอดที่ใช้ไปต่อโทเคนต่อวันเก็บใน data/token-usage.json
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "./projects.js";
import { state, getTask } from "./state.js";

export const SCOPES = ["jobs", "admin"];
export const TOKEN_DAILY_USD = Math.max(0, Number(process.env.TOKEN_DAILY_USD ?? 5) || 0); // 0 = ไม่จำกัด
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const MIN_TOKEN_LENGTH = 16;
const USAGE_FILE = () => path.join(DATA_DIR, "token-usage.json");
const KEEP_DAYS = 60;

const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

/**
 * แปลง API_TOKENS → Map(โทเคน → { name, scope })
 * รายการที่ผิดรูปจะถูกข้ามและรายงานใน warnings (ไม่ทำให้เซิร์ฟเวอร์ล้ม แต่โทเคนนั้นใช้ไม่ได้)
 */
export function parseTokens(spec = process.env.API_TOKENS || "") {
  const tokens = new Map();
  const warnings = [];
  const names = new Set();
  for (const raw of String(spec || "").split(",")) {
    const s = raw.trim();
    if (!s) continue;
    const parts = s.split(":").map((x) => x.trim());
    const [name, token, scope = "jobs"] = parts;
    const label = name ? `"${name}"` : `"${s.slice(0, 8)}…"`;
    if (parts.length < 2 || parts.length > 3) { warnings.push(`API_TOKENS รายการ ${label} ต้องเป็น ชื่อ:โทเคน[:สิทธิ์]`); continue; }
    if (!NAME_RE.test(name)) { warnings.push(`API_TOKENS ชื่อ ${label} ต้องเป็น a-z 0-9 - _ ไม่เกิน 32 ตัว`); continue; }
    if (names.has(name.toLowerCase())) { warnings.push(`API_TOKENS ชื่อ ${label} ซ้ำ`); continue; }
    if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) { warnings.push(`API_TOKENS โทเคนของ ${label} ต้องยาวอย่างน้อย ${MIN_TOKEN_LENGTH} ตัวอักษรและไม่มีช่องว่าง`); continue; }
    if (!SCOPES.includes(scope)) { warnings.push(`API_TOKENS สิทธิ์ "${scope}" ของ ${label} ไม่ถูกต้อง (ใช้ได้: ${SCOPES.join(", ")})`); continue; }
    if (tokens.has(token)) { warnings.push(`API_TOKENS โทเคนของ ${label} ซ้ำกับรายการก่อนหน้า`); continue; }
    names.add(name.toLowerCase());
    tokens.set(token, { name, scope });
  }
  return { tokens, warnings };
}

/** หา { name, scope } ของโทเคนที่ส่งมา (เทียบแบบ timing-safe ทุกรายการ) หรือ null */
export function lookupToken(tokens, presented) {
  const p = String(presented || "");
  let found = null;
  for (const [token, info] of tokens) if (safeEq(token, p)) found = info; // ไม่ break เพื่อให้เวลาเทียบคงที่
  return found;
}

/** scope นี้เรียก method+path นี้ได้ไหม (ใช้กับทุกคำขอของโทเคน ไม่ว่ามาจากที่ใด) */
export function scopeAllows(scope, method, pathname) {
  if (scope === "admin") return true;
  if (scope !== "jobs") return false;
  const p = String(pathname || "");
  if (method === "POST") return p === "/api/jobs";
  if (method !== "GET") return false;
  return (
    p === "/api/jobs" || p.startsWith("/api/jobs/") ||
    p === "/api/state" || p === "/api/health" || p === "/api/agents" ||
    p === "/api/projects" || /^\/api\/projects\/[^/]+\/context$/.test(p)
  );
}

// ---------------------------------------------------------------------------
// งบรายวันต่อโทเคน — data/token-usage.json: { "2026-10-20": { "hermes": { usd, jobs, updatedAt } } }
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, "0");
/** วันที่ตามเวลาเครื่อง (ผู้ใช้คิดงบ "รายวัน" ตามเวลาท้องถิ่น) */
export const dayKey = (ts = Date.now()) => { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

let usageCache = null;
function loadUsage() {
  if (usageCache) return usageCache;
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_FILE(), "utf8"));
    usageCache = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    usageCache = {};
  }
  return usageCache;
}
function saveUsage() {
  const data = loadUsage();
  const cutoff = dayKey(Date.now() - KEEP_DAYS * 86_400_000);
  for (const k of Object.keys(data)) if (k < cutoff) delete data[k];
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = USAGE_FILE();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}
/** ล้างแคชในหน่วยความจำ (ใช้ในเทสต์) */
export function resetUsageCache() { usageCache = null; }

/** ยอดที่บันทึกแล้วของโทเคนในวันนี้ (USD) */
export function recordedToday(name, day = dayKey()) {
  return Number(loadUsage()[day]?.[name]?.usd) || 0;
}

/** บวกต้นทุนเข้ายอดวันนี้ของโทเคน (เรียกจาก attachTokenMeter เมื่อโจทย์จบ/อัปเดตต้นทุน) */
export function addTokenCost(name, usd, { jobs = 0, day = dayKey() } = {}) {
  const data = loadUsage();
  const d = (data[day] ||= {});
  const row = (d[name] ||= { usd: 0, jobs: 0, updatedAt: null });
  row.usd = Math.max(0, row.usd + (Number(usd) || 0));
  row.jobs += jobs;
  row.updatedAt = new Date().toISOString();
  try { saveUsage(); } catch (err) { console.warn(`[tokens] บันทึก token-usage.json ไม่สำเร็จ: ${err.message}`); }
  return row;
}

/** ต้นทุนของโจทย์หนึ่ง ณ ตอนนี้ (แผน + งานย่อยทุกชิ้น) */
export const jobSpent = (job) => (job?.planCostUsd || 0) + (job?.taskIds || []).map(getTask).filter(Boolean).reduce((s, t) => s + (t.usage?.costUsd || 0), 0);

/** ยอดของโจทย์ที่ยังวิ่งอยู่ของโทเคนนี้ (ยังไม่ถูกบันทึกลงไฟล์) */
export function liveSpend(name) {
  let sum = 0;
  for (const job of state.jobs.values()) {
    if (job.source !== name || !["planning", "running", "synthesizing"].includes(job.status)) continue;
    sum += Math.max(0, jobSpent(job) - (recordedOf.get(job.id) || 0));
  }
  return sum;
}

/** ตรวจงบรายวัน: { ok, used, limit } — used = ที่บันทึกแล้ววันนี้ + โจทย์ที่กำลังวิ่ง */
export function dailyBudget(name, limit = TOKEN_DAILY_USD) {
  const used = recordedToday(name) + liveSpend(name);
  return { ok: !(limit > 0) || used < limit, used, limit };
}

// ต้นทุนของแต่ละโจทย์ที่บันทึกลงไฟล์ไปแล้ว (กันนับซ้ำเมื่อ job.failed แล้วมี job.updated ตามมาพร้อมต้นทุนใหม่)
const recordedOf = new Map(); // jobId -> usd ที่บันทึกแล้ว
const countedJobs = new Set(); // jobId ที่นับเป็น 1 โจทย์แล้ว
/** สมัครรับเหตุการณ์โจทย์ → สะสมต้นทุนเข้างบรายวันของโทเคนที่สั่งงาน (เฉพาะโจทย์ที่ job.sourceKind === "token") */
export function attachTokenMeter(bus) {
  const handler = (ev) => {
    if (!["job.completed", "job.failed", "job.updated"].includes(ev.type)) return;
    const job = ev.data?.job;
    if (!job || job.sourceKind !== "token" || !job.source) return;
    const total = Math.max(Number(job.costUsd) || 0, jobSpent(job));
    const prev = recordedOf.get(job.id) || 0;
    const delta = Math.max(0, total - prev);
    const countJob = ev.type !== "job.updated" && !countedJobs.has(job.id);
    if (delta <= 0 && !countJob) return;
    recordedOf.set(job.id, Math.max(prev, total));
    if (countJob) countedJobs.add(job.id);
    addTokenCost(job.source, delta, { jobs: countJob ? 1 : 0 });
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
