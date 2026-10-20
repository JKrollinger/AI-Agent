#!/usr/bin/env node
// mcp-server.mjs — MCP server แบบ stdio ให้ผู้จัดการใหญ่ภายนอก (Hermes Agent, Claude Code, Claude Desktop ฯลฯ) สั่งงานศูนย์ควบคุมผ่าน REST
//   ไม่มี dependency: พูด JSON-RPC 2.0 คั่นด้วยบรรทัดใหม่ตาม MCP stdio transport (initialize → tools/list → tools/call)
//   ตั้งค่า: GROCK_URL (ค่าเริ่มต้น http://127.0.0.1:3789), GROCK_TOKEN (โทเคนใน API_TOKENS ของเซิร์ฟเวอร์ สิทธิ์ jobs ก็พอ)
//   รัน: npm run mcp  หรือ  node tools/mcp-server.mjs  — ลงทะเบียนกับ Hermes: docs/11-hermes.md
//   เครื่องมือ: list_projects, list_agents, create_job(goal, project?, plan?, requestedBy?, webhookUrl?, files?), job_status, job_result, wait_job(timeoutSec)
import readline from "node:readline";

const BASE = (process.env.GROCK_URL || "http://127.0.0.1:3789").replace(/\/+$/, "");
const TOKEN = process.env.GROCK_TOKEN || firstToken(process.env.API_TOKENS); // ถ้ารันในโฟลเดอร์ศูนย์ควบคุม (npm run mcp) ใช้โทเคนแรกใน .env ได้เลย
const POLL_MS = Math.max(250, Number(process.env.GROCK_WAIT_POLL_MS) || 2000);
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "ai-workforce-control-center", title: "AI Workforce Control Center", version: "0.1.0" };
const RESULT_CAP = 20_000; // ตัวอักษรสูงสุดของผลลัพธ์เต็มที่ส่งกลับใน job_result (ฉบับเต็มอยู่ใน result.md)

