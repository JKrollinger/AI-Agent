// app.js — Dashboard client: รับเหตุการณ์ผ่าน SSE → อัปเดตสถานะ → วาดแอนิเมชันบน canvas + แผงควบคุม
const $ = (sel, root = document) => root.querySelector(sel);
const TAU = Math.PI * 2;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const fmtMs = (ms) => {
  if (!ms || ms < 1000) return `${Math.round(ms || 0)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} วิ`;
  return `${Math.floor(ms / 60_000)} นาที ${Math.round((ms % 60_000) / 1000)} วิ`;
};
const fmtUsd = (v) => `$${(v || 0).toFixed(4)}`;
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n || 0)));
const fmtTime = (ts) => new Date(ts).toLocaleTimeString("th-TH", { hour12: false });
const pct = (v) => `${Math.round((v || 0) * 100)}%`;

const STATUS_TH = {
  queued: "รอคิว", assigned: "มอบหมายแล้ว", running: "กำลังทำ", done: "เสร็จ", failed: "ล้มเหลว", cancelled: "ยกเลิก",
  planning: "วางแผน", synthesizing: "รวบรวมผล", idle: "ว่าง", working: "กำลังทำงาน", paused: "หยุดชั่วคราว",
};
const ROLE_FALLBACK = { label: "ทีม", color: "#8b97ad", emoji: "👤" };
// ไอคอน/ป้ายของเครื่องมือ (server tools ของ Claude) — key ตรงกับ name ใน block server_tool_use
const TOOL_UI = {
  web_search: { icon: "🔎", label: "ค้นเว็บ" },
  web_fetch: { icon: "🌐", label: "อ่านเว็บ" },
  code_execution: { icon: "⚙️", label: "รันโค้ด" },
  bash_code_execution: { icon: "⚙️", label: "รันโค้ด" },
  text_editor_code_execution: { icon: "📝", label: "แก้ไฟล์" },
  claude_code: { icon: "🛠️", label: "Claude Code" },
};
const toolUi = (name) => (name ? TOOL_UI[name] || { icon: "🔧", label: name } : null);
const toolChip = (name) => { const t = toolUi(name); return t ? `${t.icon} ${esc(t.label)}` : ""; };

// patch ของงาน "แก้ไฟล์จริง" (Developer ผ่าน Claude Code headless) — รอผู้ควบคุมกด apply/ปฏิเสธ
const PATCH_TH = { pending: "รออนุมัติ", applied: "apply แล้ว", rejected: "ปฏิเสธแล้ว", superseded: "ตกไป (ทำรอบใหม่)", error: "ผิดพลาด" };
const KIND_TH = { added: "เพิ่ม", modified: "แก้", deleted: "ลบ" };
const patchChip = (t) => (t.patch ? `<span class="chip patch ${esc(t.patch.status)}">🩹 ${esc(PATCH_TH[t.patch.status] || t.patch.status)}</span>` : "");
const pendingPatches = () => [...S.tasks.values()].filter((t) => t.patch?.status === "pending").length;
function patchControls(t) {
  if (!t.patch || t.patch.status !== "pending") return "";
  return `<div class="controls patch-controls" data-patch="${t.id}">
    <input type="text" class="note" placeholder="หมายเหตุ/เหตุผล (ไม่บังคับ)" />
    <button class="btn small ok" data-apply="${t.id}">✅ Apply เข้าโปรเจกต์</button>
    <button class="btn small danger" data-rejectpatch="${t.id}">✖ ปฏิเสธ</button>
  </div>`;
}
function diffHtml(text) {
  return String(text || "").split("\n").map((l) => {
    const c = l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") ? "hd" : l.startsWith("@@") ? "hk" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "";
    return c ? `<span class="${c}">${esc(l)}</span>` : esc(l);
  }).join("\n");
}
function patchSection(t) {
  const p = t.patch;
  if (!p) return "";
  const files = (p.files || []).map((f) => `<div class="pf"><span class="k ${esc(f.kind)}">${esc(KIND_TH[f.kind] || f.kind)}</span><span class="p" title="${esc(f.path)}">${esc(f.path)}</span><span class="n">+${f.add} −${f.del}</span></div>`).join("");
  const rejected = (p.rejected || []).length ? `<div class="r-line2" style="margin-top:6px;color:var(--warn)">ตัดออกเพราะนอกสิทธิ์: ${p.rejected.map((r) => `${esc(r.path)} (${esc(r.reason)})`).join(", ")}</div>` : "";
  const decided = p.status !== "pending" ? `<div class="r-line2" style="margin-top:6px">${esc(PATCH_TH[p.status] || p.status)}${p.decidedAt ? ` · ${fmtTime(p.decidedAt)}` : ""}${p.note ? ` — ${esc(p.note)}` : ""}</div>` : `<div class="r-line2" style="margin-top:6px">ไฟล์ในโปรเจกต์ยังไม่ถูกแตะ — ตรวจ diff แล้วกด Apply (git apply --check ก่อนจริง) หรือปฏิเสธ</div>`;
  const err = p.lastError ? `<div class="r-line2" style="color:var(--bad);margin-top:6px">⚠️ ${esc(p.lastError)}</div>` : "";
  return `<div class="section"><h3>🩹 Patch (แก้ไฟล์จริง) ${patchChip(t)}</h3>
    <div class="patch-box">
      <div class="r-line2">${esc(p.rel)} · ${(p.files || []).length} ไฟล์ · +${p.stats?.add ?? 0} −${p.stats?.del ?? 0} · ${p.mode === "sim" ? "จำลอง (sim)" : "Claude Code"}${p.cli?.costUsd != null ? ` · $${Number(p.cli.costUsd).toFixed(4)}` : ""} <button class="btn small ghost" data-copytext="${esc(p.path)}">คัดลอกพาธ</button></div>
      <div class="patch-files">${files}</div>${rejected}${decided}${err}
      ${patchControls(t)}
      <pre class="stream diff">${diffHtml(p.preview)}</pre>
    </div></div>`;
}

// ---------------------------------------------------------------------------
// สถานะฝั่ง client
// ---------------------------------------------------------------------------
const S = {
  mode: "sim",
  view: "3d", // มุมมองฉาก: "3d" ออฟฟิศ (office3d/ ใน iframe, ค่าเริ่มต้น) | "2d" เมืองมอร็อค (scene.js) — จำไว้ใน localStorage
  sceneSel: null, // พนักงานที่ถูกเลือกอยู่ในฉาก 3 มิติ (กันคำสั่ง select ส่งวนไปมาระหว่างหน้าแม่กับ iframe)
  screen: null, // agentId ที่เปิด "หน้าจอการทำงานจริง" อยู่ (popup)
  toolLog: new Map(), // taskId -> [{t, tool, input, result, ok}] จาก task.progress.toolStep (คำค้น/URL/คำสั่ง + ผล)
  settings: { speed: 1 },
  agents: new Map(),
  tasks: new Map(),
  jobs: new Map(),
  totals: {},
  logs: [],
  live: new Map(), // agentId -> ข้อความสดล่าสุด
  selected: null, // { type: "agent" | "task", id }
  tab: "tasks",
  collapsed: new Set(),
  expandedResults: new Set(),
};
const dirty = new Set();
const mark = (...kinds) => kinds.forEach((k) => dirty.add(k));

const roleInfo = (role) => {
  for (const a of S.agents.values()) if (a.role === role) return { label: a.roleLabel, color: a.color, emoji: a.emoji };
  return ROLE_FALLBACK;
};
const agentName = (id) => (id === "captain" ? "กัปตัน" : S.agents.get(id)?.name || "—");

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const act = (p, fn) => p.then(fn).catch((e) => toast(e.message, "bad"));

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
function connect() {
  const es = new EventSource("/api/events");
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.onmessage = (e) => handle(JSON.parse(e.data));
}
function setConn(on) {
  const b = $("#connBadge");
  b.textContent = on ? "เชื่อมต่อแล้ว" : "หลุดการเชื่อมต่อ — กำลังต่อใหม่…";
  b.className = `badge conn ${on ? "on" : "off"}`;
}

function upsertTask(t) { S.tasks.set(t.id, t); }
function upsertJob(j) { S.jobs.set(j.id, j); }
/** พนักงานคนล่าสุดที่เกี่ยวกับงานนี้ (ใช้เมื่อ assignedTo ถูกล้างแล้ว) */
const lastAgentOf = (t) => t.assignedTo || [...(t.history || [])].reverse().find((h) => h.agentId)?.agentId || null;

