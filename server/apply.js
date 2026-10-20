// apply.js — adapter "แก้ไฟล์จริง" ของตำแหน่ง Developer (coder) ผ่าน Claude Code แบบ headless + ด่านอนุมัติ (Project Pack Phase 2)
//
// หลักการ:
//   1. ทำงานใน sandbox: คัดลอกโปรเจกต์ (ยกเว้น .git / node_modules / .grock / .claude / ไฟล์ค่าลับ) ไปโฟลเดอร์ชั่วคราว แล้วเรียก `claude -p` ที่นั่น
//      จำกัดเครื่องมือ (--tools / --allowedTools) โหมดสิทธิ์ dontAsk งบ (--max-budget-usd) และ timeout ตาม permissions.<agentId> ใน project.json
//   2. จับ diff ระหว่าง sandbox กับโปรเจกต์จริง → ไฟล์ที่นอกสิทธิ์ถูกตัดทิ้ง (บันทึกเป็น rejected) → เขียน patch ไว้ที่
//      .grock/out/<jobId>/patches/NN-<งาน>.diff (+ .json audit) — ไฟล์จริงของโปรเจกต์ยังไม่ถูกแตะ
//   3. ผู้ใช้อนุมัติบน dashboard/CLI → ตรวจ sha256 ของ patch + สิทธิ์ล่าสุด + ทุก path ใน patch → git apply --check → git apply ในโปรเจกต์จริง
//      → บันทึก audit (task.history, job.json, patches/*.json, logs/events.jsonl)
//   โหมด sim: จำลอง patch (ไฟล์ใหม่ + ต่อท้ายไฟล์เดิม 1 บรรทัด) โดยไม่เรียก claude เพื่อทดสอบ UI/flow ได้โดยไม่เสียเงิน
//   ไม่มี claude CLI หรือโปรเจกต์ไม่ให้สิทธิ์ → executor ถอยไปทำแบบข้อเสนอ (Phase 1) พร้อม log บอกเหตุผล
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { ROLES } from "./agents.js";
import { skillFor } from "./skills.js";
import { PACK_DIR, resolveInRoot, isDeniedPath, redactSecrets, canWritePath, writeGrantFor, projectSkillFor, jobOutputDir, globToRegExp, WRITE_ALWAYS_DENY_DIRS } from "./projects.js";

export const PATCH_DIR = "patches";
export const CLI_TOOL_NAME = "claude_code"; // ชื่อ "เครื่องมือ" ที่ dashboard ใช้แสดง (TOOL_META ใน agents.js)
export const SANDBOX_IGNORE = new Set([".git", ".svn", ".hg", "node_modules", PACK_DIR, ".claude", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".next", ".nuxt", ".turbo", ".cache", "dist", "build", "coverage", "target", ".idea", ".vscode"]);
const SANDBOX_BASE = process.env.GROCK_SANDBOX_DIR ? path.resolve(process.env.GROCK_SANDBOX_DIR) : os.tmpdir();
const MAX_SANDBOX_FILES = Number(process.env.GROCK_SANDBOX_MAX_FILES) || 20000;
const MAX_SANDBOX_BYTES = (Number(process.env.GROCK_SANDBOX_MAX_MB) || 400) * 1024 * 1024;
const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 4 * 1024 * 1024;
const MAX_LCS_CELLS = 6_000_000; // ตาราง LCS ใหญ่กว่านี้ → แทนทั้งก้อน (ยังเป็น patch ที่ถูกต้อง แค่ไม่ละเอียด)
const PREVIEW_CHARS = 6000;
const OUTPUT_DIFF_CHARS = 12000;
const CLI_CACHE_MS = 60_000;

const pad2 = (n) => String(n ?? 0).padStart(2, "0");
const slug = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const posix = (p) => String(p).split(path.sep).join("/");
const shorten = (s, n = 60) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const abortErr = () => Object.assign(new Error("งานถูกยกเลิก"), { name: "AbortError" });
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

// ===========================================================================
// 1) unified diff (รูปแบบ git) — เขียนเองเพื่อควบคุมพาธ/บรรทัดสุดท้าย/CRLF ให้ git apply รับได้แน่นอน
// ===========================================================================
function splitLines(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const j = text.indexOf("\n", i);
    if (j < 0) { out.push(text.slice(i)); break; }
    out.push(text.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/** ลำดับการแก้ (eq/del/ins) ด้วย LCS แบบ DP หลังตัดหัว-ท้ายที่เหมือนกัน; ก้อนกลางใหญ่เกิน → แทนทั้งก้อน */
function diffOps(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ma = a.slice(start, endA), mb = b.slice(start, endB);
  let mid;
  if (!ma.length) mid = Array(mb.length).fill("ins");
  else if (!mb.length) mid = Array(ma.length).fill("del");
  else if ((ma.length + 1) * (mb.length + 1) > MAX_LCS_CELLS) mid = [...Array(ma.length).fill("del"), ...Array(mb.length).fill("ins")];
  else {
    const n = ma.length, m = mb.length, W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * W + j] = ma[i] === mb[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    mid = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) { mid.push("eq"); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { mid.push("del"); i++; }
      else { mid.push("ins"); j++; }
    }
    while (i < n) { mid.push("del"); i++; }
    while (j < m) { mid.push("ins"); j++; }
  }
  return [...Array(start).fill("eq"), ...mid, ...Array(a.length - endA).fill("eq")];
}

const fmtLine = (prefix, line) => (line.endsWith("\n") ? prefix + line : `${prefix}${line}\n\\ No newline at end of file\n`);

function buildHunks(a, b, ops, context) {
  const items = [];
  let ai = 0, bi = 0;
  for (const op of ops) {
    items.push({ op, ai, bi });
    if (op !== "ins") ai++;
    if (op !== "del") bi++;
  }
  const ranges = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].op === "eq") continue;
    let j = i;
    while (j < items.length && items[j].op !== "eq") j++;
    const rs = Math.max(0, i - context), re = Math.min(items.length, j + context);
    if (ranges.length && rs <= ranges[ranges.length - 1][1]) ranges[ranges.length - 1][1] = re;
    else ranges.push([rs, re]);
    i = j;
  }
  return ranges.map(([s, e]) => {
    const slice = items.slice(s, e);
    let aLen = 0, bLen = 0;
    const lines = [];
    for (const it of slice) {
      if (it.op === "eq") { aLen++; bLen++; lines.push(fmtLine(" ", a[it.ai])); }
      else if (it.op === "del") { aLen++; lines.push(fmtLine("-", a[it.ai])); }
      else { bLen++; lines.push(fmtLine("+", b[it.bi])); }
    }
    const aStart = aLen ? slice[0].ai + 1 : slice[0].ai;
    const bStart = bLen ? slice[0].bi + 1 : slice[0].bi;
    return `@@ -${aStart},${aLen} +${bStart},${bLen} @@\n${lines.join("")}`;
  });
}

