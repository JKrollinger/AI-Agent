// index.js — HTTP server: หน้าเว็บ dashboard + REST API + SSE (เหตุการณ์เรียลไทม์)
// ไม่ใช้ framework ภายนอก (Node >= 22) เพื่อให้อ่าน/ดัดแปลงง่าย
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bus } from "./bus.js";
import { state, snapshot } from "./state.js";
import * as orch from "./orchestrator.js";
import { liveAvailable, countTokens } from "./llm.js";
import { listProjects, registerProject, loadPack, buildProjectContext, reloadPacks, attachWriter, displayNameFor } from "./projects.js";
import { WORKER_MODEL } from "./agents.js";
import { codeMode, codeLive, validateExternalPlan } from "./executor.js";
import { parseTokens, lookupToken, scopeAllows, dailyBudget, attachTokenMeter, TOKEN_DAILY_USD } from "./tokens.js";
import { attachWebhook, checkWebhookUrl, JOB_WEBHOOK_URL, WEBHOOK_SECRET, WEBHOOK_ALLOWED_HOSTS } from "./webhook.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const PORT = Number(process.env.PORT || 3789);
const HOST = process.env.HOST || "127.0.0.1";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// ---------- เปิดใช้งานจากอินเทอร์เน็ต (ผ่าน Cloudflare Tunnel ฯลฯ) — ดู docs/10-deploy-tunnel.md ----------
// ALLOWED_HOSTS = โดเมนที่ยอมให้เรียกเข้ามา (คั่นด้วย ,) ขึ้นต้นด้วย . = ทุกโดเมนย่อย เช่น ".trycloudflare.com,ai.example.com"
// AUTH_PASSWORD (+ AUTH_USER ค่าเริ่มต้น admin) = รหัสผ่านเข้าใช้ทั้งหน้าเว็บและ API (HTTP Basic Auth) — ต้องตั้งเสมอเมื่อเปิดสาธารณะ
const ALLOWED_HOSTS = String(process.env.ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
const AUTH_USER = process.env.AUTH_USER || "admin";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
const JOB_RATE_LIMIT = Math.max(1, Number(process.env.JOB_RATE_LIMIT || 20)); // โจทย์ใหม่สูงสุดต่อ 10 นาที จากภายนอก
const hostOf = (req) => String(req.headers.host || "").replace(/:\d+$/, "").toLowerCase();
/** คำขอมาจากภายนอกเครื่อง (ผ่าน tunnel/proxy จะมีหัว cf-connecting-ip / x-forwarded-for หรือ Host ไม่ใช่ localhost) */
const isRemote = (req) => !!(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]) || !LOOPBACK.has(hostOf(req));
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
// โทเคนสิทธิ์จำกัดสำหรับระบบภายนอก (Hermes Agent ฯลฯ): API_TOKENS=ชื่อ:โทเคน:สิทธิ์ ส่งเป็น Authorization: Bearer — ดู server/tokens.js, docs/11-hermes.md
const { tokens: API_TOKENS, warnings: TOKEN_WARNINGS } = parseTokens();
function basicOk(h) {
  if (!h.startsWith("Basic ")) return false;
  let dec = "";
  try { dec = Buffer.from(h.slice(6).trim(), "base64").toString("utf8"); } catch { return false; }
  const i = dec.indexOf(":");
  return i > 0 && safeEq(dec.slice(0, i), AUTH_USER) && safeEq(dec.slice(i + 1), AUTH_PASSWORD);
}
/**
 * ตัวตนของผู้เรียก: { kind: "token"|"basic"|"local", name, scope } หรือ { status: 401, error, bearer }
 *   Bearer <โทเคน> → ต้องอยู่ใน API_TOKENS (ตรวจทุกครั้ง แม้มาจาก localhost) และถูกจำกัดสิทธิ์ตาม scope
 *   ไม่มีโทเคน → HTTP Basic Auth เมื่อตั้ง AUTH_PASSWORD (ใช้กับทุก path: หน้าเว็บ, API, SSE, ไฟล์ 3 มิติ) ไม่ตั้ง = เปิดใช้ในเครื่อง
 */
