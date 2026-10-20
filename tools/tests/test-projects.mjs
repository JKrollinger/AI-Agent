// test-projects.mjs — unit tests ของ server/projects.js (พาธ Windows, encoding, ค่าลับ, pack, context, overrides)
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-test-"));
process.env.GROCK_DATA_DIR = path.join(TMP, "data");
process.env.LOG_EVENTS = "0";
const P = await import(new URL("../../server/projects.js", import.meta.url).href);

// --- โปรเจกต์ทดสอบ ---
const root = path.join(TMP, "MyShop");
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.mkdirSync(path.join(root, "src", "deep", "deeper"), { recursive: true });
fs.writeFileSync(path.join(root, "README.md"), "# MyShop\n\nร้านค้าออนไลน์\n\n## Setup\nnpm install\n\n## Deploy\nvercel deploy\n", "utf8");
fs.writeFileSync(path.join(root, "CLAUDE.md"), "\uFEFF# กติกา\nAPI_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789\nห้ามแตะ legacy/\n", "utf8"); // BOM + ค่าลับ
fs.writeFileSync(path.join(root, "docs", "utf16.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("# เอกสาร UTF-16\nเนื้อหาไทย", "utf16le")]));
fs.writeFileSync(path.join(root, "docs", "guide.md"), "# คู่มือ\n\nรายละเอียด\n", "utf8");
fs.writeFileSync(path.join(root, ".env"), "SECRET=1\n", "utf8");
fs.writeFileSync(path.join(root, "src", "app.js"), "console.log(1)\n", "utf8");
fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
let junctionOk = false;
try {
  execSync(`cmd /c mklink /J "${path.join(root, "outside")}" "${path.join(TMP)}"`, { stdio: "ignore" });
  junctionOk = fs.existsSync(path.join(root, "outside"));
} catch {}

// --- resolveInRoot ---
assert.equal(P.resolveInRoot(root, "src/app.js").rel, "src/app.js");
assert.equal(P.resolveInRoot(root, "SRC\\APP.JS").rel, "src/app.js", "ตัวพิมพ์ต่างกันบน Windows ต้อง resolve ได้");
assert.throws(() => P.resolveInRoot(root, "../x"), /นอกโปรเจกต์|ห้าม/);
assert.throws(() => P.resolveInRoot(root, "C:/Windows/win.ini"), /สัมพัทธ์|ไม่ถูกต้อง/);
assert.throws(() => P.resolveInRoot(root, "docs/NUL"), /สงวน/);
assert.throws(() => P.resolveInRoot(root, "docs/guide.md:evil"), /ไม่ถูกต้อง/);
assert.throws(() => P.resolveInRoot(root, "src/../../x.txt"), /นอกโปรเจกต์|ห้าม/);
if (junctionOk) assert.throws(() => P.resolveInRoot(root, "outside/data/projects.json"), /นอกโฟลเดอร์/, "junction ที่ชี้ออกนอกต้องถูกปฏิเสธ");
assert.ok(P.isDeniedPath(".env") && P.isDeniedPath("config/.env.local") && P.isDeniedPath("keys/server.pem") && P.isDeniedPath(".git/config") && P.isDeniedPath("a/credentials.json"));
assert.ok(!P.isDeniedPath("README.md") && !P.isDeniedPath("src/app.js"));
console.log(`✅ resolveInRoot/isDeniedPath${junctionOk ? " (รวม junction)" : " (ไม่มีสิทธิ์สร้าง junction ข้ามเคสนั้น)"}`);

// --- readTextFile / redact ---
const bom = P.readTextFile(path.join(root, "CLAUDE.md"), 8000);
assert.ok(bom.text.startsWith("# กติกา"), "ต้องตัด BOM");
assert.ok(bom.text.includes("[REDACTED]") && !bom.text.includes("sk-ant-abc"), "ต้องปิดบัง API key");
assert.equal(bom.redactions >= 1, true);
const u16 = P.readTextFile(path.join(root, "docs", "utf16.md"), 8000);
assert.ok(u16.text.includes("เอกสาร UTF-16") && !u16.text.includes("\0"), "UTF-16 LE ต้องอ่านได้");
assert.equal(P.readTextFile(path.join(root, "bin.dat"), 100).skippedReason, "ไฟล์ไบนารี");
const big = P.readTextFile(path.join(root, "README.md"), 20);
assert.ok(big.truncated && big.text.includes("ตัดที่ 20"));
assert.equal(P.sliceSection(fs.readFileSync(path.join(root, "README.md"), "utf8"), "setup").trim(), "## Setup\nnpm install");
assert.equal(P.sliceSection("# a\n## b\n", "zzz"), null);
console.log("✅ readTextFile (BOM, UTF-16, binary, truncate), redactSecrets, sliceSection");

// --- registerProject / initPack ---
assert.throws(() => P.registerProject("bad id", root), /id/);
assert.throws(() => P.registerProject("myshop", root), /project\.json/, "ต้องมี .grock/project.json ก่อนลงทะเบียน");
assert.throws(() => P.initPack("C:\\"), /ราก/);
const init = P.initPack(root, { id: "myshop" });
assert.deepEqual(init.always, ["CLAUDE.md", "README.md"]);
assert.ok(fs.existsSync(path.join(root, ".grock", "brief.md")) && fs.existsSync(path.join(root, ".grock", "skills", "README.md")));
assert.ok(fs.readFileSync(path.join(root, ".gitignore"), "utf8").includes(".grock/out/"));
assert.throws(() => P.initPack(root, { id: "myshop" }), /อยู่แล้ว/);
assert.ok(fs.existsSync(P.REGISTRY_FILE));
assert.equal(P.listProjects()[0].id, "myshop");
console.log("✅ initPack/registerProject/listProjects");

// --- loadPack + validation + context ---
fs.writeFileSync(path.join(root, ".grock", "brief.md"), "# MyShop\nร้านค้าออนไลน์ของเรา กติกา: ตอบไทย\n", "utf8");
fs.writeFileSync(path.join(root, ".grock", "skills", "coder.md"), "<!-- replace -->\nใช้ TypeScript เท่านั้น\n", "utf8");
fs.writeFileSync(path.join(root, ".grock", "skills", "reviewer.md"), "ตรวจ unit test ด้วย\n", "utf8");
fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({
  name: "MyShop",
  context: { always: ["CLAUDE.md", "README.md#deploy", "docs/utf16.md", ".env", "missing.md", "../outside.md"], docsIndex: ["docs/*.md"], maxChars: 5000, tree: { depth: 2 } },
  plan: { roles: ["coder", "bogus"], maxTasks: 3 },
  roles: { coder: { model: "claude-haiku-5-5", effort: "xhigh", instructions: "strict", maxTokens: 999999, nonsense: 1 }, writer: { model: "x" } },
  agents: { "dev-1": { model: "not-a-model", duties: "  เขียน   API  " } },
  qa: { maxAttempts: 9, passScore: 80 },
  budget: { maxUsdPerJob: 1.25 },
  output: { dir: "../evil" },
}), "utf8");
const pack = P.loadPack("myshop", { force: true });
assert.equal(pack.name, "MyShop");
assert.deepEqual(pack.config.plan.roles, ["coder"], "ตำแหน่งที่ไม่รู้จักต้องถูกตัด");
assert.equal(pack.config.plan.maxTasks, 3);
assert.equal(pack.config.roles.coder.model, "claude-haiku-5-5");
assert.equal(pack.config.roles.coder.maxTokens, 64000, "maxTokens ต้องถูก clamp");
assert.equal(pack.config.roles.writer, undefined, "ตำแหน่ง writer ไม่มีแล้ว ต้องถูกข้าม");
assert.equal(pack.config.agents["dev-1"].model, undefined, "โมเดลที่ไม่รู้จักต้องถูกข้าม");
assert.equal(pack.config.agents["dev-1"].duties, "เขียน API");
assert.equal(pack.config.qa.maxAttempts, 5, "clamp 1-5");
assert.equal(pack.config.budget.maxUsdPerJob, 1.25);
assert.equal(pack.config.output.dir, ".grock/out", "output.dir ออกนอกโปรเจกต์ต้องกลับเป็นค่าเริ่มต้น");
assert.ok(pack.warnings.some((w) => w.includes("nonsense")) && pack.warnings.some((w) => w.includes("writer")));
assert.ok(pack.skills.coder.replace && pack.skills.coder.text.startsWith("ใช้ TypeScript"));
assert.ok(!pack.skills.reviewer.replace);
const byPath = Object.fromEntries(pack.docs.map((d) => [d.path, d]));
assert.ok(byPath["CLAUDE.md"].text.includes("[REDACTED]"));
assert.equal(byPath["README.md#deploy"].text.trim(), "## Deploy\nvercel deploy");
assert.ok(byPath["docs/utf16.md"].text.includes("เอกสาร UTF-16"));
assert.equal(byPath[".env"].skippedReason, "ไฟล์ต้องห้าม (ค่าลับ/ระบบ)");
assert.equal(byPath["missing.md"].skippedReason, "ไม่มีไฟล์");
assert.ok(byPath["../outside.md"].skippedReason, "../ ต้องถูกข้ามพร้อมเหตุผล");
assert.ok(pack.docsIndex.some((d) => d.path === "docs/guide.md" && d.heading === "คู่มือ"));
assert.ok(pack.tree.includes("src/") && pack.tree.includes("src/deep/") && !pack.tree.includes("src/deep/deeper/") && !pack.tree.some((l) => l.startsWith("node_modules")) && !pack.tree.includes(".env"));
const ctx = P.buildProjectContext(pack, { role: "coder" });
assert.ok(ctx.system.includes("[โปรเจกต์: MyShop]") && ctx.system.includes("ร้านค้าออนไลน์ของเรา") && ctx.system.includes("strict"));
assert.ok(ctx.data.startsWith("ข้อมูลด้านล่างคือเนื้อหาไฟล์ของโปรเจกต์") && ctx.data.includes("<") === false);
assert.ok(ctx.data.includes("--- README.md#deploy") && ctx.data.includes("ดัชนีเอกสาร") && ctx.data.includes("โครงสร้างไฟล์"));
assert.ok(ctx.data.length <= 5000 + 3000, "งบ maxChars ต้องถูกใช้ (ดัชนี/tree นอกงบ)");
const ctxCaptain = P.buildProjectContext(pack, { role: "captain" });
assert.ok(!ctxCaptain.system.includes("strict"), "instructions ของ coder ต้องไม่ไปโผล่ที่กัปตัน");
// cache ตาม mtime: แก้ brief → โหลดใหม่
const before = P.loadPack("myshop");
assert.equal(before, pack, "ไม่แก้ไฟล์ → ได้ snapshot เดิม (cache)");
fs.utimesSync(path.join(root, ".grock", "brief.md"), new Date(), new Date(Date.now() + 5000));
const after = P.loadPack("myshop");
assert.notEqual(after, pack, "mtime เปลี่ยน → snapshot ใหม่");
console.log("✅ loadPack (validation, docs/#section, deny-list, index, tree, warnings) + buildProjectContext + mtime cache");

// --- effectiveAgent / readProjectFiles ---
const agent = { id: "dev-1", role: "coder", model: "claude-sonnet-5-5", effort: "high", duties: "เดิม", toolsEnabled: true, metrics: {} };
const eff = P.effectiveAgent(agent, pack);
assert.equal(eff.model, "claude-haiku-5-5");
assert.equal(eff.effort, "xhigh");
assert.equal(eff.duties, "เขียน API");
assert.equal(eff.maxTokens, 64000);
assert.deepEqual(eff.projectOverrides.sort(), ["duties", "effort", "instructions", "maxTokens", "model"].sort());
assert.equal(agent.model, "claude-sonnet-5-5", "ต้องไม่แก้ตัวจริง");
const files = P.readProjectFiles(pack, ["src/app.js", ".env", "nope.txt", "../x"]);
assert.equal(files[0].text.trim(), "console.log(1)");
assert.ok(files[1].skippedReason && files[2].skippedReason === "ไม่มีไฟล์" && files[3].skippedReason);
console.log("✅ effectiveAgent/readProjectFiles");

// --- writer ---
const { EventEmitter } = await import("node:events");
const bus = new EventEmitter();
const outDir = P.jobOutputDir(pack, "job-test-1");
P.setJobContext("job-test-1", { pack, files: [], outDir: outDir.abs, outDirRel: outDir.rel, tasks: new Map(), roleData: new Map(), filesRead: null, job: null });
P.attachWriter(bus, { agentNameOf: () => "Whitesmith" });
const task = { id: "t1", jobId: "job-test-1", seq: 1, title: "เขียน API: คูปอง/ส่วนลด", role: "coder", status: "done", attempts: 1, usage: { costUsd: 0.01, inputTokens: 10, outputTokens: 5 }, output: "โค้ด…", description: "d", dependsOn: [], toolCalls: 2, review: { score: 88, approved: true } };
const job = { id: "job-test-1", goal: "ทดสอบ", status: "running", createdAt: Date.now(), finishedAt: null, taskIds: ["t1"], costUsd: 0, result: "" };
bus.emit("event", { type: "job.planned", ts: Date.now(), data: { job } });
bus.emit("event", { type: "task.completed", ts: Date.now(), data: { task } });
bus.emit("event", { type: "job.completed", ts: Date.now(), data: { job: { ...job, status: "done", finishedAt: Date.now(), result: "# สรุป\nเสร็จ", costUsd: 0.01 } } });
const taskFile = fs.readdirSync(path.join(outDir.abs, "tasks"))[0];
assert.match(taskFile, /^01-coder-/);
assert.ok(fs.readFileSync(path.join(outDir.abs, "result.md"), "utf8").includes("# สรุป"));
assert.ok(fs.readFileSync(path.join(root, ".grock", "out", "latest.md"), "utf8").includes("เสร็จ"));
assert.equal(JSON.parse(fs.readFileSync(path.join(outDir.abs, "job.json"), "utf8")).tasks[0].review.score, 88);
assert.ok(fs.existsSync(path.join(outDir.abs, "plan.json")));
console.log("✅ attachWriter (tasks/NN-role-slug.md, job.json, plan.json, result.md, latest.md)");

// --- REVIEW FIXES ---
{
  // output.dir ต้องอยู่ใต้ .grock/, plan.roles ต้องมีตำแหน่งผลิต, docsIndex ที่ราก, placement, budget null, agents.<id>.instructions
  fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({
    name: "MyShop2",
    context: { always: ["README.md"], docsIndex: ["*.md", "docs/*.md"], placement: "system" },
    plan: { roles: ["reviewer"] },
    roles: { coder: { instructions: "ของตำแหน่ง" } },
    agents: { "dev-1": { instructions: "ของคนนี้" } },
    output: { dir: "docs" },
  }), "utf8");
  let p2 = P.loadPack("myshop", { force: true });
  assert.equal(p2.config.output.dir, ".grock/out", "output.dir นอก .grock ต้องกลับเป็นค่าเริ่มต้น");
  assert.ok(p2.warnings.some((w) => w.includes("output.dir")));
  assert.deepEqual(p2.config.plan.roles, [], "plan.roles ที่มีแต่ reviewer ต้องถูกยกเลิก");
  assert.ok(p2.warnings.some((w) => w.includes("plan.roles")));
  assert.ok(p2.docsIndex.some((d) => d.path === "README.md") && p2.docsIndex.some((d) => d.path === "CLAUDE.md"), "docsIndex \"*.md\" ที่รากต้องทำดัชนีได้");
  assert.equal(p2.config.context.placement, "system");
  assert.equal(p2.config.budget.maxUsdPerJob, null, "ไม่ตั้งงบ → null (ใช้ env)");
  const c2 = P.buildProjectContext(p2, { role: "coder" });
  assert.ok(c2.brief.includes("[โปรเจกต์: MyShop2]") && !c2.brief.includes("ของตำแหน่ง"));
  assert.ok(c2.roleInstructions.includes("ของตำแหน่ง") && c2.system.includes("ของตำแหน่ง") && c2.placement === "system");
  const e2 = P.effectiveAgent({ id: "dev-1", role: "coder", model: "claude-sonnet-5-5" }, p2);
  assert.equal(e2.instructions, "ของคนนี้", "agents.<id>.instructions ต้องทับ roles.<role>.instructions");
  for (const dir of [".grock/results", ".grock/out/x"]) {
    fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({ output: { dir } }), "utf8");
    assert.equal(P.loadPack("myshop", { force: true }).config.output.dir, dir, dir + " ต้องใช้ได้");
  }
  for (const dir of [".grock/skills", ".grock", ".", "src"]) {
    fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({ output: { dir } }), "utf8");
    assert.equal(P.loadPack("myshop", { force: true }).config.output.dir, ".grock/out", dir + " ต้องถูกปฏิเสธ");
  }
  fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({ budget: { maxUsdPerJob: 0 } }), "utf8");
  assert.equal(P.loadPack("myshop", { force: true }).config.budget.maxUsdPerJob, 0, "ตั้ง 0 ชัดเจน = ไม่จำกัด");
  // ทะเบียน: id แปลก ๆ ต้อง 404 ไม่ใช่ไปโหลด cwd
  for (const bad of ["__proto__", "constructor", "../x", ""]) assert.throws(() => P.loadPack(bad), (e) => e.status === 404, "ต้อง 404: " + bad);
  // ห้ามลงทะเบียนศูนย์ควบคุม (ตัวพิมพ์ต่าง) และโฟลเดอร์ที่ครอบมัน / โฟลเดอร์ผู้ใช้
  for (const dir of [P.CONTROL_CENTER_ROOT.toLowerCase(), path.dirname(P.CONTROL_CENTER_ROOT), path.dirname(path.dirname(P.CONTROL_CENTER_ROOT)), process.env.USERPROFILE, path.dirname(process.env.USERPROFILE)]) {
    assert.throws(() => P.initPack(dir, { id: "zz", register: false }), /ห้าม/, "ต้องห้าม: " + dir);
  }
  // พาธโปรเจกต์ที่ตัวพิมพ์ต่างจากจริง ยังลงทะเบียนได้ (realpath ทำให้ตรง)
  const weird = root.replace(/MyShop$/, "MYSHOP");
  const r2 = P.registerProject("myshop2", weird);
  assert.equal(r2.path.toLowerCase(), root.replace(/\\/g, "/").toLowerCase());
  P.unregisterProject("myshop2");
  // cache: แก้ README (อยู่ใน context.always) → โหลดใหม่โดยไม่ต้องแตะ .grock/
  fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({ context: { always: ["README.md"] } }), "utf8");
  const pa = P.loadPack("myshop", { force: true });
  assert.equal(P.loadPack("myshop"), pa);
  const t2 = new Date(Date.now() + 9000); fs.utimesSync(path.join(root, "README.md"), t2, t2);
  assert.notEqual(P.loadPack("myshop"), pa, "mtime ของไฟล์ใน always เปลี่ยน → snapshot ใหม่");
  // eviction ของ jobContext ต้องไม่เตะโจทย์ที่ยังวิ่ง
  for (let i = 0; i < 70; i++) P.setJobContext("live-" + i, { job: { status: "running" } });
  assert.ok(P.getJobContext("live-0"), "โจทย์ที่ยังวิ่งต้องไม่ถูกเตะ");
  P.setJobContext("done-1", { job: { status: "done" } });
  P.setJobContext("live-99", { job: { status: "running" } });
  assert.ok(!P.getJobContext("done-1") && P.getJobContext("live-99"), "เตะเฉพาะโจทย์ที่จบแล้ว");
  console.log("✅ review fixes: output.dir ใต้ .grock, plan.roles, docsIndex ราก, placement/brief split, budget null/0, id แปลก 404, forbidden roots, cache ตาม always, eviction");
}

