// test-apply.mjs — unit ของ Project Pack Phase 2 (Developer แก้ไฟล์จริง):
// permissions normalize/glob/canWritePath, unified diff ↔ git apply, patchPaths, claudeArgs, patch จำลอง + apply/reject + audit,
// headless run กับ fake-claude (sandbox, ตัดไฟล์นอกสิทธิ์, usage/cost, timeout), fallback เมื่อไม่มี CLI
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-apply-"));
process.env.GROCK_DATA_DIR = path.join(TMP, "data");
process.env.GROCK_SANDBOX_DIR = path.join(TMP, "sandbox");
process.env.LOG_EVENTS = "0";
const P = await import(new URL("../../server/projects.js", import.meta.url).href);
const A = await import(new URL("../../server/apply.js", import.meta.url).href);
const X = await import(new URL("../../server/executor.js", import.meta.url).href);

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });
assert.equal(git(["--version"]).status, 0, "ต้องมี git");

// ---------------------------------------------------------------------------
// 1) glob
// ---------------------------------------------------------------------------
{
  const re = (g) => P.globToRegExp(g);
  assert.ok(re("src/**").test("src/a/b.js") && re("src/**").test("src/x.js") && !re("src/**").test("lib/x.js"));
  assert.ok(re("**/*.pem").test("a/b/k.pem") && re("**/*.pem").test("k.pem") && !re("**/*.pem").test("k.pem.txt"));
  assert.ok(re("*.md").test("README.md") && !re("*.md").test("docs/x.md"));
  assert.ok(re("src").test("src/x.js") && re("src").test("src") && !re("src").test("srcx/y"));
  assert.ok(re(".env*").test(".env.local") && re("tests/**/*.spec.ts").test("tests/a/b.spec.ts") && re("a?c").test("abc") && !re("a?c").test("a/c"));
  assert.ok(re("**").test("anything/at/all"));
  console.log("✅ globToRegExp");
}