/**
 * unified diff ของไฟล์เดียวในรูปแบบ git (a/<rel> → b/<rel>); null = ไม่มีไฟล์ (เพิ่ม/ลบ)
 * คืน "" เมื่อเนื้อหาเหมือนเดิม
 */
export function unifiedDiff(oldText, newText, rel, { context = 3 } = {}) {
  const isAdd = oldText == null, isDel = newText == null;
  if (!isAdd && !isDel && oldText === newText) return "";
  const a = isAdd ? [] : splitLines(oldText), b = isDel ? [] : splitLines(newText);
  const head = [`diff --git a/${rel} b/${rel}`];
  if (isAdd) head.push("new file mode 100644");
  if (isDel) head.push("deleted file mode 100644");
  const hunks = buildHunks(a, b, diffOps(a, b), context);
  if (!hunks.length) return isAdd || isDel ? head.join("\n") + "\n" : ""; // ไฟล์ว่างถูกสร้าง/ลบ
  head.push(isAdd ? "--- /dev/null" : `--- a/${rel}`, isDel ? "+++ /dev/null" : `+++ b/${rel}`);
  return head.join("\n") + "\n" + hunks.join("");
}

/** นับบรรทัดเพิ่ม/ลบของ diff (ไม่นับ header) */
export function diffStats(diff) {
  let add = 0, del = 0;
  for (const line of String(diff).split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add++;
    else if (line.startsWith("-")) del++;
  }
  return { add, del };
}

/** path ทั้งหมดใน patch (จาก header diff --git) — โยนทิ้งถ้ามี rename/copy หรือ a/b ไม่ตรงกัน */
export function patchPaths(diff) {
  const out = [];
  for (const line of String(diff).split("\n")) {
    if (/^(rename|copy) (from|to) /.test(line)) throw new Error("patch มี rename/copy ซึ่งไม่รองรับ");
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] !== m[2]) throw new Error(`header ของ patch ไม่ถูกต้อง: ${shorten(line, 80)}`);
    out.push(m[1]);
  }
  return [...new Set(out)];
}

// ===========================================================================
// 2) หา Claude Code CLI
// ===========================================================================
let cliCache = null;
function launcherFor(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    // npm shim → เรียก claude.exe / cli.js ที่ shim ชี้ไปตรง ๆ (ไม่ผ่าน cmd.exe จะได้ไม่ต้อง quote อาร์กิวเมนต์)
    const pkg = path.join(path.dirname(file), "node_modules", "@anthropic-ai", "claude-code");
    for (const f of [path.join(pkg, "bin", "claude.exe"), path.join(pkg, "cli.js")]) if (fs.existsSync(f)) return launcherFor(f);
    return { cmd: file, args: [], shell: true };
  }
  if (/\.(mjs|cjs|js)$/.test(lower)) return { cmd: process.execPath, args: [file], shell: false };
  return { cmd: file, args: [], shell: false };
}
const quoteWin = (a) => (/[\s()&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
function spawnArgs(launch, args) {
  return launch.shell ? [...launch.args, ...args].map(quoteWin) : [...launch.args, ...args];
}

/** หา claude CLI: CLAUDE_BIN → PATH → ตำแหน่งติดตั้งมาตรฐาน; ยืนยันด้วย --version (cache 60 วินาที) */
export function findClaudeCli({ force = false } = {}) {
  if (cliCache && !force && Date.now() - cliCache.checkedAt < CLI_CACHE_MS) return cliCache;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const candidates = [];
  if (process.env.CLAUDE_BIN) candidates.push(path.resolve(process.env.CLAUDE_BIN));
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) for (const n of names) candidates.push(path.join(dir, n));
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (process.platform === "win32") {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "npm", "claude.cmd"));
    if (home) candidates.push(path.join(home, ".local", "bin", "claude.exe"));
  } else if (home) candidates.push(path.join(home, ".local", "bin", "claude"), "/usr/local/bin/claude", "/opt/homebrew/bin/claude");
  const tried = [];
  for (const c of [...new Set(candidates)]) {
    if (!fs.existsSync(c)) continue;
    tried.push(c);
    const launch = launcherFor(c);
    try {
      const v = spawnSync(launch.cmd, spawnArgs(launch, ["--version"]), { encoding: "utf8", timeout: 20000, windowsHide: true, shell: launch.shell });
      if (v.status === 0 && /\d+\.\d+/.test(v.stdout || "")) {
        cliCache = { bin: c, launch, version: (v.stdout || "").trim().split("\n")[0], checkedAt: Date.now(), error: null };
        return cliCache;
      }
    } catch {}
  }
  cliCache = { bin: null, launch: null, version: null, checkedAt: Date.now(), error: `ไม่พบ claude CLI (ติดตั้ง Claude Code หรือตั้ง CLAUDE_BIN ใน .env)${tried.length ? ` — ลองแล้ว: ${tried.join(", ")}` : ""}` };
  return cliCache;
}

/** อาร์กิวเมนต์ของ `claude` ตามสิทธิ์ (pure — มี unit test) */
export function claudeArgs({ grant, agent = {} }) {
  const builtin = new Set(["Read", "Glob", "Grep"]);
  for (const t of grant.tools) builtin.add(t.startsWith("Bash(") ? "Bash" : t);
  // --strict-mcp-config: ไม่โหลด MCP ของผู้ใช้ (~/.claude.json, connector ของ claude.ai, plugin) — ทดสอบกับ claude 2.1.157: MCP ระดับผู้ใช้ทำให้ prompt บวม ~380K tokens (≈$2.5 ต่องานเล็ก ๆ)
  //   และเปิดเครื่องมือนอกสิทธิ์ (Google Drive ฯลฯ) ให้ Developer; ต้องการ MCP เฉพาะงานให้ใส่ GROCK_CLAUDE_ARGS=--mcp-config <ไฟล์> (ยัง strict: โหลดเฉพาะที่ระบุ)
  // --disable-slash-commands: ไม่โหลด skill/slash command ของผู้ใช้ (Developer ไม่มีเครื่องมือ Skill อยู่แล้ว ประหยัด ~7K tokens ต่อ turn)
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--no-session-persistence", "--setting-sources", "user", "--strict-mcp-config", "--disable-slash-commands", "--tools", [...builtin].join(",")];
  const model = grant.model || agent.model;
  if (model) args.push("--model", model);
  if (["low", "medium", "high", "xhigh"].includes(agent.effort)) args.push("--effort", agent.effort);
  if (grant.maxUsd > 0) args.push("--max-budget-usd", String(grant.maxUsd));
  args.push(...String(process.env.GROCK_CLAUDE_ARGS || "").split(/\s+/).filter(Boolean));
  args.push("--disallowedTools", "WebFetch", "WebSearch", "Task", "Agent");
  args.push("--allowedTools", ...grant.tools, "Read", "Glob", "Grep"); // variadic → ไว้ท้ายสุด
  return args;
}