function handle(ev) {
  const d = ev.data || {};
  switch (ev.type) {
    case "snapshot":
      S.mode = d.mode; S.settings = d.settings; S.totals = d.totals; S.projects = d.projects || [];
      S.agents = new Map(d.agents.map((a) => [a.id, a]));
      S.tasks = new Map(d.tasks.map((t) => [t.id, t]));
      S.jobs = new Map(d.jobs.map((j) => [j.id, j]));
      S.allowedModels = d.allowedModels || [];
      layout();
      mark("kpis", "tasks", "metrics", "results", "drawer", "mode", "roster", "strip", "projects");
      break;
    case "log.history":
      S.logs = (d.events || []).slice().reverse();
      mark("log");
      break;
    case "log":
      S.logs.unshift(ev);
      if (S.logs.length > 400) S.logs.length = 400;
      mark("log");
      break;
    case "agent.updated":
      S.agents.set(d.agent.id, d.agent);
      mark("metrics", "drawer", "roster", "screen");
      break;
    case "task.created": case "task.started": case "task.updated":
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip", "roster", "screen");
      break;
    case "task.review": {
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip", "screen");
      const who = d.task.assignedTo || lastAgentOf(d.task);
      if (who) sc().fx(who, d.approved ? "bless" : "fail");
      break;
    }
    case "task.failed": {
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip", "roster", "screen");
      const who = lastAgentOf(d.task);
      if (who) { sc().fx(who, "fail"); sc().emote(who, "question"); }
      if (!d.retry) toast(`❌ งาน "${trunc(d.task.title, 40)}" ล้มเหลว: ${d.error || ""}`, "bad");
      break;
    }
    case "task.assigned":
      upsertTask(d.task);
      spawnPacket(d.from || "captain", d.to, trunc(d.task.title, 26), S.agents.get(d.to)?.color || "#fff", d.from && d.from !== "captain" ? "handoff" : "assign");
      sc().visit(d.to, d.from || "captain"); // ผู้รับเดินไปรับงานจากกัปตัน/เพื่อน แล้วกลับมาทำที่จุดประจำ
      mark("tasks", "kpis", "drawer", "strip", "roster");
      break;
    case "task.handoff":
      upsertTask(d.task);
      if (d.from && d.from !== "captain") sc().emote(d.from, d.manual ? "question" : "angry");
      toast(`🔁 ส่งต่อ "${trunc(d.task.title, 36)}" จาก ${agentName(d.from)} → ${agentName(d.to)}${d.score != null ? ` (QA ${d.score}/100)` : ""}`, "warn");
      mark("tasks", "drawer", "strip");
      break;
    case "task.patch": {
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip");
      const t = d.task, n = (t.patch?.files || []).length, who = t.patch?.agentName || agentName(lastAgentOf(t));
      if (d.action === "pending") { toast(`🩹 ${who} ส่ง patch ${n} ไฟล์ รออนุมัติ: "${trunc(t.title, 36)}" — เปิดการ์ดงานเพื่อ Apply/ปฏิเสธ`, "warn"); const a = lastAgentOf(t); if (a) sc().emote(a, "question"); }
      else if (d.action === "applied") toast(`✅ Apply patch "${trunc(t.title, 36)}" เข้าโปรเจกต์แล้ว (${(d.files || []).length} ไฟล์)`, "ok");
      else if (d.action === "rejected") toast(`🚫 ปฏิเสธ patch "${trunc(t.title, 36)}" — ไฟล์ไม่ถูกแตะ`, "warn");
      else if (d.action === "error") toast(`⚠️ Apply patch ไม่สำเร็จ: ${d.error || ""}`, "bad");
      break;
    }
    case "task.completed":
      upsertTask(d.task);
      spawnPacket(d.from, "captain", "ส่งผลงาน ✓", S.agents.get(d.from)?.color || "#3dd598", "return");
      sc().visit(d.from, "captain"); // เดินไปส่งผลงานให้กัปตัน แล้วกลับจุดประจำ
      sc().emote(d.from, "heart");
      mark("tasks", "kpis", "drawer", "strip", "roster", "screen");
      break;
    case "task.progress": {
      const t = S.tasks.get(d.taskId);
      if (t) { t.progress = d.progress; t.phase = d.phase; if ("tool" in d) t.activeTool = d.tool; if (d.toolCalls != null) t.toolCalls = d.toolCalls; }
      const a = S.agents.get(d.agentId);
      if (a) { a.phase = d.phase; if ("tool" in d) a.activeTool = d.tool; if (d.agentToolCalls != null && a.metrics) a.metrics.toolCalls = d.agentToolCalls; }
      S.live.set(d.agentId, d.text || "");
      if (d.toolStep) recordToolStep(ev.ts, d);
      liveUpdate(d);
      if (S.screen === d.agentId) mark("screen");
      break;
    }
    case "job.created": case "job.planned": case "job.updated":
      upsertJob(d.job); mark("tasks", "results", "kpis", "strip", "screen");
      break;
    case "job.completed":
      upsertJob(d.job); burst("captain"); mark("screen");
      toast(`🎉 งานเสร็จสมบูรณ์: "${trunc(d.job.goal, 50)}" ใช้เวลา ${fmtMs(d.job.durationMs)} ต้นทุน ${fmtUsd(d.job.costUsd)}`, "ok");
      mark("tasks", "results", "kpis", "strip");
      break;
    case "job.failed":
      upsertJob(d.job); toast(`❌ งาน "${trunc(d.job.goal, 50)}" ล้มเหลว`, "bad"); mark("tasks", "results", "kpis", "strip");
      break;
    case "metrics.updated":
      S.totals = d.totals;
      for (const m of d.agents) { const a = S.agents.get(m.id); if (a) { a.metrics = m.metrics; a.computed = m.computed; } }
      mark("kpis", "metrics", "roster");
      break;
    case "settings.updated":
      S.settings = d.settings; mark("mode");
      break;
    case "mode.updated":
      S.mode = d.mode; mark("mode");
      break;
    case "projects.updated":
      S.projects = d.projects || []; mark("projects");
      break;
  }
}

// ---------------------------------------------------------------------------
// Render loop (รวมการวาด DOM ที่ค้างไว้ไปทำครั้งเดียวต่อเฟรม)
// ---------------------------------------------------------------------------
function flush() {
  if (dirty.has("mode")) renderMode();
  if (dirty.has("projects")) renderProjects();
  if (dirty.has("kpis")) renderKpis();
  if (dirty.has("tasks")) renderTasks();
  if (dirty.has("metrics")) renderMetrics();
  if (dirty.has("log")) renderLog();
  if (dirty.has("results")) renderResults();
  if (dirty.has("drawer")) renderDrawer();
  if (dirty.has("screen")) renderScreen();
  if (dirty.has("roster")) renderRoster();
  if (dirty.has("strip")) renderStrip();
  dirty.clear();
}

/** รายการโปรเจกต์ (Project Pack) ในช่องเลือกข้างช่องโจทย์ — จำตัวเลือกล่าสุดไว้ในเบราว์เซอร์ */
function renderProjects() {
  const sel = $("#projectSelect"); if (!sel) return;
  let remembered = "";
  try { remembered = localStorage.getItem("grock.project") || ""; } catch {}
  const first = !sel.dataset.ready; // ใช้ค่าที่จำไว้เฉพาะครั้งแรก — หลังจากนั้นเคารพสิ่งที่ผู้ใช้เลือกอยู่ (รวม "ไม่ระบุโปรเจกต์")
  sel.dataset.ready = "1";
  const current = first ? remembered : sel.value;
  const list = S.projects || [];
  sel.innerHTML = `<option value="">ไม่ระบุโปรเจกต์</option>` + list.map((p) => `<option value="${esc(p.id)}"${p.ok ? "" : " disabled"}>📁 ${esc(p.name || p.id)}${p.ok ? "" : " (ไม่พบโฟลเดอร์)"}</option>`).join("");
  if (current && list.some((p) => p.id === current && p.ok)) sel.value = current;
  sel.classList.toggle("hidden", !list.length);
}
function selectedProject() {
  const v = $("#projectSelect")?.value || "";
  try { localStorage.setItem("grock.project", v); } catch {}
  return v || null;
}

function renderMode() {
  const b = $("#modeBadge");
  b.textContent = S.mode === "live" ? "LIVE · Claude" : "SIM · จำลอง";
  b.className = `badge mode ${S.mode}`;
  $("#speedCtl").classList.toggle("hidden", S.mode === "live");
  $("#speedRange").value = S.settings.speed;
  $("#speedVal").textContent = `${S.settings.speed}×`;
}

