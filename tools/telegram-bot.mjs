#!/usr/bin/env node
// telegram-bot.mjs — บอท Telegram ต่อตรง (ไม่ใช้ Hermes Agent, ไม่มี dependency): รับข้อความ → สั่งโจทย์ให้ศูนย์ควบคุม → รายงานผลกลับแชตเดิม
//   ใช้ Telegram Bot API แบบ long polling (ไม่ต้องเปิดพอร์ตสาธารณะ) ผลลัพธ์รับได้ 2 ทาง: webhook จากศูนย์ควบคุม (ถ้าตั้ง TELEGRAM_HOOK_PORT)
//   และ polling สถานะโจทย์ที่บอทสั่งเอง (สำรอง ไม่ต้องตั้งอะไรเพิ่ม)
//
//   .env (หรือ env ของโปรเซส):
//     TELEGRAM_BOT_TOKEN=123456:ABC...       โทเคนจาก @BotFather
//     TELEGRAM_ALLOWED_USERS=123456789,987   user id ที่สั่งงานได้ (คั่นด้วย ,) — ไม่ตั้ง = ปฏิเสธทุกคน
//     GROCK_URL=http://127.0.0.1:3789        ศูนย์ควบคุม
//     GROCK_TOKEN=<โทเคนใน API_TOKENS สิทธิ์ jobs>
//     TELEGRAM_HOOK_PORT=3790                (ไม่บังคับ) เปิดรับ webhook ที่ http://127.0.0.1:3790/webhooks/telegram
//                                            → ตั้ง JOB_WEBHOOK_URL=http://127.0.0.1:3790/webhooks/telegram และ WEBHOOK_SECRET ให้ตรงกันในศูนย์ควบคุม
//     WEBHOOK_SECRET=...                     ตรวจลายเซ็น X-Grock-Signature ของ webhook (ต้องตรงกับศูนย์ควบคุม)
//     TELEGRAM_DEFAULT_PROJECT=myshop         (ไม่บังคับ) โปรเจกต์เริ่มต้นเมื่อไม่ได้ระบุ
//   รัน: npm run telegram   คำสั่งในแชต: /help /projects /agents /status <jobId> /result <jobId> /project <id|-> และพิมพ์โจทย์ตรง ๆ
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOT = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = new Set(String(process.env.TELEGRAM_ALLOWED_USERS || "").split(",").map((s) => s.trim()).filter(Boolean));
const BASE = (process.env.GROCK_URL || "http://127.0.0.1:3789").replace(/\/+$/, "");
const TOKEN = process.env.GROCK_TOKEN || "";
const HOOK_PORT = Number(process.env.TELEGRAM_HOOK_PORT) || 0;
const SECRET = process.env.WEBHOOK_SECRET || "";
const POLL_JOB_MS = Math.max(5000, Number(process.env.TELEGRAM_JOB_POLL_MS) || 20_000);
const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.GROCK_DATA_DIR ? path.resolve(process.env.GROCK_DATA_DIR) : path.join(here, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "telegram-bot.json"); // { jobs: { jobId: { chatId, reported } }, projects: { chatId: projectId } }
const TG = `https://api.telegram.org/bot${BOT}`;

if (!BOT) { console.error("✖ ต้องตั้ง TELEGRAM_BOT_TOKEN (ขอจาก @BotFather) ใน .env"); process.exit(1); }
if (!ALLOWED.size) console.warn("⚠️ ไม่ได้ตั้ง TELEGRAM_ALLOWED_USERS — บอทจะปฏิเสธทุกคน (หา user id ของคุณจาก @userinfobot)");

// ---------- สถานะของบอท (โจทย์ที่สั่งผ่านแชตไหน) ----------
let st = { jobs: {}, projects: {} };
try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
function save() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2)); } catch (err) { console.warn(`⚠️ บันทึก ${STATE_FILE} ไม่สำเร็จ: ${err.message}`); } }