function authenticate(req) {
  const h = String(req.headers.authorization || "");
  if (/^Bearer\s/i.test(h)) {
    const info = lookupToken(API_TOKENS, h.slice(7).trim());
    if (!info) return { status: 401, bearer: true, error: API_TOKENS.size ? "โทเคนไม่ถูกต้อง" : "เซิร์ฟเวอร์ยังไม่ได้ตั้ง API_TOKENS ใน .env (รูปแบบ ชื่อ:โทเคน:สิทธิ์)" };
    return { kind: "token", name: info.name, scope: info.scope };
  }
  if (!AUTH_PASSWORD) return { kind: "local", name: "local", scope: "admin" };
  if (basicOk(h)) return { kind: "basic", name: AUTH_USER, scope: "admin" };
  return { status: 401, bearer: false, error: "ต้องใส่ชื่อผู้ใช้และรหัสผ่าน (ตั้งใน .env: AUTH_USER / AUTH_PASSWORD) หรือส่ง Authorization: Bearer <โทเคนใน API_TOKENS>" };
}
/** ชื่อแหล่งที่สั่งงานสำหรับบันทึกใน job.source */
const sourceOf = (auth) => (auth.kind === "token" ? auth.name : auth.kind === "basic" ? `web:${auth.name}` : "local");
const cleanText = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const SEC_HEADERS = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "SAMEORIGIN", "Referrer-Policy": "same-origin" };
const jobHits = []; // timestamps ของการส่งโจทย์จากภายนอก (rate limit แบบง่าย)
function jobRateOk() { const now = Date.now(); while (jobHits.length && now - jobHits[0] > 600_000) jobHits.shift(); if (jobHits.length >= JOB_RATE_LIMIT) return false; jobHits.push(now); return true; }
// กัน DNS-rebinding/CSRF: รับเฉพาะ Host ที่เป็น localhost หรืออยู่ใน ALLOWED_HOSTS และ POST ต้องเป็น JSON
function requestAllowed(req) {
  if (LOOPBACK.has(HOST)) { // ทุก method (GET ก็อ่านไฟล์โปรเจกต์ได้ จึงต้องกัน DNS rebinding ด้วย)
    const host = hostOf(req);
    const ok = LOOPBACK.has(host) || ALLOWED_HOSTS.some((h) => (h.startsWith(".") ? host.endsWith(h) || host === h.slice(1) : host === h));
    if (!ok) return { status: 403, error: `Host "${host}" ไม่ได้รับอนุญาต — เพิ่มใน ALLOWED_HOSTS ใน .env แล้วรีสตาร์ต` };
  }
  if (req.method !== "POST") return null;
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (!ct.startsWith("application/json")) return { status: 415, error: "ต้องส่ง Content-Type: application/json" };
  return null;
}

// เลือกโหมดเริ่มต้น: MODE=live|sim|auto (auto = live ถ้ามี key, ไม่งั้น sim)
const MODE = (process.env.MODE || "auto").toLowerCase();
state.mode = MODE === "live" ? "live" : MODE === "sim" ? "sim" : liveAvailable() ? "live" : "sim";

const DEMO_GOALS = [
  "วางแผนนำ AI มาใช้ในฝ่ายบริการลูกค้าขององค์กรภายใน 90 วัน พร้อมตัวชี้วัดความสำเร็จ",
  "ออกแบบระบบ dashboard ติดตามยอดขายรายวันสำหรับร้านค้าออนไลน์ พร้อมต้นแบบโค้ด",
  "จัดทำข้อเสนอโครงการลดต้นทุนพลังงานในโรงงานขนาดกลาง",
  "สร้างแผนการตลาดเปิดตัวแอปสั่งอาหารสำหรับพนักงานออฟฟิศในกรุงเทพฯ",
  "เขียนสคริปต์อัตโนมัติสรุปอีเมลลูกค้าประจำวันและจัดลำดับความเร่งด่วน",
];
let demoIndex = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg", // office3d character textures
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new orch.HttpError(413, "body ใหญ่เกินไป"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new orch.HttpError(400, "JSON ไม่ถูกต้อง"));
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "ไม่พบไฟล์" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache", ...SEC_HEADERS });
    res.end(data);
  });
}

