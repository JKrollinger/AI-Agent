// auth.js — ล็อกอินสำหรับใช้ออนไลน์
//   AUTH=auto|token|basic|none ใน .env (ค่าเริ่มต้น auto = token ถ้ามี DASHBOARD_TOKEN, basic ถ้ามี AUTH_PASSWORD, ไม่งั้น none)
//   โหมด token: ทุกหน้า/API/SSE ต้องมีคุกกี้ grock_session (ได้จากหน้า /login) หรือหัว Authorization: Bearer <DASHBOARD_TOKEN>
//     คุกกี้ = "<หมดอายุ unix ms>.<HMAC-SHA256(secret, หมดอายุ)>" (stateless รีสตาร์ตแล้วยังใช้ได้ เปลี่ยน DASHBOARD_TOKEN = คุกกี้เดิมใช้ไม่ได้ทั้งหมด)
//   การเดาโทเคน/รหัสผ่านถูกจำกัดต่อ IP (LOGIN_MAX_FAILS ครั้งต่อ LOGIN_WINDOW_MIN นาที → 429)
//   HOST ไม่ใช่ loopback หรือมี ALLOWED_HOSTS (เปิดผ่าน tunnel) แต่ไม่มีการล็อกอิน → เซิร์ฟเวอร์ไม่ยอมสตาร์ต (เว้นแต่ตั้ง AUTH=none ชัดเจน)
import crypto from "node:crypto";

export const COOKIE_NAME = "grock_session";
export const MIN_TOKEN_LENGTH = 16;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);
const safeEq = (a, b) => { const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); };
export { safeEq };

/**
 * อ่านการตั้งค่าจาก env → { mode: "token"|"basic"|"none", explicit, token, user, password, sessionMs, maxFails, windowMs, warnings[], errors[] }
 * errors ไม่ว่าง = ห้ามสตาร์ต
 */
export function authConfig(env = process.env, { host = env.HOST || "127.0.0.1", allowedHosts = [] } = {}) {
  const warnings = [];
  const errors = [];
  const raw = String(env.AUTH || "auto").trim().toLowerCase();
  const token = String(env.DASHBOARD_TOKEN || "").trim();
  const password = String(env.AUTH_PASSWORD || "");
  const user = env.AUTH_USER || "admin";
  let mode;
  if (raw === "token") mode = "token";
  else if (raw === "basic") mode = "basic";
  else if (raw === "none") mode = "none";
  else if (raw === "auto") mode = token ? "token" : password ? "basic" : "none";
  else { errors.push(`AUTH="${raw}" ไม่รู้จัก (ใช้ auto, token, basic หรือ none)`); mode = "none"; }
  if (mode === "token") {
    if (!token) errors.push("AUTH=token ต้องตั้ง DASHBOARD_TOKEN ใน .env (สร้างด้วย node -e \"console.log(require('crypto').randomBytes(24).toString('base64url'))\")");
    else if (token.length < MIN_TOKEN_LENGTH || /\s/.test(token)) errors.push(`DASHBOARD_TOKEN ต้องยาวอย่างน้อย ${MIN_TOKEN_LENGTH} ตัวอักษรและไม่มีช่องว่าง`);
    if (password) warnings.push("ตั้งทั้ง DASHBOARD_TOKEN และ AUTH_PASSWORD — โหมด token ยังรับ Basic Auth ด้วย (ใช้ได้ทั้งสองทาง)");
  }
  if (mode === "basic" && !password) errors.push("AUTH=basic ต้องตั้ง AUTH_PASSWORD ใน .env");
  const exposed = !LOOPBACK.has(String(host).toLowerCase()) || allowedHosts.length > 0;
  if (mode === "none" && exposed) {
    if (raw === "none") warnings.push(`⚠️ AUTH=none ทั้งที่เปิดรับจากภายนอก (HOST=${host}${allowedHosts.length ? `, ALLOWED_HOSTS=${allowedHosts.join(",")}` : ""}) — ทุกคนที่เข้าถึงพอร์ตนี้สั่งงานได้`);
    else errors.push(`เปิดรับจากภายนอก (HOST=${host}${allowedHosts.length ? `, ALLOWED_HOSTS=${allowedHosts.join(",")}` : ""}) แต่ยังไม่มีการล็อกอิน — ตั้ง DASHBOARD_TOKEN (AUTH=token) หรือ AUTH_PASSWORD ใน .env ก่อน (ดู docs/10-online.md) หรือตั้ง AUTH=none ถ้าตั้งใจเปิดโดยไม่ล็อกอินจริง ๆ`);
  }
  return {
    mode, explicit: raw !== "auto", token, user, password,
    sessionMs: Math.max(1, Math.min(365, Number(env.SESSION_DAYS) || 7)) * 86_400_000,
    maxFails: Math.max(1, Math.min(100, Number(env.LOGIN_MAX_FAILS) || 5)),
    windowMs: Math.max(1, Math.min(1440, Number(env.LOGIN_WINDOW_MIN) || 15)) * 60_000,
    exposed, warnings, errors,
  };
}