// ===========================================================================
// 3) sandbox: สำเนาโปรเจกต์ที่ปลอดภัย → ให้ Claude Code แก้ → เทียบกับของจริง
// ===========================================================================
const skipDir = (name, grant) => SANDBOX_IGNORE.has(name) || grant.sandboxIgnore.includes(name);
const denyReCache = new WeakMap();
function inProjectDeny(grant, rel) {
  if (!grant.deny.length) return false;
  let res = denyReCache.get(grant);
  if (!res) { res = grant.deny.map(globToRegExp); denyReCache.set(grant, res); }
  return res.some((re) => re.test(rel));
}

/** เดินไฟล์ในโฟลเดอร์ (ข้าม symlink/junction และโฟลเดอร์ที่ไม่คัดลอก) → Map<relPosix, abs> */
function walkFiles(base, grant, { skipDenied }) {
  const out = new Map();
  let count = 0;
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skipDir(e.name, grant)) walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile()) continue;
      if (skipDenied && (isDeniedPath(r) || inProjectDeny(grant, r))) continue; // ไฟล์ค่าลับ/ไฟล์ใน deny ของโปรเจกต์ ไม่ให้ sandbox เห็น
      if (++count > MAX_SANDBOX_FILES) throw new Error(`โปรเจกต์มีไฟล์เกิน ${MAX_SANDBOX_FILES} ไฟล์ — เพิ่มโฟลเดอร์ที่ไม่ต้องคัดลอกใน permissions.<id>.sandboxIgnore`);
      out.set(r, path.join(dir, e.name));
    }
  };
  walk(base, "");
  return { files: out, count };
}

function copyProjectToSandbox(root, dest, grant) {
  const { files } = walkFiles(root, grant, { skipDenied: true });
  let bytes = 0;
  for (const [rel, abs] of files) {
    bytes += fs.statSync(abs).size;
    if (bytes > MAX_SANDBOX_BYTES) throw new Error(`โปรเจกต์ใหญ่เกิน ${Math.round(MAX_SANDBOX_BYTES / 1024 / 1024)} MB สำหรับ sandbox — ตั้ง sandboxIgnore หรือ GROCK_SANDBOX_MAX_MB`);
    const target = path.join(dest, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(abs, target);
  }
  return { files: files.size, bytes };
}

/** junction/symlink node_modules ของโปรเจกต์เข้า sandbox (ให้ Bash(npm test) ทำงานได้) — ไม่คัดลอก ไม่ถูก diff */
function maybeLinkDeps(root, dest, grant) {
  if (!grant.linkDeps || !grant.tools.some((t) => t.startsWith("Bash("))) return null;
  const src = path.join(root, "node_modules"), link = path.join(dest, "node_modules");
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory() || fs.existsSync(link)) return null;
    fs.symlinkSync(src, link, process.platform === "win32" ? "junction" : "dir");
    return link;
  } catch { return null; }
}

function cleanupSandbox(dir, link) {
  try { if (link) (process.platform === "win32" ? fs.rmdirSync : fs.unlinkSync)(link); } catch {} // ถอด junction ก่อน ไม่ให้ rm ลงไปใน node_modules จริง
  if (process.env.GROCK_KEEP_SANDBOX === "1") return;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }); } catch {}
}

const isBinary = (buf) => buf.subarray(0, 8000).includes(0);
function decodeUtf8(buf) {
  try { return utf8Strict.decode(buf); } catch { return null; }
}

/** เทียบ sandbox กับโปรเจกต์จริง → patch ของไฟล์ที่อยู่ในสิทธิ์ + รายการที่ถูกตัดออก */
export function collectChanges(root, sandbox, grant) {
  const before = walkFiles(root, grant, { skipDenied: true }).files;
  const after = walkFiles(sandbox, grant, { skipDenied: false }).files;
  const rels = [...new Set([...before.keys(), ...after.keys()])].sort();
  const files = [], rejected = [];
  let diff = "";
  for (const rel of rels) {
    const oldAbs = before.get(rel), newAbs = after.get(rel);
    const oldBuf = oldAbs ? fs.readFileSync(oldAbs) : null, newBuf = newAbs ? fs.readFileSync(newAbs) : null;
    if (oldBuf && newBuf && oldBuf.equals(newBuf)) continue;
    const kind = !oldBuf ? "added" : !newBuf ? "deleted" : "modified";
    const can = canWritePath(grant, rel);
    if (!can.ok) { rejected.push({ path: rel, kind, reason: can.reason }); continue; }
    if ((oldBuf && isBinary(oldBuf)) || (newBuf && isBinary(newBuf))) { rejected.push({ path: rel, kind, reason: "ไฟล์ไบนารี (patch ไม่รองรับ)" }); continue; }
    if ((oldBuf?.length || 0) > MAX_DIFF_FILE_BYTES || (newBuf?.length || 0) > MAX_DIFF_FILE_BYTES) { rejected.push({ path: rel, kind, reason: "ไฟล์ใหญ่เกิน 2 MB" }); continue; }
    const oldText = oldBuf ? decodeUtf8(oldBuf) : null, newText = newBuf ? decodeUtf8(newBuf) : null;
    if ((oldBuf && oldText === null) || (newBuf && newText === null)) { rejected.push({ path: rel, kind, reason: "ไม่ใช่ UTF-8 (patch ไม่รองรับ)" }); continue; }
    const d = unifiedDiff(oldText, newText, rel);
    if (!d) continue;
    const st = diffStats(d);
    files.push({ path: rel, kind, add: st.add, del: st.del });
    diff += d;
    if (diff.length > MAX_PATCH_BYTES) throw new Error(`patch ใหญ่เกิน ${Math.round(MAX_PATCH_BYTES / 1024 / 1024)} MB — งานนี้เปลี่ยนไฟล์มากเกินกว่าจะตรวจได้ ควรแบ่งงาน`);
  }
  return { diff, files, rejected, stats: diffStats(diff) };
}

// ===========================================================================
// 4) เขียน/อ่าน patch ใน .grock/out/<jobId>/patches/
// ===========================================================================
function patchFileName(task) {
  return `${pad2(task.seq)}-${slug(task.title)}${task.attempts > 1 ? `-r${task.attempts}` : ""}.diff`;
}