// ชื่อเฉพาะโปรเจกต์ (roles.<role>.name / agents.<id>.name): ผ่านการตรวจ, ผสานใน effectiveAgent/displayNameFor, ค่าผิดถูกข้ามพร้อมคำเตือน
{
  fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify({ roles: { marketer: { name: "  ทีม  คอนเทนต์ ", nick: "คอน" }, coder: { name: "" } }, agents: { "res-1": { name: "x".repeat(60), nick: 5 } } }), "utf8");
  const pk = P.loadPack("myshop", { force: true }), cfg = pk.config, w = pk.warnings;
  assert.equal(cfg.roles.marketer.name, "ทีม คอนเทนต์");
  assert.equal(cfg.roles.marketer.nick, "คอน");
  assert.equal(cfg.roles.coder.name, undefined, "ชื่อว่างต้องถูกข้าม");
  assert.equal(cfg.agents["res-1"].name.length, 40, "ชื่อยาวถูกตัดที่ 40");
  assert.equal(cfg.agents["res-1"].nick, undefined, "nick ที่ไม่ใช่ข้อความต้องถูกข้าม");
  assert.ok(w.some((x) => /coder.*name/.test(x)) && w.some((x) => /res-1.*nick/.test(x)), "ต้องมีคำเตือนสำหรับค่าที่ข้าม: " + JSON.stringify(w));
  const pack = { config: cfg };
  const base = { id: "mkt-1", name: "นักการตลาด", nick: "ริน", role: "marketer", model: "claude-sonnet-5-5" };
  const eff = P.effectiveAgent(base, pack);
  assert.equal(eff.name, "ทีม คอนเทนต์"); assert.equal(eff.nick, "คอน"); assert.ok(eff.projectOverrides.includes("name"));
  const eff2 = P.effectiveAgent({ id: "res-1", name: "นักวิจัย", nick: "นักวิจัย", role: "researcher" }, pack);
  assert.equal(eff2.nick, eff2.name, "ไม่มี nick แยกและเดิม nick = name → ตามชื่อใหม่");
  assert.equal(P.displayNameFor(base, pack), "ทีม คอนเทนต์");
  assert.equal(P.displayNameFor(base, null), "นักการตลาด");
  assert.equal(P.effectiveAgent({ id: "dev-1", name: "นักพัฒนา", nick: "โค้ด", role: "coder" }, pack).name, "นักพัฒนา", "ชื่อที่ถูกข้ามต้องไม่ทับชื่อกลาง");
  console.log("✅ project names: roles/agents .name/.nick ผ่านการตรวจ ผสานใน effectiveAgent/displayNameFor");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("PROJECTS UNIT ALL PASSED");