// ---------- Telegram ----------
async function tg(method, body) {
  const res = await fetch(`${TG}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  return data.result;
}
const send = (chatId, text) => tg("sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }).catch((err) => console.warn(`⚠️ ${err.message}`));

// ---------- ศูนย์ควบคุม ----------
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const fmtJob = (job, tasks = []) => {
  const done = tasks.filter((t) => t.status === "done").length;
  const th = { planning: "กำลังวางแผน", running: "กำลังทำ", synthesizing: "กำลังรวบรวมผล", done: "เสร็จแล้ว", failed: "ล้มเหลว" }[job.status] || job.status;
  return `🧭 ${job.id}\n${job.goal}\nสถานะ: ${th}${tasks.length ? ` (${done}/${tasks.length} งาน)` : ""} · ต้นทุน $${(job.costUsd || 0).toFixed(4)}${job.project ? ` · โปรเจกต์ ${job.project}` : ""}${job.error ? `\n⚠️ ${job.error}` : ""}`;
};
const summarize = (text, max = 1500) => {
  const paras = String(text || "").replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((p) => p.split("\n").filter((l) => !/^\s*#{1,6}\s/.test(l)).join("\n").trim()).filter(Boolean);
  let out = ""; for (const p of paras) { out = out ? `${out}\n\n${p}` : p; if (out.length >= 120) break; }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
};

async function report(jobId, { summary, status, costUsd, durationSec, resultPath, error } = {}) {
  const rec = st.jobs[jobId];
  if (!rec || rec.reported) return;
  rec.reported = true; save();
  const head = status === "done" ? "🎉 โจทย์เสร็จแล้ว" : "❌ โจทย์ล้มเหลว";
  await send(rec.chatId, `${head} (${jobId})\n${rec.goal || ""}\n\n${summary || error || "(ไม่มีสรุป)"}\n\n💵 $${Number(costUsd || 0).toFixed(4)} · ⏱ ${Math.round(durationSec || 0)} วินาที${resultPath ? `\n📁 ${resultPath}` : ""}\nดูฉบับเต็ม: /result ${jobId}`);
}

// ---------- คำสั่งในแชต ----------
const HELP = `พิมพ์โจทย์ได้เลย ทีม AI จะรับไปทำแล้วรายงานกลับที่นี่
คำสั่ง:
/projects – รายชื่อโปรเจกต์
/project <id> – ตั้งโปรเจกต์เริ่มต้นของแชตนี้ (/project - เพื่อยกเลิก)
/agents – รายชื่อทีม
/status <jobId> – สถานะโจทย์
/result <jobId> – ผลลัพธ์ฉบับเต็ม (ตัดที่ 3500 ตัวอักษร)
/jobs – โจทย์ล่าสุด`;

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};
  if (!ALLOWED.has(String(from.id))) { console.warn(`ปฏิเสธผู้ใช้ ${from.id} (${from.username || from.first_name || "?"})`); return send(chatId, `ไม่ได้รับอนุญาต — เพิ่ม user id ${from.id} ใน TELEGRAM_ALLOWED_USERS`); }
  const text = String(msg.text || "").trim();
  if (!text) return;
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const who = from.username ? `telegram:@${from.username}` : `telegram:${from.id}`;
  try {
    if (/^\/(start|help)/.test(cmd)) return send(chatId, HELP);
    if (cmd === "/projects") { const { projects } = await api("GET", "/api/projects"); return send(chatId, projects.length ? projects.map((p) => `• ${p.id} — ${p.name || ""}${p.ok === false ? " (⚠️ โหลดไม่ได้)" : ""}`).join("\n") : "ยังไม่มีโปรเจกต์ที่ลงทะเบียน"); }
    if (cmd === "/project") { if (!arg || arg === "-") { delete st.projects[chatId]; save(); return send(chatId, "ยกเลิกโปรเจกต์เริ่มต้นแล้ว"); } st.projects[chatId] = arg; save(); return send(chatId, `โจทย์ถัดไปจะส่งให้โปรเจกต์ "${arg}"`); }
    if (cmd === "/agents") { const { agents } = await api("GET", "/api/agents"); return send(chatId, agents.map((a) => `${a.emoji || "•"} ${a.id} ${a.name} (${a.roleLabel}) — ${a.duties.slice(0, 80)}`).join("\n")); }
    if (cmd === "/status") { if (!arg) return send(chatId, "ใช้: /status <jobId>"); const { job, tasks } = await api("GET", `/api/jobs/${encodeURIComponent(arg)}`); return send(chatId, fmtJob(job, tasks)); }
    if (cmd === "/result") { if (!arg) return send(chatId, "ใช้: /result <jobId>"); const { job } = await api("GET", `/api/jobs/${encodeURIComponent(arg)}`); return send(chatId, job.status === "done" || job.status === "failed" ? (job.result || job.error || "(ไม่มีผลลัพธ์)").slice(0, 3500) : fmtJob(job)); }
    if (cmd === "/jobs") { const { jobs } = await api("GET", "/api/jobs?limit=8"); return send(chatId, jobs.length ? jobs.map((j) => `${j.status === "done" ? "✅" : j.status === "failed" ? "❌" : "⏳"} ${j.id} ${j.goal.slice(0, 50)}`).join("\n") : "ยังไม่มีโจทย์"); }
    if (cmd.startsWith("/")) return send(chatId, `ไม่รู้จักคำสั่ง ${cmd}\n\n${HELP}`);
    // ข้อความธรรมดา = โจทย์ — "@โปรเจกต์ โจทย์..." เพื่อระบุโปรเจกต์ครั้งเดียว
    let goal = text, project = st.projects[chatId] || process.env.TELEGRAM_DEFAULT_PROJECT || undefined;
    const m = /^@([a-z0-9_-]{1,32})\s+([\s\S]+)$/i.exec(text);
    if (m) { project = m[1]; goal = m[2]; }
    const body = { goal, requestedBy: who, ...(project ? { project } : {}) };
    const { job } = await api("POST", "/api/jobs", body);
    st.jobs[job.id] = { chatId, goal: job.goal.slice(0, 120), createdAt: Date.now(), reported: false }; save();
    return send(chatId, `📥 รับโจทย์แล้ว (${job.id})${project ? ` → โปรเจกต์ ${project}` : ""}\nทีมกำลังทำงาน จะรายงานกลับเมื่อเสร็จ · ดูสถานะ: /status ${job.id}`);
  } catch (err) {
    return send(chatId, `⚠️ ${err.message}`);
  }
}

// ---------- long polling ----------
let offset = 0;
async function pollLoop() {
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      for (const u of updates) { offset = u.update_id + 1; if (u.message) await onMessage(u.message); }
    } catch (err) {
      console.warn(`⚠️ getUpdates: ${err.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// ---------- รับ webhook จากศูนย์ควบคุม (ถ้าตั้ง TELEGRAM_HOOK_PORT) ----------
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
if (HOOK_PORT) {
  http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/telegram") { res.writeHead(404); return res.end(); }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (SECRET) {
        const sig = String(req.headers["x-grock-signature"] || "").replace(/^sha256=/i, "");
        if (!safeEq(sig, crypto.createHmac("sha256", SECRET).update(body, "utf8").digest("hex"))) { res.writeHead(401); return res.end("bad signature"); }
      }
      let p; try { p = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
      if (p?.jobId) void report(p.jobId, p);
    });
  }).listen(HOOK_PORT, "127.0.0.1", () => console.log(`📡 รับ webhook ที่ http://127.0.0.1:${HOOK_PORT}/webhooks/telegram${SECRET ? " (ตรวจลายเซ็น)" : " ⚠️ ไม่มี WEBHOOK_SECRET"}`));
}

