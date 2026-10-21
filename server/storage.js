// storage.js — เก็บผลงานของทีม AI ขึ้นคลาวด์ (S3-compatible: Cloudflare R2, AWS S3, MinIO, Backblaze B2 ฯลฯ)
//
// ทำไมไม่ใช้ @aws-sdk/client-s3: โปรเจกต์นี้มี dependency เดียว (@anthropic-ai/sdk) และต้องการแค่ PutObject/HeadObject
//   SDK ของ AWS ดึง package มาอีกหลายสิบตัว (~10 MB) ขณะที่ SigV4 สำหรับ 2 คำสั่งนี้เขียนด้วย node:crypto ได้ใน ~60 บรรทัด
//   อ่าน/ตรวจสอบง่ายกว่า และเทสต์กับ fake S3 ในเครื่องได้โดยไม่ต้องมีคีย์จริง
//
// ตั้งค่าใน .env:
//   STORAGE_PROVIDER=none|s3        none (ค่าเริ่มต้น) = ไม่อัปโหลด
//   S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   (R2) หรือ https://s3.ap-southeast-1.amazonaws.com (AWS) หรือ http://127.0.0.1:9000 (MinIO)
//   S3_BUCKET=grock-results
//   S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY
//   S3_PREFIX=grock                  โฟลเดอร์บนสุดใน bucket (ว่างได้) → <prefix>/<projectId>/<jobId>/...
//   S3_REGION=auto                   R2 = auto, AWS = ชื่อ region ของ bucket
//   S3_PUBLIC_URL=https://pub-xxxx.r2.dev   (ไม่บังคับ) ถ้า bucket เปิดอ่านสาธารณะ/มีโดเมนเอง ใช้สร้างลิงก์ที่เปิดได้ในเบราว์เซอร์
//   S3_MAX_MB=50                     ไฟล์ใหญ่กว่านี้ข้าม (บันทึกใน skipped)
//
// เมื่อโจทย์จบ (job.completed / job.failed) → อัปโหลดทั้งโฟลเดอร์ .grock/out/<jobId>/ ของโปรเจกต์ (โจทย์ไม่มีโปรเจกต์ = สร้างไฟล์ชุดเดียวกันจากหน่วยความจำ
// ภายใต้ projectId "workspace") แบบ async ไม่บล็อก event loop, ลองใหม่ 3 ครั้งต่อไฟล์, ผลบันทึกใน job.storage และ job.json (storage: { uploaded, url, error, ... })
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STORAGE_ATTEMPTS = 3;
const MIN_KEY_LENGTH = 8;
const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data, "utf8").digest();
export const EMPTY_SHA256 = sha256Hex("");