// ---------------------------------------------------------------------------
// 2) permissions normalize + canWritePath (ผ่าน loadPack)
// ---------------------------------------------------------------------------
const root = path.join(TMP, "Proj");
fs.mkdirSync(path.join(root, "src", "lib"), { recursive: true });
fs.mkdirSync(path.join(root, "tests"), { recursive: true });
fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true });
fs.writeFileSync(path.join(root, "README.md"), "# Proj\n", "utf8");
fs.writeFileSync(path.join(root, "src", "app.js"), "const a = 1;\nconst b = 2;\nmodule.exports = { a, b };\n", "utf8");
fs.writeFileSync(path.join(root, "src", "lib", "util.js"), "export const u = 1;\n", "utf8");
fs.writeFileSync(path.join(root, "src", "data.json"), '{"k":1}\n', "utf8");
fs.writeFileSync(path.join(root, ".env"), "SECRET=shh\n", "utf8");
fs.writeFileSync(path.join(root, "node_modules", "x", "index.js"), "module.exports=1\n", "utf8");
P.initPack(root, { id: "proj", register: true });
const writeCfg = (cfg) => { fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify(cfg), "utf8"); return P.loadPack("proj", { force: true }); };
{
  const pack = writeCfg({
    name: "Proj",
    permissions: {
      "dev-1": { write: ["src/**", "tests/**", "../x", "C:/abs", "/root"], deny: [".env*", "**/*.pem", "src/generated/**"], tools: ["Edit", "Write", "Bash(npm test)", "Bash(rm -rf /; echo)", "WebFetch", "Edit"], maxUsd: 2, timeoutSec: 5, model: "claude-haiku-5-5", bogus: 1 },
      "qa-1": { write: [] },
      "bad id!": { write: ["x"] },
      "res-1": { write: ["docs/**"], tools: ["Read"] },
      "eng-1": "nope",
    },
  });
  const d = pack.config.permissions["dev-1"];
  assert.deepEqual(d.write, ["src/**", "tests/**"], "glob ที่ไม่ปลอดภัยถูกตัด");
  assert.deepEqual(d.deny, [".env*", "**/*.pem", "src/generated/**"]);
  assert.deepEqual(d.tools, ["Edit", "Write", "Bash(npm test)"], "เครื่องมือที่ไม่อนุญาต/ซ้ำถูกตัด");
  assert.equal(d.maxUsd, 2);
  assert.equal(d.timeoutSec, 30, "timeoutSec clamp ขั้นต่ำ 30");
  assert.equal(d.model, "claude-haiku-5-5");
  assert.equal(d.linkDeps, true);
  assert.equal(pack.config.permissions["qa-1"], undefined, "ไม่มี write → ไม่มีสิทธิ์");
  assert.equal(pack.config.permissions["res-1"], undefined, "ไม่มี Edit/Write → ไม่มีสิทธิ์");
  assert.equal(Object.keys(pack.config.permissions).length, 1);
  const w = pack.warnings.join("\n");
  for (const s of ["bogus", "rm -rf", "WebFetch", "qa-1", "bad id", "res-1", "../x", "eng-1"]) assert.ok(w.includes(s), `ต้องมีคำเตือนเรื่อง ${s}: ${w}`);
  assert.ok(P.writeGrantFor(pack, "dev-1") && !P.writeGrantFor(pack, "qa-1") && !P.writeGrantFor(pack, "nobody"));
  const g = P.writeGrantFor(pack, "dev-1");
  const ok = (p) => P.canWritePath(g, p).ok;
  assert.ok(ok("src/a.js") && ok("src/deep/x.ts") && ok("tests/t.js"));
  assert.ok(!ok("lib/x.js") && !ok("README.md"));
  assert.ok(!ok("src/.env.local") && !ok("src/k.pem") && !ok("src/secrets.json"), "deny ของโปรเจกต์ + deny-list กลาง");
  assert.ok(!ok(".grock/out/x.md") && !ok("node_modules/x.js") && !ok(".git/config") && !ok("src/../.env"));
  assert.ok(!ok("") && !ok("/src/a.js") && !ok("C:/src/a.js"));
  assert.equal(P.canWritePath(g, "src/generated/x.js").reason, "อยู่ใน deny ของโปรเจกต์");
  assert.equal(P.canWritePath(g, "src/.env").reason, "ไฟล์ต้องห้าม (ค่าลับ/ระบบ)", "deny-list กลางมาก่อน deny ของโปรเจกต์");
  assert.ok(P.canWritePath(null, "src/a.js").reason.includes("ไม่มีสิทธิ์"));
  // ค่าเริ่มต้น: ไม่ตั้ง permissions = ไม่มีสิทธิ์; ตั้ง write อย่างเดียว = Edit, Write
  assert.deepEqual(writeCfg({}).config.permissions, {});
  const p2 = writeCfg({ permissions: { "dev-1": { write: ["**"] } } });
  assert.deepEqual(p2.config.permissions["dev-1"].tools, ["Edit", "Write"]);
  assert.equal(p2.config.permissions["dev-1"].maxUsd, 5, "งบ CLI เริ่มต้น $5");
  assert.equal(p2.config.permissions["dev-1"].timeoutSec, 900);
  assert.ok(writeCfg({ permissions: [] }).warnings.some((x) => x.includes("permissions")));
  console.log("✅ permissions normalize + writeGrantFor + canWritePath");
}

