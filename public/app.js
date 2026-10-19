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
};
const toolUi = (name) => (name ? TOOL_UI[name] || { icon: "🔧", label: name } : null);
const toolChip = (name) => { const t = toolUi(name); return t ? `${t.icon} ${esc(t.label)}` : ""; };

// ---------------------------------------------------------------------------
// สถานะฝั่ง client
// ---------------------------------------------------------------------------
const S = {
  mode: "sim",
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
      S.mode = d.mode; S.settings = d.settings; S.totals = d.totals;
      S.agents = new Map(d.agents.map((a) => [a.id, a]));
      S.tasks = new Map(d.tasks.map((t) => [t.id, t]));
      S.jobs = new Map(d.jobs.map((j) => [j.id, j]));
      S.allowedModels = d.allowedModels || [];
      layout();
      mark("kpis", "tasks", "metrics", "results", "drawer", "mode", "roster", "strip");
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
      mark("metrics", "drawer", "roster");
      break;
    case "task.created": case "task.started": case "task.updated":
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip", "roster");
      break;
    case "task.review": {
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip");
      const who = d.task.assignedTo || lastAgentOf(d.task);
      if (who) sc().fx(who, d.approved ? "bless" : "fail");
      break;
    }
    case "task.failed": {
      upsertTask(d.task); mark("tasks", "kpis", "drawer", "strip", "roster");
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
    case "task.completed":
      upsertTask(d.task);
      spawnPacket(d.from, "captain", "ส่งผลงาน ✓", S.agents.get(d.from)?.color || "#3dd598", "return");
      sc().visit(d.from, "captain"); // เดินไปส่งผลงานให้กัปตัน แล้วกลับจุดประจำ
      sc().emote(d.from, "heart");
      mark("tasks", "kpis", "drawer", "strip", "roster");
      break;
    case "task.progress": {
      const t = S.tasks.get(d.taskId);
      if (t) { t.progress = d.progress; t.phase = d.phase; if ("tool" in d) t.activeTool = d.tool; if (d.toolCalls != null) t.toolCalls = d.toolCalls; }
      const a = S.agents.get(d.agentId);
      if (a) { a.phase = d.phase; if ("tool" in d) a.activeTool = d.tool; if (d.agentToolCalls != null && a.metrics) a.metrics.toolCalls = d.agentToolCalls; }
      S.live.set(d.agentId, d.text || "");
      liveUpdate(d);
      break;
    }
    case "job.created": case "job.planned": case "job.updated":
      upsertJob(d.job); mark("tasks", "results", "kpis", "strip");
      break;
    case "job.completed":
      upsertJob(d.job); burst("captain");
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
  }
}

// ---------------------------------------------------------------------------
// Render loop (รวมการวาด DOM ที่ค้างไว้ไปทำครั้งเดียวต่อเฟรม)
// ---------------------------------------------------------------------------
function flush() {
  if (dirty.has("mode")) renderMode();
  if (dirty.has("kpis")) renderKpis();
  if (dirty.has("tasks")) renderTasks();
  if (dirty.has("metrics")) renderMetrics();
  if (dirty.has("log")) renderLog();
  if (dirty.has("results")) renderResults();
  if (dirty.has("drawer")) renderDrawer();
  if (dirty.has("roster")) renderRoster();
  if (dirty.has("strip")) renderStrip();
  dirty.clear();
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
  $("#cntTasks").textContent = S.tasks.size ? `(${S.tasks.size})` : "";
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
  ].filter(Boolean);
  return `<div class="task" data-task="${t.id}" style="border-left-color:${ri.color}">
    <div class="row"><span class="title" title="${esc(t.title)}">${esc(t.title)}</span><span class="chip ${t.status}">${STATUS_TH[t.status] || t.status}</span></div>
    ${compact ? "" : `<div class="sub">${sub.map(esc).join(" · ")}</div>`}
    ${active ? `<div class="bar"><i style="width:${Math.round((t.progress || 0) * 100)}%;background:${ri.color}"></i></div><div class="sub"><span class="tool-chip${t.activeTool ? "" : " hidden"}" data-toolchip>${toolChip(t.activeTool)}</span><span class="phase">${esc(t.phase || "")}</span></div>` : ""}
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
          <div class="meta">${done}/${tasks.length} งาน · ${dur} · ${fmtUsd(j.costUsd || tasks.reduce((s, t) => s + (t.usage?.costUsd || 0), 0))}</div></div>
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
          <div class="stat"><div class="v">${fmtK(m.inputTokens)}</div><div class="l">โทเคนเข้า</div></div>
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
        ${S.expandedResults.has(j.id) ? `<pre>${esc(j.result || "(ไม่มีผลลัพธ์)")}</pre>` : ""}
      </div>`).join("")
    : `<div class="empty">ยังไม่มีผลงานที่เสร็จ</div>`;
}

// ---------------------------------------------------------------------------
// Drawer (รายละเอียด + ควบคุม)
// ---------------------------------------------------------------------------
function openDrawer(type, id) { S.selected = { type, id }; renderDrawer(); }
function closeDrawer() { S.selected = null; $("#drawer").classList.add("hidden"); }

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
  const keep = { to: $("#drawer .controls .to")?.value, reason: $("#drawer .controls .reason")?.value };
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
  act(api("/api/jobs", { goal }), () => toast("📥 ส่งโจทย์ให้กัปตันแล้ว"));
});
$("#demoBtn").addEventListener("click", () => act(api("/api/demo"), (r) => toast(`📥 มอบหมายงานตัวอย่าง: "${trunc(r.job.goal, 50)}"`)));
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
  if (el.dataset.copy) { const j = S.jobs.get(el.dataset.copy); navigator.clipboard?.writeText(j?.result || "").then(() => toast("คัดลอกผลลัพธ์แล้ว", "ok")); return; }
  const rosterRow = el.closest(".roster-row");
  if (rosterRow) return openDrawer("agent", rosterRow.dataset.agent);
  if (el.closest("#stripNew")) { $("#goalInput").focus(); return; }
  if (el.closest("#settingsBtn")) return openSettings();
  if (el.closest("[data-close-settings]") || el.id === "settings") return closeSettings();
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
  if (agentCard) return openDrawer("agent", agentCard.dataset.agent);
  if (el.closest(".close")) return closeDrawer();
  if (el.dataset.pause) return act(api(`/api/agents/${el.dataset.pause}/pause`), () => {});
  if (el.dataset.resume) return act(api(`/api/agents/${el.dataset.resume}/resume`), () => {});
  if (el.dataset.cancel) return act(api(`/api/tasks/${el.dataset.cancel}/cancel`), () => toast("ยกเลิกงานแล้ว", "warn"));
  if (el.dataset.retry) return act(api(`/api/tasks/${el.dataset.retry}/retry`), () => toast("สั่งทำใหม่แล้ว"));
  if (el.classList.contains("go")) {
    const box = el.closest("[data-handoff]");
    const agentId = box.querySelector(".to").value;
    const reason = box.querySelector(".reason").value.trim();
    return act(api(`/api/tasks/${box.dataset.handoff}/handoff`, { agentId, reason }), () => {});
  }
  const taskEl = el.closest(".task[data-task]");
  if (taskEl && !el.closest(".controls")) return openDrawer("task", taskEl.dataset.task);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeDrawer(); closeSettings(); } });
$("#roster").addEventListener("mouseover", (e) => { const r = e.target.closest(".roster-row"); if (r) sc().setHover(r.dataset.agent); });
$("#roster").addEventListener("mouseleave", () => sc().setHover(null));

initScene();
connect();
requestAnimationFrame(frame);