function renderKpis() {
  const t = S.totals || {};
  const items = [
    [`${t.workersBusy ?? 0}/${t.workersTotal ?? 0}`, "พนักงานกำลังทำ"],
    [t.queued ?? 0, "รอคิว"],
    [t.running ?? 0, "กำลังทำ"],
    [t.done ?? 0, "งานเสร็จ"],
    [t.jobsDone ?? 0, "โจทย์สำเร็จ"],
    [t.toolCalls ?? 0, "ใช้เครื่องมือ"],
    [fmtUsd(t.costUsd), "ต้นทุนรวม"],
  ];
  $("#kpis").innerHTML = items.map(([v, l]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="l">${l}</div></div>`).join("");
  const pend = pendingPatches();
  $("#cntTasks").innerHTML = (S.tasks.size ? `(${S.tasks.size})` : "") + (pend ? ` <span class="pending-badge" title="patch ของ Developer ที่รอคุณอนุมัติ">🩹${pend}</span>` : "");
  $("#cntResults").textContent = [...S.jobs.values()].filter((j) => j.status === "done").length || "";
}

function taskCard(t, compact = false) {
  const ri = roleInfo(t.role);
  const who = t.assignedTo ? S.agents.get(t.assignedTo) : null;
  const active = t.status === "running" || t.status === "assigned";
  const sub = [
    `${ri.emoji} ${ri.label}`,
    who ? `ผู้รับ: ${who.name}` : t.pinnedAgentId ? `รอ: ${agentName(t.pinnedAgentId)}` : t.preferredAgentId ? `กัปตันเลือก: ${agentName(t.preferredAgentId)}` : "",
    t.attempts > 1 ? `รอบที่ ${t.attempts}` : "",
    t.status === "done" ? fmtMs(t.durationMs) : "",
    t.review ? `QA ${t.review.score}/100${t.review.approved ? " ✓" : ""}` : "",
    t.toolCalls ? `🔧 เครื่องมือ ${t.toolCalls} ครั้ง` : "",
    t.patch ? `🩹 patch ${(t.patch.files || []).length} ไฟล์` : "",
  ].filter(Boolean);
  return `<div class="task" data-task="${t.id}" style="border-left-color:${ri.color}">
    <div class="row"><span class="title" title="${esc(t.title)}">${esc(t.title)}</span>${t.patch?.status === "pending" ? patchChip(t) : ""}<span class="chip ${t.status}">${STATUS_TH[t.status] || t.status}</span></div>
    ${compact ? "" : `<div class="sub">${sub.map(esc).join(" · ")}</div>`}
    ${active ? `<div class="bar"><i style="width:${Math.round((t.progress || 0) * 100)}%;background:${ri.color}"></i></div><div class="sub"><span class="tool-chip${t.activeTool ? "" : " hidden"}" data-toolchip>${toolChip(t.activeTool)}</span><span class="phase">${esc(t.phase || "")}</span></div>` : ""}
    ${compact ? "" : patchControls(t)}
  </div>`;
}

function renderTasks() {
  const root = $("#tab-tasks");
  const jobs = [...S.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!jobs.length) {
    root.innerHTML = `<div class="empty">ยังไม่มีงาน — พิมพ์โจทย์ด้านบนแล้วกด "มอบหมายงาน" หรือกด "ลองงานตัวอย่าง"</div>`;
    return;
  }
  root.innerHTML = jobs.map((j) => {
    const tasks = j.taskIds.map((id) => S.tasks.get(id)).filter(Boolean).sort((a, b) => a.seq - b.seq);
    const done = tasks.filter((t) => t.status === "done").length;
    const collapsed = S.collapsed.has(j.id);
    const dur = j.finishedAt ? fmtMs(j.durationMs || j.finishedAt - j.createdAt) : fmtMs(Date.now() - j.createdAt);
    return `<div class="job">
      <div class="job-head" data-job="${j.id}">
        <div style="flex:1;min-width:0"><div class="goal">${esc(j.goal)}</div>
          <div class="meta">${done}/${tasks.length} งาน · ${dur} · ${fmtUsd(j.costUsd || tasks.reduce((s, t) => s + (t.usage?.costUsd || 0), 0))}${j.project ? ` · <span class="chip proj">📁 ${esc(j.project)}</span>` : ""}</div></div>
        <span class="chip ${j.status}">${STATUS_TH[j.status] || j.status}</span>
        <span style="color:var(--muted)">${collapsed ? "▸" : "▾"}</span>
      </div>
      ${collapsed ? "" : `<div class="job-body">${tasks.length ? tasks.map((t) => taskCard(t)).join("") : `<div class="empty" style="padding:10px">กัปตันกำลังวางแผน…</div>`}</div>`}
    </div>`;
  }).join("");
}

function renderMetrics() {
  const root = $("#tab-metrics");
  const tasks = [...S.tasks.values()];
  const done = tasks.filter((t) => t.status === "done");
  const avg = done.length ? done.reduce((s, t) => s + t.durationMs, 0) / done.length : 0;
  const agents = [...S.agents.values()].sort((a, b) => (a.role === "captain" ? -1 : b.role === "captain" ? 1 : a.id.localeCompare(b.id)));
  const scores = agents.flatMap((a) => a.metrics?.qualityScores || []);
  const avgQ = scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : "—";
  root.innerHTML = `<div class="summary">
      <div class="sum"><div class="v">${tasks.length}</div><div class="l">งานทั้งหมด</div></div>
      <div class="sum"><div class="v">${done.length}</div><div class="l">งานเสร็จ</div></div>
      <div class="sum"><div class="v">${S.totals.toolCalls ?? 0}</div><div class="l">ใช้เครื่องมือ</div></div>
      <div class="sum"><div class="v">${fmtUsd(S.totals.costUsd)}</div><div class="l">ต้นทุนรวม</div></div>
      <div class="sum"><div class="v">${fmtMs(avg)}</div><div class="l">เวลาเฉลี่ยต่องาน</div></div>
      <div class="sum"><div class="v">${avgQ}</div><div class="l">คุณภาพเฉลี่ย (QA)</div></div>
    </div>` + agents.map((a) => {
      const m = a.metrics, c = a.computed || {};
      const toolIcons = (a.tools || []).map((n) => toolUi(n).icon).join("");
      return `<div class="agent-card" data-agent="${a.id}">
        <div class="head"><div class="avatar" style="border-color:${a.color}">${avatarHtml(a, 30)}</div>
          <div style="flex:1"><div class="name">${esc(a.name)}</div><div class="role">${esc(a.roleLabel)} · ${esc(a.model)}${toolIcons ? ` · <span title="เครื่องมือประจำตำแหน่ง">${toolIcons}</span>` : ""}</div></div>
          <span class="chip ${a.status === "working" ? "running" : a.status === "paused" ? "review" : ""}">${STATUS_TH[a.status]}</span></div>
        <div class="stat-grid">
          <div class="stat"><div class="v">${m.tasksDone}</div><div class="l">งานเสร็จ</div></div>
          <div class="stat"><div class="v">${m.tasksFailed}</div><div class="l">ล้มเหลว</div></div>
          <div class="stat"><div class="v">${fmtMs(c.avgDurationMs)}</div><div class="l">เวลาเฉลี่ย</div></div>
          <div class="stat"><div class="v">${fmtK(m.inputTokens)}</div><div class="l">โทเคนเข้า${m.cacheReadTokens ? ` · แคช ${pct(m.cacheReadTokens / Math.max(1, m.inputTokens))}` : ""}</div></div>
          <div class="stat"><div class="v">${fmtK(m.outputTokens)}</div><div class="l">โทเคนออก</div></div>
          <div class="stat"><div class="v">${fmtUsd(m.costUsd)}</div><div class="l">ต้นทุน</div></div>
          <div class="stat"><div class="v">${c.avgQuality ?? "—"}</div><div class="l">คุณภาพ (QA)</div></div>
          <div class="stat"><div class="v">${m.handoffsIn} / ${m.handoffsOut}</div><div class="l">ส่งต่อ เข้า/ออก</div></div>
          <div class="stat"><div class="v">${m.toolCalls || 0}${a.activeTool ? ` <span class="tool-chip">${toolChip(a.activeTool)}</span>` : ""}</div><div class="l">ใช้เครื่องมือ</div></div>
          <div class="stat"><div class="v">${c.successRate == null ? "—" : pct(c.successRate)}</div><div class="l">สำเร็จ</div></div>
          <div class="stat"><div class="v">${pct(c.utilization)}</div><div class="l">อัตราใช้งาน</div></div>
          <div class="stat"><div class="v">${fmtMs(m.busyMs)}</div><div class="l">เวลาทำงานรวม</div></div>
        </div>
        <div class="util"><i style="width:${Math.round((c.utilization || 0) * 100)}%;background:${a.color}"></i></div>
      </div>`;
    }).join("");
}

function renderLog() {
  $("#tab-log").innerHTML = S.logs.length
    ? S.logs.map((e) => `<div class="log-item ${esc(e.data?.level || "")}"><time>${fmtTime(e.ts)}</time><div>${esc(e.data?.message)}</div></div>`).join("")
    : `<div class="empty">ยังไม่มีบันทึกเหตุการณ์</div>`;
}

function renderResults() {
  const jobs = [...S.jobs.values()].filter((j) => j.status === "done" || j.status === "failed").sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0));
  $("#tab-results").innerHTML = jobs.length
    ? jobs.map((j) => `<div class="result">
        <div class="head" data-result="${j.id}"><div class="goal">${esc(j.goal)}</div><span class="chip ${j.status}">${STATUS_TH[j.status]}</span></div>
        <div class="meta" style="padding:0 12px 10px;color:var(--muted);font-size:11px">${fmtMs(j.durationMs)} · ${fmtUsd(j.costUsd)} · ${j.taskIds.length} งานย่อย
          <button class="btn small ghost" data-copy="${j.id}" style="margin-left:8px">คัดลอกผลลัพธ์</button></div>
        ${j.outputDir ? `<div class="outdir">📁 ${esc(j.outputDir)} <button class="btn small ghost" data-copytext="${esc(j.outputDir)}">คัดลอกพาธ</button></div>` : ""}
        ${S.expandedResults.has(j.id) ? `<pre>${esc(j.result || "(ไม่มีผลลัพธ์)")}</pre>` : ""}
      </div>`).join("")
    : `<div class="empty">ยังไม่มีผลงานที่เสร็จ</div>`;
}

// ---------------------------------------------------------------------------
// Drawer (รายละเอียด + ควบคุม)
// ---------------------------------------------------------------------------
function openDrawer(type, id) { S.selected = { type, id }; renderDrawer(); }
function closeDrawer() {
  S.selected = null; $("#drawer").classList.add("hidden");
  if (S.sceneSel) { S.sceneSel = null; office.send("select", null); } // เอาวงเลือกในฉาก 3 มิติออกด้วย
}
/** เปิด drawer ของพนักงานจากแผงรายชื่อ/การ์ด — ถ้าอยู่ในมุมมอง 3 มิติ ให้วงเลือกในฉากตามไปด้วย */
function focusAgent(id) { openDrawer("agent", id); if (S.view === "3d") { S.sceneSel = id; office.send("select", id); } }

function agentOptions(excludeId) {
  return [...S.agents.values()].filter((a) => a.role !== "captain" && a.id !== excludeId)
    .map((a) => `<option value="${a.id}">${esc(a.name)} · ${esc(a.roleLabel)}${a.status === "idle" ? " (ว่าง)" : a.status === "paused" ? " (หยุด)" : ""}</option>`).join("");
}

function handoffControls(task, excludeId) {
  return `<div class="controls" data-handoff="${task.id}">
    <select class="to">${agentOptions(excludeId)}</select>
    <input type="text" class="reason" placeholder="เหตุผล/คำแนะนำ (ไม่บังคับ)" />
    <button class="btn small primary go">ส่งต่องาน</button>
  </div>`;
}

function renderDrawer() {
  const box = $("#drawer");
  if (!S.selected) { box.classList.add("hidden"); return; }
  const { type, id } = S.selected;
  // เก็บค่าที่ผู้ใช้กำลังพิมพ์/เลือกในกล่องส่งต่อไว้ ไม่ให้หายเมื่อมี event ใหม่เข้ามา
  const keep = { to: $("#drawer .controls .to")?.value, reason: $("#drawer .controls .reason")?.value, note: $("#drawer .patch-controls .note")?.value };
  let html = "";
  if (type === "agent") {
    const a = S.agents.get(id);
    if (!a) return closeDrawer();
    const task = a.currentTaskId ? S.tasks.get(a.currentTaskId) : null;
    const m = a.metrics, c = a.computed || {};
    const live = S.live.get(a.id) || a.lastOutput || "";
    const mine = [...S.tasks.values()].filter((t) => t.assignedTo === a.id || t.history?.some((h) => h.agentId === a.id)).sort((a2, b2) => b2.createdAt - a2.createdAt).slice(0, 6);
    html = `<div class="d-head"><div class="avatar" style="border-color:${a.color}">${avatarHtml(a, 30)}</div>
        <div><h2>${esc(a.name)}</h2><div class="role">${esc(a.roleLabel)}${a.jobTh ? ` (${esc(a.jobTh)})` : ""} · ${esc(a.model)}</div></div>
        <span class="chip ${a.status === "working" ? "running" : a.status === "paused" ? "review" : ""}" style="margin-left:auto">${STATUS_TH[a.status]}</span>
        <button class="btn small ghost" data-screen="${a.id}" title="ข้อความที่สตรีม เครื่องมือที่ใช้ และผลตรวจ QA ของคนนี้">🖥️ หน้าจอการทำงาน</button>
        <button class="close" title="ปิด">×</button></div>
      <div class="d-body">
        <div class="section"><h3>หน้าที่</h3><div class="duty">${esc(a.duties || "—")}</div><div class="r-line2" style="margin-top:4px">แก้ได้ที่ปุ่ม ⚙ ตั้งค่า AI — กัปตันใช้หน้าที่นี้เลือกคนทำงาน</div></div>
        ${a.role === "captain" ? `<div class="section"><h3>บทบาท</h3><div>รับโจทย์ แตกงาน มอบหมาย ติดตาม และรวบรวมผลลัพธ์ — ${esc(a.currentTaskTitle || "พร้อมรับโจทย์")}</div></div>` : `
        <div class="section"><h3>การควบคุม</h3><div class="controls">
          ${a.status === "paused"
            ? `<button class="btn small ok" data-resume="${a.id}">▶ ให้กลับมาทำงาน</button>`
            : `<button class="btn small danger" data-pause="${a.id}">⏸ หยุดชั่วคราว${task ? " (งานกลับเข้าคิว)" : ""}</button>`}
        </div></div>`}
        <div class="section"><h3>งานปัจจุบัน</h3>
          ${task ? `${taskCard(task)}
            <div class="sub" style="margin-top:6px;color:var(--muted);font-size:12px">เฟส: <span id="dPhase">${esc(task.phase || "")}</span> · <span id="dPct">${pct(task.progress)}</span></div>
            <div style="margin-top:8px">${handoffControls(task, a.id)}</div>
            <div class="controls" style="margin-top:6px"><button class="btn small danger" data-cancel="${task.id}">ยกเลิกงานนี้</button></div>`
            : `<div style="color:var(--muted)">ไม่มีงานในมือ</div>`}
        </div>
        <div class="section"><h3>สิ่งที่กำลังทำ (สด)</h3><pre class="stream ${a.status === "working" ? "live" : ""}" id="streamBox">${esc(live || (a.status === "working" ? "กำลังเริ่ม…" : "—"))}</pre></div>
        <div class="section"><h3>ตัวชี้วัด</h3><div class="kv">
          <div>งานเสร็จ <b>${m.tasksDone}</b></div><div>ล้มเหลว <b>${m.tasksFailed}</b></div>
          <div>เวลาเฉลี่ย <b>${fmtMs(c.avgDurationMs)}</b></div><div>อัตราใช้งาน <b>${pct(c.utilization)}</b></div>
          <div>โทเคนเข้า <b>${fmtK(m.inputTokens)}</b></div><div>โทเคนออก <b>${fmtK(m.outputTokens)}</b></div>
          <div>ต้นทุน <b>${fmtUsd(m.costUsd)}</b></div><div>คุณภาพ QA <b>${c.avgQuality ?? "—"}</b></div>
          <div>รับงานต่อ <b>${m.handoffsIn}</b></div><div>ส่งงานต่อ <b>${m.handoffsOut}</b></div>
          <div>ใช้เครื่องมือ <b id="dAgentTools">${m.toolCalls || 0}</b> ครั้ง</div><div>เครื่องมือตอนนี้ <b id="dAgentTool">${toolChip(a.activeTool) || "—"}</b></div>
        </div></div>
        <div class="section"><h3>เครื่องมือประจำตำแหน่ง</h3><div>${(a.tools || []).length ? a.tools.map((n) => `<span class="tool-chip still">${toolChip(n)}</span>`).join(" ") : `<span style="color:var(--muted)">ไม่มี — ใช้ความรู้ในโมเดลอย่างเดียว</span>`}</div></div>
        <div class="section"><h3>งานล่าสุดของคนนี้</h3><div class="mini-list">${mine.length ? mine.map((t) => taskCard(t, true)).join("") : `<div style="color:var(--muted)">—</div>`}</div></div>
      </div>`;
  } else {
    const t = S.tasks.get(id);
    if (!t) return closeDrawer();
    const ri = roleInfo(t.role);
    const job = S.jobs.get(t.jobId);
    const who = t.assignedTo ? S.agents.get(t.assignedTo) : null;
    const active = ["queued", "assigned", "running"].includes(t.status);
    const live = t.status === "running" && who ? S.live.get(who.id) || "" : "";
    const deps = t.dependsOn.map((d) => S.tasks.get(d)).filter(Boolean);
    html = `<div class="d-head"><div class="avatar" style="border-color:${ri.color}">${ri.emoji}</div>
        <div><h2 style="font-size:14px">${esc(t.title)}</h2><div class="role">${esc(ri.label)} · ${who ? `ผู้รับ: ${esc(who.name)}` : "ยังไม่มอบหมาย"} · รอบที่ ${t.attempts} · ใช้เครื่องมือ <span id="dTools">${t.toolCalls || 0}</span> ครั้ง</div></div>
        <span class="chip ${t.status}" style="margin-left:auto">${STATUS_TH[t.status]}</span>
        ${who ? `<button class="btn small ghost" data-screen="${who.id}" title="หน้าจอการทำงานของ ${esc(who.name)}">🖥️ หน้าจอ</button>` : ""}
        <button class="close" title="ปิด">×</button></div>
      <div class="d-body">
        <div class="section"><h3>โจทย์หลัก</h3><div>${esc(job?.goal || "")}</div></div>
        <div class="section"><h3>รายละเอียดงาน</h3><div>${esc(t.description)}</div>
          ${deps.length ? `<div style="color:var(--muted);font-size:12px;margin-top:4px">รอผลจาก: ${deps.map((d) => esc(d.title)).join(", ")}</div>` : ""}</div>
        ${t.status === "running" ? `<div class="section"><h3>ความคืบหน้า</h3><div class="bar"><i id="dBar" style="width:${Math.round(t.progress * 100)}%;background:${ri.color}"></i></div>
          <div class="sub" style="margin-top:6px;color:var(--muted);font-size:12px"><span class="tool-chip${t.activeTool ? "" : " hidden"}" id="dToolChip">${toolChip(t.activeTool)}</span>เฟส: <span id="dPhase">${esc(t.phase || "")}</span> · <span id="dPct">${pct(t.progress)}</span></div></div>` : ""}
        <div class="section"><h3>ควบคุม</h3>
          ${handoffControls(t, t.assignedTo)}
          <div class="controls" style="margin-top:6px">
            ${active ? `<button class="btn small danger" data-cancel="${t.id}">ยกเลิกงาน</button>` : `<button class="btn small" data-retry="${t.id}">🔄 ทำใหม่</button>`}
          </div></div>
        ${patchSection(t)}
        ${t.review ? `<div class="section"><h3>ผลตรวจ QA</h3><div class="review-box"><div class="score" style="color:${t.review.approved ? "var(--ok)" : "var(--warn)"}">${t.review.score}/100 ${t.review.approved ? "ผ่าน" : t.review.acceptedWithNotes ? "รับพร้อมหมายเหตุ" : "ส่งกลับแก้"}</div>
          <div style="margin-top:4px">${esc(t.review.summary || "")}</div>${t.review.feedback ? `<pre class="stream" style="margin-top:8px">${esc(t.review.feedback)}</pre>` : ""}</div></div>` : ""}
        <div class="section"><h3>${t.status === "running" ? "ผลงานที่กำลังเขียน (สด)" : "ผลงาน"}</h3><pre class="stream ${t.status === "running" ? "live" : ""}" id="streamBox">${esc(t.status === "running" ? live || "กำลังเริ่ม…" : t.output || "—")}</pre></div>
        <div class="section"><h3>ไทม์ไลน์</h3><div class="timeline">${(t.history || []).slice(-12).map((h) => `<div><time>${fmtTime(h.t)}</time><span>${esc(h.note || h.type)}${h.agentId ? ` — ${esc(agentName(h.agentId))}` : ""}</span></div>`).join("")}</div></div>
      </div>`;
  }
  box.innerHTML = html;
  box.classList.remove("hidden");
  const toSel = $("#drawer .controls .to"), reasonIn = $("#drawer .controls .reason");
  if (toSel && keep.to && [...toSel.options].some((o) => o.value === keep.to)) toSel.value = keep.to;
  if (reasonIn && keep.reason) reasonIn.value = keep.reason;
  const noteIn = $("#drawer .patch-controls .note"); if (noteIn && keep.note) noteIn.value = keep.note;
  const sb = $("#streamBox"); if (sb) sb.scrollTop = sb.scrollHeight;
}

/** อัปเดตการ์ดงาน 1 ใบ (แถบ % / เฟส / ชิปเครื่องมือ) โดยไม่วาดใหม่ทั้งหมด */
function patchCard(card, d) {
  if (!card) return;
  const i = card.querySelector(".bar > i"); if (i) i.style.width = `${Math.round((d.progress || 0) * 100)}%`;
  const p = card.querySelector(".phase"); if (p) p.textContent = d.phase || "";
  const chip = card.querySelector("[data-toolchip]");
  if (chip && "tool" in d) { chip.innerHTML = toolChip(d.tool); chip.classList.toggle("hidden", !d.tool); }
}

/** อัปเดตเฉพาะส่วนที่เปลี่ยนบ่อย (ข้อความสด / เฟส / % / เครื่องมือที่ใช้) โดยไม่วาด drawer ใหม่ทั้งหมด */
function liveUpdate(d) {
  // การ์ดในแท็บงาน / การ์ดงานล่าสุด / แถวใน roster อัปเดตสดเสมอ (ไม่ต้องเปิด drawer)
  patchCard($(`#tab-tasks .task[data-task="${d.taskId}"]`), d);
  const sc1 = $(`#strip .task[data-task="${d.taskId}"]`);
  if (sc1) { patchCard(sc1, d); const p = sc1.querySelector(".s-pct"); if (p) p.textContent = pct(d.progress); }
  const rr = $(`#roster .roster-row[data-agent="${d.agentId}"]`);
  if (rr) { patchCard(rr, d); const c = rr.querySelector(".chip"); if (c) c.textContent = `กำลังทำ ${pct(d.progress)}`; }
  if (!S.selected) return;
  const sel = S.selected;
  const match = (sel.type === "agent" && sel.id === d.agentId) || (sel.type === "task" && sel.id === d.taskId);
  if (!match) return;
  const sb = $("#streamBox");
  if (sb) { sb.textContent = d.text || ""; sb.classList.add("live"); sb.scrollTop = sb.scrollHeight; }
  const ph = $("#dPhase"); if (ph) ph.textContent = d.phase || "";
  const pc = $("#dPct"); if (pc) pc.textContent = pct(d.progress);
  const bar = $("#dBar"); if (bar) bar.style.width = `${Math.round((d.progress || 0) * 100)}%`;
  const chip = $("#dToolChip"); if (chip && "tool" in d) { chip.innerHTML = toolChip(d.tool); chip.classList.toggle("hidden", !d.tool); }
  const dt = $("#dTools"); if (dt && d.toolCalls != null) dt.textContent = d.toolCalls;
  const at = $("#dAgentTools"); if (at && d.agentToolCalls != null) at.textContent = d.agentToolCalls;
  const atool = $("#dAgentTool"); if (atool && "tool" in d) atool.innerHTML = toolChip(d.tool) || "—";
  patchCard($(`#drawer .task[data-task="${d.taskId}"]`), d);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------
function toast(msg, kind = "") {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), 4200);
}

// ---------------------------------------------------------------------------
// หน้าจอการทำงานจริง (popup ต่อคน) — เปิดจาก drawer หรือจากการแตะจอคอมในฉาก 3 มิติ
// ข้อมูลทั้งหมดมาจาก event จริง: task.progress (ข้อความสด/เฟส/%/เครื่องมือ), task.completed (ผลงาน), task.review (QA)
// ---------------------------------------------------------------------------
function recordToolStep(ts, d) { // start → input (คำค้น/URL/คำสั่ง) → result (สรุปผล) ต่อการใช้เครื่องมือ 1 ครั้ง
  const log = S.toolLog.get(d.taskId) || [];
  if (d.toolStep === "start") log.push({ t: ts, tool: d.tool, input: "", result: "", ok: null });
  else {
    const e = [...log].reverse().find((x) => x.tool === d.tool && (d.toolStep === "input" ? !x.input : !x.result));
    if (e) { if (d.toolStep === "input") e.input = d.toolInput || ""; else { e.result = d.toolResult || ""; e.ok = d.toolOk !== false; } }
    else log.push({ t: ts, tool: d.tool, input: d.toolInput || "", result: d.toolResult || "", ok: d.toolOk ?? null });
  }
  if (log.length > 60) log.splice(0, log.length - 60);
  S.toolLog.set(d.taskId, log);
}
const ENTRY_TH = { queued: "รอคิว", assigned: "รับงานแล้ว", running: "กำลังทำ", review: "รอตรวจ", done: "เสร็จ", failed: "ล้มเหลว", cancelled: "ยกเลิก" };
let screenRenderedAt = 0, screenTimer = 0;
function openScreen(agentId) { if (!agentId || !S.agents.has(agentId)) return; S.screen = agentId; S.screenStick = true; renderScreen(true); }
function closeScreen() { S.screen = null; $("#screen").classList.add("hidden"); $("#screen").innerHTML = ""; }
/** งานของคนนี้เรียงใหม่→เก่า (งานปัจจุบันก่อน) */
function tasksOf(agentId) {
  const a = S.agents.get(agentId);
  const mine = [...S.tasks.values()].filter((t) => t.assignedTo === agentId || t.history?.some((h) => h.agentId === agentId)).sort((x, y) => (y.startedAt || y.createdAt) - (x.startedAt || x.createdAt));
  const cur = a?.currentTaskId ? S.tasks.get(a.currentTaskId) : null;
  return cur ? [cur, ...mine.filter((t) => t.id !== cur.id)] : mine;
}
function renderScreen(force = false) {
  if (!S.screen) return;
  const wait = 100 - (performance.now() - screenRenderedAt); // ≤10 ครั้ง/วินาที แม้ stream จะถี่
  if (!force && wait > 0) { if (!screenTimer) screenTimer = setTimeout(() => { screenTimer = 0; mark("screen"); }, wait); return; }
  screenRenderedAt = performance.now();
  const box = $("#screen"), a = S.agents.get(S.screen);
  if (!a) return closeScreen();
  const list = tasksOf(a.id), t = list[0] || null;
  const isCap = a.role === "captain";
  // กัปตันไม่มีงานย่อย: งานของกัปตันคือโจทย์ (วางแผน/รวบรวมผล) — ใช้ป้ายและเฟสจริงจาก agent.updated และผลสรุปจริงของโจทย์ล่าสุด (job.result)
  const jobs = isCap ? [...S.jobs.values()].sort((x, y) => y.createdAt - x.createdAt) : [];
  const capJob = isCap ? jobs.find((j) => ["planning", "synthesizing"].includes(j.status)) || jobs.find((j) => j.status === "done" && j.result) || jobs[0] || null : null;
  const working = isCap ? a.status === "working" : a.status === "working" && t && t.assignedTo === a.id && ["assigned", "running"].includes(t.status);
  const live = working ? S.live.get(a.id) || "" : "";
  const body = isCap
    ? (working ? `${a.currentTaskTitle || ""}\n${a.phase || ""}` : capJob?.result || a.lastOutput || "—")
    : working ? live || "กำลังเริ่ม…" : t ? t.output || S.live.get(a.id) || a.lastOutput || "—" : a.lastOutput || "—";
  const tools = t ? S.toolLog.get(t.id) || [] : [];
  const termEl = box.querySelector(".scr-term");
  const stick = termEl ? termEl.scrollTop + termEl.clientHeight >= termEl.scrollHeight - 8 : true;
  const built = box.dataset.agent === a.id;
  if (!built) {
    box.dataset.agent = a.id;
    box.innerHTML = `<div class="modal screen" role="document">
      <div class="m-head"><div class="avatar" style="border-color:${a.color}">${avatarHtml(a, 26)}</div>
        <div><h2>${esc(a.name)} <span class="r-sub">${esc(a.roleLabel)}</span></h2><div class="r-line2" id="scrStatus"></div></div>
        <button class="close" data-close-screen title="ปิด (Esc)">×</button></div>
      <div class="m-body" style="display:grid;gap:14px">
        <div class="section scr-task"><h3>งาน</h3><div id="scrTask"></div></div>
        <div class="section"><h3 id="scrTermTitle">ข้อความที่สตรีมออกมา (สด)</h3><div class="scr-term"><pre id="scrTerm"></pre></div></div>
        <div class="section"><h3>การใช้เครื่องมือตามลำดับ</h3><ol class="tool-log" id="scrTools"></ol></div>
        <div class="section"><h3>ผลตรวจ QA</h3><div id="scrReview"></div></div>
        <div class="section"><h3>งานย้อนหลังของคนนี้</h3><ul class="scr-hist" id="scrHist"></ul></div>
      </div></div>`;
    box.classList.remove("hidden");
  }
  $("#scrStatus").textContent = `${STATUS_TH[a.status]} · ${esc(a.model)}${a.metrics ? ` · เสร็จแล้ว ${a.metrics.tasksDone} งาน · ใช้เครื่องมือ ${a.metrics.toolCalls || 0} ครั้ง` : ""}`;
  $("#scrTask").innerHTML = isCap
    ? (working
      ? `<div><b>งานปัจจุบัน:</b> ${esc(a.currentTaskTitle || "โจทย์ของทีม")} <span class="chip running">${STATUS_TH[a.status]}</span></div><div class="r-line2">เฟส: ${esc(a.phase || "—")}</div>`
      : capJob
        ? `<div><b>โจทย์ล่าสุด:</b> ${esc(capJob.goal)} <span class="chip ${esc(capJob.status)}">${esc(capJob.status)}</span></div><div class="r-line2">${capJob.taskIds?.length || 0} งานย่อย · ${fmtMs(capJob.durationMs)} · ${fmtUsd(capJob.costUsd)}</div>`
        : `<div style="color:var(--muted)">ยังไม่มีโจทย์</div>`)
    : t
    ? `<div><b>${working ? "งานปัจจุบัน" : "งานล่าสุด"}:</b> ${esc(t.title)}${t.attempts > 1 ? ` <span class="chip">รอบที่ ${t.attempts}</span>` : ""} <span class="chip ${esc(t.status)}">${ENTRY_TH[t.status] || esc(t.status)}</span></div>
       <div class="r-line2">เฟส: ${esc(t.phase || "—")} · ${pct(t.progress)}${t.activeTool ? ` · <span class="tool-chip">${toolChip(t.activeTool)}</span>` : ""}${t.toolCalls ? ` · ใช้เครื่องมือ ${t.toolCalls} ครั้ง` : ""}</div>
       <div class="bar"><i style="width:${Math.round((t.progress || 0) * 100)}%;background:${a.color}"></i></div>`
    : `<div style="color:var(--muted)">${working ? "กำลังเริ่มงาน…" : "ยังไม่มีงาน"}</div>`;
  $("#scrTermTitle").textContent = isCap ? (working ? "สิ่งที่กัปตันกำลังทำ (สด)" : "ผลสรุปของโจทย์ล่าสุด") : working ? "ข้อความที่สตรีมออกมา (สด)" : "ผลงาน";
  const pre = $("#scrTerm"); if (pre.textContent !== body) pre.textContent = body; pre.classList.toggle("live", !!working);
  if (stick) { const w = $("#screen .scr-term"); w.scrollTop = w.scrollHeight; }
  $("#scrTools").innerHTML = tools.length
    ? tools.map((x) => `<li><div>${fmtTime(x.t)} ${toolChip(x.tool)}${x.ok === false ? " · ไม่สำเร็จ" : ""}</div>${x.input ? `<code>${esc(x.input)}</code>` : ""}${x.result ? `<div class="res">→ ${esc(x.result)}</div>` : ""}</li>`).join("")
    : `<li style="color:var(--muted)">${t ? "ยังไม่ได้ใช้เครื่องมือในงานนี้" : "—"}</li>`;
  $("#scrReview").innerHTML = t?.review
    ? `<div class="review-box"><div class="score" style="color:${t.review.approved ? "var(--ok)" : "var(--warn)"}">${t.review.score}/100 ${t.review.approved ? "ผ่าน" : t.review.acceptedWithNotes ? "รับพร้อมหมายเหตุ" : "ส่งกลับแก้"}</div>
        <div style="margin-top:4px">${esc(t.review.summary || "")}</div>${t.review.feedback ? `<pre class="stream" style="margin-top:8px">${esc(t.review.feedback)}</pre>` : ""}</div>`
    : `<div style="color:var(--muted)">${working ? "รอ QA ตรวจเมื่อเสร็จ" : "—"}</div>`;
  $("#scrHist").innerHTML = isCap
    ? (jobs.length ? jobs.slice(0, 6).map((j) => `<li>${fmtTime(j.finishedAt || j.createdAt)} · ${esc(trunc(j.goal, 48))} · ${esc(j.status)}${j.costUsd ? ` · ${fmtUsd(j.costUsd)}` : ""}</li>`).join("") : `<li>—</li>`)
    : list.length > 1
    ? list.slice(1, 7).map((x) => `<li>${fmtTime(x.finishedAt || x.startedAt || x.createdAt)} · ${esc(x.title)}${x.attempts > 1 ? ` (รอบ ${x.attempts})` : ""} · ${ENTRY_TH[x.status] || esc(x.status)}${x.review ? ` · QA ${x.review.score}` : ""}</li>`).join("")
    : `<li>—</li>`;
}

// ---------------------------------------------------------------------------
// ฉากเมืองมอร็อค (scene.js) — ตัวละครสไปรต์พิกเซลอาร์ต + แอนิเมชันเหตุการณ์
// ---------------------------------------------------------------------------
const canvas = $("#floor");
let scene = null;
const sc = () => scene || { spawnPacket() {}, emote() {}, fx() {}, burst() {}, layout() {}, setHover() {}, visit() {}, goHome() {}, spriteDataUrl: () => null, jobOf: () => null };
const avatarCache = new Map(); // jobId -> data URL
async function initScene() {
  try {
    const mod = await import("./scene.js");
    scene = mod.createScene(canvas, S, {
      onClick: (id) => (id ? openDrawer("agent", id) : closeDrawer()),
      onHover: (id) => highlightRoster(id),
      onSpriteLoaded: (jobId) => { avatarCache.delete(jobId); mark("roster", "strip", "metrics", "drawer"); },
    });
    window.__scene = scene; // สำหรับดีบักจาก console (เช่น __scene.visit("res-1", "captain"))
    scene.ready.then(() => { avatarCache.clear(); scene.layout(); mark("roster", "metrics", "drawer", "tasks", "strip"); });
    if (S.agents.size) scene.layout();
  } catch (err) {
    console.error("โหลดฉากไม่สำเร็จ", err);
    toast(`โหลดฉากไม่สำเร็จ: ${err.message}`, "bad");
  }
}
const spawnPacket = (...a) => sc().spawnPacket(...a);
const burst = (id) => sc().burst(id);
const layout = () => sc().layout();
function frame() { if (dirty.size) flush(); requestAnimationFrame(frame); }

// ---------------------------------------------------------------------------
// ฉากออฟฟิศ 3 มิติ (public/office3d/ ใน iframe) — สลับกับฉากมอร็อค 2 มิติด้วยปุ่มมุมขวาบนของเวที
// iframe ต่อ /api/events ของตัวเอง จึงไม่ต้องส่งสถานะเข้าไป; คุยกันด้วย postMessage (ดู docs/09-office3d.md §4):
//   แม่ → ลูก {type:"office3d", cmd, args}   ลูก → แม่ {type:"office3d:ready"|"office3d:select", data}
// ---------------------------------------------------------------------------
const VIEW_KEY = "grock.view";
const office = {
  frame: $("#office3d"),
  ready: false,
  src: "office3d/index.html?embed=1&theme=dark", // embed=1 ซ่อนนาฬิกา/การ์ดข้อมูลของหน้าเดี่ยว (แดชบอร์ดแสดงเองใน drawer)
  send(cmd, ...args) { if (this.ready && this.frame?.contentWindow) this.frame.contentWindow.postMessage({ type: "office3d", cmd, args }, location.origin); },
};
function setView(view, { save = true } = {}) {
  view = view === "3d" ? "3d" : "2d";
  S.view = view;
  $("#stage").classList.toggle("view-3d", view === "3d");
  document.querySelectorAll("#viewSwitch button").forEach((b) => { const on = b.dataset.view === view; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  if (view === "3d" && office.frame && !office.frame.getAttribute("src")) office.frame.src = office.src; // โหลดฉาก 3 มิติ (โมเดล ~40 MB) เฉพาะเมื่อเลือกครั้งแรก
  office.send("pause", view !== "3d"); // ซ่อนอยู่ = หยุดแอนิเมชันประหยัด GPU (เหตุการณ์ยังเข้าทาง SSE ของ iframe และเล่นต่อเมื่อสลับกลับ)
  if (save) try { localStorage.setItem(VIEW_KEY, view); } catch {}
}
function initView() {
  let v = "3d"; // ค่าเริ่มต้น = ออฟฟิศ 3 มิติ (เบราว์เซอร์ที่เคยเลือก 2D ไว้จะได้ 2D ตามที่จำ)
  try { v = localStorage.getItem(VIEW_KEY) || "3d"; } catch {}
  setView(v, { save: false });
  $("#viewSwitch")?.addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
  $("#camReset")?.addEventListener("click", () => office.send("resetView")); // กลับมุมกล้องเริ่มต้นของฉาก 3 มิติ
  window.addEventListener("message", (e) => {
    if (!office.frame || e.source !== office.frame.contentWindow || e.origin !== location.origin) return; // รับเฉพาะจาก iframe ของเราเอง
    const d = e.data || {};
    if (d.type === "office3d:ready") { office.ready = true; office.send("pause", S.view !== "3d"); return; }
    if (d.type === "office3d:screen") { if (d.data?.agentId) openScreen(d.data.agentId); return; } // แตะจอคอมของคนนั้น
    if (d.type === "office3d:select") { // ผู้ใช้แตะตัวละคร (หรือพื้นว่าง = null) ในฉาก 3 มิติ
      const id = d.data?.agentId || null;
      S.sceneSel = id;
      if (id) { if (S.agents.has(id)) openDrawer("agent", id); } else closeDrawer();
    }
  });
}

const ZONE_LABEL = { plaza: "ลานกลางเมือง", gate: "ประตูเมือง", tower: "หอเวทมนตร์", library: "ห้องสมุด", forge: "โรงตีเหล็ก", temple: "วิหาร" };
const JOB_BY_ROLE = { captain: "lord-knight", marketer: "sniper", researcher: "stalker", engineer: "high-wizard", finance: "professor", coder: "whitesmith", reviewer: "high-priest" };
const jobIdOf = (a) => a.jobId || sc().jobOf(a) || JOB_BY_ROLE[a.role] || "_base";
/** รูปตัวละคร (data URL จากสไปรต์) ใช้ใน roster/การ์ด/drawer — fallback อีโมจิ */
function avatarHtml(a, h = 36) {
  const jobId = jobIdOf(a);
  let url = avatarCache.get(jobId);
  if (!url && scene) { url = scene.spriteDataUrl(jobId, "idle", 0, 3); if (url && scene.hasSprite?.(jobId)) avatarCache.set(jobId, url); }
  return url ? `<img class="avatar-img" src="${url}" style="height:${h}px" alt="">` : `<span class="avatar-emoji">${a.emoji || "👤"}</span>`;
}

// ---------------------------------------------------------------------------
// Roster (แผงรายชื่อพนักงานซ้าย) + Task strip (การ์ดงานล่าสุดใต้แผนที่)
// ---------------------------------------------------------------------------
function highlightRoster(id) {
  document.querySelectorAll("#roster .roster-row").forEach((r) => r.classList.toggle("hl", r.dataset.agent === id));
}
function renderRoster() {
  const root = $("#roster"); if (!root) return;
  const agents = [...S.agents.values()].sort((a, b) => (a.role === "captain" ? -1 : b.role === "captain" ? 1 : a.id.localeCompare(b.id)));
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const todayMs = t0.getTime();
  root.innerHTML = `<div class="roster-head">ทีม AI <span class="count">(${agents.length})</span><span class="r-sub">${S.totals.workersBusy ?? 0} กำลังทำ · ${S.totals.queued ?? 0} รอคิว</span></div>` +
    agents.map((a) => {
      const task = a.currentTaskId ? S.tasks.get(a.currentTaskId) : null;
      const doneToday = [...S.tasks.values()].filter((t) => t.assignedTo === a.id && t.status === "done" && (t.finishedAt || 0) >= todayMs).length;
      const st = a.status === "working" ? `กำลังทำ ${pct(task?.progress)}` : a.status === "paused" ? "หยุดพัก" : "ว่าง";
      const zone = ZONE_LABEL[a.zone] || a.roleLabel;
      return `<div class="roster-row ${a.status}" data-agent="${a.id}">
        <div class="r-avatar">${avatarHtml(a, 40)}</div>
        <div class="r-body">
          <div class="r-line1"><b style="color:${a.color}">${esc(a.name)}</b><span class="chip ${a.status === "working" ? "running" : a.status === "paused" ? "review" : "idle"}">${st}</span></div>
          <div class="r-line2">${esc(a.roleLabel)}</div>
          <div class="r-line2">เสร็จวันนี้ ${doneToday} งาน${a.metrics?.toolCalls ? ` · 🔧 ${a.metrics.toolCalls}` : ""}${a.activeTool ? ` · <span class="tool-chip" data-toolchip>${toolChip(a.activeTool)}</span>` : ""}</div>
          ${task ? `<div class="r-task">${esc(trunc(task.title, 34))}</div><div class="bar"><i style="width:${Math.round((task.progress || 0) * 100)}%;background:${a.color}"></i></div><div class="r-phase phase">${esc(task.phase || "")}</div>` : ""}
        </div></div>`;
    }).join("");
}

const STEPS = ["สั่งงาน", "รับงาน", "กำลังทำ", "ตรวจ QA", "เสร็จ"];
function stripCard(t) {
  const who = t.assignedTo ? S.agents.get(t.assignedTo) : null;
  const ri = roleInfo(t.role);
  const types = new Set((t.history || []).map((h) => h.type));
  let reached = types.has("created") ? 1 : 0;
  if (types.has("assigned")) reached = 2;
  if (types.has("started")) reached = 3;
  if (t.review || (t.role === "reviewer" && t.status === "done")) reached = 4;
  if (t.status === "done") reached = 5;
  const bad = t.status === "failed" || t.status === "cancelled";
  return `<div class="scard task" data-task="${t.id}" style="border-top-color:${ri.color}">
    <div class="s-head">${who ? avatarHtml(who, 22) : `<span class="avatar-emoji">${ri.emoji}</span>`}<b>${esc(who?.name || (t.preferredAgentId ? `รอ ${agentName(t.preferredAgentId)}` : "รอมอบหมาย"))}</b><span class="s-meta">กัปตันมอบหมาย · ${fmtTime(t.assignedAt || t.createdAt)}</span></div>
    <div class="s-title" title="${esc(t.title)}">${esc(t.title)}</div>
    <div class="s-steps">${STEPS.map((s, i) => `<div class="s-step${i < reached ? " on" : ""}${i === reached - 1 && !bad && t.status !== "done" ? " now" : ""}${bad && i === reached - 1 ? " bad" : ""}"><i></i><span>${s}</span></div>`).join("")}</div>
    <div class="s-foot"><span class="chip ${t.status}">${STATUS_TH[t.status] || t.status}</span><span class="tool-chip${t.activeTool ? "" : " hidden"}" data-toolchip>${toolChip(t.activeTool)}</span><span class="s-pct">${pct(t.progress)}</span></div>
    <div class="bar"><i style="width:${Math.round((t.progress || 0) * 100)}%;background:${ri.color}"></i></div><span class="phase hidden"></span>
  </div>`;
}
function renderStrip() {
  const root = $("#strip"); if (!root) return;
  const tasks = [...S.tasks.values()].sort((a, b) => (b.startedAt || b.assignedAt || b.createdAt) - (a.startedAt || a.assignedAt || a.createdAt)).slice(0, 6);
  root.innerHTML = `<div class="scard new" id="stripNew"><div class="plus">+</div><div>สั่งงานใหม่</div></div>` + tasks.map(stripCard).join("");
}

// ---------------------------------------------------------------------------
// ตั้งค่า AI ต่อคน (โมเดล / ความลึกการคิด / เครื่องมือ)
// ---------------------------------------------------------------------------
const MODELS_FALLBACK = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"];
const EFFORTS = ["low", "medium", "high", "xhigh"];
function renderSettings() {
  const box = $("#settings"); if (!box) return;
  const models = S.allowedModels?.length ? S.allowedModels : MODELS_FALLBACK;
  const agents = [...S.agents.values()].sort((a, b) => (a.role === "captain" ? -1 : b.role === "captain" ? 1 : a.id.localeCompare(b.id)));
  box.innerHTML = `<div class="modal">
    <div class="m-head"><h2>⚙ ตั้งค่า AI ต่อคน</h2><span class="r-sub">มีผลกับงานถัดไป · บันทึกลง data/team.json · โหมด ${S.mode === "live" ? "LIVE" : "SIM (โมเดล/ความลึกจะใช้เมื่อเปิด LIVE, หน้าที่มีผลทั้งสองโหมด)"}</span><button class="close" data-close-settings title="ปิด">×</button></div>
    <div class="m-body"><table class="cfg"><thead><tr><th>พนักงาน</th><th>อาชีพ · ตำแหน่ง</th><th>โมเดล</th><th>ความลึก</th><th>เครื่องมือ</th><th>โทเคน · ต้นทุน</th><th></th></tr></thead><tbody>
    ${agents.map((a) => `<tr data-cfg="${a.id}">
      <td><div class="s-head">${avatarHtml(a, 26)}<b>${esc(a.name)}</b></div></td>
      <td class="r-line2">${esc(a.jobTh || "")} · ${esc(a.roleLabel)}</td>
      <td><select class="cfg-model">${models.map((m) => `<option value="${m}"${m === a.model ? " selected" : ""}>${m}</option>`).join("")}</select></td>
      <td><select class="cfg-effort">${EFFORTS.map((e) => `<option value="${e}"${e === (a.effort || "medium") ? " selected" : ""}>${e}</option>`).join("")}</select></td>
      <td><label class="sw"><input type="checkbox" class="cfg-tools"${a.toolsEnabled === false ? "" : " checked"}${(a.tools || []).length ? "" : " disabled"}> ${(a.tools || []).length ? a.tools.map((n) => toolUi(n).icon).join("") : "—"}</label></td>
      <td class="r-line2">${fmtK((a.metrics?.inputTokens || 0) + (a.metrics?.outputTokens || 0))} · ${fmtUsd(a.metrics?.costUsd)}</td>
      <td><button class="btn small primary cfg-save">บันทึก</button></td>
    </tr>
    <tr class="cfg-duty-row" data-cfg-duty="${a.id}"><td colspan="7">
      <label class="cfg-duty-label">หน้าที่ของ ${esc(a.name)} <span class="r-line2">(กัปตันใช้เลือกคนทำงาน และ AI เห็นหน้าที่นี้ใน prompt — ไม่เกิน 600 ตัวอักษร)</span></label>
      <textarea class="cfg-duties" rows="2" maxlength="600" placeholder="เช่น ค้นข้อมูลพื้นฐาน สถิติ และแหล่งอ้างอิง">${esc(a.duties || "")}</textarea>
    </td></tr>`).join("")}</tbody></table></div></div>`;
}
function openSettings() { renderSettings(); $("#settings").classList.remove("hidden"); }
function closeSettings() { $("#settings").classList.add("hidden"); }


// ---------------------------------------------------------------------------
// UI events
// ---------------------------------------------------------------------------
$("#jobForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#goalInput");
  const goal = input.value.trim();
  if (!goal) return toast("กรุณาพิมพ์โจทย์งานก่อน", "warn");
  input.value = "";
  const project = selectedProject();
  act(api("/api/jobs", { goal, project }), (r) => toast(project ? `📥 ส่งโจทย์ให้กัปตันแล้ว (โปรเจกต์ ${project}) — ผลงานจะอยู่ที่ ${r.job?.outputDir || ""}` : "📥 ส่งโจทย์ให้กัปตันแล้ว"));
});
$("#projectSelect")?.addEventListener("change", (e) => { try { localStorage.setItem("grock.project", e.target.value); } catch {} });
$("#demoBtn").addEventListener("click", () => act(api("/api/demo", { project: selectedProject() }), (r) => toast(`📥 มอบหมายงานตัวอย่าง: "${trunc(r.job.goal, 50)}"`)));
$("#modeBadge").addEventListener("click", () => act(api("/api/mode", { mode: S.mode === "live" ? "sim" : "live" }), () => {}));

let speedTimer;
$("#speedRange").addEventListener("input", (e) => {
  $("#speedVal").textContent = `${e.target.value}×`;
  clearTimeout(speedTimer);
  speedTimer = setTimeout(() => act(api("/api/settings", { speed: Number(e.target.value) }), () => {}), 150);
});

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (!b) return;
  S.tab = b.dataset.tab;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab-body").forEach((x) => x.classList.toggle("hidden", x.id !== `tab-${S.tab}`));
});