// ---------- สำรอง: ถามสถานะโจทย์ที่ยังไม่รายงาน ----------
setInterval(async () => {
  for (const [jobId, rec] of Object.entries(st.jobs)) {
    if (rec.reported) { if (Date.now() - rec.createdAt > 7 * 86_400_000) { delete st.jobs[jobId]; save(); } continue; }
    try {
      const { job } = await api("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
      if (job.status === "done" || job.status === "failed") await report(jobId, { status: job.status, summary: summarize(job.result), error: job.error, costUsd: job.costUsd, durationSec: Math.round((job.durationMs || 0) / 1000), resultPath: job.outputDir ? `${job.outputDir}/result.md` : null });
    } catch (err) {
      if (/404|ไม่พบ/.test(err.message)) { rec.reported = true; save(); } // เซิร์ฟเวอร์รีสตาร์ต โจทย์หายจากหน่วยความจำ
    }
  }
}, POLL_JOB_MS).unref();

const me = await tg("getMe", {}).catch((err) => { console.error(`✖ ${err.message}`); process.exit(1); });
console.log(`🤖 @${me.username} พร้อมรับโจทย์ → ${BASE} (ผู้ใช้ที่อนุญาต: ${[...ALLOWED].join(", ") || "ไม่มี"})`);
void pollLoop();