// ---------------------------------------------------------------------------
// 3) unified diff ↔ git apply (ทุกเคสต้อง apply ได้และได้ผลตรงเป๊ะ)
// ---------------------------------------------------------------------------
{
  let n = 0;
  const roundtrip = (name, oldText, newText, rel = "f.txt") => {
    const dir = path.join(TMP, `rt-${++n}`);
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    if (oldText != null) fs.writeFileSync(path.join(dir, rel), oldText, "utf8");
    const diff = A.unifiedDiff(oldText, newText, rel);
    if (oldText === newText) { assert.equal(diff, "", name); return; }
    assert.ok(diff.startsWith(`diff --git a/${rel} b/${rel}\n`), name);
    const pf = path.join(dir, "p.diff");
    fs.writeFileSync(pf, diff, "utf8");
    // ด่านตรวจเสริม: git apply --check (ปิดการแปลงท้ายบรรทัด) ต้องยอมรับรูปแบบ patch ของเรา
    const chk = git(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "apply", "--check", "--whitespace=nowarn", pf], dir);
    assert.equal(chk.status, 0, `${name}: git apply --check: ${chk.stderr}
${diff}`);
    // ด่านหลัก: applier ของระบบ (ไบต์ต่อไบต์ คง CRLF/LF)
    const plan = A.planPatch(dir, diff);
    assert.deepEqual(plan.map((p) => p.rel), [rel]);
    if (oldText != null) assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), oldText, name + ": planPatch ต้องไม่เขียนไฟล์");
    assert.deepEqual(A.applyDiffToTree(dir, diff), [rel]);
    if (newText == null) assert.ok(!fs.existsSync(path.join(dir, rel)), name + ": ไฟล์ต้องถูกลบ");
    else assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), newText, name + ": เนื้อหาหลัง apply");
    if (diff.split("\n").some((l) => l.startsWith("-") && !l.startsWith("---"))) assert.throws(() => A.planPatch(dir, diff), /ไม่ตรง|มีอยู่แล้ว|ไม่พบไฟล์/, `${name}: apply ซ้ำต้องถูกปฏิเสธ`); // hunk ที่มีแต่บรรทัดเพิ่ม apply ซ้ำได้โดยธรรมชาติ (เหมือน git) — สถานะ applied ของงานเป็นตัวกัน
    assert.deepEqual(A.patchPaths(diff), [rel]);
    return diff;
  };
  roundtrip("แก้กลางไฟล์", "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n", "a\nb\nc\nX\ne\nf\ng\nh\nY\nj\n");
  roundtrip("ต่อท้าย", "a\nb\n", "a\nb\nc\n");
  roundtrip("แทรกหัว", "a\nb\n", "z\na\nb\n");
  roundtrip("ไฟล์ใหม่", null, "สวัสดี\nบรรทัดสอง\n", "src/ใหม่.md");
  roundtrip("ลบไฟล์", "bye\n", null);
  roundtrip("CRLF", "a\r\nb\r\nc\r\n", "a\r\nb\r\nc\r\nd\r\n");
  roundtrip("ไม่มี newline ท้าย → มี", "a\nb", "a\nb\nc\n");
  roundtrip("มี newline ท้าย → ไม่มี", "a\nb\n", "a\nb");
  roundtrip("ว่าง → มีเนื้อหา", "", "x\n");
  roundtrip("มีเนื้อหา → ว่าง", "x\n", "");
  roundtrip("ไฟล์ว่างใหม่", null, "", "empty.txt");
  roundtrip("เหมือนเดิม", "same\n", "same\n");
  roundtrip("แก้หลายจุดห่างกัน", Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join(""), Array.from({ length: 40 }, (_, i) => (i === 3 || i === 30 ? `LINE ${i}\n` : `line ${i}\n`)).join(""));
  roundtrip("ก้อนใหญ่ (fallback แทนทั้งก้อน)", Array.from({ length: 3000 }, (_, i) => `${i}\n`).join(""), Array.from({ length: 3000 }, (_, i) => `${i * 7 % 3001}\n`).join(""));
  const d = A.unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "x.js");
  assert.ok(d.includes("@@ -1,3 +1,3 @@") && d.includes("-b\n") && d.includes("+B\n"));
  assert.deepEqual(A.diffStats(d), { add: 1, del: 1 });
  assert.throws(() => A.patchPaths("diff --git a/x b/y\n"), /header/);
  assert.throws(() => A.patchPaths("diff --git a/x b/x\nrename from x\nrename to y\n"), /rename/);
  // โปรเจกต์อยู่ใต้ git repo ที่รากสูงกว่า → ต้องใช้ --directory
  const repo = path.join(TMP, "repo");
  fs.mkdirSync(path.join(repo, "sub", "src"), { recursive: true });
  assert.equal(git(["init", "-q"], repo).status, 0);
  fs.writeFileSync(path.join(repo, "sub", "src", "a.txt"), "1\n2\n", "utf8");
  const extra = A.gitApplyExtraArgs(path.join(repo, "sub"));
  assert.deepEqual(extra, ["--directory=sub"]);
  const diff2 = A.unifiedDiff("1\n2\n", "1\n2\n3\n", "src/a.txt");
  fs.writeFileSync(path.join(repo, "p.diff"), diff2, "utf8");
  assert.equal(git(["apply", "--check", "--directory=sub", path.join(repo, "p.diff")], path.join(repo, "sub")).status, 0, "git apply ใน subdir ของ repo");
  assert.deepEqual(A.gitApplyExtraArgs(repo), [], "รากเดียวกัน → ไม่ต้อง --directory");
  assert.deepEqual(A.gitApplyExtraArgs(root), [], "ไม่ใช่ git repo → ไม่ต้อง --directory");
  console.log("✅ unifiedDiff → planPatch/applyDiffToTree (14 เคส, ไบต์ต่อไบต์) + git apply --check ยอมรับ + patchPaths + --directory");
}