// ---------- SSE ----------
const sseClients = new Set();
function handleSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event) => res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  // ส่ง snapshot ทั้งระบบก่อน แล้วตามด้วย log ย้อนหลัง
  send({ id: 0, ts: Date.now(), type: "snapshot", data: snapshot() });
  send({ id: 0, ts: Date.now(), type: "log.history", data: { events: bus.recent(400).filter((e) => e.type === "log") } });
  const listener = (event) => send(event);
  bus.on("event", listener);
  sseClients.add(res);
  const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    bus.off("event", listener);
    sseClients.delete(res);
  });
}

// ---------- Router ----------
async function handleApi(req, res, url, auth) {
  const { pathname } = url;
  const m = req.method;
  const seg = pathname.split("/").filter(Boolean); // ["api", ...]

  if (m === "GET" && pathname === "/api/state") return sendJson(res, 200, snapshot());
  if (m === "GET" && pathname === "/api/events") return handleSse(req, res);
  if (m === "GET" && pathname === "/api/logs") {
    const limit = Number(url.searchParams.get("limit") || 200);
    return sendJson(res, 200, { events: bus.recent(limit).filter((e) => e.type === "log") });
  }
  if (m === "GET" && pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, mode: state.mode, liveAvailable: liveAvailable(), codeMode: codeMode(), codeLive: codeLive(), clients: sseClients.size, uptimeMs: Date.now() - state.startedAt });
  }

  const remote = isRemote(req);
  if (remote && (m === "POST") && (pathname === "/api/projects" || pathname === "/api/projects/reload")) {
    throw new orch.HttpError(403, "การลงทะเบียน/โหลดโปรเจกต์ใหม่ทำได้เฉพาะจากเครื่องที่รันเซิร์ฟเวอร์ (localhost) เท่านั้น");
  }
  const external = remote || auth.kind === "token"; // โทเคนจากระบบภายนอกนับเป็นภายนอกเสมอ แม้เรียกจาก localhost
  if (external && m === "POST" && (pathname === "/api/jobs" || pathname === "/api/demo") && !jobRateOk()) {
    throw new orch.HttpError(429, `ส่งโจทย์จากภายนอกได้ไม่เกิน ${JOB_RATE_LIMIT} โจทย์ต่อ 10 นาที (ปรับที่ JOB_RATE_LIMIT ใน .env)`);
  }
  if (m === "POST" && pathname === "/api/jobs") {
    const body = await readBody(req);
    const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f === "string" && f.trim() && f.length <= 260).slice(0, 10) : [];
    const projectId = typeof body.project === "string" && body.project.trim() ? body.project.trim() : null;
    const requestedBy = cleanText(body.requestedBy, 120);
    let plan = null;
    if (body.plan !== undefined && body.plan !== null) { // แผนจากผู้จัดการใหญ่ภายนอก (เช่น Hermes) — ตรวจก่อนรับ
      try { plan = validateExternalPlan(body.plan); } catch (err) { throw new orch.HttpError(400, err.message); }
    }
    let webhookUrl = null;
    if (body.webhookUrl !== undefined && body.webhookUrl !== null && body.webhookUrl !== "") {
      const v = checkWebhookUrl(body.webhookUrl);
      if (v.error) throw new orch.HttpError(400, v.error);
      webhookUrl = v.url;
    }
    if (auth.kind === "token") { // งบรายวันต่อโทเคน (TOKEN_DAILY_USD) — ยอดที่บันทึกแล้ววันนี้ + โจทย์ที่กำลังวิ่งของโทเคนนี้
      const b = dailyBudget(auth.name);
      if (!b.ok) throw new orch.HttpError(429, `โทเคน "${auth.name}" ใช้งบรายวันครบแล้ว (ใช้ไป $${b.used.toFixed(4)} จากงบ $${b.limit.toFixed(2)} ต่อวัน) — รอวันถัดไป หรือเพิ่ม TOKEN_DAILY_USD ใน .env แล้วรีสตาร์ต`);
    }
    const job = orch.submitJob(body.goal, { projectId, files, plan, requestedBy, webhookUrl, source: sourceOf(auth), sourceKind: auth.kind });
    return sendJson(res, 202, { job }); // 202 = รับแล้ว กัปตันกำลังวางแผน (ติดตามทาง SSE หรือ GET /api/jobs/:id)
  }
  if (m === "POST" && pathname === "/api/demo") {
    const body = await readBody(req);
    const goal = DEMO_GOALS[demoIndex++ % DEMO_GOALS.length];
    const projectId = typeof body.project === "string" && body.project.trim() ? body.project.trim() : null;
    const job = orch.submitJob(goal, { projectId, source: sourceOf(auth), sourceKind: auth.kind });
    return sendJson(res, 202, { job });
  }
  if (m === "GET" && pathname === "/api/jobs") { // รายการโจทย์ (ล่าสุดก่อน) สำหรับระบบภายนอก — ไม่รวมผลลัพธ์เต็ม (ดู GET /api/jobs/:id)
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
    const status = url.searchParams.get("status");
    const jobs = [...state.jobs.values()].filter((j) => !status || j.status === status).sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
      .map(({ result, plan, ...j }) => ({ ...j, taskCount: j.taskIds.length, resultChars: (result || "").length }));
    return sendJson(res, 200, { jobs });
  }
  if (m === "GET" && seg[1] === "jobs" && seg[2]) {
    return sendJson(res, 200, orch.getJobDetail(decodeURIComponent(seg[2])));
  }
  if (m === "GET" && pathname === "/api/agents") { // รายชื่อทีม + ตำแหน่ง + หน้าที่ (ให้ผู้จัดการใหญ่ภายนอกเลือก agentId/role ตอนวางแผน)
    const agents = [...state.agents.values()].map((a) => ({ id: a.id, name: a.name, nick: a.nick, role: a.role, roleLabel: a.roleLabel, emoji: a.emoji, duties: a.duties, model: a.model, tools: a.tools, status: a.status, canAssign: a.role !== "captain" }));
    return sendJson(res, 200, { agents, roles: [...new Set(agents.filter((a) => a.canAssign).map((a) => a.role))] });
  }
  if (m === "GET" && pathname === "/api/projects") return sendJson(res, 200, { projects: listProjects() });
  if (m === "POST" && pathname === "/api/projects") {
    const body = await readBody(req);
    let entry;
    try {
      entry = registerProject(body.id, body.path, { name: body.name });
    } catch (err) {
      throw new orch.HttpError(400, err.message);
    }
    bus.publish("projects.updated", { projects: listProjects() });
    bus.log(`📁 ลงทะเบียนโปรเจกต์ "${entry.name || entry.id}" (${entry.path})`);
    return sendJson(res, 201, { project: entry, projects: listProjects() });
  }
  if (m === "POST" && pathname === "/api/projects/reload") {
    reloadPacks();
    bus.publish("projects.updated", { projects: listProjects() });
    return sendJson(res, 200, { ok: true, projects: listProjects() });
  }
  if (m === "GET" && seg[1] === "projects" && seg[2] && seg[3] === "context") {
    const id = decodeURIComponent(seg[2]);
    const role = url.searchParams.get("role") || "captain";
    let pack;
    try {
      pack = loadPack(id, { force: url.searchParams.get("fresh") === "1" });
    } catch (err) {
      throw new orch.HttpError(err.status || 400, err.message);
    }
    const ctx = buildProjectContext(pack, { role });
    const out = {
      id: pack.id, name: pack.name, root: pack.rootPosix, role,
      systemChars: ctx.systemChars, dataChars: ctx.dataChars, chars: ctx.chars, estTokens: Math.ceil(ctx.chars / 3),
      files: ctx.files, docsIndex: pack.docsIndex.length, tree: pack.tree.length, warnings: pack.warnings, config: pack.config,
      system: ctx.system, data: ctx.data, inputTokens: null,
    };
    if (url.searchParams.get("tokens") === "1" && liveAvailable()) {
      try {
        out.inputTokens = await countTokens({ model: WORKER_MODEL, system: [{ type: "text", text: ctx.system }], messages: [{ role: "user", content: ctx.data }] });
      } catch (err) {
        out.tokensError = err.message;
      }
    }
    return sendJson(res, 200, out);
  }
  if (m === "GET" && seg[1] === "tasks" && seg[2] && seg[3] === "patch") {
    // เนื้อหา patch ฉบับเต็มของงานแก้ไฟล์จริง (อ่านจาก .grock/out ของโปรเจกต์ — localhost เท่านั้นเหมือน API อื่น)
    return sendJson(res, 200, orch.getTaskPatch(decodeURIComponent(seg[2])));
  }
  if (m === "POST" && seg[1] === "tasks" && seg[2] && seg[3]) {
    const body = await readBody(req);
    const id = decodeURIComponent(seg[2]);
    if (seg[3] === "handoff") return sendJson(res, 200, { task: orch.handoff(id, body.agentId, body.reason) });
    if (seg[3] === "retry") return sendJson(res, 200, { task: orch.retryTask(id) });
    if (seg[3] === "cancel") return sendJson(res, 200, { task: orch.cancelTask(id) });
    // ด่านอนุมัติ patch (Developer แก้ไฟล์จริง): apply = git apply --check → git apply ในโปรเจกต์, reject = ไม่แตะไฟล์
    if (seg[3] === "apply") return sendJson(res, 200, { task: orch.applyPatch(id, { note: body.note }) });
    if (seg[3] === "reject") return sendJson(res, 200, { task: orch.rejectPatch(id, { reason: body.reason }) });
  }
  if (m === "POST" && seg[1] === "agents" && seg[2] && seg[3]) {
    const id = decodeURIComponent(seg[2]);
    if (seg[3] === "pause") return sendJson(res, 200, { agent: orch.pauseAgent(id) });
    if (seg[3] === "resume") return sendJson(res, 200, { agent: orch.resumeAgent(id) });
    if (seg[3] === "config") {
      const body = await readBody(req);
      return sendJson(res, 200, { agent: orch.configureAgent(id, body) });
    }
  }
  if (m === "POST" && pathname === "/api/settings") {
    const body = await readBody(req);
    return sendJson(res, 200, { settings: orch.updateSettings(body) });
  }
  if (m === "POST" && pathname === "/api/mode") {
    const body = await readBody(req);
    return sendJson(res, 200, { mode: orch.setMode(body.mode) });
  }
  return sendJson(res, 404, { error: "ไม่พบ endpoint" });
}