/** เขียน patch + audit sidecar แล้วคืนข้อมูลสำหรับ task.patch (preview ถูกปิดบังค่าลับ, ไฟล์ patch เป็นต้นฉบับเพื่อให้ apply ได้) */
export function writePatch({ pack, task, agent, changes, mode, cli = null, denied = [] }) {
  const out = jobOutputDir(pack, task.jobId);
  const dir = path.join(out.abs, PATCH_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const name = patchFileName(task);
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, changes.diff, "utf8");
  const buf = fs.readFileSync(abs);
  const patch = {
    name,
    rel: `${out.rel}/${PATCH_DIR}/${name}`,
    path: posix(abs),
    sha256: sha256(buf),
    bytes: buf.length,
    mode, // "live" | "sim"
    status: "pending", // pending | applied | rejected | superseded | error
    agentId: agent.id,
    agentName: agent.name,
    attempt: task.attempts,
    files: changes.files,
    rejected: changes.rejected,
    denied,
    stats: changes.stats,
    cli,
    createdAt: Date.now(),
    decidedAt: null,
    decidedBy: null,
    note: "",
    lastError: null,
    preview: redactSecrets(changes.diff).text.slice(0, PREVIEW_CHARS),
  };
  writePatchMeta(patch, { event: "created" });
  return patch;
}

/** sidecar <patch>.json = audit ที่อยู่คู่กับไฟล์ patch (ถูกเติมทุกครั้งที่มีการตัดสินใจ) */
export function writePatchMeta(patch, decision = null) {
  const file = `${patch.path}.json`;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
  const { preview, applying, ...rest } = patch; // preview ก้อนใหญ่และธงชั่วคราวไม่ต้องลง audit
  meta = { ...(meta || {}), ...rest, createdAt: new Date(patch.createdAt).toISOString(), decidedAt: patch.decidedAt ? new Date(patch.decidedAt).toISOString() : null, decisions: meta?.decisions || [] };
  if (decision) meta.decisions.push({ t: new Date().toISOString(), ...decision });
  try { fs.writeFileSync(file, JSON.stringify(meta, null, 2) + "\n", "utf8"); } catch {}
  return meta;
}

/** อ่านไฟล์ patch กลับมา (ตรวจว่าอยู่ในโปรเจกต์ + sha256 ตรงกับตอนสร้าง) */
export function readPatch(pack, patch) {
  const { abs } = resolveInRoot(pack.root, patch.rel);
  if (!fs.existsSync(abs)) throw new Error(`ไม่พบไฟล์ patch ${patch.rel}`);
  const buf = fs.readFileSync(abs);
  if (sha256(buf) !== patch.sha256) throw new Error("ไฟล์ patch ถูกแก้หลังสร้าง (sha256 ไม่ตรง) — ปฏิเสธเพื่อความปลอดภัย ให้สั่งทำงานใหม่");
  return { abs, buf, text: buf.toString("utf8") };
}

// ===========================================================================
// 5) ด่านอนุมัติ: ตรวจ patch กับไฟล์จริงแบบไบต์ต่อไบต์ (+ git apply --check เป็นด่านตรวจเพิ่ม) → เขียนไฟล์ในโปรเจกต์จริง
//    เหตุที่ไม่ให้ git เป็นคนเขียน: core.autocrlf / .gitattributes (text=auto) ทำให้ git แปลงท้ายบรรทัด (CRLF↔LF) ทั้งตอนเทียบและตอนเขียน
//    patch ของเราสร้างจากไบต์จริงของไฟล์ จึงต้องเทียบและเขียนแบบไบต์จริงเพื่อคงรูปแบบท้ายบรรทัดเดิมของโปรเจกต์
// ===========================================================================
/** แปลง patch (รูปแบบที่ unifiedDiff สร้าง / git diff ทั่วไป) → [{ path, kind, hunks: [{ aStart, aLen, bStart, bLen, lines: [{ op, text }] }] }] */
export function parsePatch(text) {
  const files = [];
  let cur = null, hunk = null, lastLine = null;
  for (const raw of String(text).split("\n")) {
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
    if (m) {
      if (m[1] !== m[2]) throw new Error(`header ของ patch ไม่ถูกต้อง: ${shorten(raw, 80)}`);
      cur = { path: m[1], kind: "modified", hunks: [] };
      files.push(cur);
      hunk = null; lastLine = null;
      continue;
    }
    if (!cur) { if (raw.trim()) throw new Error(`patch ไม่ขึ้นต้นด้วย diff --git: ${shorten(raw, 60)}`); continue; }
    if (/^(rename|copy) (from|to) /.test(raw)) throw new Error("patch มี rename/copy ซึ่งไม่รองรับ");
    if (raw.startsWith("new file mode")) { cur.kind = "added"; continue; }
    if (raw.startsWith("deleted file mode")) { cur.kind = "deleted"; continue; }
    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ") || raw.startsWith("old mode") || raw.startsWith("new mode") || raw.startsWith("similarity") || raw.startsWith("Binary files")) {
      if (raw.startsWith("Binary files")) throw new Error(`patch มีไฟล์ไบนารี: ${cur.path}`);
      continue;
    }
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (h) {
      hunk = { aStart: Number(h[1]), aLen: h[2] === undefined ? 1 : Number(h[2]), bStart: Number(h[3]), bLen: h[4] === undefined ? 1 : Number(h[4]), lines: [] };
      cur.hunks.push(hunk);
      lastLine = null;
      continue;
    }
    if (!hunk) { if (raw.trim()) throw new Error(`บรรทัดนอก hunk ใน patch ของ ${cur.path}: ${shorten(raw, 60)}`); continue; }
    if (raw.startsWith("\\")) { if (lastLine) lastLine.text = lastLine.text.replace(/\n$/, ""); continue; } // "\ No newline at end of file"
    if (raw === "" ) { lastLine = null; continue; } // บรรทัดว่างท้ายไฟล์ patch
    const op = raw[0];
    if (op !== " " && op !== "+" && op !== "-") throw new Error(`บรรทัดที่ไม่รู้จักใน patch ของ ${cur.path}: ${shorten(raw, 60)}`);
    lastLine = { op, text: raw.slice(1) + "\n" };
    hunk.lines.push(lastLine);
  }
  for (const f of files) for (const h of f.hunks) {
    const aLen = h.lines.filter((l) => l.op !== "+").length, bLen = h.lines.filter((l) => l.op !== "-").length;
    if (aLen !== h.aLen || bLen !== h.bLen) throw new Error(`hunk ของ ${f.path} นับบรรทัดไม่ตรง header (@@ -${h.aStart},${h.aLen} +${h.bStart},${h.bLen} @@)`);
  }
  return files;
}

const linesEqualAt = (a, pos, pre) => pos >= 0 && pos + pre.length <= a.length && pre.every((l, i) => a[pos + i] === l);