// ---------------------------------------------------------------------------
// 4) claudeArgs
// ---------------------------------------------------------------------------
{
  const grant = { write: ["src/**"], deny: [], tools: ["Edit", "Write", "Bash(npm test)"], maxUsd: 3, timeoutSec: 60, sandboxIgnore: [], linkDeps: true };
  const args = A.claudeArgs({ grant, agent: { model: "claude-sonnet-5-5", effort: "high" } });
  assert.equal(args[0], "-p");
  const s = args.join(" ");
  assert.ok(s.includes("--output-format stream-json") && s.includes("--verbose") && s.includes("--permission-mode dontAsk") && s.includes("--no-session-persistence"));
  assert.ok(s.includes("--tools Read,Glob,Grep,Edit,Write,Bash") && s.includes("--model claude-sonnet-5-5") && s.includes("--effort high") && s.includes("--max-budget-usd 3"));
  assert.ok(!s.includes("--max-turns"), "CLI รุ่นปัจจุบันไม่มี --max-turns");
  const i = args.indexOf("--allowedTools");
  assert.deepEqual(args.slice(i + 1), ["Edit", "Write", "Bash(npm test)", "Read", "Glob", "Grep"], "--allowedTools ต้องอยู่ท้ายสุด (variadic)");
  const a2 = A.claudeArgs({ grant: { ...grant, maxUsd: 0, model: "claude-haiku-5-5" }, agent: { model: "claude-sonnet-5-5" } });
  assert.ok(!a2.includes("--max-budget-usd") && a2.includes("claude-haiku-5-5") && !a2.includes("--effort"));
  console.log("✅ claudeArgs");
}

