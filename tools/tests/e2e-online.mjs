// e2e-online.mjs — ออนไลน์ครบวงจรกับเซิร์ฟเวอร์จริงโหมด sim: AUTH=token (401/หน้า login/คุกกี้/Bearer/SSE/rate limit/logout), ALLOWED_HOSTS,
//   เก็บผลงานขึ้น fake S3 (โจทย์โปรเจกต์ + workspace → job.storage.url + job.json บนดิสก์และบนคลาวด์), ด่านอนุมัติ push branch grock/<jobId> ไป bare repo (+ ปฏิเสธ),
//   รีสตาร์ต → โจทย์เก่ายังอยู่ (ผลงาน/ตัวชี้วัด) + โจทย์ที่ค้างถูกทำเครื่องหมายล้มเหลว + คุกกี้เดิมยังใช้ได้, และเซิร์ฟเวอร์ไม่ยอมสตาร์ตเมื่อเปิดรับจากภายนอกโดยไม่มีล็อกอิน
import { spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFakeS3 } from "./fake-s3.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const freePort = (start) => new Promise((resolve) => { const tryPort = (p) => { const s = net.createServer(); s.once("error", () => tryPort(p + 1)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(p))); }; tryPort(start); });
const PORT = await freePort(3797);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-e2e-online-"));
const DATA = path.join(TMP, "data");
process.env.GROCK_DATA_DIR = DATA;
process.env.LOG_EVENTS = "0";
const P = await import(new URL("../../server/projects.js", import.meta.url).href);

const TOKEN = crypto.randomBytes(24).toString("base64url");
const API_TOK = crypto.randomBytes(24).toString("base64url");
const AK = "AKIAE2EFAKEKEY00001", SK = "e2e-secret-key-0123456789abcdef";
const BUCKET = "grock-e2e";
const s3 = await createFakeS3({ accessKeyId: AK, secretAccessKey: SK, region: "auto", bucket: BUCKET });

// ---------- โปรเจกต์ชั่วคราว: git repo + remote (bare) + git.pushBranch ----------
const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@test", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@test" } }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
const bare = path.join(TMP, "remote.git");
git(TMP, "init", "--bare", "-q", bare);
function makeProject(name, extra = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n\nโปรเจกต์ทดสอบออนไลน์\n`, "utf8");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const x = 1;\n", "utf8");
  P.initPack(root, { id: name.toLowerCase(), register: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(root, ".grock", "project.json"), "utf8"));
  Object.assign(cfg, { name, qa: { maxAttempts: 1 }, ...extra });
  fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify(cfg, null, 2), "utf8");
  return root;
}
const rootA = makeProject("OnlineProj", { git: { pushBranch: true, remote: "origin" } });
git(rootA, "init", "-q"); git(rootA, "config", "core.autocrlf", "false"); git(rootA, "add", "-A"); git(rootA, "commit", "-q", "-m", "init"); git(rootA, "remote", "add", "origin", bare);
const headA = git(rootA, "rev-parse", "HEAD");
makeProject("NoGitProj", { git: { pushBranch: true } }); // ไม่ใช่ repo → skipped

// ---------- เซิร์ฟเวอร์ ----------
const ENV = {
  ...process.env, PORT: String(PORT), MODE: "sim", CODE_MODE: "sim", LOG_EVENTS: "0", GROCK_DATA_DIR: DATA,
  AUTH: "token", DASHBOARD_TOKEN: TOKEN, AUTH_PASSWORD: "", LOGIN_MAX_FAILS: "3", LOGIN_WINDOW_MIN: "5", SESSION_DAYS: "1",
  ALLOWED_HOSTS: "ai.example.com,.trycloudflare.com", API_TOKENS: `hermes:${API_TOK}:jobs`, JOB_RATE_LIMIT: "50",
  STORAGE_PROVIDER: "s3", S3_ENDPOINT: s3.endpoint, S3_BUCKET: BUCKET, S3_ACCESS_KEY_ID: AK, S3_SECRET_ACCESS_KEY: SK, S3_PREFIX: "grock", S3_RETRY_MS: "50",
  JOB_WEBHOOK_URL: "", WEBHOOK_SECRET: "", TOKEN_DAILY_USD: "0",
};
let child = null, stdout = "", stderr = "";
function startServer(extraEnv = {}) {
  stdout = ""; stderr = "";
  child = spawn(process.execPath, ["server/index.js"], { cwd: ROOT, env: { ...ENV, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return child;
}
async function waitUp(headers) { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/health`, { headers })).ok) return; } catch {} await sleep(250); } throw new Error(`เซิร์ฟเวอร์ไม่ขึ้น\n${stdout}\n${stderr}`); }
async function stopServer() { if (!child) return; const c = child; child = null; c.kill(); await new Promise((r) => { c.once("exit", r); setTimeout(r, 3000); }); }
const req = (p, init = {}) => fetch(`${BASE}${p}`, { redirect: "manual", ...init });
const json = async (p, init = {}) => { const r = await req(p, init); return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers }; };
const bearer = { authorization: `Bearer ${TOKEN}` };
const post = (p, body, headers = {}) => json(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (p, headers = {}) => json(p, { headers });
async function waitJob(id, headers, pred = (j) => j.status === "done" || j.status === "failed", ms = 120_000) {
  const t0 = Date.now();
  for (;;) { const r = await get(`/api/jobs/${id}`, headers); if (r.status === 200 && pred(r.body.job)) return r.body; if (Date.now() - t0 > ms) throw new Error(`รอโจทย์ ${id} เกินเวลา: ${JSON.stringify(r.body.job?.status)}`); await sleep(300); }
}
async function readSseFirst(headers, ms = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(`${BASE}/api/events`, { headers, signal: ac.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /text\/event-stream/);
    const reader = r.body.getReader();
    let text = "";
    while (!text.includes("\n\n")) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString("utf8"); }
    ac.abort();
    return text;
  } finally { clearTimeout(t); }
}