/** apply hunks กับเนื้อหาเดิมแบบตรงตัว (ต้องเจอบรรทัดต้นฉบับที่ตำแหน่งเดิม หรือเจอเพียงที่เดียวในไฟล์) */
export function applyHunks(oldText, hunks, label = "") {
  const a = splitLines(oldText);
  const out = [];
  let ai = 0;
  for (const h of hunks) {
    const pre = h.lines.filter((l) => l.op !== "+").map((l) => l.text);
    let pos = h.aLen ? h.aStart - 1 : h.aStart;
    if (!linesEqualAt(a, pos, pre)) {
      let found = -1;
      if (pre.length) {
        for (let i = ai; i + pre.length <= a.length; i++) if (linesEqualAt(a, i, pre)) { if (found >= 0) { found = -2; break; } found = i; }
      }
      if (found < 0) throw new Error(`${label}: บรรทัดต้นฉบับที่ @@ -${h.aStart},${h.aLen} @@ ไม่ตรงกับไฟล์ปัจจุบัน${found === -2 ? " (เจอหลายที่)" : ""} — ไฟล์เปลี่ยนไปจากตอนสร้าง patch`);
      pos = found;
    }
    if (pos < ai) throw new Error(`${label}: hunk ซ้อนทับกัน`);
    for (let i = ai; i < pos; i++) out.push(a[i]);
    for (const l of h.lines) if (l.op !== "-") out.push(l.text);
    ai = pos + pre.length;
  }
  for (let i = ai; i < a.length; i++) out.push(a[i]);
  return out.join("");
}

/**
 * ตรวจ patch กับไฟล์จริงใน root (ไม่เขียน) → แผนการเขียน [{ rel, abs, kind, newText }]
 * โยน Error เมื่อไฟล์เปลี่ยนไป / ไฟล์ใหม่มีอยู่แล้ว / path ออกนอกโปรเจกต์
 */
export function planPatch(root, diffText) {
  const files = parsePatch(diffText);
  if (!files.length) throw new Error("patch ว่าง");
  const plan = [];
  for (const f of files) {
    const { abs, rel } = resolveInRoot(root, f.path);
    if (rel !== f.path.replace(/\\/g, "/")) throw new Error(`path ใน patch ไม่สะอาด: ${f.path}`);
    const exists = fs.existsSync(abs);
    if (f.kind === "added") {
      if (exists) throw new Error(`${f.path}: ไฟล์มีอยู่แล้ว (patch ต้องการสร้างใหม่)`);
      plan.push({ rel, abs, kind: "added", newText: applyHunks("", f.hunks, f.path) });
      continue;
    }
    if (!exists || !fs.statSync(abs).isFile()) throw new Error(`${f.path}: ไม่พบไฟล์ในโปรเจกต์`);
    const buf = fs.readFileSync(abs);
    const oldText = decodeUtf8(buf);
    if (oldText === null || isBinary(buf)) throw new Error(`${f.path}: ไฟล์ไม่ใช่ข้อความ UTF-8`);
    const newText = applyHunks(oldText, f.hunks, f.path);
    if (f.kind === "deleted") {
      if (newText !== "") throw new Error(`${f.path}: patch บอกว่าลบไฟล์ แต่ยังเหลือเนื้อหา`);
      plan.push({ rel, abs, kind: "deleted", newText: null });
    } else plan.push({ rel, abs, kind: "modified", newText });
  }
  return plan;
}

/** เขียนตามแผน (ไฟล์ละครั้ง เขียน tmp แล้ว rename) */
function executePlan(plan) {
  for (const p of plan) {
    if (p.kind === "deleted") { fs.unlinkSync(p.abs); continue; }
    fs.mkdirSync(path.dirname(p.abs), { recursive: true });
    const tmp = `${p.abs}.${process.pid}.grock-tmp`;
    fs.writeFileSync(tmp, p.newText, "utf8");
    fs.renameSync(tmp, p.abs);
  }
}

/** apply patch text กับโฟลเดอร์ (ใช้ในเทสต์และเป็นแกนของ applyPatchToProject) → รายชื่อไฟล์ */
export function applyDiffToTree(root, diffText) {
  const plan = planPatch(root, diffText);
  executePlan(plan);
  return plan.map((p) => p.rel);
}

function runGit(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60000, windowsHide: true });
  if (r.error) return { status: -1, stdout: "", stderr: r.error.code === "ENOENT" ? "ไม่พบ git ในเครื่อง (ต้องติดตั้ง git เพื่อ apply patch)" : r.error.message };
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

/** โปรเจกต์อยู่ใต้ git repo ที่รากอยู่สูงกว่า → git apply ต้องใช้ --directory=<พาธจากราก> เพราะ git ตีความ path ใน patch จากราก repo */
export function gitApplyExtraArgs(root) {
  const r = runGit(["rev-parse", "--show-toplevel"], root);
  if (r.status !== 0) return [];
  let top = r.stdout.trim();
  if (!top) return [];
  try { top = fs.realpathSync.native(top); } catch {}
  let real = root;
  try { real = fs.realpathSync.native(root); } catch {}
  const rel = path.relative(top, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return [];
  return [`--directory=${posix(rel)}`];
}

/** git apply --check (ปิดการแปลงท้ายบรรทัด) เป็นด่านตรวจเพิ่ม → { ok, skipped, message } */
export function gitCheckPatch(root, patchAbs) {
  const extra = gitApplyExtraArgs(root);
  const r = runGit(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "apply", "--check", "--whitespace=nowarn", ...extra, patchAbs], root);
  if (r.status === -1) return { ok: false, skipped: true, message: r.stderr };
  return { ok: r.status === 0, skipped: false, message: r.status === 0 ? "git apply --check ผ่าน" : shorten(r.stderr.trim().replace(/\s+/g, " "), 300) };
}

/**
 * นำ patch ที่รออนุมัติเข้าโปรเจกต์จริง:
 *   ตรวจ sha256 ของไฟล์ patch → สิทธิ์ล่าสุดของทุก path → git apply --check (ด่านตรวจเพิ่ม บันทึกผล) → เทียบบรรทัดต้นฉบับแบบไบต์ต่อไบต์ (ด่านหลัก) → เขียนไฟล์
 * @returns {{ files: string[], gitCheck: object }}
 */
