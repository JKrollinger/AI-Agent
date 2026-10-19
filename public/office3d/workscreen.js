// workscreen.js — "หน้าจอการทำงานจริง" popup for the standalone office3d page.
// Opens when the user taps a desk monitor or a character (Office3D 'screen' / 'select' events) and shows that person's
// real work from the bridge store: current task (title, attempt, phase, progress), the streamed text as a terminal
// (auto-scroll, paused while the user scrolls up), the tool uses in order, the QA verdict, the final output and a short history.
// When the page is embedded in the dashboard (?embed=1) this file does nothing: app.js opens the same popup in the dashboard.
(function () {
  const O = window.Office3D, B = window.Office3DBridge;
  if (!O || !B || B.embed) return;
  const $ = (s) => document.querySelector(s);
  const root = $("#screen"); if (!root) return;
  const el = {
    name: $("#s-name"), role: $("#s-role"), status: $("#s-status"), task: $("#s-task"), term: $("#s-term"),
    tools: $("#s-tools"), review: $("#s-review"), hist: $("#s-hist"), close: $("#s-close"), termWrap: $("#s-termwrap"),
  };
  const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString("th-TH", { hour12: false }) : "");
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  const STATUS_TH = { working: "กำลังทำงาน", idle: "ว่าง", paused: "หยุดชั่วคราว" };
  const ENTRY_TH = { running: "กำลังทำ", done: "เสร็จ", failed: "ล้มเหลว", cancelled: "ยกเลิก", handoff: "ส่งต่อ" };
  let current = null, stick = true, lastRender = 0, pending = 0;

  function text(node, s) { node.textContent = s == null ? "" : String(s); }
  function row(cls, label, value) { const d = document.createElement("div"); d.className = cls; const b = document.createElement("b"); b.textContent = label; d.append(b, document.createTextNode(" " + value)); return d; }

  function render() {
    if (!current) return;
    lastRender = performance.now();
    const a = B.agent(current), list = B.entries(current), e = list[0] || null;
    const working = a?.status === "working";
    text(el.name, a?.name || current); text(el.role, a?.roleLabel || "");
    text(el.status, STATUS_TH[a?.status] || a?.status || ""); el.status.dataset.state = a?.status || "idle";
    // current / last task
    el.task.replaceChildren();
    if (e && e.taskId) {
      el.task.append(row("t-title", working ? "งานปัจจุบัน:" : "งานล่าสุด:", e.title + (e.attempts > 1 ? ` (รอบที่ ${e.attempts})` : "")));
      el.task.append(row("t-meta", "เฟส:", `${e.phase || "—"}${e.progress == null ? "" : " · " + pct(e.progress)}${e.toolCalls ? ` · ใช้เครื่องมือ ${e.toolCalls} ครั้ง` : ""}${e.status !== "running" ? ` · ${ENTRY_TH[e.status] || e.status}` : ""}`));
      if (e.progress != null) { const bar = document.createElement("div"); bar.className = "t-bar"; const fill = document.createElement("i"); fill.style.width = pct(e.progress); bar.append(fill); el.task.append(bar); }
      if (e.error) el.task.append(row("t-err", "ข้อผิดพลาด:", e.error));
    } else text(el.task, working ? "กำลังเริ่มงาน…" : "ยังไม่มีงาน");
    // terminal: the live stream while running, the final output afterwards
    const body = e ? (e.status === "running" ? e.text : e.output || e.text) : "";
    const wrap = el.termWrap;
    const wasStick = stick;
    if (el.term.textContent !== (body || "")) text(el.term, body || (working ? "กำลังเริ่ม…" : "—"));
    el.term.classList.toggle("live", !!(e && e.status === "running"));
    if (wasStick) wrap.scrollTop = wrap.scrollHeight;
    // tools in order
    el.tools.replaceChildren();
    if (e && e.tools.length) for (const t of e.tools) {
      const li = document.createElement("li"); const u = B.toolUi(t.tool);
      const head = document.createElement("div"); head.className = "tl-head"; head.textContent = `${fmtTime(t.t)} ${u.icon} ${u.label}${t.ok === false ? " · ไม่สำเร็จ" : ""}`;
      li.append(head);
      if (t.input) { const i = document.createElement("code"); i.textContent = t.input; li.append(i); }
      if (t.result) { const r = document.createElement("div"); r.className = "tl-res"; r.textContent = "→ " + t.result; li.append(r); }
      el.tools.append(li);
    } else { const li = document.createElement("li"); li.className = "muted"; li.textContent = "ยังไม่ได้ใช้เครื่องมือในงานนี้"; el.tools.append(li); }
    // QA
    el.review.replaceChildren();
    if (e && e.review) {
      const r = e.review, ok = r.approved;
      el.review.append(row(ok ? "qa ok" : "qa warn", `${r.score}/100`, ok ? "ผ่าน" : r.acceptedWithNotes ? "รับพร้อมหมายเหตุ" : "ส่งกลับแก้"));
      if (r.summary) { const s = document.createElement("div"); s.textContent = r.summary; el.review.append(s); }
      if (r.feedback) { const f = document.createElement("pre"); f.className = "fb"; f.textContent = r.feedback; el.review.append(f); }
    } else text(el.review, e && e.status === "running" ? "รอ QA ตรวจเมื่อเสร็จ" : "—");
    // history (this person's previous attempts)
    el.hist.replaceChildren();
    for (const h of list.slice(1)) { const li = document.createElement("li"); const when = fmtTime(h.finishedAt || h.startedAt); li.textContent = `${when ? when + " · " : ""}${h.title}${h.attempts > 1 ? ` (รอบ ${h.attempts})` : ""} · ${ENTRY_TH[h.status] || h.status}${h.review ? ` · QA ${h.review.score}` : ""}`; el.hist.append(li); }
    if (list.length <= 1) { const li = document.createElement("li"); li.className = "muted"; li.textContent = "—"; el.hist.append(li); }
  }
  function scheduleRender() { // ≤10 renders per second even if the stream is chatty
    if (!current || root.hidden) return;
    const wait = 100 - (performance.now() - lastRender);
    if (wait <= 0) { clearTimeout(pending); pending = 0; render(); }
    else if (!pending) pending = setTimeout(() => { pending = 0; render(); }, wait);
  }
  function open(agentId) {
    if (!agentId) return;
    current = agentId; stick = true; root.hidden = false;
    const info = document.getElementById("info"); if (info) info.hidden = true; // the popup supersedes the small info card
    render(); el.termWrap.scrollTop = el.termWrap.scrollHeight;
  }
  function close() { root.hidden = true; current = null; }

  el.termWrap.addEventListener("scroll", () => { stick = el.termWrap.scrollTop + el.termWrap.clientHeight >= el.termWrap.scrollHeight - 8; });
  el.close.addEventListener("click", close);
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !root.hidden) close(); });
  B.on((ids) => { if (current && ids.includes(current)) scheduleRender(); });
  O.on("screen", (d) => d && open(d.agentId));
  O.on("select", (d) => d && open(d.agentId));
  window.OfficeWorkScreen = { open, close };
})();