// เขียนผลงานกลับเข้าโปรเจกต์ (เมื่อโจทย์ผูกกับ Project Pack) — ทำงานทั้งโหมด sim และ live
attachWriter(bus, { agentNameOf: (id, pack) => displayNameFor(state.agents.get(id), pack) || "" }); // ไฟล์ใน .grock/out ใช้ชื่อเฉพาะโปรเจกต์ (project.json roles/agents .name)
attachTokenMeter(bus); // ต้นทุนของโจทย์ที่สั่งผ่านโทเคน → งบรายวัน (data/token-usage.json)
attachWebhook(bus); // โจทย์เสร็จ/ล้มเหลว → POST สรุปไปยัง JOB_WEBHOOK_URL หรือ webhookUrl ของโจทย์ (หลัง attachWriter เพื่อให้ result.md ถูกเขียนก่อน)

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    const auth = authenticate(req); // ตัวตนก่อนทุกอย่าง (รวมไฟล์หน้าเว็บ): Bearer token ตาม API_TOKENS หรือ Basic Auth เมื่อตั้ง AUTH_PASSWORD
    if (auth.status) {
      if (auth.bearer) return sendJson(res, 401, { error: auth.error });
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="AI Workforce Control Center", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS });
      return res.end(auth.error);
    }
    if (auth.kind === "token" && !scopeAllows(auth.scope, req.method, url.pathname)) { // สิทธิ์ของโทเคนบังคับทุกคำขอ ไม่ว่ามาจากที่ใด
      return sendJson(res, 403, { error: `โทเคน "${auth.name}" (สิทธิ์ ${auth.scope}) ไม่มีสิทธิ์เรียก ${req.method} ${url.pathname}` });
    }
    if (url.pathname.startsWith("/api/")) {
      const denied = requestAllowed(req);
      if (denied) return sendJson(res, denied.status, { error: denied.error });
      return await handleApi(req, res, url, auth);
    }
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof orch.HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    return sendJson(res, status, { error: err.message || "เกิดข้อผิดพลาด" });
  }
});