document.addEventListener("click", (e) => {
  const el = e.target;
  const jobHead = el.closest(".job-head");
  if (jobHead) { const id = jobHead.dataset.job; S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id); return renderTasks(); }
  const resHead = el.closest("[data-result]");
  if (resHead) { const id = resHead.dataset.result; S.expandedResults.has(id) ? S.expandedResults.delete(id) : S.expandedResults.add(id); return renderResults(); }
  if (el.dataset.copytext) { navigator.clipboard?.writeText(el.dataset.copytext).then(() => toast("คัดลอกพาธแล้ว", "ok")); return; }
  if (el.dataset.copy) { const j = S.jobs.get(el.dataset.copy); navigator.clipboard?.writeText(j?.result || "").then(() => toast("คัดลอกผลลัพธ์แล้ว", "ok")); return; }
  const rosterRow = el.closest(".roster-row");
  if (rosterRow) return focusAgent(rosterRow.dataset.agent);
  if (el.closest("#stripNew")) { $("#goalInput").focus(); return; }
  if (el.closest("#settingsBtn")) return openSettings();
  if (el.closest("[data-close-settings]") || el.id === "settings") return closeSettings();
  const scrBtn = el.closest("[data-screen]");
  if (scrBtn) return openScreen(scrBtn.dataset.screen);
  if (el.closest("[data-close-screen]") || el.id === "screen") return closeScreen();
  if (el.classList.contains("cfg-save")) {
    const row = el.closest("[data-cfg]");
    const body = { model: row.querySelector(".cfg-model").value, effort: row.querySelector(".cfg-effort").value };
    const dutyBox = $(`#settings [data-cfg-duty="${row.dataset.cfg}"] .cfg-duties`);
    if (dutyBox) {
      const duties = dutyBox.value.trim();
      if (!duties) return toast("กรุณาระบุหน้าที่ก่อนบันทึก", "warn");
      body.duties = duties;
    }
    const tools = row.querySelector(".cfg-tools");
    if (tools && !tools.disabled) body.toolsEnabled = tools.checked;
    return act(api(`/api/agents/${row.dataset.cfg}/config`, body), (r) => toast(`บันทึกการตั้งค่า ${r.agent.name} แล้ว`, "ok"));
  }
  const agentCard = el.closest(".agent-card");
  if (agentCard) return focusAgent(agentCard.dataset.agent);
  if (el.closest(".close")) return closeDrawer();
  if (el.dataset.pause) return act(api(`/api/agents/${el.dataset.pause}/pause`), () => {});
  if (el.dataset.resume) return act(api(`/api/agents/${el.dataset.resume}/resume`), () => {});
  if (el.dataset.cancel) return act(api(`/api/tasks/${el.dataset.cancel}/cancel`), () => toast("ยกเลิกงานแล้ว", "warn"));
  if (el.dataset.retry) return act(api(`/api/tasks/${el.dataset.retry}/retry`), () => toast("สั่งทำใหม่แล้ว"));
  if (el.dataset.apply || el.dataset.rejectpatch) { // ด่านอนุมัติ patch ของ Developer (ผลลัพธ์มาทาง event task.patch)
    const id = el.dataset.apply || el.dataset.rejectpatch;
    const note = el.closest("[data-patch]")?.querySelector(".note")?.value.trim() || "";
    el.disabled = true;
    const p = el.dataset.apply ? api(`/api/tasks/${id}/apply`, { note }) : api(`/api/tasks/${id}/reject`, { reason: note });
    return act(p.finally(() => { el.disabled = false; }), () => {});
  }
  if (el.classList.contains("go")) {
    const box = el.closest("[data-handoff]");
    const agentId = box.querySelector(".to").value;
    const reason = box.querySelector(".reason").value.trim();
    return act(api(`/api/tasks/${box.dataset.handoff}/handoff`, { agentId, reason }), () => {});
  }
  const taskEl = el.closest(".task[data-task]");
  if (taskEl && !el.closest(".controls")) return openDrawer("task", taskEl.dataset.task);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (S.screen) return closeScreen(); closeDrawer(); closeSettings(); } });
$("#roster").addEventListener("mouseover", (e) => { const r = e.target.closest(".roster-row"); if (r) sc().setHover(r.dataset.agent); });
$("#roster").addEventListener("mouseleave", () => sc().setHover(null));

initScene();
initView();
connect();
requestAnimationFrame(frame);