/** คีย์ลับสำหรับเซ็นคุกกี้: ได้จาก DASHBOARD_TOKEN (ไม่เก็บโทเคนในคุกกี้ตรง ๆ) */
export const cookieSecret = (token) => crypto.createHash("sha256").update(`grock-session:${token}`).digest();
export function makeCookieValue(secret, { now = Date.now(), ttlMs }) {
  const exp = String(now + ttlMs);
  return `${exp}.${crypto.createHmac("sha256", secret).update(exp).digest("base64url")}`;
}
/** ตรวจคุกกี้ → { ok, exp } */
export function verifyCookieValue(secret, value, { now = Date.now() } = {}) {
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{40,50})$/.exec(String(value || ""));
  if (!m) return { ok: false };
  const exp = Number(m[1]);
  if (!(exp > now)) return { ok: false, expired: true };
  const want = crypto.createHmac("sha256", secret).update(m[1]).digest("base64url");
  return { ok: safeEq(want, m[2]), exp };
}
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
/** คำขอมาทาง https ไหม (ตรง หรือผ่าน Cloudflare/proxy) → ใช้ตัดสินแฟล็ก Secure ของคุกกี้ */
export function isHttps(req) {
  if (req.socket?.encrypted) return true;
  const xf = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (xf === "https") return true;
  try { if (req.headers["cf-visitor"] && JSON.parse(req.headers["cf-visitor"]).scheme === "https") return true; } catch {}
  return false;
}
export const setCookieHeader = (value, { maxAgeSec, secure }) => `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=${maxAgeSec}`;
export const clearCookieHeader = ({ secure }) => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}; Max-Age=0`;

/** IP ของผู้เรียก (ผ่าน Cloudflare/proxy ใช้หัวที่ proxy ใส่ให้) */
export function clientIp(req) {
  const cf = String(req.headers["cf-connecting-ip"] || "").trim();
  if (cf) return cf;
  const xff = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (xff) return xff;
  return String(req.socket?.remoteAddress || "unknown");
}

/** จำกัดการเดาโทเคน/รหัสผ่านต่อ IP: หลังล้มเหลวครบ max ครั้งใน window → บล็อกจนกว่า window จะหมด */
export class LoginLimiter {
  constructor({ max = 5, windowMs = 15 * 60_000, now = Date.now } = {}) { this.max = max; this.windowMs = windowMs; this.now = now; this.fails = new Map(); }
  _prune(ip) {
    const t = this.now();
    const list = (this.fails.get(ip) || []).filter((x) => t - x < this.windowMs);
    if (list.length) this.fails.set(ip, list); else this.fails.delete(ip);
    if (this.fails.size > 10_000) { for (const [k, v] of this.fails) { if (v.every((x) => t - x >= this.windowMs)) this.fails.delete(k); } } // กันโตไม่จำกัด
    return list;
  }
  /** → { ok, remaining, retryAfterSec } */
  check(ip) {
    const list = this._prune(ip);
    if (list.length < this.max) return { ok: true, remaining: this.max - list.length, retryAfterSec: 0 };
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((this.windowMs - (this.now() - list[0])) / 1000)) };
  }
  fail(ip) { const list = this._prune(ip); list.push(this.now()); this.fails.set(ip, list); return this.check(ip); }
  reset(ip) { this.fails.delete(ip); }
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** พาธปลายทางหลังล็อกอิน: รับเฉพาะพาธภายใน (ขึ้นต้นด้วย / เดียว) */
export const safeNext = (v) => { const s = String(v || ""); return /^\/(?![\/\\])[^\s]*$/.test(s) && s.length <= 500 ? s : "/"; };

/** หน้า login แบบง่าย (ธีมเดียวกับแดชบอร์ด) */
export function loginPageHtml({ error = "", next = "/", title = "AI Workforce Control Center" } = {}) {
  return `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>เข้าสู่ระบบ — ${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+Thai:wght@400;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0b1020;--card:#141a2e;--line:#273153;--text:#e8ecf7;--muted:#8b97ad;--accent:#f5b942;--bad:#ff5f6d}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(1200px 600px at 50% -10%,#1b2548,var(--bg));color:var(--text);font-family:"Noto Sans Thai",system-ui,sans-serif}
.card{width:min(92vw,400px);background:var(--card);border:1px solid var(--line);border-radius:14px;padding:26px 24px;box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{margin:0 0 4px;font-size:18px}p{margin:0 0 16px;color:var(--muted);font-size:13px}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px}
input{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#0e1427;color:var(--text);font-size:15px;font-family:inherit;letter-spacing:.5px}
input:focus{outline:none;border-color:var(--accent)}
button{margin-top:14px;width:100%;padding:11px;border:0;border-radius:9px;background:var(--accent);color:#1b1400;font-weight:700;font-size:14px;font-family:inherit;cursor:pointer}
.err{color:var(--bad);font-size:13px;margin:10px 0 0;min-height:1em}.hint{margin-top:14px;font-size:11px;color:var(--muted)}
</style></head><body>
<form class="card" method="post" action="/login" autocomplete="off">
  <h1>⚔️ ${esc(title)}</h1>
  <p>ศูนย์ควบคุมพนักงาน AI — ใส่โทเคนเข้าใช้ (DASHBOARD_TOKEN) เพื่อเข้าสู่ระบบ</p>
  <label for="token">โทเคน</label>
  <input id="token" name="token" type="password" autofocus required minlength="${MIN_TOKEN_LENGTH}" autocomplete="current-password" placeholder="วางโทเคนที่นี่">
  <input type="hidden" name="next" value="${esc(next)}">
  <div class="err" role="alert">${esc(error)}</div>
  <button type="submit">เข้าสู่ระบบ</button>
  <div class="hint">โทเคนอยู่ใน .env ของเครื่องที่รันเซิร์ฟเวอร์ (DASHBOARD_TOKEN) · เซสชันเก็บเป็นคุกกี้ HttpOnly · เดาผิดหลายครั้งจะถูกพักชั่วคราว</div>
</form></body></html>`;
}