// ตัวจัดคิวเดินทุก 500ms กันกรณีมีงานค้าง + ส่งตัวชี้วัดสดทุก 2 วินาที
setInterval(() => orch.tick(), 500);
setInterval(() => {
  if (!sseClients.size) return;
  const snap = snapshot();
  bus.publish("metrics.updated", {
    totals: snap.totals,
    agents: snap.agents.map((a) => ({ id: a.id, status: a.status, metrics: a.metrics, computed: a.computed })),
  });
}, 2000);

server.listen(PORT, HOST, () => {
  const modeLabel = state.mode === "live" ? "LIVE (เรียก Claude จริง)" : "SIM (จำลอง — ตั้ง ANTHROPIC_API_KEY ใน .env เพื่อใช้โมเดลจริง)";
  console.log(`\n🧭 AI Workforce Control Center`);
  console.log(`   เปิดหน้าควบคุม: http://${HOST}:${PORT}`);
  console.log(`   โหมด: ${modeLabel}`);
  if (codeMode() === "live" && state.mode !== "live") console.log(`   🧑‍💻 CODE_MODE=live: Developer ที่มีสิทธิ์แก้ไฟล์จะเรียก Claude Code จริง (บัญชีที่ล็อกอินไว้ใน claude) แม้ระบบอยู่โหมด SIM`);
  else if (codeMode() === "sim" && state.mode === "live") console.log(`   🧑‍💻 CODE_MODE=sim: Developer ไม่เรียก Claude Code (ได้ patch จำลอง) แม้ระบบอยู่โหมด LIVE`);
  if (AUTH_PASSWORD) console.log(`   🔒 ต้องใส่รหัสผ่าน (ผู้ใช้ "${AUTH_USER}")${ALLOWED_HOSTS.length ? ` · เปิดรับโดเมน: ${ALLOWED_HOSTS.join(", ")}` : ""}`);
  else if (ALLOWED_HOSTS.length) console.log(`   ⚠️ เปิดรับโดเมน ${ALLOWED_HOSTS.join(", ")} โดยไม่มีรหัสผ่าน — ตั้ง AUTH_PASSWORD ใน .env ก่อนเปิดสาธารณะ`);
  if (API_TOKENS.size) console.log(`   🎫 โทเคน API: ${[...API_TOKENS.values()].map((t) => `${t.name} (${t.scope})`).join(", ")} · งบรายวัน ${TOKEN_DAILY_USD > 0 ? `$${TOKEN_DAILY_USD}` : "ไม่จำกัด"} ต่อโทเคน`);
  for (const w of TOKEN_WARNINGS) console.log(`   ⚠️ ${w}`);
  if (JOB_WEBHOOK_URL || WEBHOOK_ALLOWED_HOSTS.length) console.log(`   📡 webhook แจ้งผล: ${JOB_WEBHOOK_URL || "(เฉพาะ webhookUrl ที่ส่งมากับโจทย์)"}${WEBHOOK_ALLOWED_HOSTS.length ? ` · host ที่รับได้: ${WEBHOOK_ALLOWED_HOSTS.join(", ")}` : ""}${WEBHOOK_SECRET ? " · มีลายเซ็น" : " · ⚠️ ไม่มี WEBHOOK_SECRET (ส่งโดยไม่มีลายเซ็น)"}`);
  console.log("");
  bus.log(`🚀 ระบบเริ่มทำงานในโหมด ${state.mode.toUpperCase()}`);
  for (const w of TOKEN_WARNINGS) bus.log(`⚠️ ${w}`, { level: "warn" });
  if (codeMode() === "live" && state.mode !== "live") bus.log("🧑‍💻 CODE_MODE=live — งานแก้ไฟล์ของ Developer เรียก Claude Code จริง (กัปตัน/QA ยังจำลอง) ต้นทุนที่ CLI รายงานนับเข้าโจทย์", { level: "warn" });
  else if (codeMode() === "sim" && state.mode === "live") bus.log("🧑‍💻 CODE_MODE=sim — Developer ไม่เรียก Claude Code (patch จำลอง)", { level: "warn" });
});
