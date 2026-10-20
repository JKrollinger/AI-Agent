// test-hermes.mjs — unit: โทเคนสิทธิ์จำกัด (parse/lookup/scope/งบรายวัน), validateExternalPlan, ลายเซ็น webhook + summary + checkWebhookUrl
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

process.env.LOG_EVENTS = "0";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-hermes-unit-"));
process.env.GROCK_DATA_DIR = TMP;
process.env.TOKEN_DAILY_USD = "1";
process.env.WEBHOOK_SECRET = "unit-secret";
process.env.WEBHOOK_ALLOWED_HOSTS = ".example.com,127.0.0.1";

const T = await import(new URL("../../server/tokens.js", import.meta.url).href);
const W = await import(new URL("../../server/webhook.js", import.meta.url).href);
const X = await import(new URL("../../server/executor.js", import.meta.url).href);
const { bus } = await import(new URL("../../server/bus.js", import.meta.url).href);
const { state } = await import(new URL("../../server/state.js", import.meta.url).href);

try {
  // ---------- parseTokens / lookupToken ----------
  const good = "hermes:abcdefghijklmnopqrstuvwxyz123456:jobs, ops:ABCDEFGHIJKLMNOPQRSTUVWXYZ0001:admin,bot:zzzzzzzzzzzzzzzzzzzz";
  const { tokens, warnings } = T.parseTokens(good);
  assert.equal(tokens.size, 3);
  assert.deepEqual(tokens.get("abcdefghijklmnopqrstuvwxyz123456"), { name: "hermes", scope: "jobs" });
  assert.deepEqual(tokens.get("ABCDEFGHIJKLMNOPQRSTUVWXYZ0001"), { name: "ops", scope: "admin" });
  assert.equal(tokens.get("zzzzzzzzzzzzzzzzzzzz").scope, "jobs", "ไม่ระบุสิทธิ์ → jobs");
  assert.deepEqual(warnings, []);
  const bad = T.parseTokens("x:short:jobs,hermes:abcdefghijklmnopqrstuvwxyz123456:root,hermes:abcdefghijklmnopqrstuvwxyz123457:jobs,HERMES:abcdefghijklmnopqrstuvwxyz123458:jobs,ok name:abcdefghijklmnopqrstuvwxyz1234:jobs,justname,a:b:c:d");
  assert.equal(bad.tokens.size, 1, `รายการผิดรูปต้องถูกข้าม: ${JSON.stringify([...bad.tokens.values()])}`);
  assert.equal(bad.warnings.length, 6, bad.warnings.join(" | "));
  assert.equal(T.parseTokens("").tokens.size, 0);
  assert.deepEqual(T.lookupToken(tokens, "abcdefghijklmnopqrstuvwxyz123456"), { name: "hermes", scope: "jobs" });
  assert.equal(T.lookupToken(tokens, "abcdefghijklmnopqrstuvwxyz12345"), null);
  assert.equal(T.lookupToken(tokens, ""), null);
  console.log("✅ parseTokens/lookupToken: รูปแบบ ชื่อ:โทเคน:สิทธิ์, ข้ามรายการผิด, เทียบ timing-safe");

  // ---------- scopeAllows ----------
  const allow = [["POST", "/api/jobs"], ["GET", "/api/jobs"], ["GET", "/api/jobs/job-1"], ["GET", "/api/state"], ["GET", "/api/projects"], ["GET", "/api/projects/shop/context"], ["GET", "/api/agents"], ["GET", "/api/health"]];
  const deny = [["POST", "/api/projects"], ["POST", "/api/projects/reload"], ["POST", "/api/demo"], ["POST", "/api/mode"], ["POST", "/api/settings"], ["POST", "/api/tasks/t1/cancel"], ["POST", "/api/agents/dev-1/config"], ["GET", "/api/events"], ["GET", "/api/logs"], ["GET", "/api/tasks/t1/patch"], ["GET", "/"], ["GET", "/index.html"], ["DELETE", "/api/jobs"], ["GET", "/api/projects/shop/context/x"]];
  for (const [m, p] of allow) assert.ok(T.scopeAllows("jobs", m, p), `jobs ต้องเรียก ${m} ${p} ได้`);
  for (const [m, p] of deny) assert.ok(!T.scopeAllows("jobs", m, p), `jobs ต้องเรียก ${m} ${p} ไม่ได้`);
  for (const [m, p] of [...allow, ...deny]) assert.ok(T.scopeAllows("admin", m, p));
  assert.ok(!T.scopeAllows("other", "GET", "/api/state"));
  console.log("✅ scopeAllows: jobs = สั่ง/ดูโจทย์ + state/projects/context/agents เท่านั้น, admin ทำได้ทุกอย่าง");

  // ---------- งบรายวัน ----------
  assert.equal(T.TOKEN_DAILY_USD, 1);
  assert.equal(T.recordedToday("hermes"), 0);
  let b = T.dailyBudget("hermes");
  assert.deepEqual(b, { ok: true, used: 0, limit: 1 });
  T.addTokenCost("hermes", 0.4, { jobs: 1 });
  T.addTokenCost("hermes", 0.5, { jobs: 1 });
  assert.ok(Math.abs(T.recordedToday("hermes") - 0.9) < 1e-9);
  assert.ok(T.dailyBudget("hermes").ok, "0.9 < 1 ยังสั่งได้");
  T.addTokenCost("hermes", 0.1);
  b = T.dailyBudget("hermes");
  assert.ok(!b.ok && Math.abs(b.used - 1) < 1e-9, "ครบ $1 → ไม่ให้สั่งต่อ");
  assert.ok(T.dailyBudget("other").ok, "โทเคนอื่นไม่กระทบ");
  assert.ok(T.dailyBudget("hermes", 0).ok, "limit 0 = ไม่จำกัด");
  const file = JSON.parse(fs.readFileSync(path.join(TMP, "token-usage.json"), "utf8"));
  const day = T.dayKey();
  assert.equal(file[day].hermes.jobs, 2);
  assert.ok(Math.abs(file[day].hermes.usd - 1) < 1e-9);
  T.resetUsageCache();
  assert.ok(Math.abs(T.recordedToday("hermes") - 1) < 1e-9, "อ่านกลับจากไฟล์ได้");
  // โจทย์ที่กำลังวิ่งของโทเคนนับเข้า used ด้วย (liveSpend)
  const { createJob, createTask } = await import(new URL("../../server/state.js", import.meta.url).href);
  const jobLive = createJob("live", { source: "bot", sourceKind: "token" });
  jobLive.status = "running";
  const t1 = createTask({ jobId: jobLive.id, seq: 1, title: "x", description: "", role: "coder" });
  t1.usage.costUsd = 0.3;
  jobLive.taskIds = [t1.id];
  jobLive.planCostUsd = 0.05;
  assert.ok(Math.abs(T.liveSpend("bot") - 0.35) < 1e-9);
  assert.ok(Math.abs(T.dailyBudget("bot").used - 0.35) < 1e-9);
  // attachTokenMeter: job.failed แล้ว job.updated ตามมาพร้อมต้นทุนใหม่ → นับเฉพาะส่วนเพิ่ม, โจทย์นับ 1 ครั้ง
  const off = T.attachTokenMeter(bus);
  jobLive.status = "failed"; jobLive.costUsd = 0.35;
  bus.publish("job.failed", { job: jobLive });
  assert.ok(Math.abs(T.recordedToday("bot") - 0.35) < 1e-9, "job.failed → บันทึก 0.35");
  assert.equal(T.liveSpend("bot"), 0, "โจทย์จบแล้วไม่นับเป็น live");
  jobLive.costUsd = 0.5;
  bus.publish("job.updated", { job: jobLive });
  assert.ok(Math.abs(T.recordedToday("bot") - 0.5) < 1e-9, "job.updated หลังล้ม → เพิ่มเฉพาะส่วนต่าง 0.15");
  bus.publish("job.completed", { job: jobLive });
  assert.ok(Math.abs(T.recordedToday("bot") - 0.5) < 1e-9, "ไม่นับซ้ำ");
  T.resetUsageCache();
  assert.equal(JSON.parse(fs.readFileSync(path.join(TMP, "token-usage.json"), "utf8"))[day].bot.jobs, 1);
  const jobLocal = createJob("local", { source: "local", sourceKind: "local" });
  jobLocal.costUsd = 9; bus.publish("job.completed", { job: jobLocal });
  assert.equal(T.recordedToday("local"), 0, "โจทย์ที่ไม่ได้มาจากโทเคนไม่นับ");
  off();
  state.jobs.clear(); state.tasks.clear();
  console.log("✅ งบรายวัน: สะสม/อ่านไฟล์/ครบงบ → ไม่ให้สั่ง, นับโจทย์ที่กำลังวิ่ง, meter ไม่นับซ้ำ");

  // ---------- validateExternalPlan ----------
  const roster = [{ id: "res-1", role: "researcher" }, { id: "dev-1", role: "coder" }, { id: "qa-1", role: "reviewer" }];
  const ok = X.validateExternalPlan([
    { title: "  วิจัย\tตลาด ", brief: "หาข้อมูล", role: "Researcher" },
    { title: "โค้ด", brief: "เขียน", agentId: "dev-1", dependsOn: [0, 0] },
    { title: "ตรวจ", description: "ตรวจงาน", role: "reviewer", depends_on: [1] },
  ], roster);
  assert.deepEqual(ok, [
    { title: "วิจัย ตลาด", description: "หาข้อมูล", role: "researcher", assignee: "", depends_on: [] },
    { title: "โค้ด", description: "เขียน", role: "coder", assignee: "dev-1", depends_on: [0] },
    { title: "ตรวจ", description: "ตรวจงาน", role: "reviewer", assignee: "", depends_on: [1] },
  ]);
  const rejects = (plan, re) => assert.throws(() => X.validateExternalPlan(plan, roster), re);
  rejects("x", /อาร์เรย์/);
  rejects([], /อย่างน้อย 1/);
  rejects(Array.from({ length: 13 }, () => ({ title: "a", brief: "b", role: "coder" })), /ไม่เกิน 12/);
  rejects([null], /plan\[0\] ต้องเป็นออบเจกต์/);
  rejects([{ brief: "b", role: "coder" }], /plan\[0\]\.title ต้องไม่ว่าง/);
  rejects([{ title: "a".repeat(71), brief: "b", role: "coder" }], /title ยาวเกิน 70/);
  rejects([{ title: "a", role: "coder" }], /brief ต้องไม่ว่าง/);
  rejects([{ title: "a", brief: "b" }], /ต้องระบุ role .* หรือ agentId/);
  rejects([{ title: "a", brief: "b", role: "captain" }], /role "captain" ไม่ถูกต้อง/);
  rejects([{ title: "a", brief: "b", agentId: "ghost" }], /agentId "ghost" ไม่มีในทีม/);
  rejects([{ title: "a", brief: "b", agentId: "dev-1", role: "finance" }], /ไม่ตรงกับตำแหน่งของ dev-1/);
  rejects([{ title: "a", brief: "b", role: "coder", dependsOn: [0] }], /plan\[0\]\.dependsOn/);
  rejects([{ title: "a", brief: "b", role: "coder" }, { title: "c", brief: "d", role: "coder", dependsOn: [2] }], /plan\[1\]\.dependsOn/);
  rejects([{ title: "a", brief: "b", role: "coder" }, { title: "c", brief: "d", role: "coder", dependsOn: ["0"] }], /plan\[1\]\.dependsOn/);
  rejects([{ title: "a", brief: "b", role: "coder", dependsOn: "0" }], /dependsOn ต้องเป็นอาร์เรย์/);
  // แผน 12 งานผ่าน normalizePlan ด้วยเพดาน MAX_EXTERNAL_PLAN_TASKS → ครบ 12 + QA ปิดท้าย 1
  const twelve = X.validateExternalPlan(Array.from({ length: 12 }, (_, i) => ({ title: `งาน ${i}`, brief: "b", role: "coder", dependsOn: i ? [i - 1] : [] })), roster);
  const norm = X.normalizePlan(twelve, undefined, { maxTasks: X.MAX_EXTERNAL_PLAN_TASKS, maxTasksCap: X.MAX_EXTERNAL_PLAN_TASKS });
  assert.equal(norm.filter((t) => t.role !== "reviewer").length, 12);
  assert.equal(norm.filter((t) => t.role === "reviewer").length, 1);
  assert.equal(X.normalizePlan(twelve, undefined, {}).filter((t) => t.role !== "reviewer").length, 8, "ไม่มีเพดานพิเศษ → ยังจำกัด 8 เหมือนเดิม");
  console.log("✅ validateExternalPlan: title/brief/role|agentId/dependsOn, ไม่เกิน 12, ข้อความระบุตำแหน่งที่ผิด; normalizePlan รับเพดาน 12");

  // ---------- webhook: ลายเซ็น ----------
  const body = JSON.stringify({ jobId: "job-1", status: "done" });
  const h = W.signatureHeaders(body, { secret: "unit-secret", ts: 1700000000 });
  const hex = crypto.createHmac("sha256", "unit-secret").update(body).digest("hex");
  assert.equal(h["X-Grock-Signature"], `sha256=${hex}`);
  assert.equal(h["X-Webhook-Signature"], hex);
  assert.equal(h["X-Webhook-Timestamp"], "1700000000");
  assert.equal(h["X-Webhook-Signature-V2"], crypto.createHmac("sha256", "unit-secret").update(`1700000000.${body}`).digest("hex"), "V2 ของ Hermes = HMAC(<ts>.<body>)");
  assert.deepEqual(W.signatureHeaders(body, { secret: "" }), {}, "ไม่มี secret → ไม่มีหัวลายเซ็น");
  assert.ok(W.verifySignature(body, h["X-Grock-Signature"], { secret: "unit-secret" }));
  assert.ok(W.verifySignature(body, hex, { secret: "unit-secret" }), "รับ hex ล้วน");
  assert.ok(!W.verifySignature(body + " ", h["X-Grock-Signature"], { secret: "unit-secret" }), "body เปลี่ยน → ไม่ผ่าน");
  assert.ok(!W.verifySignature(body, h["X-Grock-Signature"], { secret: "wrong" }));
  assert.ok(!W.verifySignature(body, "", { secret: "unit-secret" }));
  const now = Math.floor(Date.now() / 1000);
  const h2 = W.signatureHeaders(body, { secret: "unit-secret", ts: now });
  assert.ok(W.verifySignature(body, h2["X-Webhook-Signature-V2"], { secret: "unit-secret", ts: now }));
  assert.ok(!W.verifySignature(body, h2["X-Webhook-Signature-V2"], { secret: "unit-secret", ts: now - 1000 }), "ts เก่าเกิน 300 วินาที → ไม่ผ่าน");
  console.log("✅ ลายเซ็น webhook: X-Grock-Signature sha256=hex, V1/V2 แบบ Hermes, verify timing-safe + กัน replay");

  // ---------- webhook: summary / payload / url ----------
  const para1 = "ย่อหน้าแรกที่ยาวพอสมควรสำหรับทดสอบการตัดย่อหน้าและการข้ามบรรทัดหัวข้อ markdown ทั้งหมดในผลลัพธ์ของกัปตัน ซึ่งต้องยาวเกิน 120 ตัวอักษรจึงจะถือว่าเป็นสรุปที่พออ่านรู้เรื่องโดยไม่ต้องต่อย่อหน้าถัดไป";
  assert.ok(para1.length >= 120);
  assert.equal(W.summaryOf(`# หัวข้อ\n\n${para1}\n\nย่อหน้าสอง`), para1, "ย่อหน้าแรกยาวพอ → เอาแค่ย่อหน้าแรก ไม่เอาหัวข้อ");
  assert.equal(W.summaryOf("## A\nสั้น\n\n## B\nย่อหน้าสองต่อให้ยาวพอ"), "สั้น\n\nย่อหน้าสองต่อให้ยาวพอ", "ย่อหน้าแรกสั้น → ต่อย่อหน้าถัดไป");
  assert.equal(W.summaryOf(""), "");
  const long = W.summaryOf("ก".repeat(3000));
  assert.equal(long.length, 1500); assert.ok(long.endsWith("…"));
  const job = { id: "job-9", status: "done", goal: "โจทย์", project: "shop", outputDir: "C:/p/.grock/out/job-9", costUsd: 0.123456, durationMs: 65_400, createdAt: 1, finishedAt: 65_401, requestedBy: "telegram:@u", source: "hermes", planSource: "external" };
  const p = W.buildPayload(job, { summary: "สรุป", resultPath: "C:/p/.grock/out/job-9/result.md" });
  assert.equal(p.event, "job.completed"); assert.equal(p.jobId, "job-9"); assert.equal(p.costUsd, 0.1235); assert.equal(p.durationSec, 65);
  assert.equal(p.requestedBy, "telegram:@u"); assert.equal(p.resultPath, "C:/p/.grock/out/job-9/result.md"); assert.equal(p.planSource, "external");
  assert.equal(W.buildPayload({ ...job, status: "failed", error: "เกินงบ" }).event, "job.failed");
  assert.ok(W.checkWebhookUrl("https://hooks.example.com/webhooks/grock").url);
  assert.ok(W.checkWebhookUrl("http://127.0.0.1:8644/webhooks/x").url);
  assert.match(W.checkWebhookUrl("https://evil.com/x").error, /WEBHOOK_ALLOWED_HOSTS/);
  assert.match(W.checkWebhookUrl("ftp://hooks.example.com/x").error, /http/);
  assert.match(W.checkWebhookUrl("not a url").error, /URL/);
  assert.match(W.checkWebhookUrl("https://u:p@hooks.example.com/x").error, /รหัสผ่าน/);
  assert.match(W.checkWebhookUrl("https://hooks.example.com/x", []).error, /ยังไม่ได้ตั้ง WEBHOOK_ALLOWED_HOSTS/);
  assert.ok(W.hostAllowed("sub.example.com", [".example.com"]) && W.hostAllowed("example.com", [".example.com"]) && !W.hostAllowed("example.com.evil", [".example.com"]));
  console.log("✅ summaryOf/buildPayload/checkWebhookUrl");

  // ---------- deliver: retry 3 ครั้ง + หัวลายเซ็น ----------
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); if (calls.length < 3) throw new Error("ECONNREFUSED"); return { ok: true, status: 200 }; };
  const r = await W.deliver("https://hooks.example.com/w", { a: 1 }, { secret: "unit-secret", retryMs: 10, fetchImpl });
  assert.deepEqual({ ok: r.ok, status: r.status, attempts: r.attempts }, { ok: true, status: 200, attempts: 3 });
  assert.equal(calls.length, 3);
  assert.ok(W.verifySignature(calls[2].body, calls[2].headers["X-Grock-Signature"], { secret: "unit-secret" }));
  assert.equal(JSON.parse(calls[2].body).a, 1);
  const r2 = await W.deliver("https://hooks.example.com/w", {}, { secret: "unit-secret", retryMs: 10, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.deepEqual({ ok: r2.ok, status: r2.status, attempts: r2.attempts, error: r2.error }, { ok: false, status: 500, attempts: 3, error: "HTTP 500" });
  console.log("✅ deliver: ลองใหม่จนครบ 3 ครั้ง, หัวลายเซ็นตรวจผ่าน, ล้มเหลวรายงาน HTTP 500");

  console.log("HERMES UNIT ALL PASSED");
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
