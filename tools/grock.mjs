#!/usr/bin/env node
// grock.mjs — สั่งงานทีม AI (AI Workforce Control Center) ให้โปรเจกต์อื่นจากบรรทัดคำสั่ง (ไม่มี dependency)
//
//   node tools/grock.mjs init <โฟลเดอร์โปรเจกต์> [--id myshop] [--name "ชื่อ"]   สร้าง .grock/ + ลงทะเบียน
//   node tools/grock.mjs projects                                              รายชื่อโปรเจกต์ที่ลงทะเบียน
//   node tools/grock.mjs context <id> [--role coder] [--tokens] [--full]        ดูว่าเอเจนต์จะเห็นอะไร (ใช้ได้ในโหมด sim)
//   node tools/grock.mjs run "<โจทย์>" --project <id|.> [--files a.md,b.ts] [--wait]
//   node tools/grock.mjs run --goal-file goal.txt --project . --wait            (โจทย์ภาษาไทยยาว ๆ ใส่ไฟล์ได้)
//   node tools/grock.mjs status <jobId>
//   node tools/grock.mjs register <id> <โฟลเดอร์>                             ลงทะเบียนโฟลเดอร์ที่มี .grock/ อยู่แล้ว
//   node tools/grock.mjs patches [jobId]                                       patch ของ Developer ที่รออนุมัติ (แก้ไฟล์จริง)
//   node tools/grock.mjs patch <taskId>                                        พิมพ์ diff ฉบับเต็ม
//   node tools/grock.mjs apply <taskId> [--note "..."]                         อนุมัติ → git apply เข้าโปรเจกต์
//   node tools/grock.mjs reject <taskId> [--reason "..."]                      ปฏิเสธ (ไม่แตะไฟล์)
//
// ตั้ง GROCK_URL ถ้าเซิร์ฟเวอร์ไม่ได้อยู่ที่ http://127.0.0.1:3789
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.GROCK_URL || "http://127.0.0.1:3789").replace(/\/+$/, "");
const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const flags = {};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; } else flags[key] = true;
  } else positional.push(a);
}

// ตัด control characters (ยกเว้น tab) ก่อนพิมพ์ — ข้อความบางส่วนมาจากไฟล์ของโปรเจกต์ ซึ่งอาจฝัง escape sequence ของเทอร์มินัล
const out = (s = "") => process.stdout.write(`${String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}\n`);
const die = (msg, code = 1) => { process.stderr.write(`✖ ${msg}\n`); process.exit(code); };

