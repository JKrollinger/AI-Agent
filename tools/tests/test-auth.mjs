// test-auth.mjs — unit: authConfig (auto/token/basic/none + บังคับเมื่อเปิดรับจากภายนอก), คุกกี้เซ็น/ตรวจ/หมดอายุ, parseCookies, LoginLimiter, isHttps, safeNext, หน้า login
//                + gitpush: branchUrl, prepareBranch (orphan/patch) กับ repo ชั่วคราว, pushBranch ไป bare repo, attachGitGate
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

process.env.LOG_EVENTS = "0";
const A = await import(new URL("../../server/auth.js", import.meta.url).href);
const G = await import(new URL("../../server/gitpush.js", import.meta.url).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-auth-unit-"));
const TOKEN = "unit-test-token-0123456789abcdef";

try {
  // ---------- authConfig ----------
  let c = A.authConfig({}, { host: "127.0.0.1" });
  assert.equal(c.mode, "none"); assert.deepEqual(c.errors, []); assert.equal(c.exposed, false);
  c = A.authConfig({ DASHBOARD_TOKEN: TOKEN }, { host: "127.0.0.1" });
  assert.equal(c.mode, "token"); assert.deepEqual(c.errors, []); assert.equal(c.token, TOKEN); assert.equal(c.explicit, false);
  c = A.authConfig({ AUTH_PASSWORD: "secret-password-123" }, { host: "localhost" });
  assert.equal(c.mode, "basic"); assert.deepEqual(c.errors, []);
  c = A.authConfig({ AUTH: "token" }, { host: "127.0.0.1" });
  assert.equal(c.errors.length, 1); assert.match(c.errors[0], /DASHBOARD_TOKEN/);
  c = A.authConfig({ AUTH: "token", DASHBOARD_TOKEN: "short" }, {});
  assert.match(c.errors[0], /16 ตัวอักษร/);
  c = A.authConfig({ AUTH: "token", DASHBOARD_TOKEN: "has space in token xxxxx" }, {});
  assert.equal(c.errors.length, 1);
  c = A.authConfig({ AUTH: "basic" }, {});
  assert.match(c.errors[0], /AUTH_PASSWORD/);
  c = A.authConfig({ AUTH: "what" }, {});
  assert.match(c.errors[0], /ไม่รู้จัก/);
  c = A.authConfig({ DASHBOARD_TOKEN: TOKEN, AUTH_PASSWORD: "pw-pw-pw-pw-pw-pw" }, {});
  assert.equal(c.mode, "token"); assert.equal(c.warnings.length, 1);
  // เปิดรับจากภายนอกโดยไม่มีล็อกอิน → error (ไม่ยอมสตาร์ต)
  c = A.authConfig({}, { host: "0.0.0.0" });
  assert.equal(c.exposed, true); assert.equal(c.errors.length, 1); assert.match(c.errors[0], /HOST=0\.0\.0\.0/);
  c = A.authConfig({}, { host: "127.0.0.1", allowedHosts: ["ai.example.com"] });
  assert.equal(c.exposed, true); assert.match(c.errors[0], /ALLOWED_HOSTS=ai\.example\.com/);
  c = A.authConfig({ AUTH: "none" }, { host: "0.0.0.0" });
  assert.deepEqual(c.errors, []); assert.equal(c.warnings.length, 1); assert.match(c.warnings[0], /AUTH=none/);
  c = A.authConfig({ DASHBOARD_TOKEN: TOKEN }, { host: "0.0.0.0", allowedHosts: ["x.y"] });
  assert.deepEqual(c.errors, []);
  c = A.authConfig({ DASHBOARD_TOKEN: TOKEN, SESSION_DAYS: "2", LOGIN_MAX_FAILS: "3", LOGIN_WINDOW_MIN: "1" }, {});
  assert.equal(c.sessionMs, 2 * 86_400_000); assert.equal(c.maxFails, 3); assert.equal(c.windowMs, 60_000);
  console.log("✅ authConfig: auto เลือกตามค่าที่ตั้ง, token ต้องมี DASHBOARD_TOKEN ≥16 ตัว, เปิดรับจากภายนอกโดยไม่มีล็อกอิน → error, AUTH=none ชัดเจน → เตือนแต่ผ่าน");

  // ---------- คุกกี้ ----------
  const secret = A.cookieSecret(TOKEN);
  const v = A.makeCookieValue(secret, { now: 1_000_000, ttlMs: 5_000 });
  assert.match(v, /^1005000\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(A.verifyCookieValue(secret, v, { now: 1_004_999 }), { ok: true, exp: 1_005_000 });
  assert.equal(A.verifyCookieValue(secret, v, { now: 1_005_000 }).ok, false, "หมดอายุ");
  assert.equal(A.verifyCookieValue(secret, v, { now: 1_005_000 }).expired, true);
  assert.equal(A.verifyCookieValue(A.cookieSecret("other-token-0123456789abcdef"), v, { now: 1_000_001 }).ok, false, "เปลี่ยนโทเคน = คุกกี้เดิมใช้ไม่ได้");
  assert.equal(A.verifyCookieValue(secret, `1005000.${"A".repeat(43)}`, { now: 1 }).ok, false);
  assert.equal(A.verifyCookieValue(secret, "9999999999999.x", { now: 1 }).ok, false);
  assert.equal(A.verifyCookieValue(secret, "", { now: 1 }).ok, false);
  assert.deepEqual(A.parseCookies("a=1; grock_session=abc.def ; x=%20y"), { a: "1", grock_session: "abc.def", x: " y" });
  assert.deepEqual(A.parseCookies(""), {});
  assert.equal(A.setCookieHeader("v", { maxAgeSec: 60, secure: true }), "grock_session=v; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=60");
  assert.equal(A.clearCookieHeader({ secure: false }), "grock_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
  assert.equal(A.isHttps({ headers: { "x-forwarded-proto": "https" }, socket: {} }), true);
  assert.equal(A.isHttps({ headers: { "cf-visitor": '{"scheme":"https"}' }, socket: {} }), true);
  assert.equal(A.isHttps({ headers: {}, socket: {} }), false);
  assert.equal(A.clientIp({ headers: { "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }, socket: { remoteAddress: "127.0.0.1" } }), "1.2.3.4");
  assert.equal(A.clientIp({ headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1" }, socket: { remoteAddress: "127.0.0.1" } }), "5.6.7.8");
  assert.equal(A.clientIp({ headers: {}, socket: { remoteAddress: "::1" } }), "::1");
  for (const [inp, want] of [["/", "/"], ["/x?y=1", "/x?y=1"], ["//evil.com", "/"], ["http://evil", "/"], ["", "/"], ["/\\evil", "/"], [`/${"a".repeat(600)}`, "/"]]) assert.equal(A.safeNext(inp), want, `safeNext(${inp})`);
  const page = A.loginPageHtml({ error: "<b>ผิด</b>", next: "/x" });
  assert.ok(page.includes('name="token"') && page.includes("&lt;b&gt;ผิด&lt;/b&gt;") && page.includes('value="/x"') && page.includes('action="/login"'));
  console.log("✅ คุกกี้: HMAC ของเวลาหมดอายุ, ตรวจ/หมดอายุ/เปลี่ยนโทเคน, parseCookies, Secure ตาม https/proxy, clientIp, safeNext กัน open redirect, หน้า login escape");

  // ---------- LoginLimiter ----------
  let t = 0;
  const lim = new A.LoginLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.deepEqual(lim.check("ip1"), { ok: true, remaining: 3, retryAfterSec: 0 });
  lim.fail("ip1"); lim.fail("ip1");
  assert.equal(lim.check("ip1").remaining, 1);
  const blocked = lim.fail("ip1");
  assert.equal(blocked.ok, false); assert.equal(blocked.retryAfterSec, 1);
  assert.equal(lim.check("ip2").ok, true, "IP อื่นไม่กระทบ");
  t = 500; assert.equal(lim.check("ip1").ok, false);
  t = 1001; assert.equal(lim.check("ip1").ok, true, "พ้น window แล้วลองใหม่ได้");
  lim.fail("ip1"); lim.reset("ip1"); assert.equal(lim.check("ip1").remaining, 3);
  console.log("✅ LoginLimiter: ครบจำนวนใน window → บล็อกพร้อม retryAfter, แยกต่อ IP, พ้น window ปลดเอง, reset เมื่อสำเร็จ");

  // ---------- gitpush ----------
  assert.equal(G.branchUrl("https://github.com/JKrollinger/AI-Agent.git", "grock/job-1"), "https://github.com/JKrollinger/AI-Agent/tree/grock/job-1");
  assert.equal(G.branchUrl("git@github.com:JKrollinger/AI-Agent.git", "grock/job-1"), "https://github.com/JKrollinger/AI-Agent/tree/grock/job-1");
  assert.equal(G.branchUrl("ssh://git@github.com/o/r", "b"), "https://github.com/o/r/tree/b");
  assert.equal(G.branchUrl("https://gitlab.com/g/p.git", "grock/x"), "https://gitlab.com/g/p/-/tree/grock/x");
  assert.equal(G.branchUrl("https://user:tok@bitbucket.org/w/r.git", "b"), "https://bitbucket.org/w/r/branch/b");
  assert.equal(G.branchUrl("https://git.example.com/o/r.git", "b"), null);
  assert.equal(G.branchUrl("C:/bare/repo.git", "b"), null);
  assert.equal(G.branchUrl("", "b"), null);
  assert.equal(G.scrub("fatal: https://user:ghp_secret@github.com/x failed\n  twice"), "fatal: https://user:[REDACTED]@github.com/x failed twice");
  assert.equal(G.gitInfo(TMP).isRepo, false);
  const git = (cwd, ...args) => { const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`); return r.stdout.trim(); };
  // repo ชั่วคราว + bare remote
  const repo = path.join(TMP, "proj"); const bare = path.join(TMP, "remote.git");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  git(TMP, "init", "--bare", "-q", bare);
  git(repo, "init", "-q"); git(repo, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const x = 1;\n", "utf8");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".grock/out/\n", "utf8");
  git(repo, "add", "-A"); git(repo, "commit", "-q", "-m", "init");
  git(repo, "remote", "add", "origin", bare);
  const head = git(repo, "rev-parse", "HEAD");
  const info = G.gitInfo(repo, "origin");
  assert.equal(info.isRepo, true); assert.equal(info.head, head); assert.equal(info.remoteUrl, bare); assert.ok(["master", "main"].includes(info.branch));
  assert.equal(G.gitInfo(repo, "nope").remoteUrl, null); assert.equal(G.gitInfo(repo, "bad name!").remoteUrl, null);
  // ผลงาน + patch
  const outRel = ".grock/out/job-unit1";
  fs.mkdirSync(path.join(repo, outRel, "tasks"), { recursive: true });
  fs.writeFileSync(path.join(repo, outRel, "result.md"), "# ผล\n", "utf8");
  fs.writeFileSync(path.join(repo, outRel, "job.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(repo, outRel, "tasks", "01-x.md"), "x\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "untracked-dirty.js"), "// ไม่ควรติดไปด้วย\n", "utf8");
  // orphan
  const o = G.prepareBranch({ root: repo, jobId: "job-unit1", outRel, message: "grock: test" });
  assert.equal(o.ok, true, o.error); assert.equal(o.mode, "orphan"); assert.equal(o.branch, "grock/job-unit1"); assert.equal(o.files, 3); assert.equal(o.parent, null);
  assert.deepEqual(git(repo, "ls-tree", "-r", "--name-only", "grock/job-unit1").split("\n").sort(), [".grock/out/job-unit1/job.json", ".grock/out/job-unit1/result.md", ".grock/out/job-unit1/tasks/01-x.md"], "branch มีเฉพาะไฟล์ผลงาน");
  assert.equal(git(repo, "rev-list", "--count", "grock/job-unit1"), "1");
  assert.equal(git(repo, "log", "-1", "--format=%s", "grock/job-unit1"), "grock: test");
  assert.equal(git(repo, "rev-parse", "HEAD"), head, "HEAD ของผู้ใช้ไม่เปลี่ยน");
  assert.ok(["master", "main"].includes(git(repo, "rev-parse", "--abbrev-ref", "HEAD")), "ไม่สลับ branch");
  assert.equal(git(repo, "status", "--porcelain").split("\n").filter(Boolean).join(","), "?? src/untracked-dirty.js", "index/working tree ของผู้ใช้ไม่ถูกแตะ");
  // patch mode: ไฟล์ที่ patch แก้ (ตาม working tree) + ผลงาน บน HEAD
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const x = 2;\n", "utf8");
  fs.writeFileSync(path.join(repo, "src", "new.js"), "export const y = 1;\n", "utf8");
  const p = G.prepareBranch({ root: repo, jobId: "job-unit1", outRel, patchPaths: ["src/app.js", "src/new.js", "../etc/passwd", "C:/x"], message: "grock: patch" });
  assert.equal(p.ok, true, p.error); assert.equal(p.mode, "patch"); assert.equal(p.parent, head); assert.equal(p.files, 5);
  assert.deepEqual(git(repo, "ls-tree", "-r", "--name-only", "grock/job-unit1").split("\n").sort(), [".gitignore", ".grock/out/job-unit1/job.json", ".grock/out/job-unit1/result.md", ".grock/out/job-unit1/tasks/01-x.md", "src/app.js", "src/new.js"], "ไฟล์ของ HEAD + patch + ผลงาน (ไม่มี untracked-dirty.js)");
  assert.equal(git(repo, "show", "grock/job-unit1:src/app.js"), "export const x = 2;");
  assert.equal(git(repo, "rev-parse", "grock/job-unit1^"), head, "parent = HEAD");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
  assert.equal(git(repo, "diff", "--name-only").trim(), "src/app.js", "working tree ยังเปลี่ยนอยู่ตามเดิม (ไม่ถูก stage)");
  assert.equal(G.prepareBranch({ root: repo, jobId: "Bad Id", outRel }).ok, false);
  assert.equal(G.prepareBranch({ root: repo, jobId: "job-none", outRel: ".grock/out/job-none" }).ok, false);
  assert.equal(G.prepareBranch({ root: TMP, jobId: "job-x", outRel }).ok, false);
  // push ไป bare
  const push = await G.pushBranch({ root: repo, branch: "grock/job-unit1", remote: "origin" });
  assert.equal(push.ok, true, push.error);
  assert.equal(git(bare, "rev-parse", "refs/heads/grock/job-unit1"), git(repo, "rev-parse", "grock/job-unit1"));
  const bad = await G.pushBranch({ root: repo, branch: "grock/job-unit1", remote: "nope" });
  assert.equal(bad.ok, false); assert.ok(bad.error);
  assert.equal((await G.pushBranch({ root: repo, branch: "x", remote: "bad name" })).ok, false);
  // attachGitGate
  class Bus extends EventEmitter { constructor() { super(); this.events = []; this.logs = []; } publish(type, data) { const ev = { type, data }; this.events.push(ev); this.emit("event", ev); return ev; } log(m, x = {}) { this.logs.push({ message: m, ...x }); } }
  const bus = new Bus();
  const packOn = { root: repo, config: { git: { pushBranch: true, remote: "origin" } } };
  const packOff = { root: repo, config: { git: { pushBranch: false, remote: "origin" } } };
  const packNoRemote = { root: repo, config: { git: { pushBranch: true, remote: "upstream" } } };
  const packNotRepo = { root: TMP, config: { git: { pushBranch: true, remote: "origin" } } };
  const ctxOf = (j) => ({ shop: { pack: packOn }, off: { pack: packOff }, nr: { pack: packNoRemote }, nrepo: { pack: packNotRepo } }[j.project] || null);
  const d = G.attachGitGate(bus, { contextOf: ctxOf });
  const jobs = { on: { id: "job-g1", goal: "x", project: "shop" }, off: { id: "job-g2", goal: "x", project: "off" }, nr: { id: "job-g3", goal: "x", project: "nr" }, nrepo: { id: "job-g4", goal: "x", project: "nrepo" }, ws: { id: "job-g5", goal: "x", project: null }, failed: { id: "job-g6", goal: "x", project: "shop" } };
  for (const j of Object.values(jobs)) bus.publish(j === jobs.failed ? "job.failed" : "job.completed", { job: j });
  assert.equal(jobs.on.git.status, "pending"); assert.equal(jobs.on.git.branch, "grock/job-g1"); assert.equal(jobs.on.git.remote, "origin"); assert.equal(jobs.on.git.url, null, "bare path ไม่มี URL เว็บ");
  assert.equal(jobs.off.git, undefined, "pushBranch=false → ไม่ทำอะไร");
  assert.equal(jobs.nr.git.status, "skipped"); assert.match(jobs.nr.git.error, /upstream/);
  assert.equal(jobs.nrepo.git.status, "skipped"); assert.match(jobs.nrepo.git.error, /git repository/);
  assert.equal(jobs.ws.git, undefined); assert.equal(jobs.failed.git, undefined, "job.failed ไม่เข้าด่าน push");
  assert.equal(bus.events.filter((e) => e.type === "job.git").length, 3);
  assert.ok(bus.logs.some((l) => l.message.includes("รออนุมัติ") && l.jobId === "job-g1"));
  bus.publish("job.completed", { job: jobs.on });
  assert.equal(bus.events.filter((e) => e.type === "job.git").length, 3, "มี job.git แล้วไม่ทำซ้ำ");
  d();
  console.log("✅ gitpush: branchUrl, prepareBranch orphan (เฉพาะผลงาน) / patch (HEAD + ไฟล์ patch + ผลงาน) ไม่แตะ index/working tree/HEAD, push ไป bare repo, attachGitGate pending/skipped");

  console.log("AUTH/GIT UNIT ALL PASSED");
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