export function applyPatchToProject({ pack, patch, note = "", by = "dashboard" }) {
  if (!patch || patch.status !== "pending") throw new Error("ไม่มี patch ที่รออนุมัติ");
  const { abs, text } = readPatch(pack, patch);
  const grant = writeGrantFor(pack, patch.agentId);
  if (!grant) throw new Error(`โปรเจกต์ไม่ให้สิทธิ์แก้ไฟล์กับ ${patch.agentId} แล้ว (ตรวจ permissions ใน .grock/project.json)`);
  const paths = patchPaths(text);
  if (!paths.length) throw new Error("patch ว่าง");
  for (const rel of paths) {
    const can = canWritePath(grant, rel);
    if (!can.ok) throw new Error(`patch แตะไฟล์นอกสิทธิ์: ${rel} (${can.reason})`);
    resolveInRoot(pack.root, rel); // กัน ../ หรือ junction ออกนอกโปรเจกต์
  }
  const gitCheck = gitCheckPatch(pack.root, abs);
  let plan;
  try {
    plan = planPatch(pack.root, text);
  } catch (err) {
    throw new Error(`ตรวจ patch กับไฟล์ปัจจุบันไม่ผ่าน: ${err.message}${!gitCheck.ok && !gitCheck.skipped ? ` · git apply --check: ${gitCheck.message}` : ""}`);
  }
  executePlan(plan);
  const files = plan.map((p) => p.rel);
  const gitNote = gitCheck.skipped ? `git apply --check ข้าม (${gitCheck.message})` : gitCheck.ok ? "git apply --check ผ่าน" : `git apply --check เตือน: ${gitCheck.message} — ระบบเทียบไบต์ต่อไบต์แล้วตรงกัน (มักเป็นเรื่อง CRLF/LF หรือ .gitattributes) จึง apply ด้วยตัวเขียนของระบบ`;
  writePatchMeta({ ...patch, status: "applied", decidedAt: Date.now(), decidedBy: by, note }, { event: "applied", by, note, files, gitCheck: gitNote });
  return { files, gitCheck: { ...gitCheck, note: gitNote } };
}

export function rejectPatchOfProject({ patch, reason = "", by = "dashboard" }) {
  if (!patch || patch.status !== "pending") throw new Error("ไม่มี patch ที่รออนุมัติ");
  writePatchMeta({ ...patch, status: "rejected", decidedAt: Date.now(), decidedBy: by, note: reason }, { event: "rejected", by, note: reason });
}

export function markPatch(patch, status, note = "") {
  writePatchMeta({ ...patch, status, decidedAt: Date.now(), note }, { event: status, note });
}

// ===========================================================================
// 6) ผลงาน (ข้อความ) ที่ส่งกลับให้กัปตัน/QA — มี patch preview ให้ QA ตรวจได้
// ===========================================================================
const KIND_TH = { added: "เพิ่มใหม่", deleted: "ลบ", modified: "แก้ไข" };
export function composeEditOutput({ summary, patch, changes, denied = [] }) {
  const parts = [summary?.trim() || "(Claude Code ไม่ได้ส่งข้อความสรุป)"];
  if (patch) {
    parts.push(`## Patch รออนุมัติ: ${patch.rel}`);
    parts.push(`ไฟล์ที่เปลี่ยน ${patch.files.length} ไฟล์ (+${patch.stats.add} −${patch.stats.del}) — ยังไม่ได้แตะไฟล์จริง ต้องให้ผู้ควบคุมกด apply บน dashboard ก่อน`);
    parts.push(patch.files.map((f) => `- ${f.path} — ${KIND_TH[f.kind] || f.kind} (+${f.add} −${f.del})`).join("\n"));
  } else parts.push("## ไม่มีการแก้ไฟล์\nไม่มีการเปลี่ยนแปลงไฟล์ในขอบเขตสิทธิ์ (งานนี้จึงเป็นข้อเสนอ/คำอธิบายเท่านั้น)");
  const rejected = changes?.rejected || patch?.rejected || [];
  if (rejected.length) parts.push(`ถูกตัดออกเพราะนอกสิทธิ์ (${rejected.length}):\n${rejected.map((r) => `- ${r.path} — ${r.reason}`).join("\n")}`);
  if (denied.length) parts.push(`คำสั่งที่ Claude Code ถูกปฏิเสธโดยอัตโนมัติ (${denied.length}):\n${denied.map((d) => `- ${d.tool_name || d.tool || "?"}: ${shorten(JSON.stringify(d.tool_input || d.input || ""), 100)}`).join("\n")}`);
  if (patch) {
    const diff = redactSecrets(changes?.diff || "").text;
    parts.push("```diff\n" + (diff.length > OUTPUT_DIFF_CHARS ? diff.slice(0, OUTPUT_DIFF_CHARS) + `\n…[ตัดที่ ${OUTPUT_DIFF_CHARS} ตัวอักษร ดูฉบับเต็มที่ ${patch.rel}]` : diff) + "\n```");
  }
  return parts.join("\n\n");
}

// ===========================================================================
// 7) โหมด LIVE: เรียก Claude Code headless ใน sandbox
// ===========================================================================
/** prompt ที่ส่งทาง stdin (ไม่ใส่ใน argv เพื่อเลี่ยงปัญหา quote/ความยาวบน Windows) */
export function headlessPrompt({ agent, task, context, grant, taskBody }) {
  const pack = context.project.pack;
  const roleDef = ROLES.coder;
  let skill = skillFor("coder");
  const ps = projectSkillFor(pack, "coder");
  if (ps) skill = ps.replace || agent.skillMode === "replace" ? ps.text : `${skill}\n\n[ทักษะเพิ่มเฉพาะโปรเจกต์]\n${ps.text}`;
  const who = agent.nick && agent.nick !== agent.name ? `${agent.name} (${agent.nick})` : agent.name;
  const alwaysDeny = [...WRITE_ALWAYS_DENY_DIRS].map((d) => `${d}/`).concat(["ไฟล์ค่าลับ (.env*, *.pem, *.key, credentials*.json ฯลฯ)"]);
  return [
    `คุณคือ ${who} ตำแหน่ง ${roleDef.label} ในทีม AI ขององค์กร\n${roleDef.system}`,
    agent.duties ? `หน้าที่ประจำของคุณ: ${agent.duties}` : "",
    skill ? `[คู่มือทักษะประจำตำแหน่ง]\n${skill.replace(/code_execution/g, "เครื่องมือของ Claude Code")}` : "",
    context.project.system ? `[โปรเจกต์]\n${context.project.system}` : "",
    agent.instructions ? `[คำแนะนำเฉพาะคุณในโปรเจกต์นี้]\n${agent.instructions}` : "",
    `[กติกาการแก้ไฟล์ — บังคับ]
- โฟลเดอร์ทำงานนี้คือสำเนา (sandbox) ของโปรเจกต์ "${pack.name}" ที่ ${pack.rootPosix} การเปลี่ยนแปลงทั้งหมดจะถูกสรุปเป็น patch ให้มนุษย์ตรวจและอนุมัติก่อนนำเข้าโปรเจกต์จริง
- แก้ได้เฉพาะไฟล์ที่ตรงกับ: ${grant.write.join(", ")} — การแก้ไฟล์นอกขอบเขตนี้จะถูกตัดออกจาก patch (เสียเปล่า)
- ห้ามแตะ: ${[...grant.deny, ...alwaysDeny].join(", ")}
- เครื่องมือที่ใช้ได้: ${grant.tools.join(", ")} (และอ่าน/ค้นหาไฟล์) — คำสั่งอื่นจะถูกปฏิเสธอัตโนมัติ อย่าพยายามหลบเลี่ยง
- ห้าม git commit/branch/push ห้ามติดตั้งแพ็กเกจใหม่ ห้ามเขียนค่าลับลงไฟล์ ห้ามลบไฟล์ที่ไม่เกี่ยวกับงาน
- ทำเฉพาะงานที่ได้รับมอบหมาย เปลี่ยนให้น้อยที่สุดเท่าที่จำเป็น คงสไตล์โค้ดเดิม และรันเทสต์ด้วยเครื่องมือที่อนุญาตถ้ามี`,
    `[งาน]\n${taskBody}`,
    context.files?.length ? `ไฟล์ที่ผู้สั่งงานแนบมาให้ใช้ประกอบ (เปิดอ่านได้ในโฟลเดอร์นี้): ${context.files.map((f) => f.path).join(", ")}` : "",
    "เมื่อทำเสร็จ ให้ตอบสรุปเป็นภาษาไทย: ไฟล์ที่แก้และเหตุผล วิธีทดสอบ และสิ่งที่ยังไม่ได้ทำ (ถ้ามี) — ไม่ต้องวางโค้ดทั้งไฟล์ซ้ำในคำตอบ",
  ].filter(Boolean).join("\n\n");
}