async function api(method, p, body) {
  let res;
  try {
    res = await fetch(`${BASE}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    die(`ต่อเซิร์ฟเวอร์ ${BASE} ไม่ได้ (${err.cause?.code || err.message}) — เปิดศูนย์ควบคุมด้วย npm start ก่อน`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${method} ${p} → ${res.status}: ${data.error || res.statusText}`);
  return data;
}

async function serverUp() {
  try {
    const r = await fetch(`${BASE}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function resolveProjectId(idOrDot) {
  if (!idOrDot || idOrDot === ".") {
    const cwd = fs.realpathSync.native(process.cwd()).replace(/\\/g, "/").toLowerCase();
    const { projects } = await api("GET", "/api/projects");
    const hit = projects.find((p) => String(p.root || "").replace(/\\/g, "/").toLowerCase() === cwd);
    if (!hit) die(`โฟลเดอร์ปัจจุบันยังไม่ได้ลงทะเบียนเป็นโปรเจกต์ — รัน: node "${path.join(here, "grock.mjs")}" init "${process.cwd()}" --id <id>`);
    return hit.id;
  }
  return idOrDot;
}

const PHASE_ICON = { "task.started": "▶", "task.completed": "✅", "task.failed": "⚠️", "task.assigned": "📨", "task.handoff": "🔁" };

/** ติดตามเหตุการณ์ของโจทย์ผ่าน SSE จนจบ (Node 24 ไม่มี EventSource → อ่าน stream เอง) */
async function follow(jobId) {
  let lastId = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    let res;
    try {
      res = await fetch(`${BASE}/api/events`, { headers: lastId ? { "Last-Event-ID": String(lastId) } : {} });
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          let ev;
          try { ev = JSON.parse(dataLine.slice(6)); } catch { continue; }
          if (ev.id) lastId = ev.id;
          const result = handleEvent(ev, jobId);
          if (result !== undefined) return result;
        }
      }
    } catch {
      // หลุด → ต่อใหม่
    }
    attempt = Math.max(0, attempt - 1); // การหลุดชั่วคราวไม่นับเป็นความล้มเหลว
    await new Promise((r) => setTimeout(r, 1000));
  }
  die("ติดตามเหตุการณ์ไม่ได้ (หลุดการเชื่อมต่อซ้ำ) — ดูสถานะด้วย: status " + jobId);
}

function handleEvent(ev, jobId) {
  const d = ev.data || {};
  const t = d.task, j = d.job;
  const belongs = (t && t.jobId === jobId) || (j && j.id === jobId) || d.jobId === jobId;
  if (!belongs) return undefined;
  const ts = new Date(ev.ts).toLocaleTimeString("th-TH", { hour12: false });
  switch (ev.type) {
    case "log":
      out(`${ts}  ${d.message}`);
      break;
    case "job.planned":
      out(`${ts}  🧭 กัปตันวางแผนแล้ว ${j.taskIds.length} งาน`);
      break;
    case "task.started":
    case "task.completed":
    case "task.failed":
      out(`${ts}  ${PHASE_ICON[ev.type]} [${t.role}] ${t.title}${ev.type === "task.completed" ? ` ($${(t.usage?.costUsd || 0).toFixed(4)})` : ""}${ev.type === "task.failed" ? ` — ${d.error || ""}` : ""}`);
      break;
    case "task.patch":
      if (d.action === "pending") out(`${ts}  🩹 patch รออนุมัติ: ${t.title} → ${t.patch?.rel} (${(t.patch?.files || []).length} ไฟล์)  อนุมัติ: apply ${t.id}  ปฏิเสธ: reject ${t.id}`);
      else if (d.action === "applied") out(`${ts}  ✅ apply patch แล้ว: ${t.title} (${(d.files || []).length} ไฟล์)`);
      else if (d.action === "rejected") out(`${ts}  🚫 ปฏิเสธ patch: ${t.title}`);
      else if (d.action === "error") out(`${ts}  ⚠️ apply patch ไม่สำเร็จ: ${d.error || ""}`);
      break;
    case "job.completed":
      out(`${ts}  🎉 เสร็จสมบูรณ์ ต้นทุน $${(j.costUsd || 0).toFixed(4)}`);
      if (j.outputDir) out(`ผลงาน: ${j.outputDir}/result.md`);
      return 0;
    case "job.failed":
      out(`${ts}  ❌ โจทย์ล้มเหลว`);
      if (j.outputDir) out(`ผลงานบางส่วน: ${j.outputDir}/`);
      return 1;
    default:
      break;
  }
  return undefined;
}

/** หลังโจทย์จบ: เตือนถ้ามี patch ของ Developer ที่ยังรออนุมัติ (ไฟล์ในโปรเจกต์ยังไม่เปลี่ยนจนกว่าจะ apply) */
async function printPending(jobId) {
  try {
    const { tasks } = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
    const pending = tasks.filter((t) => t.patch?.status === "pending");
    if (!pending.length) return;
    out(`🩹 มี patch รออนุมัติ ${pending.length} รายการ (ไฟล์ในโปรเจกต์ยังไม่ถูกแตะ):`);
    for (const t of pending) out(`   ${t.id}  ${t.title}  → ${t.patch.rel}  (apply ${t.id} | reject ${t.id})`);
  } catch {}
}

async function main() {
  switch (cmd) {
    case "init": {
      const dir = positional[0];
      if (!dir) die('ใช้: init <โฟลเดอร์โปรเจกต์> [--id myshop] [--name "ชื่อ"]');
      const { initPack } = await import(path.join(here, "..", "server", "projects.js").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "file:///$1:"));
      const r = initPack(dir, { id: flags.id, name: flags.name, register: true });
      out(`✔ สร้าง ${r.packDir} แล้ว (id: ${r.id})`);
      out(`  ไฟล์แนะนำที่พบและจะถูกอ่านทุกครั้ง: ${r.always.length ? r.always.join(", ") : "ไม่มี (แก้ context.always ใน project.json)"}`);
      out(`  ขั้นต่อไป: แก้ ${path.join(r.packDir, "brief.md")} ให้ตรงกับโปรเจกต์ แล้วลอง: context ${r.id}`);
      if (await serverUp()) await api("POST", "/api/projects/reload");
      else out("  (เซิร์ฟเวอร์ยังไม่เปิด — ทะเบียนถูกเขียนลง data/projects.json แล้ว จะเห็นเมื่อเปิดเซิร์ฟเวอร์)");
      break;
    }
    case "register": {
      const [id, dir] = positional;
      if (!id || !dir) die("ใช้: register <id> <โฟลเดอร์>");
      const r = await api("POST", "/api/projects", { id, path: dir, name: flags.name });
      out(`✔ ลงทะเบียน ${r.project.id} → ${r.project.path}`);
      break;
    }
    case "projects": {
      const { projects } = await api("GET", "/api/projects");
      if (!projects.length) out("ยังไม่มีโปรเจกต์ — ใช้: init <โฟลเดอร์> --id <id>");
      for (const p of projects) out(`${p.ok ? "✔" : "✖"} ${p.id.padEnd(14)} ${p.name.padEnd(24)} ${p.root}${p.ok ? "" : `  (${p.error})`}`);
      break;
    }
    case "context": {
      const id = await resolveProjectId(positional[0]);
      const role = flags.role || "captain";
      const q = new URLSearchParams({ role, ...(flags.tokens ? { tokens: "1" } : {}), fresh: "1" });
      const c = await api("GET", `/api/projects/${encodeURIComponent(id)}/context?${q}`);
      out(`โปรเจกต์ ${c.name} (${c.id}) — ${c.root}`);
      out(`บริบทสำหรับตำแหน่ง ${role}: system ${c.systemChars.toLocaleString()} + ข้อมูล ${c.dataChars.toLocaleString()} ตัวอักษร ≈ ${c.estTokens.toLocaleString()} โทเคน${c.inputTokens != null ? ` (นับจริง ${c.inputTokens.toLocaleString()})` : ""}`);
      out(`ดัชนีเอกสาร ${c.docsIndex} รายการ · โครงสร้างไฟล์ ${c.tree} รายการ`);
      out("ไฟล์ที่ใส่ให้:");
      for (const f of c.files) out(`  ${f.skippedReason ? "✖" : "✔"} ${f.path.padEnd(40)} ${f.skippedReason ? `ข้าม: ${f.skippedReason}` : `${f.chars.toLocaleString()} ตัวอักษร${f.truncated ? " (ถูกตัด)" : ""}${f.redactions ? ` ปิดบังค่าลับ ${f.redactions} จุด` : ""}`}`);
      for (const w of c.warnings) out(`  ⚠ ${w}`);
      if (flags.full) { out("\n===== SYSTEM ====="); out(c.system); out("\n===== DATA ====="); out(c.data); }
      break;
    }
    case "run": {
      let goal = positional[0] || "";
      if (flags["goal-file"]) goal = fs.readFileSync(flags["goal-file"], "utf8").replace(/^﻿/, "").trim();
      if (!goal) die('ใช้: run "<โจทย์>" --project <id|.> [--files a,b] [--wait]  หรือ run --goal-file goal.txt');
      const project = await resolveProjectId(flags.project);
      const files = flags.files ? String(flags.files).split(",").map((s) => s.trim()).filter(Boolean) : [];
      const { job } = await api("POST", "/api/jobs", { goal, project, files });
      out(`📥 รับโจทย์แล้ว: ${job.id} (โปรเจกต์ ${project})`);
      if (job.outputDir) out(`ผลงานจะอยู่ที่: ${job.outputDir}`);
      if (!flags.wait) { out(`ติดตามได้ที่ ${BASE} หรือ: status ${job.id}`); break; }
      const code = await follow(job.id);
      await printPending(job.id);
      process.exit(code);
    }
    case "status": {
      const id = positional[0];
      if (!id) die("ใช้: status <jobId>");
      const { job, tasks } = await api("GET", `/api/jobs/${encodeURIComponent(id)}`);
      out(`${job.id}  ${job.status}  $${(job.costUsd || 0).toFixed(4)}  ${job.goal}`);
      for (const t of tasks) out(`  ${String(t.seq).padStart(2, "0")} [${t.role}] ${t.status.padEnd(9)} ${t.title}${t.review ? ` QA ${t.review.score}` : ""}${t.patch ? ` 🩹 ${t.patch.status}` : ""}`);
      if (job.outputDir) out(`ผลงาน: ${job.outputDir}`);
      await printPending(job.id);
      break;
    }
    case "patches": {
      const jobId = positional[0] || null;
      const { tasks } = await api("GET", "/api/state");
      const list = tasks.filter((t) => t.patch && (!jobId || t.jobId === jobId));
      if (!list.length) { out("ไม่มี patch" + (jobId ? ` ของโจทย์ ${jobId}` : "")); break; }
      for (const t of list) out(`${t.patch.status === "pending" ? "🩹" : "  "} ${t.id}  ${t.patch.status.padEnd(10)} ${String((t.patch.files || []).length).padStart(2)} ไฟล์  ${t.title}  → ${t.patch.rel}`);
      out("อนุมัติ: apply <taskId>  ·  ปฏิเสธ: reject <taskId> --reason \"...\"  ·  ดู diff: patch <taskId>");
      break;
    }
    case "patch": {
      const id = positional[0];
      if (!id) die("ใช้: patch <taskId>");
      const r = await api("GET", `/api/tasks/${encodeURIComponent(id)}/patch`);
      out(`# ${r.patch.rel}  (${r.patch.status}, ${(r.patch.files || []).length} ไฟล์, +${r.patch.stats?.add ?? 0} −${r.patch.stats?.del ?? 0})`);
      if (r.error) out(`# ${r.error}`);
      if (r.diff) process.stdout.write(r.diff.endsWith("\n") ? r.diff : r.diff + "\n");
      break;
    }
    case "apply": {
      const id = positional[0];
      if (!id) die('ใช้: apply <taskId> [--note "..."]');
      const { task } = await api("POST", `/api/tasks/${encodeURIComponent(id)}/apply`, { note: typeof flags.note === "string" ? flags.note : "" });
      out(`✔ apply patch ของ "${task.title}" เข้าโปรเจกต์แล้ว: ${(task.patch.appliedFiles || []).join(", ")}`);
      break;
    }
    case "reject": {
      const id = positional[0];
      if (!id) die('ใช้: reject <taskId> [--reason "..."]');
      const { task } = await api("POST", `/api/tasks/${encodeURIComponent(id)}/reject`, { reason: typeof flags.reason === "string" ? flags.reason : "" });
      out(`✔ ปฏิเสธ patch ของ "${task.title}" แล้ว (ไฟล์ไม่ถูกแตะ)`);
      break;
    }
    default:
      out("grock — สั่งงานทีม AI ให้โปรเจกต์อื่น");
      out('  init <โฟลเดอร์> [--id x] [--name n]   สร้าง .grock/ และลงทะเบียน');
      out("  projects                              รายชื่อโปรเจกต์");
      out("  context <id|.> [--role r] [--tokens] [--full]");
      out('  run "<โจทย์>" --project <id|.> [--files a,b] [--wait]   (หรือ --goal-file ไฟล์)');
      out("  status <jobId>");
      out("  register <id> <โฟลเดอร์>");
      out("  patches [jobId] · patch <taskId> · apply <taskId> [--note] · reject <taskId> [--reason]   (patch ของ Developer ที่รออนุมัติ)");
      process.exit(cmd ? 1 : 0);
  }
}
main().catch((err) => die(err.message));
