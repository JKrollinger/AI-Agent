// gitpush.js — ส่งผลงานของโจทย์ขึ้น GitHub (หรือ remote ใด ๆ) เป็น branch `grock/<jobId>` ด้วย git CLI ของเครื่อง (ใช้ credential helper ของผู้ใช้ ไม่เก็บโทเคนเอง)
//   เปิดต่อโปรเจกต์ใน .grock/project.json: "git": { "pushBranch": true, "remote": "origin" } — ปิดเป็นค่าเริ่มต้น
//   เมื่อโจทย์เสร็จ (job.completed) และโปรเจกต์เป็น git repo ที่มี remote นั้น → job.git = { status: "pending", branch, remote } รอผู้ควบคุมกดอนุมัติบนแดชบอร์ด
//   อนุมัติ (POST /api/jobs/:id/push) → สร้าง commit จาก index ชั่วคราว (ไม่แตะ index/working tree/branch ปัจจุบันของผู้ใช้):
//     - ไม่มี patch ที่ apply แล้ว: branch "orphan" (ไม่มี parent) มีเฉพาะไฟล์ใน .grock/out/<jobId>/
//     - มี patch ที่ apply แล้ว (Phase 2): parent = HEAD ของโปรเจกต์ + ไฟล์ที่ patch แก้ (ตามที่อยู่จริงใน working tree) + .grock/out/<jobId>/
//   แล้ว `git push <remote> refs/heads/grock/<jobId>` (GIT_TERMINAL_PROMPT=0 ไม่ถามรหัส — ต้องมี credential helper/SSH key อยู่แล้ว)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const BRANCH_PREFIX = "grock/";
export const REMOTE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PUSH_TIMEOUT_MS = Math.max(10_000, Number(process.env.GIT_PUSH_TIMEOUT_MS) || 120_000);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

function git(root, args, { env = {}, input } = {}) {
  const r = spawnSync("git", args, { cwd: root, env: { ...GIT_ENV, ...env }, encoding: "utf8", input, windowsHide: true, timeout: 30_000 });
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim(), error: r.error?.message || "" };
}

/** ข้อมูล git ของโฟลเดอร์ → { isRepo, head, branch, remoteUrl } (remoteUrl = null ถ้าไม่มี remote ชื่อนั้น) */
export function gitInfo(root, remote = "origin") {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { isRepo: false, error: top.error || top.stderr || "ไม่ใช่ git repository" };
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const url = REMOTE_NAME_RE.test(remote) ? git(root, ["remote", "get-url", remote]) : { ok: false };
  return { isRepo: true, top: top.stdout, head: head.ok ? head.stdout : null, branch: branch.ok ? branch.stdout : null, remote, remoteUrl: url.ok ? url.stdout : null };
}

/** URL ของ branch บนเว็บจาก remote URL (รองรับ GitHub/GitLab/Bitbucket แบบ https และ ssh) หรือ null */
export function branchUrl(remoteUrl, branch) {
  const s = String(remoteUrl || "").trim();
  let host = "", repo = "";
  let m = /^(?:https?:\/\/)(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(s);
  if (m) { host = m[1]; repo = m[2]; }
  else if ((m = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+?)(?:\.git)?\/?$/.exec(s))) { host = m[1]; repo = m[2]; }
  if (!host || !repo || repo.includes("..")) return null;
  const b = encodeURIComponent(branch).replace(/%2F/g, "/");
  if (/(^|\.)github\.com$/i.test(host)) return `https://github.com/${repo}/tree/${b}`;
  if (/(^|\.)gitlab\.com$/i.test(host)) return `https://gitlab.com/${repo}/-/tree/${b}`;
  if (/(^|\.)bitbucket\.org$/i.test(host)) return `https://bitbucket.org/${repo}/branch/${b}`;
  return null;
}