function toolPhase(c, cwd) {
  const inp = c.input || {};
  const rel = (p) => (p ? shorten(posix(path.relative(cwd, String(p))) || String(p), 60) : "");
  switch (c.name) {
    case "Edit": case "Write": case "MultiEdit": case "NotebookEdit": return `กำลังแก้ไฟล์: ${rel(inp.file_path || inp.notebook_path)}`;
    case "Bash": return `กำลังรันคำสั่ง: ${shorten(String(inp.command || ""), 60)}`;
    case "Read": return `กำลังอ่าน: ${rel(inp.file_path)}`;
    case "Glob": case "Grep": return "กำลังค้นหาในโค้ด";
    default: return `กำลังใช้ ${c.name}`;
  }
}

/** รัน claude แบบ headless อ่าน stream-json ทีละบรรทัด (prompt ส่งทาง stdin) */
function spawnClaude({ launch, args, cwd, prompt, timeoutMs, signal, onEvent }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.cmd, spawnArgs(launch, args), { cwd, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: launch.shell });
    } catch (err) { return reject(err); }
    let stdoutTail = "", stderr = "", buf = "", timedOut = false, done = false;
    const kill = () => { try { child.kill(); } catch {} const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000); t.unref?.(); };
    const onAbort = () => kill();
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); resolve(res); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        stdoutTail = (stdoutTail + line + "\n").slice(-4000);
        try { onEvent(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-4000); });
    child.on("error", (err) => finish({ code: -1, error: err, stderr: err.message, stdoutTail, timedOut }));
    child.on("close", (code, sig) => {
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch {} }
      finish({ code, signal: sig, stderr, stdoutTail, timedOut });
    });
    try { child.stdin.on("error", () => {}); child.stdin.end(prompt, "utf8"); } catch {}
  });
}

/** โหมด LIVE: แก้ไฟล์ใน sandbox ด้วย Claude Code → patch รออนุมัติ */
export async function runHeadlessEdit({ agent, task, context, grant, cli = null, taskBody, signal, onProgress }) {
  cli = cli || findClaudeCli();
  if (!cli.bin) throw new Error(cli.error);
  const pack = context.project.pack;
  fs.mkdirSync(SANDBOX_BASE, { recursive: true });
  const sandbox = fs.mkdtempSync(path.join(SANDBOX_BASE, `grock-${String(task.id).replace(/[^a-z0-9-]/gi, "")}-`));
  let link = null;
  const st = { result: null, text: "", toolCalls: 0, model: null };
  try {
    onProgress?.({ phase: "กำลังเตรียม sandbox (สำเนาโปรเจกต์)", progress: 0.04, tool: null });
    const copied = copyProjectToSandbox(pack.root, sandbox, grant);
    link = maybeLinkDeps(pack.root, sandbox, grant);
    if (signal?.aborted) throw abortErr();
    const prompt = headlessPrompt({ agent, task, context, grant, taskBody });
    const args = claudeArgs({ grant, agent });
    onProgress?.({ phase: `กำลังเรียก Claude Code ${cli.version || ""} (headless, ${copied.files} ไฟล์ใน sandbox)`, progress: 0.08, tool: CLI_TOOL_NAME, toolStarted: true });
    const run = await spawnClaude({
      launch: cli.launch, args, cwd: sandbox, prompt, timeoutMs: grant.timeoutSec * 1000, signal,
      onEvent: (ev) => {
        if (ev.type === "assistant") {
          for (const c of ev.message?.content || []) {
            if (c.type === "text" && c.text) { st.text = c.text; onProgress?.({ phase: "กำลังเขียนสรุป", text: c.text.slice(-1500), progress: Math.min(0.85, 0.15 + st.toolCalls * 0.03), tool: null }); }
            else if (c.type === "tool_use") { st.toolCalls++; onProgress?.({ phase: toolPhase(c, sandbox), tool: CLI_TOOL_NAME, toolStarted: true, progress: Math.min(0.85, 0.15 + st.toolCalls * 0.03) }); }
          }
        } else if (ev.type === "result") st.result = ev;
        else if (ev.type === "system" && ev.subtype === "init" && ev.model) st.model = ev.model;
      },
    });
    if (signal?.aborted) throw abortErr();
    const res = st.result;
    if (!res) {
      const why = run.timedOut ? `Claude Code ทำงานเกิน ${grant.timeoutSec} วินาที — หยุดแล้ว` : `Claude Code จบโดยไม่มีผลลัพธ์ (exit ${run.code})`;
      throw new Error(`${why}${run.stderr ? `: ${shorten(run.stderr.trim().replace(/\s+/g, " "), 240)}` : ""}`);
    }
    onProgress?.({ phase: "กำลังเทียบไฟล์และสรุป patch", progress: 0.92, tool: null });
    const changes = collectChanges(pack.root, sandbox, grant);
    // claude จริง (2.1.157): เมื่อ is_error (เช่น error_max_budget_usd = ชน --max-budget-usd) ไม่มี field result แต่มี errors[] — ไฟล์ที่แก้ไปแล้วก่อนหยุดยังอยู่ใน sandbox จึงยังสรุปเป็น patch ได้ (พร้อมคำเตือน)
    const cliErrors = (Array.isArray(res.errors) ? res.errors : []).map((e) => String(e?.message || e || "")).filter(Boolean);
    const errorText = cliErrors.join("; ") || (typeof res.error === "string" ? res.error : "");
    let summary = typeof res.result === "string" && res.result.trim() ? res.result : st.text;
    if (res.is_error && !changes.files.length) throw new Error(`Claude Code รายงานข้อผิดพลาด (${res.subtype || "error"}): ${shorten(String(errorText || summary || ""), 240)}`);
    if (res.is_error) summary = `⚠️ Claude Code หยุดก่อนเสร็จ (${res.subtype || "error"}${errorText ? `: ${shorten(errorText, 200)}` : ""}) — patch นี้อาจไม่ครบ ตรวจ diff ให้ดีก่อน apply${summary ? `\n\n${summary}` : ""}`;
    const denied = Array.isArray(res.permission_denials) ? res.permission_denials : [];
    const cliInfo = { version: cli.version, subtype: res.subtype || null, isError: Boolean(res.is_error), errors: cliErrors, turns: res.num_turns ?? null, durationMs: res.duration_ms ?? null, costUsd: res.total_cost_usd ?? null, sessionId: res.session_id || null, sandboxFiles: copied.files };
    const patch = changes.files.length ? writePatch({ pack, task, agent, changes, mode: "live", cli: cliInfo, denied }) : null;
    // usage: claude จริงรายงาน result.usage เป็นยอดรวมทุก turn เมื่อสำเร็จ แต่ตอน is_error เป็นแค่ turn แรก — modelUsage (รายโมเดล) เป็นยอดรวมเสมอ จึงเอาค่าที่มากกว่า
    const u = res.usage || {};
    const mu = Object.values(res.modelUsage && typeof res.modelUsage === "object" ? res.modelUsage : {});
    const tok = (uKey, mKey) => Math.max(Number(u[uKey]) || 0, mu.reduce((a, m) => a + (Number(m?.[mKey]) || 0), 0));
    const cacheRead = tok("cache_read_input_tokens", "cacheReadInputTokens"), cacheWrite = tok("cache_creation_input_tokens", "cacheCreationInputTokens");
    const usage = {
      input_tokens: tok("input_tokens", "inputTokens"),
      output_tokens: tok("output_tokens", "outputTokens"),
      ...(cacheRead ? { cache_read_input_tokens: cacheRead } : {}),
      ...(cacheWrite ? { cache_creation_input_tokens: cacheWrite } : {}),
      ...(Number.isFinite(Number(res.total_cost_usd)) ? { total_cost_usd: Number(res.total_cost_usd) } : {}),
    };
    const model = Object.keys(res.modelUsage || {})[0] || st.model || grant.model || agent.model;
    return { output: composeEditOutput({ summary, patch, changes, denied }), usage, model, toolCalls: st.toolCalls, patch, changes: { files: changes.files.length, rejected: changes.rejected.length } };
  } finally {
    cleanupSandbox(sandbox, link);
  }
}