try {
  // ---------- ไม่ยอมสตาร์ตเมื่อเปิดรับจากภายนอกโดยไม่มีล็อกอิน ----------
  for (const [label, env] of [
    ["HOST=0.0.0.0 ไม่มี auth", { AUTH: "auto", DASHBOARD_TOKEN: "", HOST: "0.0.0.0", ALLOWED_HOSTS: "" }],
    ["ALLOWED_HOSTS ไม่มี auth", { AUTH: "auto", DASHBOARD_TOKEN: "", ALLOWED_HOSTS: "ai.example.com" }],
    ["AUTH=token ไม่มี DASHBOARD_TOKEN", { AUTH: "token", DASHBOARD_TOKEN: "" }],
    ["DASHBOARD_TOKEN สั้น", { AUTH: "token", DASHBOARD_TOKEN: "short" }],
  ]) {
    const r = spawnSync(process.execPath, ["server/index.js"], { cwd: ROOT, env: { ...ENV, ...env, PORT: String(await freePort(PORT + 50)) }, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 1, `${label}: ต้อง exit 1 (ได้ ${r.status})\n${r.stdout}\n${r.stderr}`);
    assert.ok(/ไม่เริ่มทำงาน/.test(r.stderr), `${label}: ต้องบอกว่าไม่เริ่มทำงาน: ${r.stderr}`);
  }
  console.log("✅ ไม่ยอมสตาร์ต: HOST ไม่ใช่ loopback / มี ALLOWED_HOSTS โดยไม่มีล็อกอิน, AUTH=token โดยไม่มีโทเคน/โทเคนสั้น → exit 1");

  startServer();
  await waitUp(bearer);
  assert.ok(stdout.includes("ล็อกอินด้วยโทเคน") && stdout.includes("เก็บผลงานขึ้นคลาวด์") && stdout.includes("สถานะถาวร"), stdout);
  assert.equal((await post("/api/settings", { speed: 6 }, bearer)).status, 200);

  // ---------- AUTH=token ----------
  const noAuth = await get("/api/state");
  assert.equal(noAuth.status, 401); assert.equal(noAuth.body.login, "/login"); assert.match(noAuth.body.error, /ล็อกอิน/);
  assert.equal((await get("/api/state", { authorization: "Basic " + Buffer.from("admin:whatever").toString("base64") })).status, 401, "ไม่ได้ตั้ง AUTH_PASSWORD → Basic ใช้ไม่ได้");
  const htmlRedirect = await req("/", { headers: { accept: "text/html,*/*" } });
  assert.equal(htmlRedirect.status, 302); assert.equal(htmlRedirect.headers.get("location"), "/login?next=%2F");
  assert.equal((await req("/app.js", { headers: { accept: "text/html" } })).status, 302, "ไฟล์หน้าเว็บก็ต้องล็อกอิน");
  assert.equal((await req("/app.js")).status, 401, "ไม่ใช่เบราว์เซอร์ → 401 ไม่ redirect");
  const loginPage = await req("/login");
  assert.equal(loginPage.status, 200); assert.match(loginPage.headers.get("content-type"), /text\/html/);
  const loginHtml = await loginPage.text();
  assert.ok(loginHtml.includes('name="token"') && loginHtml.includes("เข้าสู่ระบบ"));
  assert.equal((await req("/login?next=//evil.com")).status, 200);
  // ฟอร์มผิด → 401 HTML
  const wrongForm = await req("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent("wrong-token-0123456789")}&next=%2F` });
  assert.equal(wrongForm.status, 401); assert.ok((await wrongForm.text()).includes("โทเคนไม่ถูกต้อง"));
  // rate limit ต่อ IP (จำลอง IP อื่นผ่าน x-forwarded-for เพื่อไม่บล็อก IP จริงของเทสต์): ผิด 3 ครั้ง → ครั้งที่ 4 ได้ 429 แม้โทเคนถูก
  const spoof = { "x-forwarded-for": "10.9.9.9" };
  for (let i = 0; i < 2; i++) assert.equal((await post("/login", { token: "wrong-token-0123456789" }, spoof)).status, 401);
  const third = await post("/login", { token: "wrong-token-0123456789" }, spoof);
  assert.equal(third.status, 401); assert.match(third.body.error, /พักชั่วคราว/);
  const blocked = await post("/login", { token: TOKEN }, spoof);
  assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get("retry-after")) > 0); assert.match(blocked.body.error, /ลองใหม่ใน/);
  assert.equal((await get("/api/state", { ...spoof, ...bearer })).status, 429, "IP ที่ถูกพักใช้ Bearer ก็ไม่ได้");
  const spoof2 = { "x-forwarded-for": "10.8.8.8" };
  for (let i = 0; i < 3; i++) assert.equal((await get("/api/state", { ...spoof2, authorization: "Bearer not-the-token-000000" })).status, 401);
  assert.equal((await get("/api/state", { ...spoof2, authorization: "Bearer not-the-token-000000" })).status, 429, "เดา Bearer ผิดก็ถูกนับ");
  // ล็อกอินถูก (JSON) → คุกกี้
  const ok = await post("/login", { token: TOKEN, next: "/?tab=results" });
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true); assert.equal(ok.body.next, "/?tab=results");
  const setCookie = ok.headers.get("set-cookie") || "";
  assert.match(setCookie, /^grock_session=\d+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=86400$/, setCookie);
  const cookie = { cookie: setCookie.split(";")[0] };
  assert.equal((await get("/api/state", cookie)).status, 200);
  const home = await req("/", { headers: { ...cookie, accept: "text/html" } });
  assert.equal(home.status, 200); assert.ok((await home.text()).includes("logoutBtn"));
  assert.equal((await req("/login", { headers: { ...cookie, accept: "text/html" } })).status, 302, "ล็อกอินแล้วเปิด /login → เด้งกลับ");
  const okForm = await req("/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-proto": "https" }, body: `token=${encodeURIComponent(TOKEN)}&next=%2F%3Ftab%3Dtasks` });
  assert.equal(okForm.status, 303); assert.equal(okForm.headers.get("location"), "/?tab=tasks"); assert.match(okForm.headers.get("set-cookie"), /; Secure;/, "ผ่าน https → Secure");
  assert.equal((await get("/api/state", { cookie: "grock_session=1999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).status, 401, "คุกกี้ปลอมใช้ไม่ได้");
  assert.equal((await get("/api/state", bearer)).status, 200, "Bearer DASHBOARD_TOKEN ใช้ได้");
  assert.equal((await get("/api/state", { authorization: `Bearer ${API_TOK}` })).status, 200, "API_TOKENS ยังใช้ได้");
  assert.equal((await get("/api/logs", { authorization: `Bearer ${API_TOK}` })).status, 403, "scope jobs ยังถูกจำกัด");
  const snap = (await get("/api/state", cookie)).body;
  assert.deepEqual(snap.online, { auth: "token", storage: BUCKET, stateDb: true });
  // SSE ด้วยคุกกี้
  const sse = await readSseFirst(cookie);
  assert.ok(sse.includes('"type":"snapshot"'), sse.slice(0, 200));
  assert.equal((await req("/api/events")).status, 401);
  // ALLOWED_HOSTS (fetch ของ Node ไม่ให้ตั้งหัว Host เอง → ใช้ node:http)
  const rawGet = (p, headers) => new Promise((resolve, reject) => { const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET", headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); }); r.on("error", reject); r.end(); });
  assert.equal(await rawGet("/api/state", { ...cookie, host: "evil.example" }), 403);
  assert.equal(await rawGet("/api/state", { ...cookie, host: "ai.example.com" }), 200);
  assert.equal(await rawGet("/api/state", { ...cookie, host: "abc.trycloudflare.com" }), 200);
  // logout
  const lo = await req("/logout", { method: "POST", headers: { ...cookie, accept: "application/json" } });
  assert.equal(lo.status, 200); assert.match(lo.headers.get("set-cookie"), /grock_session=; .*Max-Age=0/);
  const loForm = await req("/logout", { method: "POST", headers: cookie });
  assert.equal(loForm.status, 303); assert.equal(loForm.headers.get("location"), "/login");
  console.log("✅ AUTH=token: ไม่มีโทเคน 401 (+login), เบราว์เซอร์ → /login, หน้า login, ฟอร์ม/JSON, rate limit ต่อ IP 429 (login + Bearer), คุกกี้ HttpOnly/Strict/Secure, Bearer, API_TOKENS, SSE, ALLOWED_HOSTS, logout");

  // ---------- โจทย์โปรเจกต์ → อัปโหลด fake S3 + รออนุมัติ push ----------
  const plan = [{ title: "สรุปโครงสร้างโปรเจกต์", brief: "อ่าน README แล้วสรุป", role: "researcher" }];
  const j1 = await post("/api/jobs", { goal: "ทดสอบเก็บผลงานบนคลาวด์ (e2e online)", project: "onlineproj", plan }, bearer);
  assert.equal(j1.status, 202, JSON.stringify(j1.body));
  assert.equal(j1.body.job.source, "web:dashboard");
  const d1 = await waitJob(j1.body.job.id, bearer, (j) => j.status === "done" && j.storage?.status && j.storage.status !== "uploading" && j.git?.status);
  const job1 = d1.job;
  assert.equal(job1.status, "done");
  assert.equal(job1.storage.status, "uploaded", JSON.stringify(job1.storage)); assert.equal(job1.storage.uploaded, true);
  const prefix1 = `grock/onlineproj/${job1.id}`;
  assert.equal(job1.storage.keyPrefix, prefix1); assert.equal(job1.storage.url, `${s3.endpoint}/${BUCKET}/${prefix1}/`); assert.equal(job1.storage.resultUrl, `${s3.endpoint}/${BUCKET}/${prefix1}/result.md`);
  assert.ok(job1.storage.files >= 4 && job1.storage.bytes > 0, JSON.stringify(job1.storage));
  const keys = [...s3.objects.keys()].filter((k) => k.startsWith(prefix1 + "/"));
  assert.ok(keys.includes(`${prefix1}/result.md`) && keys.includes(`${prefix1}/job.json`) && keys.includes(`${prefix1}/plan.json`) && keys.some((k) => k.startsWith(`${prefix1}/tasks/`)), keys.join(", "));
  const outDir = path.join(rootA, ".grock", "out", job1.id);
  assert.equal(s3.objects.get(`${prefix1}/result.md`).body.toString("utf8"), fs.readFileSync(path.join(outDir, "result.md"), "utf8"), "เนื้อหาบนคลาวด์ตรงกับดิสก์");
  await sleep(300);
  const jobJsonDisk = JSON.parse(fs.readFileSync(path.join(outDir, "job.json"), "utf8"));
  assert.equal(jobJsonDisk.storage.uploaded, true); assert.equal(jobJsonDisk.storage.url, job1.storage.url); assert.equal(jobJsonDisk.storage.error, null);
  const jobJsonCloud = JSON.parse(s3.objects.get(`${prefix1}/job.json`).body.toString("utf8"));
  assert.equal(jobJsonCloud.storage?.uploaded, true, "job.json บนคลาวด์ถูกส่งซ้ำหลังรู้ผลอัปโหลด");
  assert.equal(jobJsonCloud.storage.url, job1.storage.url);
  // ด่านอนุมัติ push
  assert.equal(job1.git.status, "pending"); assert.equal(job1.git.branch, `grock/${job1.id}`); assert.equal(job1.git.remote, "origin");
  assert.equal(jobJsonDisk.git.status, "pending");
  assert.equal((await post(`/api/jobs/${job1.id}/push`, { note: "ok" }, { authorization: `Bearer ${API_TOK}` })).status, 403, "โทเคน jobs อนุมัติ push ไม่ได้");
  assert.equal((await post("/api/jobs/job-nope/push", {}, bearer)).status, 404);
  const pushRes = await post(`/api/jobs/${job1.id}/push`, { note: "อนุมัติจาก e2e" }, bearer);
  assert.equal(pushRes.status, 202, JSON.stringify(pushRes.body)); assert.ok(["pushing", "pushed", "failed"].includes(pushRes.body.job.git.status));
  const d1b = await waitJob(job1.id, bearer, (j) => ["pushed", "failed"].includes(j.git?.status), 60_000);
  assert.equal(d1b.job.git.status, "pushed", JSON.stringify(d1b.job.git));
  assert.equal(d1b.job.git.mode, "orphan"); assert.equal(d1b.job.git.decidedBy, "web:dashboard"); assert.equal(d1b.job.git.note, "อนุมัติจาก e2e"); assert.match(d1b.job.git.commit, /^[0-9a-f]{40}$/);
  assert.equal(git(bare, "rev-parse", `refs/heads/grock/${job1.id}`), d1b.job.git.commit, "branch ถึง remote");
  const treeFiles = git(bare, "-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", `refs/heads/grock/${job1.id}`).split("\n");
  assert.ok(treeFiles.includes(`.grock/out/${job1.id}/result.md`) && treeFiles.includes(`.grock/out/${job1.id}/job.json`), treeFiles.join(","));
  assert.ok(treeFiles.every((f) => f.startsWith(`.grock/out/${job1.id}/`)), `orphan branch มีเฉพาะไฟล์ผลงาน: ${treeFiles.join(", ")}`);
  assert.equal(git(rootA, "rev-parse", "HEAD"), headA, "HEAD ของโปรเจกต์ไม่เปลี่ยน");
  assert.equal(git(rootA, "status", "--porcelain"), "", "working tree/index ของโปรเจกต์ไม่ถูกแตะ");
  assert.equal((await post(`/api/jobs/${job1.id}/push`, {}, bearer)).status, 409, "push แล้วอนุมัติซ้ำไม่ได้");
  await sleep(300);
  assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, "job.json"), "utf8")).git.status, "pushed");
  console.log(`✅ โจทย์โปรเจกต์: อัปโหลด ${job1.storage.files} ไฟล์ขึ้น ${prefix1}/ (job.json บนดิสก์+คลาวด์มี storage.url), รออนุมัติ → push branch grock/<jobId> ถึง remote (orphan, ไม่แตะ HEAD/working tree)`);

  // ---------- โจทย์ workspace (ไม่มีโปรเจกต์) → อัปโหลดจากหน่วยความจำ ----------
  const j2 = await post("/api/jobs", { goal: "โจทย์ไม่มีโปรเจกต์ (workspace)", plan: [{ title: "คิดชื่อสินค้า", brief: "เสนอชื่อ 3 ชื่อ", role: "marketer" }] }, bearer);
  assert.equal(j2.status, 202);
  const d2 = await waitJob(j2.body.job.id, bearer, (j) => j.status === "done" && j.storage?.status && j.storage.status !== "uploading");
  const prefix2 = `grock/workspace/${j2.body.job.id}`;
  assert.equal(d2.job.storage.status, "uploaded"); assert.equal(d2.job.storage.keyPrefix, prefix2); assert.equal(d2.job.outputDir, null); assert.equal(d2.job.git, null);
  const wsKeys = [...s3.objects.keys()].filter((k) => k.startsWith(prefix2 + "/"));
  assert.ok(wsKeys.includes(`${prefix2}/result.md`) && wsKeys.includes(`${prefix2}/job.json`) && wsKeys.filter((k) => k.includes("/tasks/")).length === d2.tasks.length, wsKeys.join(","));
  assert.ok(s3.objects.get(`${prefix2}/result.md`).body.toString("utf8").includes(d2.job.result.slice(0, 40)));
  await sleep(500); // job.json ของ workspace ถูกส่งซ้ำพร้อม storage หลังอัปโหลดเสร็จ
  const wsJobJson = JSON.parse(s3.objects.get(`${prefix2}/job.json`).body.toString("utf8"));
  assert.equal(wsJobJson.project, "workspace"); assert.equal(wsJobJson.storage?.uploaded, true, "job.json ของ workspace บนคลาวด์ต้องมี storage.uploaded"); assert.equal(wsJobJson.storage.url, d2.job.storage.url);
  console.log("✅ โจทย์ workspace: result.md/tasks/job.json จากหน่วยความจำขึ้น grock/workspace/<jobId>/ (job.json ส่งซ้ำพร้อม storage)");

  // ---------- ปฏิเสธ push + โปรเจกต์ที่ไม่ใช่ repo → skipped ----------
  const j3 = await post("/api/jobs", { goal: "ทดสอบปฏิเสธ push", project: "onlineproj", plan }, bearer);
  const d3 = await waitJob(j3.body.job.id, bearer, (j) => j.status === "done" && j.git?.status);
  assert.equal(d3.job.git.status, "pending");
  const rj = await post(`/api/jobs/${j3.body.job.id}/push/reject`, { reason: "ยังไม่พร้อม" }, bearer);
  assert.equal(rj.status, 200); assert.equal(rj.body.job.git.status, "rejected"); assert.equal(rj.body.job.git.note, "ยังไม่พร้อม");
  assert.equal((await post(`/api/jobs/${j3.body.job.id}/push`, {}, bearer)).status, 409);
  assert.equal(git(bare, "branch", "--list", `grock/${j3.body.job.id}`), "", "ไม่ push");
  const j4 = await post("/api/jobs", { goal: "โปรเจกต์ไม่ใช่ repo", project: "nogitproj", plan }, bearer);
  const d4 = await waitJob(j4.body.job.id, bearer, (j) => j.status === "done" && j.git?.status);
  assert.equal(d4.job.git.status, "skipped"); assert.match(d4.job.git.error, /git repository/);
  assert.equal((await post(`/api/jobs/${j4.body.job.id}/push`, {}, bearer)).status, 409);
  const logs = (await get("/api/logs?limit=400", bearer)).body.events.map((e) => e.data.message);
  assert.ok(logs.some((m) => m.includes("☁️ อัปโหลดผลงาน")) && logs.some((m) => m.includes("รออนุมัติ")) && logs.some((m) => m.includes("✅ push")) && logs.some((m) => m.includes("🚫 ไม่ push")) && logs.some((m) => m.includes("ข้ามการ push")), "log ครบทุกขั้น");
  console.log("✅ ปฏิเสธ push → rejected ไม่มี branch, โปรเจกต์ที่ไม่ใช่ repo → skipped, log ครบ");

  // ---------- รีสตาร์ตขณะมีโจทย์ค้าง ----------
  assert.equal((await post("/api/settings", { speed: 0.5 }, bearer)).status, 200);
  const j5 = await post("/api/jobs", { goal: "โจทย์ที่จะค้างตอนรีสตาร์ต", plan: [{ title: "งานยาว 1", brief: "x", role: "researcher" }, { title: "งานยาว 2", brief: "y", role: "finance", dependsOn: [0] }] }, bearer);
  assert.equal(j5.status, 202);
  await waitJob(j5.body.job.id, bearer, (j) => j.status === "running", 30_000);
  await sleep(1500);
  const before = (await get("/api/state", bearer)).body;
  const resBefore = before.agents.find((a) => a.id === "res-1").metrics;
  assert.ok(resBefore.tasksDone >= 2, JSON.stringify(resBefore));
  await stopServer();
  assert.ok(fs.existsSync(path.join(DATA, "state.db")));
  startServer();
  await waitUp(bearer);
  assert.ok(stdout.includes("โหลดโจทย์เก่า 5 รายการ") && stdout.includes("ค้างตอนรีสตาร์ต 1 รายการ"), stdout);
  const after = (await get("/api/state", cookie)).body;
  assert.equal(after.jobs.length, 5, "โจทย์ทั้งหมดกลับมา (คุกกี้เดิมยังใช้ได้)");
  const r1 = after.jobs.find((j) => j.id === job1.id);
  assert.equal(r1.status, "done"); assert.equal(r1.result, job1.result); assert.equal(r1.storage.status, "uploaded"); assert.equal(r1.storage.url, job1.storage.url); assert.equal(r1.git.status, "pushed"); assert.equal(r1.restored.from, "done");
  assert.ok(r1.taskIds.every((id) => after.tasks.some((t) => t.id === id && t.status === "done")), "งานย่อยของโจทย์เก่ากลับมาครบ");
  assert.equal(after.jobs.find((j) => j.id === j2.body.job.id).storage.keyPrefix, prefix2);
  assert.equal(after.jobs.find((j) => j.id === j3.body.job.id).git.status, "rejected");
  const r5 = after.jobs.find((j) => j.id === j5.body.job.id);
  assert.equal(r5.status, "failed"); assert.match(r5.error, /รีสตาร์ต.*running/); assert.equal(r5.restored.from, "running");
  const t5 = after.tasks.filter((t) => t.jobId === r5.id);
  assert.ok(t5.length === 3 && t5.every((t) => ["done", "cancelled"].includes(t.status)) && t5.some((t) => t.status === "cancelled" && t.phase.includes("รีสตาร์ต")), JSON.stringify(t5.map((t) => [t.title, t.status]))); // แผน 2 งาน + QA ที่กัปตันเติม = 3
  assert.equal(after.totals.jobsDone, 4); assert.equal(after.totals.failed, 0);
  const resAfter = after.agents.find((a) => a.id === "res-1").metrics;
  assert.equal(resAfter.tasksDone, resBefore.tasksDone, "ตัวชี้วัดต่อคนกลับมา"); assert.ok(resAfter.costUsd > 0);
  assert.ok(after.agents.every((a) => a.status !== "working" && !a.currentTaskId), "ไม่มีใครค้างสถานะทำงาน");
  assert.equal((await post(`/api/jobs/${job1.id}/push`, {}, bearer)).status, 409, "โจทย์เก่าหลังรีสตาร์ต push ซ้ำไม่ได้ (pushed แล้ว)");
  const logs2 = (await get("/api/logs?limit=50", bearer)).body.events.map((e) => e.data.message);
  assert.ok(logs2.some((m) => m.includes("💾 โหลดโจทย์เก่า 5")) && logs2.some((m) => m.includes("ค้างอยู่ตอนรีสตาร์ต")), logs2.join("\n"));
  // หลังรีสตาร์ตยังสั่งงานใหม่และอัปโหลดได้
  assert.equal((await post("/api/settings", { speed: 6 }, bearer)).status, 200);
  const j6 = await post("/api/jobs", { goal: "โจทย์หลังรีสตาร์ต", plan: [{ title: "สั้น ๆ", brief: "x", role: "researcher" }] }, bearer);
  const d6 = await waitJob(j6.body.job.id, bearer, (j) => j.status === "done" && j.storage?.status === "uploaded");
  assert.equal(d6.job.storage.uploaded, true);
  assert.equal((await get("/api/state", bearer)).body.jobs.length, 6);
  console.log("✅ รีสตาร์ต: โจทย์เก่า 5 รายการกลับมาพร้อมผลงาน/storage/git/งานย่อย/ตัวชี้วัด, โจทย์ที่ค้าง → failed + งานค้าง → cancelled, คุกกี้เดิมใช้ได้, สั่งงานใหม่ได้");

  assert.ok(!/TypeError|ReferenceError|SyntaxError/.test(stderr), `เซิร์ฟเวอร์มี error ใน stderr:\n${stderr.slice(0, 2000)}`);
  console.log("E2E ONLINE ALL PASSED");
} finally {
  await stopServer();
  await s3.close();
  await sleep(300);
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (err) { console.warn(`(ลบ temp ไม่ได้: ${err.message})`); }
}