// ---------------------------------------------------------------------------
// 5) patch จำลอง (sim) → writePatch → apply/reject + audit + ตรวจ sha256/สิทธิ์ตอน apply
// ---------------------------------------------------------------------------
{
  const pack = writeCfg({ name: "Proj", permissions: { "dev-1": { write: ["src/**"], deny: ["**/*.json"] } } });
  const grant = P.writeGrantFor(pack, "dev-1");
  const agent = { id: "dev-1", name: "Whitesmith", nick: "โค้ด", role: "coder", model: "claude-sonnet-5-5" };
  const task = { id: "task-sim-1", jobId: "job-sim-1", seq: 4, title: "เพิ่มฟีเจอร์: คูปอง", description: "เขียนโค้ดคูปอง", attempts: 1 };
  const changes = A.simulateChanges({ pack, grant, task, agent });
  assert.ok(changes && changes.files.length === 2, JSON.stringify(changes?.files));
  assert.equal(changes.files[0].path, "src/GROCK-SIM-04.md");
  assert.equal(changes.files[0].kind, "added");
  assert.equal(changes.files[1].path, "src/app.js", "ต่อท้ายไฟล์เดิมที่อยู่ในสิทธิ์ (ไม่ใช่ data.json ที่ถูก deny)");
  assert.equal(changes.files[1].kind, "modified");
  const before = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
  const patch = A.writePatch({ pack, task, agent, changes, mode: "sim" });
  assert.equal(patch.status, "pending");
  assert.equal(patch.rel, ".grock/out/job-sim-1/patches/04-เพิ่มฟีเจอร์-คูปอง.diff");
  assert.ok(fs.existsSync(patch.path) && fs.existsSync(`${patch.path}.json`));
  assert.ok(patch.preview.includes("+// grock sim"));
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), before, "สร้าง patch แล้วไฟล์จริงต้องยังไม่เปลี่ยน");
  assert.ok(!fs.existsSync(path.join(root, "src", "GROCK-SIM-04.md")));
  const out = A.composeEditOutput({ summary: "สรุป", patch, changes });
  assert.ok(out.includes("Patch รออนุมัติ") && out.includes("```diff") && out.includes("src/app.js"));
  // ถอนสิทธิ์ก่อน apply → ต้องถูกปฏิเสธ
  const noPerm = writeCfg({ name: "Proj", permissions: {} });
  assert.throws(() => A.applyPatchToProject({ pack: noPerm, patch }), /ไม่ให้สิทธิ์/);
  // สิทธิ์แคบลงจน path ใน patch หลุด → ปฏิเสธ
  const narrow = writeCfg({ name: "Proj", permissions: { "dev-1": { write: ["src/lib/**"] } } });
  assert.throws(() => A.applyPatchToProject({ pack: narrow, patch }), /นอกสิทธิ์/);
  // แก้ไฟล์ patch บนดิสก์ → sha256 ไม่ตรง → ปฏิเสธ
  const pack2 = writeCfg({ name: "Proj", permissions: { "dev-1": { write: ["src/**"], deny: ["**/*.json"] } } });
  const orig = fs.readFileSync(patch.path);
  fs.appendFileSync(patch.path, "\n");
  assert.throws(() => A.applyPatchToProject({ pack: pack2, patch }), /sha256/);
  fs.writeFileSync(patch.path, orig);
  // apply จริง
  const r = A.applyPatchToProject({ pack: pack2, patch, note: "ok", by: "test" });
  assert.deepEqual(r.files, ["src/GROCK-SIM-04.md", "src/app.js"]);
  assert.ok(fs.readFileSync(path.join(root, "src", "app.js"), "utf8").endsWith("// grock sim: เพิ่มฟีเจอร์: คูปอง (Whitesmith, รอบที่ 1)\n"));
  assert.ok(fs.existsSync(path.join(root, "src", "GROCK-SIM-04.md")));
  const meta = JSON.parse(fs.readFileSync(`${patch.path}.json`, "utf8"));
  assert.equal(meta.status, "applied");
  assert.equal(meta.decidedBy, "test");
  assert.deepEqual(meta.decisions.map((d) => d.event), ["created", "applied"]);
  assert.equal(meta.preview, undefined, "sidecar ไม่เก็บ preview");
  // apply ซ้ำ (ไฟล์เปลี่ยนไปแล้ว) → git apply --check ไม่ผ่าน
  assert.throws(() => A.applyPatchToProject({ pack: pack2, patch }), /ตรวจ patch กับไฟล์ปัจจุบันไม่ผ่าน/);
  // reject
  const task2 = { ...task, id: "task-sim-2", seq: 5, title: "งานสอง" };
  const ch2 = A.simulateChanges({ pack: pack2, grant: P.writeGrantFor(pack2, "dev-1"), task: task2, agent });
  const p2 = A.writePatch({ pack: pack2, task: task2, agent, changes: ch2, mode: "sim" });
  const snap = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
  A.rejectPatchOfProject({ patch: p2, reason: "ไม่เอา", by: "test" });
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), snap);
  const m2 = JSON.parse(fs.readFileSync(`${p2.path}.json`, "utf8"));
  assert.equal(m2.status, "rejected");
  assert.equal(m2.note, "ไม่เอา");
  assert.throws(() => A.applyPatchToProject({ pack: pack2, patch: { ...p2, status: "rejected" } }), /รออนุมัติ/);
  // ไม่มีไฟล์ไหนอยู่ในสิทธิ์เลย (glob ชี้โฟลเดอร์ที่ไม่มี) → ยังสร้างไฟล์ใหม่ได้
  const p3 = writeCfg({ name: "Proj", permissions: { "dev-1": { write: ["newdir/**"] } } });
  const ch3 = A.simulateChanges({ pack: p3, grant: P.writeGrantFor(p3, "dev-1"), task: { ...task, seq: 6 }, agent });
  assert.equal(ch3.files.length, 1);
  assert.equal(ch3.files[0].path, "newdir/GROCK-SIM-06.md");
  console.log("✅ simulateChanges + writePatch + applyPatchToProject (ถอนสิทธิ์/sha256/--check) + reject + audit sidecar");
}