function firstToken(spec) {
  for (const raw of String(spec || "").split(",")) {
    const parts = raw.trim().split(":");
    if (parts.length >= 2 && parts[1].trim().length >= 16) return parts[1].trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
async function api(method, p, body) {
  let res;
  try {
    res = await fetch(`${BASE}${p}`, {
      method,
      headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError(0, `ติดต่อศูนย์ควบคุมที่ ${BASE} ไม่ได้: ${err?.cause?.message || err.message} (เซิร์ฟเวอร์เปิดอยู่ไหม? ตั้ง GROCK_URL ถ้าอยู่ที่อื่น)`);
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) throw new ApiError(res.status, `${data.error || `HTTP ${res.status}`}${res.status === 401 ? " — ตรวจ GROCK_TOKEN ให้ตรงกับ API_TOKENS ของเซิร์ฟเวอร์" : ""}`);
  return data;
}

// ---------------------------------------------------------------------------
// เครื่องมือ
// ---------------------------------------------------------------------------
const ROLE_DOC = "marketer=นักการตลาด, researcher=นักวิจัย, finance=การเงิน/กลยุทธ์/เรียบเรียงข้อเสนอ, engineer=วิศวกร AI, coder=นักพัฒนา, reviewer=QA";
const TOOLS = [
  {
    name: "list_projects",
    title: "รายชื่อโปรเจกต์",
    description: "รายชื่อโปรเจกต์ (Project Pack) ที่ลงทะเบียนกับศูนย์ควบคุม ใช้ id เป็นค่า project ตอน create_job เมื่อโจทย์เกี่ยวกับโค้ด/เอกสารของโปรเจกต์นั้น",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_agents",
    title: "รายชื่อทีม",
    description: `รายชื่อพนักงาน AI ในทีม พร้อมตำแหน่ง (role) หน้าที่ และสถานะ ใช้เลือก role/agentId ตอนเขียน plan ให้ create_job (${ROLE_DOC}) กัปตัน (captain) เป็นผู้มอบหมาย/QA/รวมผล ไม่ต้องใส่ในแผน`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "create_job",
    title: "สั่งโจทย์ให้ทีม",
    description:
      "ส่งโจทย์ให้ทีม AI ของศูนย์ควบคุม ตอบกลับทันทีพร้อม jobId (ทีมทำงานต่อเบื้องหลัง ใช้ wait_job หรือ job_status ติดตาม) " +
      "ถ้าไม่ส่ง plan กัปตันจะวางแผนเอง ถ้าส่ง plan (ไม่เกิน 12 งาน) ศูนย์ควบคุมจะใช้แผนนั้น แต่ยังเลือกคน/ตรวจ QA/รวมผลให้ " +
      "เมื่อเสร็จจะยิง webhook ไป JOB_WEBHOOK_URL ของเซิร์ฟเวอร์ (หรือ webhookUrl ที่ระบุ) ระวังค่าใช้จ่าย: โหมด live เรียก Claude จริงทุกงาน",
    inputSchema: {
      type: "object",
      required: ["goal"],
      additionalProperties: false,
      properties: {
        goal: { type: "string", description: "โจทย์งานภาษาไทยหรืออังกฤษ ไม่เกิน 2000 ตัวอักษร บอกผลลัพธ์ที่ต้องการให้ชัด" },
        project: { type: "string", description: "id ของโปรเจกต์จาก list_projects (ไม่ใส่ = โจทย์ทั่วไป ไม่เขียนไฟล์ผลงานลงโปรเจกต์)" },
        plan: {
          type: "array",
          maxItems: 12,
          description: `แผนงานจากคุณ (ผู้จัดการใหญ่): ลำดับงานย่อย แต่ละงานระบุ role หรือ agentId (${ROLE_DOC}) ไม่ต้องใส่งาน QA ปิดท้าย ระบบเติมให้`,
          items: {
            type: "object",
            required: ["title", "brief"],
            additionalProperties: false,
            properties: {
              title: { type: "string", description: "ชื่องานสั้น ๆ ไม่เกิน 70 ตัวอักษร" },
              brief: { type: "string", description: "สิ่งที่ต้องส่งมอบ/ขอบเขต (ไม่เกิน 4000 ตัวอักษร)" },
              role: { type: "string", enum: ["marketer", "researcher", "finance", "engineer", "coder", "reviewer"], description: "ตำแหน่งที่ทำ (ใช้แทน agentId ได้)" },
              agentId: { type: "string", description: "id พนักงานจาก list_agents (เช่น res-1) ถ้าอยากระบุคน" },
              dependsOn: { type: "array", items: { type: "integer", minimum: 0 }, description: "ดัชนี (เริ่ม 0) ของงานก่อนหน้าในแผนที่ต้องเสร็จก่อน" },
            },
          },
        },
        requestedBy: { type: "string", description: "ใครเป็นคนขอ (ข้อความอิสระ ไม่เกิน 120 ตัวอักษร) เช่น telegram:@somchai — จะแสดงบนแดชบอร์ดและส่งกลับใน webhook" },
        webhookUrl: { type: "string", description: "URL รับผลเฉพาะโจทย์นี้ (host ต้องอยู่ใน WEBHOOK_ALLOWED_HOSTS ของเซิร์ฟเวอร์) ไม่ใส่ = ใช้ JOB_WEBHOOK_URL" },
        files: { type: "array", items: { type: "string" }, maxItems: 10, description: "ไฟล์ในโปรเจกต์ (path สัมพัทธ์) ให้ทีมอ่านประกอบ (ใช้คู่กับ project)" },
      },
    },
  },
  {
    name: "job_status",
    title: "สถานะโจทย์",
    description: "สถานะปัจจุบันของโจทย์: planning | running | synthesizing | done | failed พร้อมความคืบหน้าของงานย่อย ต้นทุน และผลส่ง webhook",
    inputSchema: { type: "object", required: ["jobId"], additionalProperties: false, properties: { jobId: { type: "string" } } },
  },
  {
    name: "job_result",
    title: "ผลลัพธ์โจทย์",
    description: "ผลลัพธ์สุดท้ายของโจทย์ที่เสร็จแล้ว (สรุป + เนื้อหาเต็มไม่เกิน 20,000 ตัวอักษร + พาธไฟล์ result.md + คะแนน QA ของงานย่อย) ถ้ายังไม่เสร็จจะบอกสถานะ",
    inputSchema: { type: "object", required: ["jobId"], additionalProperties: false, properties: { jobId: { type: "string" } } },
  },
  {
    name: "wait_job",
    title: "รอโจทย์จนเสร็จ",
    description: "รอจนโจทย์เสร็จหรือล้มเหลว (ไม่เกิน timeoutSec ค่าเริ่มต้น 600 สูงสุด 3600) แล้วคืนผลเหมือน job_result ถ้าหมดเวลาคืนสถานะล่าสุด (timedOut=true) เรียกซ้ำได้",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      additionalProperties: false,
      properties: { jobId: { type: "string" }, timeoutSec: { type: "integer", minimum: 1, maximum: 3600, description: "เวลารอสูงสุด (วินาที)" } },
    },
  },
];

const summarize = (text, max = 1500) => {
  const paras = String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.split("\n").filter((l) => !/^\s*#{1,6}\s/.test(l)).join("\n").trim()).filter(Boolean);
  let out = "";
  for (const p of paras) { out = out ? `${out}\n\n${p}` : p; if (out.length >= 120) break; }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};
const jobView = (job, tasks = []) => ({
  jobId: job.id,
  status: job.status,
  goal: job.goal,
  project: job.project || null,
  requestedBy: job.requestedBy || "",
  planSource: job.planSource || "captain",
  outputDir: job.outputDir || null,
  resultPath: job.outputDir ? `${job.outputDir}/result.md` : null,
  costUsd: Number((job.costUsd || 0).toFixed(4)),
  durationSec: Math.round((job.durationMs || (job.finishedAt ? job.finishedAt - job.createdAt : Date.now() - job.createdAt)) / 1000),
  error: job.error || null,
  webhook: job.webhook || null,
  tasks: tasks.map((t) => ({ seq: t.seq, title: t.title, role: t.role, status: t.status, assignedTo: t.assignedTo, phase: t.phase, attempts: t.attempts, qaScore: t.review?.score ?? null, qaApproved: t.review?.approved ?? null })),
  progress: tasks.length ? `${tasks.filter((t) => t.status === "done").length}/${tasks.length} งานเสร็จ` : "กัปตันกำลังวางแผน",
});
const isTerminal = (s) => s === "done" || s === "failed";

const handlers = {
  async list_projects() {
    const { projects } = await api("GET", "/api/projects");
    return { projects: (projects || []).map((p) => ({ id: p.id, name: p.name, path: p.path, ok: p.ok !== false, error: p.error || null })) };
  },
  async list_agents() {
    const { agents, roles } = await api("GET", "/api/agents");
    return { roles, agents: (agents || []).map((a) => ({ id: a.id, name: a.name, nick: a.nick, role: a.role, roleLabel: a.roleLabel, duties: a.duties, status: a.status, model: a.model, canAssign: a.canAssign })) };
  },
  async create_job(args) {
    const body = { goal: args.goal };
    for (const k of ["project", "plan", "requestedBy", "webhookUrl", "files"]) if (args[k] !== undefined && args[k] !== null && args[k] !== "") body[k] = args[k];
    const { job } = await api("POST", "/api/jobs", body);
    return { ...jobView(job), message: `รับโจทย์แล้ว (jobId ${job.id}) ทีมกำลังทำงาน — ใช้ wait_job หรือ job_status ติดตาม${job.webhookUrl ? ` ผลจะถูกส่งไป ${job.webhookUrl}` : ""}` };
  },
  async job_status({ jobId }) {
    const { job, tasks } = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    return jobView(job, tasks);
  },
  async job_result({ jobId }) {
    const { job, tasks } = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    const view = jobView(job, tasks);
    if (!isTerminal(job.status)) return { ...view, message: `โจทย์ยังไม่เสร็จ (${job.status}: ${view.progress}) — ใช้ wait_job เพื่อรอ` };
    const full = String(job.result || "");
    return { ...view, summary: summarize(full) || (job.error ? `โจทย์ล้มเหลว: ${job.error}` : ""), result: full.length > RESULT_CAP ? `${full.slice(0, RESULT_CAP)}\n…[ตัดที่ ${RESULT_CAP} ตัวอักษร ฉบับเต็มอยู่ใน ${view.resultPath || "GET /api/jobs/:id"}]` : full };
  },
  async wait_job({ jobId, timeoutSec }) {
    const limit = Math.max(1, Math.min(3600, Number(timeoutSec) || 600)) * 1000;
    const t0 = Date.now();
    for (;;) {
      const { job, tasks } = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
      if (isTerminal(job.status)) return handlers.job_result({ jobId });
      if (Date.now() - t0 >= limit) return { ...jobView(job, tasks), timedOut: true, message: `รอครบ ${Math.round(limit / 1000)} วินาทีแล้วโจทย์ยังไม่เสร็จ (${job.status}: ${jobView(job, tasks).progress}) — เรียก wait_job อีกครั้งได้` };
      await new Promise((r) => setTimeout(r, Math.min(POLL_MS, limit - (Date.now() - t0))));
    }
  },
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio (newline-delimited)
// ---------------------------------------------------------------------------
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
const fail = (id, code, message, data) => write({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const toolText = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], structuredContent: obj });

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize":
        return reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            "ศูนย์ควบคุมพนักงาน AI (ทีม 7 ตำแหน่ง มีกัปตันมอบหมาย/QA/รวมผล) ขั้นตอนปกติ: list_projects/list_agents → create_job (ใส่ plan ถ้าอยากกำหนดงานเอง) → wait_job → job_result " +
            "ทุกโจทย์ในโหมด live มีค่าใช้จ่าย API และถูกจำกัดด้วยงบรายวันของโทเคน ถ้าได้ 429 ให้แจ้งผู้ใช้ ไม่ต้องลองซ้ำ",
        });
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/progress":
        return; // ไม่ต้องตอบ
      case "ping":
        return reply(id, {});
      case "tools/list":
        return reply(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name;
        const h = handlers[name];
        if (!h) return fail(id, -32602, `ไม่รู้จักเครื่องมือ "${name}"`);
        const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
        try {
          return reply(id, toolText(await h(args)));
        } catch (err) {
          const text = err instanceof ApiError ? `ผิดพลาด${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}` : `ผิดพลาด: ${err.message}`;
          return reply(id, { content: [{ type: "text", text }], isError: true });
        }
      }
      case "resources/list":
        return reply(id, { resources: [] });
      case "prompts/list":
        return reply(id, { prompts: [] });
      default:
        if (isNotification) return;
        return fail(id, -32601, `ไม่รองรับ method "${method}"`);
    }
  } catch (err) {
    if (!isNotification) fail(id, -32603, err.message || String(err));
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { return fail(null, -32700, "JSON ไม่ถูกต้อง"); }
  if (Array.isArray(msg)) { for (const m of msg) void handle(m); return; }
  if (!msg || typeof msg !== "object" || !msg.method) { if (msg?.id !== undefined && !("result" in msg) && !("error" in msg)) fail(msg.id, -32600, "คำขอไม่ถูกต้อง"); return; }
  void handle(msg);
});
rl.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
if (!TOKEN) process.stderr.write("⚠️ ไม่มี GROCK_TOKEN — ถ้าเซิร์ฟเวอร์ตั้ง API_TOKENS/AUTH_PASSWORD ไว้ ทุกคำขอจะได้ 401 (ตั้ง GROCK_TOKEN ใน env ของ MCP server)\n");
