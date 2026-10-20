// webhook.js — แจ้งผลโจทย์ขาออก: โจทย์เสร็จ/ล้มเหลว → POST JSON ไปยังระบบภายนอก (เช่น Hermes Agent → Telegram)
//   ปลายทาง: JOB_WEBHOOK_URL ใน .env (ค่าเริ่มต้นทุกโจทย์) หรือ `webhookUrl` ที่ส่งมากับโจทย์ (เฉพาะ host ใน WEBHOOK_ALLOWED_HOSTS)
//   ลายเซ็น: HMAC-SHA256 ด้วย WEBHOOK_SECRET — หัว X-Grock-Signature: sha256=<hex ของ body>
//            + หัวที่ Hermes Agent ตรวจได้ทันที: X-Webhook-Signature-V2 = hex HMAC ของ "<unix วินาที>.<body>", X-Webhook-Timestamp, X-Webhook-Signature (V1 = hex HMAC ของ body)
//   ส่งไม่สำเร็จลองใหม่รวม 3 ครั้ง (WEBHOOK_RETRY_MS คั่น ค่าเริ่มต้น 2000) ผลการส่งลง log + job.webhook
import crypto from "node:crypto";

export const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
export const JOB_WEBHOOK_URL = String(process.env.JOB_WEBHOOK_URL || "").trim();
export const WEBHOOK_ALLOWED_HOSTS = String(process.env.WEBHOOK_ALLOWED_HOSTS || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
export const WEBHOOK_ATTEMPTS = 3;
export const WEBHOOK_RETRY_MS = Math.max(50, Number(process.env.WEBHOOK_RETRY_MS) || 2000);
export const WEBHOOK_TIMEOUT_MS = Math.max(1000, Number(process.env.WEBHOOK_TIMEOUT_MS) || 10_000);
export const SUMMARY_MAX = 1500;

const hmacHex = (secret, text) => crypto.createHmac("sha256", secret).update(text, "utf8").digest("hex");
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };

/** host ตรงกับรายการที่อนุญาตไหม (ขึ้นต้นด้วย . = ทุกโดเมนย่อย เหมือน ALLOWED_HOSTS) */
export function hostAllowed(hostname, allowed = WEBHOOK_ALLOWED_HOSTS) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return allowed.some((h) => (h.startsWith(".") ? host.endsWith(h) || host === h.slice(1) : host === h));
}

/** ตรวจ webhookUrl ที่ส่งมากับโจทย์ → { url } หรือ { error } (ภาษาไทย) */
export function checkWebhookUrl(raw, allowed = WEBHOOK_ALLOWED_HOSTS) {
  const s = String(raw || "").trim();
  if (!s) return { error: "webhookUrl ว่าง" };
  if (s.length > 2048) return { error: "webhookUrl ยาวเกิน 2048 ตัวอักษร" };
  let u;
  try { u = new URL(s); } catch { return { error: "webhookUrl ไม่ใช่ URL ที่ถูกต้อง" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "webhookUrl ต้องเป็น http:// หรือ https://" };
  if (u.username || u.password) return { error: "webhookUrl ห้ามมีชื่อผู้ใช้/รหัสผ่านใน URL" };
  if (!allowed.length) return { error: "เซิร์ฟเวอร์ยังไม่ได้ตั้ง WEBHOOK_ALLOWED_HOSTS ใน .env จึงรับ webhookUrl จากภายนอกไม่ได้ (ใช้ JOB_WEBHOOK_URL แทน)" };
  if (!hostAllowed(u.hostname, allowed)) return { error: `host "${u.hostname}" ของ webhookUrl ไม่อยู่ใน WEBHOOK_ALLOWED_HOSTS` };
  return { url: u.toString() };
}

/** หัวลายเซ็นสำหรับ body นี้ (ไม่มี secret → คืน {} และผู้เรียกควรเตือน) */
export function signatureHeaders(body, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  if (!secret) return {};
  const v1 = hmacHex(secret, body);
  return {
    "X-Grock-Signature": `sha256=${v1}`,
    "X-Webhook-Signature": v1,
    "X-Webhook-Timestamp": String(ts),
    "X-Webhook-Signature-V2": hmacHex(secret, `${ts}.${body}`),
  };
}

/** ตรวจลายเซ็นฝั่งผู้รับ (ใช้ในเทสต์และ tools/telegram-bot.mjs): รับทั้ง "sha256=<hex>" และ hex ล้วน; ถ้าให้ ts มาจะตรวจแบบ V2 */
export function verifySignature(body, header, { secret = WEBHOOK_SECRET, ts = null, maxSkewSec = 300 } = {}) {
  if (!secret || !header) return false;
  const got = String(header).replace(/^sha256=/i, "").trim().toLowerCase();
  if (ts !== null && ts !== undefined) {
    const n = Number(ts);
    if (!Number.isFinite(n) || Math.abs(Date.now() / 1000 - n) > maxSkewSec) return false;
    return safeEq(got, hmacHex(secret, `${Math.trunc(n)}.${body}`));
  }
  return safeEq(got, hmacHex(secret, body));
}

/** ย่อหน้าแรกของผลงาน (ข้ามบรรทัดหัวข้อ/ข้อมูลเมตา) ไม่เกิน max ตัวอักษร — ถ้าย่อหน้าแรกสั้นมากจะต่อย่อหน้าถัดไปจนพออ่านรู้เรื่อง */
export function summaryOf(text, max = SUMMARY_MAX) {
  const paras = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").filter((l) => !/^\s*#{1,6}\s/.test(l)).join("\n").trim()) // ตัดบรรทัดหัวข้อ markdown
    .filter(Boolean);
  let out = "";
  for (const p of paras) {
    out = out ? `${out}\n\n${p}` : p;
    if (out.length >= 120) break; // ย่อหน้าแรกที่มีเนื้อหาพอสมควร
  }
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** payload ที่ส่งให้ปลายทาง */
export function buildPayload(job, { summary = "", resultPath = null } = {}) {
  const finishedAt = job.finishedAt || Date.now();
  return {
    event: job.status === "done" ? "job.completed" : "job.failed",
    jobId: job.id,
    status: job.status,
    goal: job.goal,
    project: job.project || null,
    summary,
    resultPath,
    outputDir: job.outputDir || null,
    costUsd: Number((job.costUsd || 0).toFixed(4)),
    durationSec: Math.max(0, Math.round((job.durationMs || finishedAt - job.createdAt) / 1000)),
    requestedBy: job.requestedBy || "",
    source: job.source || "local",
    planSource: job.planSource || "captain",
    error: job.error || null,
    finishedAt: new Date(finishedAt).toISOString(),
  };
}

/** ส่ง payload (ลองใหม่ได้) → { ok, status, attempts, error } — ไม่โยน error */
export async function deliver(url, payload, { secret = WEBHOOK_SECRET, attempts = WEBHOOK_ATTEMPTS, retryMs = WEBHOOK_RETRY_MS, timeoutMs = WEBHOOK_TIMEOUT_MS, fetchImpl = fetch, onAttempt } = {}) {
  const body = JSON.stringify(payload);
  let last = { ok: false, status: 0, error: "" };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "user-agent": "grock-agent-webhook/1", ...signatureHeaders(body, { secret }) },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      last = { ok: res.ok, status: res.status, error: res.ok ? "" : `HTTP ${res.status}` };
      try { res.body?.cancel?.(); } catch {}
    } catch (err) {
      last = { ok: false, status: 0, error: (err?.cause?.message || err?.message || String(err)).slice(0, 200) };
    }
    onAttempt?.({ attempt: i, ...last });
    if (last.ok) return { ...last, attempts: i };
    if (i < attempts) await new Promise((r) => setTimeout(r, retryMs * i));
  }
  return { ...last, attempts };
}

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