const MIME = {
  ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".diff": "text/x-diff; charset=utf-8", ".patch": "text/x-diff; charset=utf-8", ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".ts": "text/plain; charset=utf-8", ".py": "text/x-python; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".yml": "text/yaml; charset=utf-8", ".yaml": "text/yaml; charset=utf-8", ".xml": "application/xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf", ".zip": "application/zip",
};
export const contentTypeOf = (name) => MIME[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";

// ---------------------------------------------------------------------------
// การตั้งค่า
// ---------------------------------------------------------------------------
/** อ่านค่าจาก env → { provider, endpoint, bucket, accessKeyId, secretAccessKey, prefix, region, publicUrl, maxBytes, warnings[], errors[] } */
export function storageConfig(env = process.env) {
  const warnings = [];
  const errors = [];
  const provider = String(env.STORAGE_PROVIDER || "none").trim().toLowerCase();
  const cfg = {
    provider: provider === "s3" ? "s3" : "none",
    endpoint: String(env.S3_ENDPOINT || "").trim().replace(/\/+$/, ""),
    bucket: String(env.S3_BUCKET || "").trim(),
    accessKeyId: String(env.S3_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.S3_SECRET_ACCESS_KEY || "").trim(),
    prefix: String(env.S3_PREFIX ?? "grock").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
    region: String(env.S3_REGION || "auto").trim() || "auto",
    publicUrl: String(env.S3_PUBLIC_URL || "").trim().replace(/\/+$/, ""),
    maxBytes: Math.max(1, Number(env.S3_MAX_MB) || 50) * 1024 * 1024,
    attempts: Math.max(1, Math.min(10, Number(env.S3_ATTEMPTS) || STORAGE_ATTEMPTS)),
    retryMs: Math.max(10, Number(env.S3_RETRY_MS) || 1000),
    timeoutMs: Math.max(1000, Number(env.S3_TIMEOUT_MS) || 60_000),
    concurrency: Math.max(1, Math.min(8, Number(env.S3_CONCURRENCY) || 3)),
    warnings, errors,
  };
  if (provider !== "none" && provider !== "s3") errors.push(`STORAGE_PROVIDER "${provider}" ไม่รู้จัก (ใช้ none หรือ s3)`);
  if (cfg.provider === "s3") {
    let u = null;
    try { u = new URL(cfg.endpoint); } catch { /* ตรวจด้านล่าง */ }
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) errors.push("S3_ENDPOINT ต้องเป็น URL แบบ https://… (เช่น https://<account>.r2.cloudflarestorage.com)");
    else if (u.protocol === "http:" && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(u.hostname)) warnings.push(`S3_ENDPOINT ใช้ http:// (ไม่เข้ารหัส) — ใช้เฉพาะทดสอบในเครื่อง`);
    if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(cfg.bucket)) errors.push("S3_BUCKET ต้องเป็นชื่อ bucket ตัวพิมพ์เล็ก a-z 0-9 . - ยาว 3–63 ตัว");
    if (cfg.accessKeyId.length < MIN_KEY_LENGTH) errors.push("S3_ACCESS_KEY_ID ว่างหรือสั้นเกินไป");
    if (cfg.secretAccessKey.length < MIN_KEY_LENGTH) errors.push("S3_SECRET_ACCESS_KEY ว่างหรือสั้นเกินไป");
    if (cfg.prefix.includes("..")) errors.push("S3_PREFIX ห้ามมี ..");
    if (cfg.publicUrl && !/^https?:\/\//.test(cfg.publicUrl)) { warnings.push("S3_PUBLIC_URL ต้องขึ้นต้นด้วย http(s):// — ข้าม"); cfg.publicUrl = ""; }
  }
  return cfg;
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4 (ส่วนที่ S3 PutObject/HeadObject/GetObject ต้องใช้)
// ---------------------------------------------------------------------------
/** URI-encode ตาม RFC 3986 แบบที่ S3 ใช้ใน canonical URI (เข้ารหัสทุกอย่างยกเว้น A-Z a-z 0-9 - _ . ~ และ / ที่คั่น segment) */
export function encodeKey(key) {
  return String(key).split("/").map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}
const amzDateOf = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z"); // 20130524T000000Z

/**
 * ลงลายเซ็น SigV4 ให้คำขอหนึ่ง (pure function — ใช้ทั้งฝั่งส่งและ fake S3 ที่ตรวจ)
 * @param {object} r { method, path (เข้ารหัสแล้ว เริ่มด้วย /), query (string ว่างได้), headers (object ชื่อเล็ก/ใหญ่ได้; ต้องมี host), payloadHash, amzDate, accessKeyId, secretAccessKey, region, service }
 * @returns {{ authorization, signedHeaders, canonicalRequest, stringToSign, signature }}
 */
export function signV4({ method, path: p, query = "", headers, payloadHash, amzDate, accessKeyId, secretAccessKey, region, service = "s3", signedHeaders = null }) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const names = (signedHeaders ? signedHeaders.split(";") : Object.keys(lower)).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = names.map((h) => `${h}:${lower[h] ?? ""}\n`).join("");
  const signed = names.join(";");
  const canonicalQuery = String(query || "").split("&").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return i < 0 ? [kv, ""] : [kv.slice(0, i), kv.slice(i + 1)]; })
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonicalRequest = [method.toUpperCase(), p, canonicalQuery, canonicalHeaders, signed, payloadHash].join("\n");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`, signedHeaders: signed, canonicalRequest, stringToSign, signature, scope };
}

/** แยกหัว Authorization ของ SigV4 → { accessKeyId, scope, signedHeaders, signature } หรือ null (ใช้ใน fake S3 ของเทสต์) */
export function parseAuthorization(h) {
  const m = /^AWS4-HMAC-SHA256\s+Credential=([^/]+)\/([^,]+),\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]{64})$/i.exec(String(h || "").trim());
  return m ? { accessKeyId: m[1], scope: m[2], signedHeaders: m[3], signature: m[4] } : null;
}

// ---------------------------------------------------------------------------
// S3 client (path-style: <endpoint>/<bucket>/<key> — R2/MinIO/AWS รองรับ)
// ---------------------------------------------------------------------------
export class S3Client {
  constructor(cfg, { fetchImpl = fetch, now = () => new Date() } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.now = now;
    this.base = `${cfg.endpoint}/${cfg.bucket}`;
  }
  /** URL ของ object สำหรับแสดง/เปิด: S3_PUBLIC_URL ถ้ามี ไม่งั้น endpoint path-style (เปิดได้เฉพาะเมื่อ bucket สาธารณะ) */
  objectUrl(key) {
    const k = encodeKey(key);
    return this.cfg.publicUrl ? `${this.cfg.publicUrl}/${k}` : `${this.base}/${k}`;
  }
  async request(method, key, { body = null, contentType = null, query = "" } = {}) {
    const url = new URL(`${this.base}/${encodeKey(key)}${query ? `?${query}` : ""}`);
    const payloadHash = body === null ? EMPTY_SHA256 : sha256Hex(body);
    const amzDate = amzDateOf(this.now());
    const headers = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    if (body !== null && contentType) headers["content-type"] = contentType;
    const { authorization } = signV4({ method, path: url.pathname, query: url.search.slice(1), headers, payloadHash, amzDate, accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey, region: this.cfg.region });
    const { host, ...send } = headers;
    const res = await this.fetch(url, { method, headers: { ...send, authorization }, body: body === null ? undefined : body, signal: AbortSignal.timeout(this.cfg.timeoutMs || 60_000) });
    return res;
  }
  /** PUT object → { ok, status, error } (ไม่โยน error) */
  async putObject(key, body, { contentType = contentTypeOf(key) } = {}) {
    try {
      const res = await this.request("PUT", key, { body, contentType });
      let error = "";
      if (!res.ok) { const text = await res.text().catch(() => ""); error = `HTTP ${res.status}${text ? `: ${text.replace(/\s+/g, " ").slice(0, 200)}` : ""}`; }
      else { try { res.body?.cancel?.(); } catch {} }
      return { ok: res.ok, status: res.status, error };
    } catch (err) {
      return { ok: false, status: 0, error: (err?.cause?.message || err?.message || String(err)).slice(0, 200) };
    }
  }
  async headObject(key) {
    try { const res = await this.request("HEAD", key); try { res.body?.cancel?.(); } catch {} return { ok: res.ok, status: res.status, size: Number(res.headers.get("content-length")) || 0 }; }
    catch (err) { return { ok: false, status: 0, error: err.message }; }
  }
  async getObject(key) {
    const res = await this.request("GET", key);
    if (!res.ok) return { ok: false, status: res.status, body: null };
    return { ok: true, status: res.status, body: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") || "" };
  }
}

/** PUT พร้อมลองใหม่ (backoff คูณรอบ) → { ok, attempts, error } */
export async function putWithRetry(client, key, body, { contentType, attempts = STORAGE_ATTEMPTS, retryMs = 1000, onAttempt } = {}) {
  let last = { ok: false, status: 0, error: "" };
  for (let i = 1; i <= attempts; i++) {
    last = await client.putObject(key, body, { contentType });
    onAttempt?.({ attempt: i, key, ...last });
    if (last.ok) return { ok: true, attempts: i, error: "" };
    if (i < attempts) await new Promise((r) => setTimeout(r, retryMs * i));
  }
  return { ok: false, attempts, error: last.error || `HTTP ${last.status}` };
}

// ---------------------------------------------------------------------------
// รายการไฟล์ที่จะอัปโหลด
// ---------------------------------------------------------------------------
/** เดินโฟลเดอร์ (ไม่ตาม symlink) → [{ rel (posix), abs, size }] เรียงตามชื่อ */
export function listFilesRecursive(dir) {
  const out = [];
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(childAbs, childRel);
      else if (e.isFile()) { try { out.push({ rel: childRel, abs: childAbs, size: fs.statSync(childAbs).size }); } catch {} }
    }
  };
  walk(dir, "");
  return out;
}

const pad2 = (n) => String(n).padStart(2, "0");
const slug = (s) => String(s || "").normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
/** ไฟล์ชุดเดียวกับที่ projects.js เขียนให้โจทย์ที่มีโปรเจกต์ แต่สร้างจากหน่วยความจำสำหรับโจทย์ "workspace" (ไม่มีโปรเจกต์) → [{ rel, body }] */
export function workspaceFiles(job, tasks = [], { agentNameOf = () => "" } = {}) {
  const ts = (t) => (t ? new Date(t).toISOString() : null);
  const sorted = [...tasks].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const files = [];
  const header = [
    `# ผลลัพธ์: ${job.goal}`, "",
    `- โปรเจกต์: workspace (ไม่ระบุโปรเจกต์)`,
    `- สถานะ: ${job.status === "done" ? "เสร็จสมบูรณ์" : job.status}${job.error ? ` — ${job.error}` : ""}`,
    `- เริ่ม: ${ts(job.createdAt)}${job.finishedAt ? ` · จบ: ${ts(job.finishedAt)}` : ""}`,
    `- ต้นทุนรวม: $${(job.costUsd || 0).toFixed(4)}`,
    `- งานย่อย: ${sorted.map((t) => `${t.title} [${t.status}${t.review ? ` QA ${t.review.score}` : ""}]`).join(" · ") || "-"}`, "",
  ].join("\n");
  const body = job.result || `(ยังไม่มีผลสรุปจากกัปตัน)\n\n${sorted.filter((t) => t.status === "done").map((t) => `## ${t.title}\n${t.output}`).join("\n\n")}`;
  files.push({ rel: "result.md", body: `${header}\n${body}\n` });
  for (const t of sorted) {
    const name = `${pad2(t.seq || 0)}-${t.role}-${slug(t.title)}.md`;
    const who = agentNameOf(t.assignedTo) || "";
    files.push({ rel: `tasks/${name}`, body: [`# ${t.title}`, "", `- โปรเจกต์งาน: ${t.jobId}`, `- ตำแหน่ง: ${t.role}${who ? ` · ผู้ทำ: ${who}` : ""}`, `- สถานะ: ${t.status} (รอบที่ ${t.attempts})`,
      `- ต้นทุน: $${(t.usage?.costUsd || 0).toFixed(4)}`, t.review ? `- ผลตรวจ QA: ${t.review.score}/100 ${t.review.approved ? "ผ่าน" : "ไม่ผ่าน"}` : "", "", "## รายละเอียดงาน", t.description || "-", "", "## ผลงาน", t.output || "(ไม่มีผลงาน)"].join("\n") + "\n" });
  }
  files.push({ rel: "job.json", body: JSON.stringify({
    id: job.id, goal: job.goal, project: "workspace", status: job.status, source: job.source || "local", requestedBy: job.requestedBy || "", error: job.error || null,
    createdAt: ts(job.createdAt), finishedAt: ts(job.finishedAt), costUsd: job.costUsd || 0,
    tasks: sorted.map((t) => ({ id: t.id, seq: t.seq, title: t.title, role: t.role, status: t.status, assignedTo: t.assignedTo, attempts: t.attempts, usage: t.usage, review: t.review ? { score: t.review.score, approved: t.review.approved } : null, file: `tasks/${pad2(t.seq || 0)}-${t.role}-${slug(t.title)}.md` })),
  }, null, 2) + "\n" });
  return files;
}

