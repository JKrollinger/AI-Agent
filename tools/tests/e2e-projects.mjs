// e2e-projects.mjs — รันเซิร์ฟเวอร์จริงในโหมด sim กับ Project Pack ชั่วคราว 3 โปรเจกต์
// ตรวจ: 202 + GET /api/jobs/:id, guard 415/403/400/404, ลงทะเบียนผ่าน API + projects.updated, context preview (ปิดบังค่าลับ/ข้าม .env),
// งานพร้อมกัน 2 โปรเจกต์ + กัปตัน ref-count, plan rules (roles/maxTasks) + override เฉพาะโปรเจกต์, ไฟล์ผลงานใน .grock/out, งบต่อโจทย์, แคชจำลอง
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."); // รากของศูนย์ควบคุม
const PORT = 3793;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-e2e-"));
const DATA = path.join(TMP, "data");
process.env.GROCK_DATA_DIR = DATA;
const P = await import(new URL("../../server/projects.js", import.meta.url).href);

function makeProject(name, config = {}) {
  const root = path.join(TMP, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n\nระบบ ${name} สำหรับทดสอบ e2e\n\n## Setup\nnpm i\n`, "utf8");
  fs.writeFileSync(path.join(root, "CLAUDE.md"), `\uFEFF# กติกา ${name}\nTOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD\nตอบเป็นภาษาไทย\n`, "utf8");
  fs.writeFileSync(path.join(root, "docs", "spec.md"), "# สเปก\nรายละเอียดสเปก\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=shh\n", "utf8");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const x = 1;\n", "utf8");
  return root;
}
const rootA = makeProject("ProjA");
const rootB = makeProject("ProjB");
const rootC = makeProject("ProjC");
P.initPack(rootA, { id: "proja", register: true }); // ลงทะเบียนก่อนเปิดเซิร์ฟเวอร์ → ต้องเห็นตั้งแต่ snapshot แรก
P.initPack(rootB, { id: "projb", register: false }); // จะลงทะเบียนผ่าน API
P.initPack(rootC, { id: "projc", register: false });
fs.writeFileSync(path.join(rootA, ".grock", "brief.md"), "# ProjA\nโปรเจกต์ A ทดสอบ e2e — กติกา: ตอบไทย\n", "utf8");
const cfgB = JSON.parse(fs.readFileSync(path.join(rootB, ".grock", "project.json"), "utf8"));
Object.assign(cfgB, { name: "Project B", plan: { roles: ["coder"], maxTasks: 2 }, roles: { coder: { model: "claude-haiku-5-5", effort: "low", instructions: "ใช้ TypeScript" } }, qa: { maxAttempts: 1, passScore: 60 } });
fs.writeFileSync(path.join(rootB, ".grock", "project.json"), JSON.stringify(cfgB, null, 2), "utf8");
const cfgC = JSON.parse(fs.readFileSync(path.join(rootC, ".grock", "project.json"), "utf8"));
Object.assign(cfgC, { name: "Project C", plan: { maxTasks: 3 }, budget: { maxUsdPerJob: 0.02 } });
fs.writeFileSync(path.join(rootC, ".grock", "project.json"), JSON.stringify(cfgC, null, 2), "utf8");

const child = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MODE: "sim", LOG_EVENTS: "0", GROCK_DATA_DIR: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += c));
const json = (p, init) => fetch(`${BASE}${p}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (p, body, headers = {}) => json(p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {} await sleep(250); }
  await post("/api/settings", { speed: 6 });

  // --- SSE ---
  const events = [];
  const ac = new AbortController();
  const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ""; let stop = false;
  const pump = (async () => {
    while (!stop) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) { const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2); const l = chunk.split("\n").find((x) => x.startsWith("data: ")); if (l) events.push(JSON.parse(l.slice(6))); }
    }
  })().catch(() => {});
  const waitFor = async (pred, ms = 150_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await sleep(200); } return null; };

  // --- guards ---
  const r415 = await fetch(`${BASE}/api/jobs`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ goal: "x" }) });
  assert.equal(r415.status, 415);
  // fetch (undici) ไม่ยอมให้ตั้ง Host header → ยิงตรงด้วย node:http เพื่อทดสอบ guard
  const rawPost = (p, headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", reject); req.end(body);
  });
  assert.equal(await rawPost("/api/jobs", { host: "evil.example.com" }, JSON.stringify({ goal: "x" })), 403);
  assert.equal(await rawPost("/api/jobs", { host: `localhost:${PORT}` }, "not json"), 400, "Host ถูกต้องแต่ body ไม่ใช่ JSON → 400");
  assert.equal((await post("/api/jobs", { goal: "x", project: "nope" })).status, 404);
  assert.equal((await post("/api/projects", { id: "bad", path: "C:\\" })).status, 400);
  assert.equal((await post("/api/projects", { id: "noPack", path: TMP })).status, 400, "โฟลเดอร์ที่ไม่มี .grock/project.json ต้องลงทะเบียนไม่ได้");
  assert.equal((await post("/api/projects", { id: "self", path: ROOT })).status, 400, "ห้ามลงทะเบียนศูนย์ควบคุมเอง");
  console.log("✅ guards: 415 text/plain, 403 Host แปลก, 404 โปรเจกต์ไม่มี, 400 ราก/ไม่มี pack/ศูนย์ควบคุม");

  // --- registry ---
  const st0 = (await json("/api/state")).body;
  assert.ok(st0.projects.some((p) => p.id === "proja" && p.ok), "snapshot ต้องมีโปรเจกต์ที่ลงทะเบียนก่อนเปิดเซิร์ฟเวอร์");
  const reg = await post("/api/projects", { id: "projb", path: rootB });
  assert.equal(reg.status, 201);
  assert.equal((await post("/api/projects", { id: "projc", path: rootC })).status, 201);
  assert.ok(await waitFor((e) => e.type === "projects.updated" && e.data.projects.some((p) => p.id === "projb"), 5000));
  const list = (await json("/api/projects")).body.projects;
  assert.deepEqual(list.map((p) => p.id).sort(), ["proja", "projb", "projc"]);
  assert.equal(list.find((p) => p.id === "projb").name, "Project B");
  console.log("✅ registry: ลงทะเบียนผ่าน API → 201 + projects.updated + GET /api/projects");

  // --- context preview ---
  const ctx = (await json("/api/projects/proja/context?role=coder&fresh=1")).body;
  assert.equal(ctx.role, "coder");
  assert.ok(ctx.system.includes("โปรเจกต์ A ทดสอบ e2e"), "brief ต้องอยู่ใน system");
  assert.ok(ctx.data.includes("[REDACTED]") && !ctx.data.includes("ghp_abc"), "ต้องปิดบังโทเคนใน CLAUDE.md");
  assert.ok(!ctx.data.includes("SECRET=shh"), ".env ต้องไม่ถูกอ่าน");
  assert.ok(ctx.files.some((f) => f.path === "CLAUDE.md" && f.redactions >= 1));
  assert.ok(ctx.docsIndex >= 1 && ctx.tree >= 2 && ctx.estTokens > 0 && ctx.inputTokens === null);
  const ctxB = (await json("/api/projects/projb/context?role=coder")).body;
  assert.ok(ctxB.system.includes("ใช้ TypeScript") && ctxB.config.plan.roles.length === 1);
  console.log("✅ context preview: brief ใน system, ค่าลับถูกปิดบัง, .env ถูกข้าม, ดัชนี/tree/estTokens");

  // --- jobs พร้อมกัน 2 โปรเจกต์ ---
  const jA = await post("/api/jobs", { goal: "ออกแบบระบบ dashboard ยอดขายและเขียนต้นแบบโค้ด (e2e A)", project: "proja", files: ["src/app.js", ".env", "nope.md"] });
  assert.equal(jA.status, 202);
  const jB = await post("/api/jobs", { goal: "เขียน API คูปองส่วนลดพร้อมทดสอบ (e2e B)", project: "projb" });
  assert.equal(jB.status, 202);
  const jobA = jA.body.job, jobB = jB.body.job;
  assert.equal(jobA.project, "proja");
  assert.ok(jobA.outputDir.replace(/\\/g, "/").toLowerCase().includes("/proja/.grock/out/" + jobA.id.toLowerCase()), `outputDir ผิด: ${jobA.outputDir}`);
  assert.deepEqual(jobA.files, ["src/app.js", ".env", "nope.md"]);
  assert.ok(["planning", "running"].includes(jobA.status));
  const det = (await json(`/api/jobs/${jobA.id}`)).body;
  assert.equal(det.job.id, jobA.id);
  assert.ok(Array.isArray(det.tasks));
  const stMid = (await json("/api/state")).body;
  const capMid = stMid.agents.find((a) => a.role === "captain");
  assert.equal(capMid.status, "working", "กัปตันต้องกำลังทำงานระหว่างวางแผน 2 โจทย์");
  assert.ok(await waitFor((e) => e.type === "job.planned" && e.data.job.id === jobA.id, 30_000), "โจทย์ A ต้องถูกวางแผน");
  assert.ok(await waitFor((e) => e.type === "job.planned" && e.data.job.id === jobB.id, 30_000), "โจทย์ B ต้องถูกวางแผน (ref-count ไม่บล็อก)");
  console.log("✅ POST /api/jobs → 202 ทันที (status planning), GET /api/jobs/:id, 2 โจทย์วางแผนพร้อมกัน");

  const endA = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jobA.id);
  const endB = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jobB.id);
  assert.equal(endA?.type, "job.completed", "A ต้องสำเร็จ");
  assert.equal(endB?.type, "job.completed", "B ต้องสำเร็จ");
  const st1 = (await json("/api/state")).body;
  const tasksA = st1.tasks.filter((t) => t.jobId === jobA.id);
  const tasksB = st1.tasks.filter((t) => t.jobId === jobB.id);
  const producersB = tasksB.filter((t) => t.role !== "reviewer");
  assert.ok(producersB.length >= 1 && producersB.length <= 2, `maxTasks=2 แต่ได้งานผลิต ${producersB.length}`);
  assert.equal(tasksB.filter((t) => t.role === "reviewer").length, 1, "ต้องมีงาน QA ปิดท้าย 1 ชิ้น");
  assert.ok(tasksB.every((t) => ["coder", "reviewer"].includes(t.role)), `plan.roles ต้องจำกัดตำแหน่ง: ${tasksB.map((t) => t.role)}`);
  assert.ok(tasksB.some((t) => t.history.some((h) => h.type === "override" && h.note.includes("model"))), "dev-1 ต้องถูกบันทึกว่าใช้ค่าเฉพาะโปรเจกต์ (model)");
  assert.ok(tasksA.every((t) => (t.usage.cacheReadTokens || 0) > 0), "งานของโปรเจกต์ต้องมีโทเคนแคชจำลอง");
  assert.ok(tasksA.some((t) => String(t.output).includes("ผลงานจำลองสำหรับโปรเจกต์")), "ผลงาน sim ต้องระบุว่าใช้บริบทโปรเจกต์");
  assert.ok(st1.totals.cacheReadTokens === undefined || st1.totals.cacheReadTokens >= 0);
  const cap1 = st1.agents.find((a) => a.role === "captain");
  assert.equal(cap1.status, "idle", "กัปตันต้องว่างหลังทั้งสองโจทย์จบ");
  assert.equal(cap1.activeJobs || 0, 0);
  assert.ok((cap1.metrics.cacheReadTokens || 0) >= 0);
  console.log(`✅ ทั้งสองโจทย์สำเร็จ (A ${tasksA.length} งาน, B ${tasksB.length} งาน ตำแหน่ง ${[...new Set(tasksB.map((t) => t.role))]}) กัปตันว่าง ref-count=0`);

  // --- ไฟล์ผลงาน ---
  await sleep(300);
  const outA = path.join(rootA, ".grock", "out", jobA.id);
  assert.ok(fs.existsSync(path.join(outA, "result.md")), "result.md");
  assert.ok(fs.existsSync(path.join(outA, "plan.json")), "plan.json");
  const jobJson = JSON.parse(fs.readFileSync(path.join(outA, "job.json"), "utf8"));
  assert.equal(jobJson.status, "done");
  assert.equal(jobJson.tasks.length, tasksA.length);
  const taskFiles = fs.readdirSync(path.join(outA, "tasks"));
  assert.equal(taskFiles.length, tasksA.length, "ผลงานรายชิ้นครบทุกงาน");
  assert.ok(taskFiles.every((f) => /^\d{2}-[a-z]+-/.test(f)));
  const latest = fs.readFileSync(path.join(rootA, ".grock", "out", "latest.md"), "utf8");
  assert.equal(latest, fs.readFileSync(path.join(outA, "result.md"), "utf8"));
  assert.ok(!latest.includes("ghp_abc") && !fs.readFileSync(path.join(outA, "job.json"), "utf8").includes("ghp_abc"));
  assert.ok(fs.existsSync(path.join(rootB, ".grock", "out", jobB.id, "result.md")));
  console.log("✅ .grock/out/<jobId>/{result.md,plan.json,job.json,tasks/NN-role-*.md} + latest.md");

  // --- งบต่อโจทย์ ---
  const jC = await post("/api/jobs", { goal: "จัดทำแผนการตลาดและประเมินต้นทุน (e2e C งบน้อย)", project: "projc" });
  assert.equal(jC.status, 202);
  const endC = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jC.body.job.id);
  assert.equal(endC?.type, "job.failed", "งบ $0.02 ต้องทำให้โจทย์ล้มเหลวเพราะเกินงบหลังงานแรก ๆ เสร็จ");
  const budgetLog = events.find((e) => e.type === "log" && e.data.jobId === jC.body.job.id && e.data.message.includes("เกินงบ"));
  assert.ok(budgetLog, "ต้องมี log เกินงบ");
  await sleep(300);
  const st2 = (await json("/api/state")).body;
  const tasksC = st2.tasks.filter((t) => t.jobId === jC.body.job.id);
  console.log("   สถานะงานของ C:", tasksC.map((t) => `${t.role}:${t.status}`).join(", "), "ใช้ไป $" + (endC.data.job.costUsd || 0).toFixed(4));
  assert.ok(tasksC.every((t) => ["done", "cancelled", "failed"].includes(t.status)), "งานทุกชิ้นต้องจบสถานะ");
  assert.ok(tasksC.some((t) => t.status === "cancelled"), "ต้องมีงานที่ถูกยกเลิกเพราะงบ");
  assert.ok(!tasksC.some((t) => ["running", "assigned", "queued"].includes(t.status)), "ต้องไม่มีงานค้างหรือวิ่งต่อหลังเกินงบ");
  assert.ok((endC.data.job.costUsd || 0) > 0.02, "ต้นทุนที่บันทึกต้องเกินงบ");
  assert.ok(fs.existsSync(path.join(rootC, ".grock", "out", jC.body.job.id, "result.md")), "โจทย์ล้มเหลวก็ต้องมี result.md");
  assert.equal(st2.agents.find((a) => a.role === "captain").status, "idle");
  const cancelledC = tasksC.find((t) => t.status === "cancelled");
  assert.equal((await post(`/api/tasks/${cancelledC.id}/retry`, {})).status, 409, "retry หลังเกินงบ → 409 พร้อมคำอธิบาย");
  assert.equal((await json(`/api/jobs/${jC.body.job.id}`)).body.job.status, "failed", "โจทย์ต้องยังเป็น failed (ไม่ล้มซ้ำ/ไม่ถูกปลุก)");
  console.log("✅ budget.maxUsdPerJob: หยุดงานที่เหลือ → job.failed, ผลงานที่เสร็จแล้วยังถูกบันทึก");

  // --- แก้ .grock แล้วโจทย์ถัดไปเห็นค่าใหม่ (mtime) ---
  fs.writeFileSync(path.join(rootA, ".grock", "brief.md"), "# ProjA\nโปรเจกต์ A ฉบับแก้ใหม่ 2\n", "utf8");
  const t = new Date(Date.now() + 3000); fs.utimesSync(path.join(rootA, ".grock", "brief.md"), t, t);
  const ctx2 = (await json("/api/projects/proja/context?role=captain")).body;
  assert.ok(ctx2.system.includes("ฉบับแก้ใหม่ 2"), "แก้ brief.md แล้วต้องเห็นโดยไม่รีสตาร์ต");

  // --- โจทย์ไม่ระบุโปรเจกต์ยังทำงานได้เหมือนเดิม ---
  const jN = await post("/api/jobs", { goal: "สรุปแนวโน้มตลาด AI ปี 2026 (e2e ไม่มีโปรเจกต์)" });
  assert.equal(jN.status, 202);
  assert.equal(jN.body.job.project, null);
  assert.equal(jN.body.job.outputDir, null);
  const endN = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jN.body.job.id);
  assert.equal(endN?.type, "job.completed");
  console.log("✅ mtime reload + โจทย์ไม่มีโปรเจกต์ยังทำงานปกติ");

  // --- CANCEL/HANDOFF: ยกเลิกงานผลิตที่กำลังวิ่ง ---
  {
    const jX = await post("/api/jobs", { goal: "ออกแบบระบบสมาชิกและเขียนต้นแบบโค้ด (e2e cancel)", project: "proja" });
    assert.equal(jX.status, 202);
    // เลือกงานผลิตที่มี QA ตรวจ (ไม่ใช่งานวิจัยชิ้นแรกที่ไม่มี QA) แล้วรอให้มันเริ่มทำ
    assert.ok(await waitFor((e) => e.type === "job.planned" && e.data.job.id === jX.body.job.id, 30_000));
    const planned = (await json("/api/state")).body.tasks.filter((t) => t.jobId === jX.body.job.id);
    const reviewed = planned.find((t) => t.role !== "reviewer" && planned.some((q) => q.reviewOfId === t.id));
    assert.ok(reviewed, "แผนต้องมีงานผลิตที่มี QA: " + JSON.stringify(planned.map((t) => [t.role, t.reviewOfId])));
    const started = await waitFor((e) => e.type === "task.started" && e.data.task.id === reviewed.id, 60_000);
    assert.ok(started, "งานที่มี QA ต้องเริ่มทำ");
    const tid = started.data.task.id;
    // ส่งต่อให้คนอื่นก่อน (ทำให้มี run เก่าที่ถูก abort + run ใหม่) แล้วค่อยยกเลิก
    const stX = (await json("/api/state")).body;
    const other = stX.agents.find((a) => a.role !== "captain" && a.id !== started.data.task.assignedTo && a.status === "idle");
    if (other) {
      const h = await post(`/api/tasks/${tid}/handoff`, { agentId: other.id, reason: "e2e" });
      assert.equal(h.status, 200, JSON.stringify(h.body));
      await waitFor((e) => e.type === "task.started" && e.data.task.id === tid && e.data.task.assignedTo === other.id, 15_000);
    }
    const c = await post(`/api/tasks/${tid}/cancel`, {});
    assert.equal(c.status, 200, JSON.stringify(c.body));
    await sleep(4000); // ให้ run เก่า/ใหม่ที่ค้างอยู่วิ่งจนถึงจุดที่จะ finish (ถ้าบั๊กยังอยู่ สถานะจะพลิกเป็น done)
    const stY = (await json("/api/state")).body;
    const tX = stY.tasks.find((t) => t.id === tid);
    assert.equal(tX.status, "cancelled", "งานที่ยกเลิกต้องคงเป็น cancelled ไม่พลิกเป็น done (owner check)");
    assert.ok(!tX.history.some((h) => h.type === "done"), "ต้องไม่มี history done หลังยกเลิก");
    const qa = stY.tasks.filter((t) => t.jobId === jX.body.job.id && t.reviewOfId === tid);
    assert.ok(qa.length >= 1 && qa.every((t) => t.status === "cancelled"), "QA ของงานที่ถูกยกเลิกต้องถูกยกเลิกตาม: " + JSON.stringify(qa.map((t) => t.status)));
    const endX = await waitFor((e) => ["job.completed", "job.failed"].includes(e.type) && e.data.job.id === jX.body.job.id);
    assert.ok(endX, "โจทย์ต้องจบ (ไม่ค้าง)");
    const stZ = (await json("/api/state")).body;
    assert.equal(stZ.tasks.find((t) => t.id === tid).status, "cancelled", "หลังโจทย์จบ งานที่ยกเลิกยังต้องเป็น cancelled");
    assert.ok(stZ.agents.every((a) => a.role === "captain" || a.status !== "working"), "ไม่มีใครค้างทำงาน");
    console.log("✅ cancel/handoff: งานคง cancelled, QA ถูกยกเลิกตาม, โจทย์จบ, ไม่มี run ซ้อน");
  }

  stop = true; ac.abort(); await pump;
  assert.ok(!/Error|TypeError|ReferenceError/.test(stderr), `เซิร์ฟเวอร์มี error ใน stderr:\n${stderr.slice(0, 2000)}`);
  console.log("E2E PROJECTS ALL PASSED");
} finally {
  child.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}