/**
 * สมัครรับ job.completed / job.failed → ส่ง webhook ไปยัง job.webhookUrl หรือ defaultUrl
 * ผลการส่งเขียนลง job.webhook { url(host), status: sent|failed, httpStatus, attempts, error, at } + event job.webhook + log
 * @param {object} opts.resultPathOf (job) → พาธ result.md หรือ null
 */
export function attachWebhook(bus, { defaultUrl = JOB_WEBHOOK_URL, secret = WEBHOOK_SECRET, resultPathOf = (job) => (job.outputDir ? `${job.outputDir}/result.md` : null), deliverImpl = deliver } = {}) {
  const inflight = new Set();
  const handler = (ev) => {
    if (ev.type !== "job.completed" && ev.type !== "job.failed") return;
    const job = ev.data?.job;
    if (!job || inflight.has(job.id)) return;
    const url = job.webhookUrl || defaultUrl;
    if (!url) return;
    inflight.add(job.id);
    const payload = buildPayload(job, { summary: summaryOf(job.result) || (job.error ? `โจทย์ล้มเหลว: ${job.error}` : ""), resultPath: resultPathOf(job) });
    job.webhook = { url: hostOf(url), status: "sending", httpStatus: 0, attempts: 0, error: "", at: Date.now() };
    if (!secret) bus.log(`⚠️ ส่ง webhook โดยไม่มีลายเซ็น (ยังไม่ได้ตั้ง WEBHOOK_SECRET ใน .env)`, { jobId: job.id, level: "warn" });
    void deliverImpl(url, payload, {
      secret,
      onAttempt: ({ attempt, ok, status, error }) => {
        if (!ok) bus.log(`📡 ส่ง webhook ไป ${hostOf(url)} ครั้งที่ ${attempt} ไม่สำเร็จ: ${error}`, { jobId: job.id, level: "warn" });
      },
    }).then((r) => {
      job.webhook = { url: hostOf(url), status: r.ok ? "sent" : "failed", httpStatus: r.status, attempts: r.attempts, error: r.error, at: Date.now() };
      bus.publish("job.webhook", { job, ok: r.ok });
      bus.log(r.ok ? `📡 ส่งผลโจทย์ "${job.goal.slice(0, 50)}" ไปยัง ${hostOf(url)} แล้ว (HTTP ${r.status}${r.attempts > 1 ? `, ครั้งที่ ${r.attempts}` : ""})`
        : `❌ ส่ง webhook ไปยัง ${hostOf(url)} ไม่สำเร็จหลังลอง ${r.attempts} ครั้ง: ${r.error}`, { jobId: job.id, level: r.ok ? undefined : "error" });
    }).finally(() => inflight.delete(job.id));
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}