/**
 * อัปโหลดรายการไฟล์ขึ้น <keyPrefix>/<rel> ทีละ `concurrency` ไฟล์ แต่ละไฟล์ลองใหม่ได้ → { ok, files, bytes, failed[], skipped[], keys[] }
 * @param {Array<{rel:string, abs?:string, body?:string|Buffer}>} files
 */
export async function uploadFiles(client, files, keyPrefix, { attempts = STORAGE_ATTEMPTS, retryMs = 1000, concurrency = 3, maxBytes = 50 * 1024 * 1024, onAttempt } = {}) {
  const prefix = String(keyPrefix || "").replace(/^\/+|\/+$/g, "");
  const keyOf = (rel) => (prefix ? `${prefix}/${rel}` : rel);
  const queue = [...files];
  const result = { ok: true, files: 0, bytes: 0, failed: [], skipped: [], keys: [] };
  const worker = async () => {
    for (;;) {
      const f = queue.shift();
      if (!f) return;
      let body = f.body;
      if (body === undefined || body === null) {
        let size = f.size;
        try { if (size === undefined) size = fs.statSync(f.abs).size; } catch (err) { result.skipped.push({ rel: f.rel, reason: `อ่านไม่ได้: ${err.message}` }); continue; }
        if (size > maxBytes) { result.skipped.push({ rel: f.rel, reason: `ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024)} MB` }); continue; }
        try { body = await fs.promises.readFile(f.abs); } catch (err) { result.skipped.push({ rel: f.rel, reason: `อ่านไม่ได้: ${err.message}` }); continue; }
      } else if (typeof body === "string") body = Buffer.from(body, "utf8");
      if (body.length > maxBytes) { result.skipped.push({ rel: f.rel, reason: `ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024)} MB` }); continue; }
      const key = keyOf(f.rel);
      const r = await putWithRetry(client, key, body, { contentType: f.contentType || contentTypeOf(f.rel), attempts, retryMs, onAttempt });
      if (r.ok) { result.files += 1; result.bytes += body.length; result.keys.push(key); }
      else { result.ok = false; result.failed.push({ rel: f.rel, key, error: r.error, attempts: r.attempts }); }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, worker));
  return result;
}