// ===========================================================================
// 8) โหมด SIM: patch ปลอมที่ apply ได้จริง (ไฟล์ใหม่ + ต่อท้ายไฟล์เดิม 1 บรรทัด) โดยไม่เรียก claude
// ===========================================================================
const line2 = (t) => `// ${t}`, hash = (t) => `# ${t}`, html = (t) => `<!-- ${t} -->`;
const COMMENT_BY_EXT = {
  js: line2, mjs: line2, cjs: line2, ts: line2, tsx: line2, jsx: line2, go: line2, rs: line2, java: line2, kt: line2, cs: line2, c: line2, cpp: line2, h: line2, swift: line2, php: line2, scss: line2,
  css: (t) => `/* ${t} */`, py: hash, rb: hash, sh: hash, ps1: hash, yml: hash, yaml: hash, toml: hash, r: hash,
  md: html, html, vue: html, txt: (t) => t,
};

/** โฟลเดอร์เป้าหมายของ glob แรก: "src/**" → "src", "**" → "", "docs/api.md" → "docs" */
function globDir(glob) {
  const wild = glob.search(/[*?]/);
  if (wild < 0) return glob.includes("/") ? glob.slice(0, glob.lastIndexOf("/")) : glob.includes(".") ? "" : glob;
  return glob.slice(0, wild).replace(/\/[^/]*$/, "").replace(/\/+$/, "");
}

function findSimTarget(pack, grant) {
  for (const rel of pack.tree || []) {
    if (rel.endsWith("/")) continue;
    const ext = rel.split(".").pop().toLowerCase();
    if (!COMMENT_BY_EXT[ext] || !canWritePath(grant, rel).ok) continue;
    let abs;
    try { abs = resolveInRoot(pack.root, rel).abs; } catch { continue; }
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 200_000) continue;
      const buf = fs.readFileSync(abs);
      if (isBinary(buf)) continue;
      const text = decodeUtf8(buf);
      if (text === null) continue;
      return { rel, text, ext };
    } catch {}
  }
  return null;
}

/** สร้าง changes จำลอง (ไม่แตะไฟล์จริง) — คืน null ถ้าไม่มีไฟล์ไหนอยู่ในสิทธิ์เลย */
export function simulateChanges({ pack, grant, task, agent }) {
  const files = [];
  let diff = "";
  const stamp = `grock sim: ${task.title} (${agent.name}, รอบที่ ${task.attempts})`;
  const dir = globDir(grant.write[0]);
  const newRel = `${dir ? `${dir}/` : ""}GROCK-SIM-${pad2(task.seq)}${task.attempts > 1 ? `-r${task.attempts}` : ""}.md`;
  let newAbs = null;
  try { newAbs = resolveInRoot(pack.root, newRel).abs; } catch {}
  if (newAbs && !fs.existsSync(newAbs) && canWritePath(grant, newRel).ok) {
    const content = `# ผลงานจำลองของ ${agent.name}: ${task.title}\n\n(โหมด sim — ไม่ได้เรียก Claude Code จริง ไฟล์นี้ใช้ทดสอบด่านอนุมัติ patch ลบได้)\n\n- โจทย์: ${task.description}\n- โปรเจกต์: ${pack.name}\n`;
    const d = unifiedDiff(null, content, newRel);
    const st = diffStats(d);
    files.push({ path: newRel, kind: "added", add: st.add, del: st.del });
    diff += d;
  }
  const target = findSimTarget(pack, grant);
  if (target) {
    const eol = target.text.includes("\r\n") ? "\r\n" : "\n";
    const line = COMMENT_BY_EXT[target.ext](stamp);
    const newText = `${target.text}${target.text === "" || target.text.endsWith("\n") ? "" : eol}${line}${eol}`;
    const d = unifiedDiff(target.text, newText, target.rel);
    const st = diffStats(d);
    files.push({ path: target.rel, kind: "modified", add: st.add, del: st.del });
    diff += d;
  }
  if (!files.length) return null;
  return { diff, files, rejected: [], stats: diffStats(diff) };
}