// ---------------------------------------------------------------------------
// 6) headless run กับ fake-claude: sandbox, ตัดไฟล์นอกสิทธิ์, usage/cost, prompt, timeout, crash
// ---------------------------------------------------------------------------
{
  const fake = path.join(here, "fake-claude.mjs");
  process.env.CLAUDE_BIN = fake;
  const cli = A.findClaudeCli({ force: true });
  assert.equal(cli.bin, fake, cli.error);
  assert.ok(cli.version.includes("fake-claude"));
  const pack = writeCfg({ name: "Proj", permissions: { "dev-1": { write: ["src/**"], deny: ["**/*.json"], tools: ["Edit", "Write", "Bash(npm test)"], maxUsd: 1 } } });
  const grant = P.writeGrantFor(pack, "dev-1");
  const agent = { id: "dev-1", name: "Whitesmith", nick: "โค้ด", role: "coder", model: "claude-sonnet-5-5", effort: "high", duties: "เขียน API", toolsEnabled: true };
  const task = { id: "task-live-1", jobId: "job-live-1", seq: 2, title: "แก้ app.js", description: "เพิ่มฟังก์ชัน", attempts: 1 };
  const context = { goal: "ทดสอบ headless", inputs: [], files: [{ path: "src/app.js", text: "x" }], project: { pack, name: pack.name, system: "[โปรเจกต์: Proj]\nbrief", data: "", qa: pack.config.qa, files: [] } };
  const logFile = path.join(TMP, "fake.log");
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.FAKE_CLAUDE_EDITS = JSON.stringify([
    { path: "src/app.js", append: "export const c = 3;\n" },
    { path: "src/new.js", content: "export const n = 1;\n" },
    { path: "src/data.json", content: "{}" }, // deny ของโปรเจกต์ (ไฟล์ถูกซ่อนจาก sandbox ด้วย → โผล่เป็น added แล้วถูกตัด)
    { path: ".env", content: "LEAK=1\n" }, // deny-list กลาง
    { path: "lib/out.js", content: "x" }, // นอก write glob
    { path: "src/lib/util.js", delete: true },
  ]);
  const phases = [];
  const before = { app: fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), env: fs.readFileSync(path.join(root, ".env"), "utf8") };
  const r = await A.runHeadlessEdit({ agent, task, context, grant, taskBody: "งานของคุณ: แก้ app.js", onProgress: (p) => phases.push(p) });
  assert.ok(r.patch, "ต้องได้ patch");
  assert.deepEqual(r.patch.files.map((f) => `${f.kind}:${f.path}`), ["modified:src/app.js", "deleted:src/lib/util.js", "added:src/new.js"]);
  assert.deepEqual(r.patch.rejected.map((f) => f.path).sort(), [".env", "lib/out.js", "src/data.json"]);
  assert.ok(r.patch.rejected.every((f) => f.reason));
  assert.equal(r.usage.total_cost_usd, 0.0123);
  assert.equal(r.usage.input_tokens, 1000);
  assert.equal(r.model, "claude-fake-1");
  assert.equal(r.toolCalls, 6);
  assert.equal(r.patch.cli.costUsd, 0.0123);
  assert.equal(r.patch.cli.version, cli.version);
  assert.equal(r.patch.denied.length, 1);
  assert.ok(r.output.includes("fake") && r.output.includes("ถูกตัดออกเพราะนอกสิทธิ์ (3)") && r.output.includes("ถูกปฏิเสธโดยอัตโนมัติ (1)"));
  assert.equal(fs.readFileSync(path.join(root, "src", "app.js"), "utf8"), before.app, "ไฟล์จริงต้องไม่เปลี่ยน");
  assert.equal(fs.readFileSync(path.join(root, ".env"), "utf8"), before.env);
  assert.ok(fs.existsSync(path.join(root, "src", "lib", "util.js")) && !fs.existsSync(path.join(root, "lib")));
  assert.ok(phases.some((p) => p.phase?.includes("sandbox")) && phases.some((p) => p.phase?.includes("กำลังแก้ไฟล์: src/app.js")) && phases.some((p) => p.tool === "claude_code" && p.toolStarted));
  const log = JSON.parse(fs.readFileSync(logFile, "utf8").trim().split("\n").pop());
  assert.ok(log.args.includes("--allowedTools") && log.args.includes("Bash(npm test)") && log.args.includes("--max-budget-usd"));
  assert.ok(log.prompt.includes("งานของคุณ: แก้ app.js") && log.prompt.includes("src/**") && log.prompt.includes("Whitesmith") && log.prompt.includes("brief") && log.prompt.includes("เขียน API"));
  assert.ok(log.cwd.startsWith(process.env.GROCK_SANDBOX_DIR), "ต้องรันใน sandbox");
  assert.ok(!fs.existsSync(path.join(log.cwd, ".env")) || true, "sandbox ถูกลบแล้ว");
  assert.ok(!fs.existsSync(log.cwd), "sandbox ต้องถูกลบหลังเสร็จ");
  assert.ok(!fs.existsSync(path.join(root, "node_modules", "x", "GROCK")) && fs.existsSync(path.join(root, "node_modules", "x", "index.js")), "node_modules จริงต้องไม่ถูกลบตาม junction");
  // apply patch จาก headless ได้จริง
  const ap = A.applyPatchToProject({ pack, patch: r.patch, by: "test" });
  assert.deepEqual(ap.files, ["src/app.js", "src/lib/util.js", "src/new.js"]);
  assert.ok(fs.readFileSync(path.join(root, "src", "app.js"), "utf8").endsWith("export const c = 3;\n"));
  assert.ok(!fs.existsSync(path.join(root, "src", "lib", "util.js")) && fs.existsSync(path.join(root, "src", "new.js")));
  // ไม่มีการแก้ไฟล์ → ไม่มี patch
  process.env.FAKE_CLAUDE_EDITS = "[]";
  const r0 = await A.runHeadlessEdit({ agent, task: { ...task, id: "task-live-0" }, context, grant, taskBody: "x", onProgress: () => {} });
  assert.equal(r0.patch, null);
  assert.ok(r0.output.includes("ไม่มีการแก้ไฟล์"));
  // crash (ไม่มี result) → error
  process.env.FAKE_CLAUDE_NO_RESULT = "1";
  await assert.rejects(A.runHeadlessEdit({ agent, task, context, grant, taskBody: "x", onProgress: () => {} }), /ไม่มีผลลัพธ์/);
  delete process.env.FAKE_CLAUDE_NO_RESULT;
  // timeout → error (grant ส่งตรง ไม่ผ่าน clamp)
  process.env.FAKE_CLAUDE_SLEEP = "4000";
  const t0 = Date.now();
  await assert.rejects(A.runHeadlessEdit({ agent, task, context, grant: { ...grant, timeoutSec: 1 }, taskBody: "x", onProgress: () => {} }), /เกิน 1 วินาที/);
  assert.ok(Date.now() - t0 < 3500, "ต้องหยุดตาม timeout");
  // ยกเลิกกลางคัน
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  await assert.rejects(A.runHeadlessEdit({ agent, task, context, grant, taskBody: "x", signal: ac.signal, onProgress: () => {} }), /ยกเลิก/);
  delete process.env.FAKE_CLAUDE_SLEEP;
  assert.deepEqual(fs.readdirSync(process.env.GROCK_SANDBOX_DIR), [], "sandbox ทุกอันต้องถูกเก็บกวาด");
  console.log("✅ runHeadlessEdit (fake-claude): sandbox, ตัดไฟล์นอกสิทธิ์ 3 ไฟล์, usage/cost, prompt, apply ได้จริง, ไม่มีการแก้, crash, timeout, abort");
}