// ---------------------------------------------------------------------------
// subscriber: โจทย์จบ → อัปโหลด (async) → job.storage + event job.storage
// ---------------------------------------------------------------------------
/** key prefix ของโจทย์: <S3_PREFIX>/<projectId|workspace>/<jobId> */
export function jobKeyPrefix(cfg, job) {
  const project = /^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(job.project || "")) ? job.project : "workspace";
  return [cfg.prefix, project, job.id].filter(Boolean).join("/");
}

/**
 * สมัครรับ job.completed / job.failed → อัปโหลดโฟลเดอร์ผลงาน
 * @param {object} opts.client  S3Client
 * @param {object} opts.cfg     storageConfig()
 * @param {function} opts.outDirOf (job) → โฟลเดอร์ผลงานบนดิสก์ หรือ null (โจทย์ไม่มีโปรเจกต์)
 * @param {function} opts.tasksOf  (job) → tasks[] (ใช้สร้างไฟล์ของโจทย์ workspace)
 * @param {function} [opts.agentNameOf] (agentId) → ชื่อ
 * @param {function} [opts.afterUpload] (job) → เรียกหลังบันทึก job.storage และยิง event แล้ว (เช่น อัปโหลด job.json ฉบับที่มี storage อีกครั้ง)
 */
export function attachStorage(bus, { client, cfg, outDirOf, tasksOf = () => [], agentNameOf = () => "", onUploaded = null }) {
  const inflight = new Set();
  const handler = (ev) => {
    if (ev.type !== "job.completed" && ev.type !== "job.failed") return;
    const job = ev.data?.job;
    if (!job || inflight.has(job.id) || job.storage?.status === "uploaded") return;
    inflight.add(job.id);
    const keyPrefix = jobKeyPrefix(cfg, job);
    const dir = outDirOf(job);
    let files;
    if (dir) files = listFilesRecursive(dir);
    else files = workspaceFiles(job, tasksOf(job), { agentNameOf });
    const url = `${client.objectUrl(keyPrefix)}/`;
    job.storage = { status: "uploading", uploaded: false, provider: "s3", bucket: cfg.bucket, keyPrefix, url, resultUrl: client.objectUrl(`${keyPrefix}/result.md`), files: 0, bytes: 0, skipped: [], error: "", at: Date.now() };
    bus.publish("job.storage", { job, ok: null });
    void uploadFiles(client, files, keyPrefix, {
      attempts: cfg.attempts, retryMs: cfg.retryMs, concurrency: cfg.concurrency, maxBytes: cfg.maxBytes,
      onAttempt: ({ attempt, key, ok, error }) => { if (!ok) bus.log(`☁️ อัปโหลด ${key.slice(keyPrefix.length + 1)} ครั้งที่ ${attempt} ไม่สำเร็จ: ${error}`, { jobId: job.id, level: "warn" }); },
    }).then(async (r) => {
      const error = r.ok ? "" : `อัปโหลดไม่สำเร็จ ${r.failed.length} ไฟล์: ${r.failed.map((f) => `${f.rel} (${f.error})`).join(", ")}`.slice(0, 300);
      job.storage = { ...job.storage, status: r.ok ? "uploaded" : "failed", uploaded: r.ok, files: r.files, bytes: r.bytes, skipped: r.skipped, failed: r.failed.map((f) => f.rel), error, at: Date.now() };
      bus.publish("job.storage", { job, ok: r.ok });
      bus.log(r.ok ? `☁️ อัปโหลดผลงาน "${String(job.goal).slice(0, 50)}" ขึ้น ${cfg.bucket}/${keyPrefix}/ แล้ว (${r.files} ไฟล์, ${(r.bytes / 1024).toFixed(1)} KB${r.skipped.length ? `, ข้าม ${r.skipped.length}` : ""})`
        : `❌ ${error}`, { jobId: job.id, level: r.ok ? undefined : "error" });
      if (onUploaded) { try { await onUploaded(job, { client, keyPrefix, dir }); } catch (err) { bus.log(`☁️ อัปเดต job.json บนคลาวด์ไม่สำเร็จ: ${err.message}`, { jobId: job.id, level: "warn" }); } }
    }).catch((err) => {
      job.storage = { ...job.storage, status: "failed", uploaded: false, error: String(err?.message || err).slice(0, 300), at: Date.now() };
      bus.publish("job.storage", { job, ok: false });
      bus.log(`❌ อัปโหลดผลงานขึ้นคลาวด์ล้มเหลว: ${job.storage.error}`, { jobId: job.id, level: "error" });
    }).finally(() => inflight.delete(job.id));
  };
  bus.on("event", handler);
  return () => bus.off("event", handler);
}

/** สร้าง client จาก config ถ้าเปิดใช้ (provider=s3 และไม่มี errors) ไม่งั้น null */
export function createStorage(cfg = storageConfig()) {
  if (cfg.provider !== "s3" || cfg.errors.length) return null;
  return new S3Client(cfg);
}