export const branchFor = (jobId) => `${BRANCH_PREFIX}${jobId}`;
/** ตัดส่วนลับออกจากข้อความ error ของ git (เช่น โทเคนใน URL) */
export const scrub = (s) => String(s || "").replace(/(\/\/[^\s\/:@]+:)[^\s\/@]+@/g, "$1[REDACTED]@").replace(/\s+/g, " ").trim().slice(0, 400);

/**
 * สร้าง commit + branch grock/<jobId> โดยไม่แตะ index/working tree ของผู้ใช้ → { ok, branch, commit, mode: "orphan"|"patch", files, error }
 * @param {object} o { root, jobId, outRel (เช่น ".grock/out/job-1"), patchPaths: string[] (ไฟล์ที่ patch ที่ apply แล้วแก้), message }
 */
export function prepareBranch({ root, jobId, outRel, patchPaths = [], message }) {
  if (!JOB_ID_RE.test(jobId)) return { ok: false, error: `jobId "${jobId}" ไม่ถูกต้อง` };
  const info = gitInfo(root);
  if (!info.isRepo) return { ok: false, error: info.error };
  const outAbs = path.join(root, outRel);
  if (!fs.existsSync(outAbs)) return { ok: false, error: `ไม่พบโฟลเดอร์ผลงาน ${outRel}` };
  const branch = branchFor(jobId);
  const tmpIndex = path.join(os.tmpdir(), `grock-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  const cleanup = () => { try { fs.rmSync(tmpIndex, { force: true }); } catch {} };
  try {
    const cleanPatch = patchPaths.filter((p) => typeof p === "string" && p && !p.includes("..") && !path.isAbsolute(p)).map((p) => p.replace(/\\/g, "/"));
    const mode = cleanPatch.length && info.head ? "patch" : "orphan";
    if (mode === "patch") {
      const rt = git(root, ["read-tree", "HEAD"], { env });
      if (!rt.ok) return { ok: false, error: `git read-tree: ${scrub(rt.stderr || rt.error)}` };
      // -A ภายใต้ pathspec ของ patch: ไฟล์ที่ถูกลบใน working tree จะถูกลบจาก tree ด้วย
      const addP = git(root, ["add", "-A", "-f", "--", ...cleanPatch], { env });
      if (!addP.ok) return { ok: false, error: `git add (patch): ${scrub(addP.stderr || addP.error)}` };
    }
    const addOut = git(root, ["add", "-f", "--", outRel], { env }); // -f เพราะ .grock/out/ อยู่ใน .gitignore ของโปรเจกต์
    if (!addOut.ok) return { ok: false, error: `git add (ผลงาน): ${scrub(addOut.stderr || addOut.error)}` };
    const ls = git(root, ["ls-files", "--", outRel], { env });
    const outFiles = ls.ok ? ls.stdout.split(/\r?\n/).filter(Boolean) : [];
    if (!outFiles.length) return { ok: false, error: `ไม่มีไฟล์ใน ${outRel} ให้ commit` };
    const wt = git(root, ["write-tree"], { env });
    if (!wt.ok) return { ok: false, error: `git write-tree: ${scrub(wt.stderr || wt.error)}` };
    const args = ["commit-tree", wt.stdout, "-m", message || `grock: ผลงานโจทย์ ${jobId}`];
    if (mode === "patch") args.push("-p", info.head);
    const ct = git(root, args, { env: { ...env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Grock Agent", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "grock-agent@localhost", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || process.env.GIT_AUTHOR_NAME || "Grock Agent", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || process.env.GIT_AUTHOR_EMAIL || "grock-agent@localhost" } });
    if (!ct.ok) return { ok: false, error: `git commit-tree: ${scrub(ct.stderr || ct.error)}` };
    const ur = git(root, ["update-ref", `refs/heads/${branch}`, ct.stdout]);
    if (!ur.ok) return { ok: false, error: `git update-ref: ${scrub(ur.stderr || ur.error)}` };
    return { ok: true, branch, commit: ct.stdout, mode, parent: mode === "patch" ? info.head : null, files: outFiles.length + (mode === "patch" ? cleanPatch.length : 0), error: "" };
  } finally {
    cleanup();
  }
}

/** push branch ไป remote (async, ไม่ถามรหัส, timeout) → { ok, stdout, stderr, error } */
export function pushBranch({ root, branch, remote = "origin", timeoutMs = PUSH_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (!REMOTE_NAME_RE.test(remote)) return resolve({ ok: false, error: `ชื่อ remote "${remote}" ไม่ถูกต้อง` });
    let out = "", err = "", done = false;
    let child;
    try {
      child = spawn("git", ["push", "--porcelain", remote, `refs/heads/${branch}:refs/heads/${branch}`], { cwd: root, env: GIT_ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { return resolve({ ok: false, error: e.message }); }
    const timer = setTimeout(() => { if (!done) { try { child.kill(); } catch {} err += `\n(หมดเวลา ${Math.round(timeoutMs / 1000)} วินาที)`; } }, timeoutMs);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => { done = true; clearTimeout(timer); resolve({ ok: false, stdout: out, stderr: err, error: scrub(e.message) }); });
    child.on("close", (code) => { done = true; clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out.trim(), stderr: err.trim(), error: code === 0 ? "" : scrub(err || out || `git push exit ${code}`) }); });
  });
}

/** ตั้งค่า git ของโปรเจกต์ (หลัง normalize) → { pushBranch, remote } */
export const gitSettingsOf = (pack) => ({ pushBranch: Boolean(pack?.config?.git?.pushBranch), remote: pack?.config?.git?.remote || "origin" });

/**
 * สมัครรับ job.completed → ถ้าโปรเจกต์เปิด git.pushBranch และเป็น repo ที่มี remote → job.git = pending (รออนุมัติ) + event job.git
 * @param {function} opts.contextOf (job) → { pack, outDirRel } หรือ null
 */
export function attachGitGate(bus, { contextOf }) {
  const handler = (ev) => {
    if (ev.type !== "job.completed") return;
    const job = ev.data?.job;
    if (!job || job.git) return;
    const ctx = contextOf(job);
    if (!ctx?.pack) return;
    const { pushBranch: on, remote } = gitSettingsOf(ctx.pack);
    if (!on) return;
    const info = gitInfo(ctx.pack.root, remote);
    const branch = branchFor(job.id);
    if (!info.isRepo) { job.git = { status: "skipped", branch, remote, error: "โปรเจกต์ไม่ใช่ git repository", at: Date.now() }; }
    else if (!info.remoteUrl) { job.git = { status: "skipped", branch, remote, error: `ไม่มี remote "${remote}" ในโปรเจกต์ (git remote add ${remote} <url>)`, at: Date.now() }; }
    else job.git = { status: "pending", branch, remote, remoteHost: hostOf(info.remoteUrl), url: branchUrl(info.remoteUrl, branch), commit: null, error: "", at: Date.now() };
    bus.publish("job.git", { job, action: job.git.status });
    if (job.git.status === "pending") bus.log(`📤 ผลงาน "${String(job.goal).slice(0, 50)}" พร้อม push เป็น branch ${branch} ไป ${remote} (${job.git.remoteHost}) — รออนุมัติบนแท็บผลงาน`, { jobId: job.id });
    else bus.log(`📤 ข้ามการ push ของ "${String(job.goal).slice(0, 50)}": ${job.git.error}`, { jobId: job.id, level: "warn" });
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
/** host ของ remote สำหรับแสดงผล (github.com ฯลฯ) — remote ที่เป็นพาธในเครื่อง (C:\..., /srv/repo.git) คืน "" */
const hostOf = (url) => {
  const s = String(url || "").trim();
  if (!s || /^[a-z]:[\\/]/i.test(s) || s.startsWith("/") || s.startsWith("\\") || s.startsWith(".") || s.startsWith("file:")) return "";
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)/i.exec(s);
  return m ? m[1] : "";
};