// ---------------------------------------------------------------------------
// 7) executor: editGrantFor + fallback เมื่อไม่มี CLI
// ---------------------------------------------------------------------------
{
  const pack = writeCfg({ name: "Proj", permissions: { "dev-1": { write: ["src/**"] } } });
  const ctx = { project: { pack } };
  assert.ok(X.editGrantFor({ agent: { id: "dev-1", role: "coder" }, task: { role: "coder" }, context: ctx }));
  assert.equal(X.editGrantFor({ agent: { id: "qa-1", role: "reviewer" }, task: { role: "reviewer" }, context: ctx }), null);
  assert.equal(X.editGrantFor({ agent: { id: "dev-1", role: "coder" }, task: { role: "coder" }, context: {} }), null, "ไม่มีโปรเจกต์ → ไม่มีสิทธิ์");
  const notes = [];
  assert.equal(X.editGrantFor({ agent: { id: "dev-1", name: "W", role: "coder", toolsEnabled: false }, task: { role: "coder" }, context: ctx, onProgress: (p) => notes.push(p) }), null);
  assert.ok(notes[0]?.note?.includes("ปิดเครื่องมือ"));
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  process.env.CLAUDE_BIN = path.join(TMP, "nope.exe");
  process.env.PATH = TMP; process.env.APPDATA = TMP; process.env.USERPROFILE = TMP; process.env.HOME = TMP;
  const miss = A.findClaudeCli({ force: true });
  assert.equal(miss.bin, null);
  assert.ok(miss.error.includes("ไม่พบ claude CLI"));
  Object.assign(process.env, saved);
  console.log("✅ editGrantFor + findClaudeCli ไม่พบ CLI → fallback");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("APPLY UNIT ALL PASSED");
