// e2e-hermes.mjs — ผัง Hermes: เซิร์ฟเวอร์จริงโหมด sim (พอร์ตว่าง ไม่แตะ 3789) + ปลายทาง webhook จำลอง + MCP server ผ่าน stdio
// ตรวจ: โทเคน Bearer (401/403/400), MCP initialize → tools/list → create_job พร้อมแผน 3 งาน → wait_job → job_result,
//        ทีมทำตามแผน (+QA ที่กัปตันเติม), webhook ถึงปลายทางพร้อมลายเซ็นถูกต้อง (X-Grock-Signature + V2 แบบ Hermes), งบรายวัน → 429,
//        webhookUrl ต่อโจทย์ + ลองใหม่เมื่อปลายทางตอบ 503, โจทย์ล้มเหลว (เกินงบ) → webhook status failed
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const freePort = (start) => new Promise((resolve) => { const tryPort = (p) => { const s = net.createServer(); s.once("error", () => tryPort(p + 1)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(p))); }; tryPort(start); });
const PORT = await freePort(3795);
const HOOK_PORT = await freePort(PORT + 1);
const BASE = `http://127.0.0.1:${PORT}`;
const HOOK = `http://127.0.0.1:${HOOK_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-e2e-hermes-"));
const DATA = path.join(TMP, "data");
process.env.GROCK_DATA_DIR = DATA;
process.env.LOG_EVENTS = "0";
const P = await import(new URL("../../server/projects.js", import.meta.url).href);

const TOK_HERMES = crypto.randomBytes(24).toString("base64url");
const TOK_OPS = crypto.randomBytes(24).toString("base64url");
const SECRET = "e2e-webhook-secret";
const PASS = "e2e-pass-0123456789";
const basic = `Basic ${Buffer.from(`admin:${PASS}`).toString("base64")}`;

// โปรเจกต์ชั่วคราว 2 ตัว: ปกติ (ผลงานเขียน result.md) และงบน้อย (โจทย์ล้มเหลว → webhook failed)
function makeProject(name, extra = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n\nโปรเจกต์ทดสอบ Hermes\n`, "utf8");
  P.initPack(root, { id: name.toLowerCase(), register: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".grock", "project.json"), "utf8"));
  Object.assign(cfg, { name, qa: { maxAttempts: 1 }, ...extra });
  fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify(cfg, null, 2), "utf8");
  return root;
}
const rootA = makeProject("HermesProj");
makeProject("TinyBudget", { budget: { maxUsdPerJob: 0.001 } });

// ---------- ปลายทาง webhook จำลอง ----------
const received = []; // { url, headers, body, json }
let flakyFails = 2; // /webhooks/flaky ตอบ 503 สองครั้งแรก
const hook = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let json = null; try { json = JSON.parse(body); } catch {}
    received.push({ url: req.url, headers: req.headers, body, json });
    if (req.url === "/webhooks/flaky" && flakyFails > 0) { flakyFails--; res.writeHead(503); return res.end("busy"); }
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
});
await new Promise((r) => hook.listen(HOOK_PORT, "127.0.0.1", r));
const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s, "utf8").digest("hex");
const waitHook = async (pred, ms = 20_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = received.find(pred); if (hit) return hit; await sleep(100); } return null; };

// ---------- เซิร์ฟเวอร์ ----------
const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), MODE: "sim", CODE_MODE: "auto", LOG_EVENTS: "0", GROCK_DATA_DIR: DATA,
    AUTH_USER: "admin", AUTH_PASSWORD: PASS, ALLOWED_HOSTS: "",
    API_TOKENS: `hermes:${TOK_HERMES}:jobs,ops:${TOK_OPS}:admin,broken:short:jobs`,
    TOKEN_DAILY_USD: "0.05", // โจทย์ sim 1 โจทย์ ~$0.09 → โจทย์ที่สองของโทเคนเดิมต้องได้ 429
    WEBHOOK_SECRET: SECRET, WEBHOOK_ALLOWED_HOSTS: "127.0.0.1", JOB_WEBHOOK_URL: `${HOOK}/webhooks/grock`, WEBHOOK_RETRY_MS: "100",
    JOB_RATE_LIMIT: "50",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "", stdout = "";
child.stderr.on("data", (c) => (stderr += c));
child.stdout.on("data", (c) => (stdout += c));
const json = (p, init = {}) => fetch(`${BASE}${p}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }));
const asTok = (tok) => ({ authorization: `Bearer ${tok}` });
const post = (p, body, headers = {}) => json(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (p, headers = {}) => json(p, { headers });

// ---------- MCP client ผ่าน stdio ----------
let mcp = null;
const pending = new Map();
let rpcId = 0;
function startMcp() {
  mcp = spawn(process.execPath, ["tools/mcp-server.mjs"], { cwd: ROOT, env: { ...process.env, GROCK_URL: BASE, GROCK_TOKEN: TOK_HERMES, GROCK_WAIT_POLL_MS: "300", API_TOKENS: "" }, stdio: ["pipe", "pipe", "pipe"] });
  mcp.stderr.on("data", (c) => process.stderr.write(`[mcp] ${c}`));
  readline.createInterface({ input: mcp.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg; try { msg = JSON.parse(line); } catch { throw new Error(`MCP ส่งบรรทัดที่ไม่ใช่ JSON: ${line}`); }
    const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id); p(msg);
  });
}
const rpc = (method, params, ms = 150_000) => new Promise((resolve, reject) => {
  const id = ++rpcId;
  const t = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} ไม่ตอบใน ${ms} ms`)); }, ms);
  pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const notify = (method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
const call = async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); assert.ok(r.result, `tools/call ${name} error: ${JSON.stringify(r.error)}`); return r.result; };

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`, { headers: asTok(TOK_HERMES) })).ok) break; } catch {} await sleep(250); }
  assert.equal((await post("/api/settings", { speed: 6 }, { authorization: basic })).status, 200);

  // ---------- guards: โทเคน ----------
  const noAuth = await fetch(`${BASE}/api/state`);
  assert.equal(noAuth.status, 401); assert.ok(noAuth.headers.get("www-authenticate")?.startsWith("Basic"), "ไม่มี auth → ถาม Basic");
  const badTok = await get("/api/state", asTok("not-a-real-token-xxxxxxxx"));
  assert.equal(badTok.status, 401); assert.match(badTok.body.error, /โทเคนไม่ถูกต้อง/);
  assert.equal((await get("/api/state", { authorization: basic })).status, 200, "Basic Auth ยังใช้ได้");
  assert.equal((await get("/api/state", asTok(TOK_HERMES))).status, 200);
  const agents = await get("/api/agents", asTok(TOK_HERMES));
  assert.equal(agents.status, 200);
  assert.equal(agents.body.agents.length, 7);
  assert.ok(agents.body.agents.every((a) => a.id && a.role && a.roleLabel && typeof a.duties === "string"));
  assert.deepEqual([...agents.body.roles].sort(), ["coder", "engineer", "finance", "marketer", "researcher", "reviewer"]);
  assert.equal((await get("/api/projects", asTok(TOK_HERMES))).status, 200);
  assert.equal((await get("/api/projects/hermesproj/context?role=captain", asTok(TOK_HERMES))).status, 200);
  for (const [m, p] of [["POST", "/api/projects"], ["POST", "/api/projects/reload"], ["POST", "/api/demo"], ["POST", "/api/mode"], ["POST", "/api/settings"], ["POST", "/api/agents/dev-1/config"], ["GET", "/api/events"], ["GET", "/api/logs"], ["GET", "/"]]) {
    const r = await json(p, { method: m, headers: { ...asTok(TOK_HERMES), "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
    assert.equal(r.status, 403, `${m} ${p} ด้วยโทเคน jobs ต้อง 403 (ได้ ${r.status})`);
    assert.match(r.body.error || "", /ไม่มีสิทธิ์/);
  }
  assert.equal((await post("/api/projects", { id: "x", path: TMP }, asTok(TOK_OPS))).status, 400, "โทเคน admin ผ่านด่านสิทธิ์ (ไป 400 เพราะโฟลเดอร์ไม่มี pack)");
  assert.ok(stdout.includes('"broken"') && stdout.includes("16 ตัวอักษร"), "รายการโทเคนที่ผิดต้องถูกเตือนตอนเริ่ม");
  console.log("✅ โทเคน: ไม่มี auth 401, โทเคนผิด 401, jobs เรียก state/agents/projects/context ได้, POST /api/projects ฯลฯ 403, admin ผ่าน");

  // ---------- guards: plan / webhookUrl ----------
  const badPlan = await post("/api/jobs", { goal: "x", plan: [{ title: "a", brief: "b", role: "coder", dependsOn: [0] }] }, asTok(TOK_HERMES));
  assert.equal(badPlan.status, 400); assert.match(badPlan.body.error, /plan\[0\]\.dependsOn/);
  assert.equal((await post("/api/jobs", { goal: "x", plan: [{ title: "a", brief: "b", agentId: "nobody" }] }, asTok(TOK_HERMES))).status, 400);
  assert.equal((await post("/api/jobs", { goal: "x", plan: Array.from({ length: 13 }, () => ({ title: "a", brief: "b", role: "coder" })) }, asTok(TOK_HERMES))).status, 400);
  const badHook = await post("/api/jobs", { goal: "x", webhookUrl: "https://evil.example/hook" }, asTok(TOK_HERMES));
  assert.equal(badHook.status, 400); assert.match(badHook.body.error, /WEBHOOK_ALLOWED_HOSTS/);
  console.log("✅ POST /api/jobs: แผนผิด 400 พร้อมตำแหน่ง, webhookUrl นอก WEBHOOK_ALLOWED_HOSTS 400");

  // ---------- MCP ผ่าน stdio ----------
  startMcp();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } }, 10_000);
  assert.ok(init.result?.protocolVersion && init.result.capabilities?.tools && init.result.serverInfo?.name, JSON.stringify(init));
  notify("notifications/initialized");
  const list = await rpc("tools/list", {}, 10_000);
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), ["create_job", "job_result", "job_status", "list_agents", "list_projects", "wait_job"]);
  assert.ok(list.result.tools.every((t) => t.inputSchema?.type === "object" && t.description));
  const la = await call("list_agents");
  assert.equal(la.structuredContent.agents.length, 7);
  assert.ok(la.content[0].text.includes("res-1"));
  const lp = await call("list_projects");
  assert.ok(lp.structuredContent.projects.some((p) => p.id === "hermesproj" && p.ok));
  const unknown = await call("job_status", { jobId: "job-nope" });
  assert.equal(unknown.isError, true); assert.match(unknown.content[0].text, /404/);
  console.log("✅ MCP: initialize, tools/list 6 เครื่องมือ, list_agents/list_projects, error → isError");

  const plan = [
    { title: "ค้นข้อมูลตลาดกาแฟพิเศษ", brief: "รวบรวมขนาดตลาด แนวโน้ม และพฤติกรรมผู้บริโภคกาแฟพิเศษในไทย", role: "researcher" },
    { title: "วางแผนการตลาด", brief: "จากข้อมูลวิจัย วางกลยุทธ์ช่องทางและข้อความสื่อสาร", role: "marketer", dependsOn: [0] },
    { title: "ประเมินการเงิน 12 เดือน", brief: "ประมาณการต้นทุน รายได้ และจุดคุ้มทุน", agentId: "fin-1", dependsOn: [1] },
  ];
  const cj = await call("create_job", { goal: "วางแผนเปิดร้านกาแฟพิเศษ (e2e hermes)", project: "hermesproj", plan, requestedBy: "telegram:@tester" });
  const job0 = cj.structuredContent;
  assert.ok(job0.jobId?.startsWith("job-"), JSON.stringify(cj));
  assert.ok(["planning", "running"].includes(job0.status));
  assert.equal(job0.planSource, "external");
  assert.equal(job0.requestedBy, "telegram:@tester");
  assert.ok(job0.resultPath?.endsWith("/result.md"));
  const st = await call("job_status", { jobId: job0.jobId });
  assert.equal(st.structuredContent.jobId, job0.jobId);
  const w = await call("wait_job", { jobId: job0.jobId, timeoutSec: 120 });
  const done = w.structuredContent;
  assert.equal(done.status, "done", `โจทย์ต้องสำเร็จ: ${JSON.stringify(done)}`);
  assert.ok(!done.timedOut);
  assert.equal(done.tasks.length, 4, "แผน 3 งาน + QA ปิดท้าย 1 = 4");
  assert.deepEqual(done.tasks.map((t) => t.role), ["researcher", "marketer", "finance", "reviewer"]);
  assert.deepEqual(done.tasks.map((t) => t.title).slice(0, 3), plan.map((t) => t.title));
  assert.equal(done.tasks[2].assignedTo, "fin-1", "agentId ในแผนต้องถูกใช้");
  assert.ok(done.tasks.every((t) => t.status === "done"));
  assert.ok(typeof done.tasks[3].qaScore === "number");
  assert.ok(done.summary && done.summary.length <= 1500);
  assert.ok(done.result.includes("ผลลัพธ์สุดท้าย"));
  assert.ok(done.costUsd > 0 && done.durationSec >= 0);
  const jr = await call("job_result", { jobId: job0.jobId });
  assert.equal(jr.structuredContent.result, done.result);
  console.log(`✅ MCP: create_job พร้อมแผน 3 งาน → wait_job → done (${done.tasks.length} งาน, $${done.costUsd}) → job_result`);

  // ทีมทำตามแผน (REST + ไฟล์ผลงาน)
  const det = (await get(`/api/jobs/${job0.jobId}`, asTok(TOK_HERMES))).body;
  assert.equal(det.job.source, "hermes"); assert.equal(det.job.sourceKind, "token"); assert.equal(det.job.planSource, "external"); assert.equal(det.job.plan, null);
  assert.equal(det.tasks[1].dependsOn[0], det.tasks[0].id, "dependsOn ของแผนต้องถูกแปลงเป็น id งาน");
  assert.ok(det.tasks[0].history[0].note.includes("แผนจาก hermes"));
  assert.ok(det.tasks[3].history[0].note.includes("กัปตันเติม QA"));
  await sleep(300);
  const outA = path.join(rootA, ".grock", "out", job0.jobId);
  const planJson = JSON.parse(fs.readFileSync(path.join(outA, "plan.json"), "utf8"));
  assert.equal(planJson.planSource, "external"); assert.equal(planJson.source, "hermes"); assert.equal(planJson.requestedBy, "telegram:@tester");
  const jobJson = JSON.parse(fs.readFileSync(path.join(outA, "job.json"), "utf8"));
  assert.equal(jobJson.source, "hermes"); assert.equal(jobJson.planSource, "external");
  const resultMd = fs.readFileSync(path.join(outA, "result.md"), "utf8");
  assert.ok(resultMd.includes("สั่งโดย: hermes (telegram:@tester)"));
  const jobsList = (await get("/api/jobs?limit=5", asTok(TOK_HERMES))).body.jobs;
  assert.ok(jobsList.some((j) => j.id === job0.jobId && j.taskCount === 4 && j.plan === undefined && j.result === undefined));
  console.log("✅ ทีมทำตามแผน: dependsOn → id, history บอกที่มา, plan.json/job.json/result.md บันทึกแหล่งที่สั่ง, GET /api/jobs");

  // ---------- webhook ถึงปลายทางพร้อมลายเซ็น ----------
  const h1 = await waitHook((r) => r.url === "/webhooks/grock" && r.json?.jobId === job0.jobId);
  assert.ok(h1, "webhook ต้องถึงปลายทางจำลอง");
  assert.match(h1.headers["content-type"], /application\/json/);
  assert.equal(h1.headers["x-grock-signature"], `sha256=${hmac(h1.body)}`, "X-Grock-Signature ต้องตรง HMAC ของ body");
  assert.equal(h1.headers["x-webhook-signature"], hmac(h1.body));
  const ts = h1.headers["x-webhook-timestamp"];
  assert.ok(Math.abs(Date.now() / 1000 - Number(ts)) < 60);
  assert.equal(h1.headers["x-webhook-signature-v2"], hmac(`${ts}.${h1.body}`), "V2 แบบ Hermes = HMAC(<ts>.<body>)");
  const pl = h1.json;
  assert.equal(pl.event, "job.completed"); assert.equal(pl.status, "done"); assert.equal(pl.project, "hermesproj");
  assert.equal(pl.requestedBy, "telegram:@tester"); assert.equal(pl.source, "hermes"); assert.equal(pl.planSource, "external");
  assert.ok(pl.summary && pl.summary.length <= 1500 && !pl.summary.startsWith("#"), `summary: ${pl.summary?.slice(0, 80)}`);
  assert.ok(pl.resultPath?.endsWith("/result.md") && fs.existsSync(pl.resultPath), `resultPath ต้องมีจริง: ${pl.resultPath}`);
  assert.ok(pl.costUsd > 0 && Number.isInteger(pl.durationSec) && pl.goal.includes("กาแฟ") && pl.error === null);
  const detW = (await get(`/api/jobs/${job0.jobId}`, asTok(TOK_HERMES))).body.job;
  assert.equal(detW.webhook?.status, "sent"); assert.equal(detW.webhook.attempts, 1); assert.equal(detW.webhook.httpStatus, 200);
  console.log("✅ webhook: ลายเซ็น X-Grock-Signature/V1/V2 ถูกต้อง, payload ครบ (summary ≤ 1500, resultPath มีจริง), job.webhook = sent");

  // ---------- งบรายวันต่อโทเคน → 429 ----------
  const over = await post("/api/jobs", { goal: "โจทย์ที่สองของ hermes" }, asTok(TOK_HERMES));
  assert.equal(over.status, 429, JSON.stringify(over.body));
  assert.match(over.body.error, /งบรายวัน/);
  const usage = JSON.parse(fs.readFileSync(path.join(DATA, "token-usage.json"), "utf8"));
  const today = Object.keys(usage).sort().pop();
  assert.ok(usage[today].hermes.usd > 0.05 && usage[today].hermes.jobs === 1, JSON.stringify(usage));
  const viaMcp = await call("create_job", { goal: "ผ่าน MCP หลังเกินงบ" });
  assert.equal(viaMcp.isError, true); assert.match(viaMcp.content[0].text, /429/);
  console.log("✅ งบรายวัน: โทเคน hermes เกิน $0.05 → 429 (REST และ MCP), token-usage.json บันทึก");

  // ---------- webhookUrl ต่อโจทย์ + ลองใหม่เมื่อปลายทางตอบ 503 (โทเคน admin คนละงบ) ----------
  const j2 = await post("/api/jobs", { goal: "ทดสอบ webhook ต่อโจทย์ (flaky)", webhookUrl: `${HOOK}/webhooks/flaky`, requestedBy: "ops:test", plan: [{ title: "เขียนสคริปต์สำรองข้อมูล", brief: "สคริปต์ backup", role: "coder" }] }, asTok(TOK_OPS));
  assert.equal(j2.status, 202, JSON.stringify(j2.body));
  assert.equal(j2.body.job.source, "ops"); assert.equal(j2.body.job.webhookUrl, `${HOOK}/webhooks/flaky`);
  const okHit = await waitHook((r) => r.url === "/webhooks/flaky" && r.json?.jobId === j2.body.job.id && r.json.status === "done" && flakyFails === 0, 120_000);
  assert.ok(okHit, "webhook flaky ต้องถึงหลังลองใหม่");
  await sleep(500);
  const flakyHits = received.filter((r) => r.url === "/webhooks/flaky" && r.json?.jobId === j2.body.job.id);
  assert.equal(flakyHits.length, 3, "503, 503 แล้ว 200 = 3 ครั้ง");
  const det2 = (await get(`/api/jobs/${j2.body.job.id}`, asTok(TOK_OPS))).body.job;
  assert.equal(det2.webhook.status, "sent"); assert.equal(det2.webhook.attempts, 3);
  const logs = (await get("/api/logs?limit=300", { authorization: basic })).body.events.map((e) => e.data.message);
  assert.ok(logs.filter((m) => m.includes("ส่ง webhook") && m.includes("ไม่สำเร็จ") && m.includes("HTTP 503")).length >= 2, "ต้อง log ความล้มเหลวแต่ละครั้ง");
  assert.ok(logs.some((m) => m.includes("ส่งผลโจทย์") && m.includes("ครั้งที่ 3")));
  assert.ok(logs.some((m) => m.includes("รับแผน 1 งานจาก ops")));
  console.log("✅ webhookUrl ต่อโจทย์: ปลายทาง 503 ×2 → ลองใหม่จนสำเร็จครั้งที่ 3, log ทุกครั้ง, job.webhook.attempts = 3");

  // ---------- โจทย์ล้มเหลว (เกินงบโปรเจกต์) → webhook status failed + error (ใช้ Basic = ไม่ติดงบโทเคน) ----------
  const j3 = await post("/api/jobs", { goal: "โจทย์งบน้อย (ต้องล้ม)", project: "tinybudget", requestedBy: "telegram:@tester", plan: [{ title: "วิจัย", brief: "x", role: "researcher" }, { title: "โค้ด", brief: "y", role: "coder", dependsOn: [0] }] }, { authorization: basic });
  assert.equal(j3.status, 202, JSON.stringify(j3.body));
  assert.equal(j3.body.job.source, "web:admin");
  const failHit = await waitHook((r) => r.url === "/webhooks/grock" && r.json?.jobId === j3.body.job.id, 120_000);
  assert.ok(failHit, "โจทย์ล้มเหลวก็ต้องยิง webhook");
  assert.equal(failHit.json.event, "job.failed"); assert.equal(failHit.json.status, "failed");
  assert.match(failHit.json.error || "", /เกินงบ/); assert.match(failHit.json.summary || "", /ล้มเหลว|เกินงบ/);
  assert.equal(failHit.json.source, "web:admin"); assert.equal(failHit.json.requestedBy, "telegram:@tester");
  assert.equal(failHit.headers["x-grock-signature"], `sha256=${hmac(failHit.body)}`);
  console.log("✅ โจทย์ล้มเหลว → webhook event job.failed พร้อม error/summary และลายเซ็น");

  assert.ok(!/Error|TypeError|ReferenceError/.test(stderr), `เซิร์ฟเวอร์มี error ใน stderr:\n${stderr.slice(0, 2000)}`);
  console.log("E2E HERMES ALL PASSED");
} finally {
  try { mcp?.stdin.end(); } catch {}
  mcp?.kill();
  child.kill();
  hook.close();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}
