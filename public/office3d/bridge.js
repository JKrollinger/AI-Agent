// bridge.js — connects the 3D office to the Grock Agent server.
// Listens to the same SSE stream as the dashboard (/api/events) and turns every event into Office3D calls.
// Rule: every walk, pose, bubble and screen below comes from a real server event or the real agent/task status —
// nothing is invented client-side. The full table "event → movement" is in docs/09-office3d.md §2.
// Also keeps a small per-person work history (text stream, tool uses, QA) that feeds the desk monitors and the
// work-screen popup (workscreen.js standalone / app.js when embedded in the dashboard).
// Open with ?demo=1 to skip the server, or ?events=<url> to use another stream.
(function () {
  const O = window.Office3D, CFG = window.OFFICE3D_CONFIG || {}, RX = CFG.reactions || {};
  if (!O) return console.error("office3d.js must load before bridge.js");
  const qs = new URLSearchParams(location.search);
  const EMBED = document.documentElement.dataset.embed === "1";

  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
  const lastAgentOf = (t) => t.assignedTo || [...(t.history || [])].reverse().find((h) => h.agentId)?.agentId || null;
  const TOOL_UI = Object.assign({
    web_search: { icon: "🔎", label: "ค้นเว็บ" }, web_fetch: { icon: "🌐", label: "อ่านหน้าเว็บ" },
    code_execution: { icon: "⚙️", label: "รันโค้ด" }, bash_code_execution: { icon: "⚙️", label: "รันโค้ด" },
    text_editor_code_execution: { icon: "📝", label: "แก้ไฟล์" }, claude_code: { icon: "🛠️", label: "Claude Code" },
  }, CFG.toolUi || {});
  const toolUi = (n) => (n ? TOOL_UI[n] || { icon: "🔧", label: n } : null);

  // ---------- store: what the monitors and the work-screen popup read ----------
  const KEEP = 6, TEXT_MAX = 8000, TOOLS_MAX = 60;
  const store = {
    mode: "sim", speed: 1, connected: false,
    agents: new Map(), // agentId -> agent view from the server
    tasks: new Map(),  // taskId -> task
    jobs: new Map(),   // jobId -> job
    work: new Map(),   // agentId -> [entry, …] newest first; entry = one attempt of one task by this person
    trace: [],         // last events and what the scene did about them (debug / test evidence) — see Office3DBridge.trace
  };
  const listeners = new Set();
  const dirtyAgents = new Set();
  let flushTimer = 0;
  function touch(agentId) { // throttle UI updates (monitors + popup) to ≤10/s per batch
    if (agentId) dirtyAgents.add(agentId);
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = 0;
      const ids = [...dirtyAgents]; dirtyAgents.clear();
      if (RX.screens !== false) ids.forEach(drawScreen);
      listeners.forEach((fn) => { try { fn(ids); } catch (e) { console.error(e); } });
    }, 100);
  }
  function entries(agentId) { let l = store.work.get(agentId); if (!l) { l = []; store.work.set(agentId, l); } return l; }
  /** the running entry of this task for this person (created on task.started / task.assigned) */
  function entryOf(agentId, taskId, create = false) {
    const l = entries(agentId);
    let e = l.find((x) => x.taskId === taskId && x.status === "running");
    if (!e && create) {
      const t = store.tasks.get(taskId) || {};
      e = { taskId, title: t.title || "", attempts: t.attempts || 1, phase: t.phase || "", progress: t.progress || 0, status: "running",
        text: "", tools: [], review: null, output: "", error: "", startedAt: Date.now(), finishedAt: null, from: null };
      l.unshift(e); if (l.length > KEEP) l.length = KEEP;
    }
    return e || null;
  }
  function closeEntry(agentId, taskId, status, extra = {}) {
    const e = entryOf(agentId, taskId); if (!e) return null;
    Object.assign(e, extra, { status, finishedAt: Date.now() }); touch(agentId); return e;
  }
  function trace(type, actions) { store.trace.push({ ts: Date.now(), type, actions }); if (store.trace.length > 300) store.trace.shift(); }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString("th-TH", { hour12: false });
  /** the captain's own work (planning / synthesizing a job) is not a task: keep an entry from the real label + phases the server sends */
  function captainLog(a) {
    const l = entries(a.id);
    let e = l.find((x) => x.status === "running");
    if (a.status === "working") {
      if (!e) {
        e = { taskId: "captain:" + Date.now(), title: a.currentTaskTitle || "งานของกัปตัน", attempts: 1, phase: a.phase || "", progress: null, status: "running",
          text: "", tools: [], review: null, output: "", error: "", startedAt: Date.now(), finishedAt: null, from: null, captain: true };
        l.unshift(e); if (l.length > KEEP) l.length = KEEP;
      }
      if (a.currentTaskTitle && e.title !== a.currentTaskTitle) e.title = a.currentTaskTitle;
      if (a.phase && a.phase !== e.phase) { e.phase = a.phase; e.text += `[${fmtTime(Date.now())}] ${a.phase}\n`; }
    } else if (e) { e.status = "done"; e.finishedAt = Date.now(); e.progress = 1; }
    touch(a.id);
  }
  const captainEntry = () => entries("captain").find((x) => x.status === "running") || entries("captain")[0] || null;
  let signText = "";
  function roomSign(a) { const t = `${a.name} · ${a.roleLabel || ""}`.replace(/ · $/, ""); if (t !== signText && O.setManagerLabel) { signText = t; O.setManagerLabel(t); } }

  // ---------- agent view → scene ----------
  function agentPatch(a) {
    const t = a.currentTaskId && store.tasks.get(a.currentTaskId);
    return {
      status: a.status,                                   // idle | working | paused (the only source of "what pose")
      name: a.name, role: a.roleLabel,
      task: a.currentTaskTitle || (t && t.title) || "",
      phase: a.phase || (t && t.phase) || "",
      progress: t ? t.progress || 0 : a.status === "working" ? 0 : undefined,
      tool: a.activeTool || null,
      attempts: t ? t.attempts || 0 : 0,
      toolCalls: t ? t.toolCalls || 0 : 0,
      stats: a.metrics ? { done: a.metrics.tasksDone, cost: a.metrics.costUsd } : undefined,
    };
  }
  const jobsActive = () => [...store.jobs.values()].some((j) => ["planning", "running", "synthesizing"].includes(j.status));
  const applyActivity = () => O.setActivity(jobsActive());
  // the scene clock follows the dashboard's simulation speed (sim only): walks and talks get shorter when tasks finish faster
  const sceneSpeed = () => (store.mode === "sim" ? Math.max(1, Math.min(4, Math.round(store.speed))) : 1);
  const talkSecs = () => (store.mode === "sim" ? Math.max(0.8, Math.min(3, 3 / Math.max(0.25, store.speed))) : 3);
  const pinSecs = () => (store.mode === "sim" ? Math.max(0.5, Math.min(1.2, 1.2 / Math.max(0.25, store.speed))) : 1.2); // pinning a paper is quick
  const paperOf = (t, from) => ({ id: t.id, title: t.title, attempts: t.attempts || 1, from: from && from !== "captain" ? name(from) : "captain" });
  const pins = new Map(); // taskId -> agentId whose board holds the paper
  function dropPaper(t) { const owner = pins.get(t.id); if (owner) { O.unpin(owner, t.id); pins.delete(t.id); } }
  function applySpeed() { O.setSpeed(sceneSpeed()); }
  function connLabel() { return store.mode === "live" ? "เชื่อมต่อแล้ว · Claude จริง" : "เชื่อมต่อแล้ว · โหมดจำลอง"; }
  const name = (id) => store.agents.get(id)?.name || (id === "captain" ? "กัปตัน" : id);

  // ---------- events → movement (1:1 with docs/09-office3d.md §2) ----------
  function handle(ev) {
    const d = ev.data || {}, did = [];
    const act = (what) => did.push(what);
    switch (ev.type) {
      case "snapshot": { // open the page later → draw everybody's current state at once
        store.mode = d.mode; store.speed = d.settings?.speed || 1;
        (d.tasks || []).forEach((t) => store.tasks.set(t.id, t));
        (d.jobs || []).forEach((j) => store.jobs.set(j.id, j));
        (d.agents || []).forEach((a) => {
          store.agents.set(a.id, a);
          O.setAgent(a.id, agentPatch(a));
          if (a.role === "captain") roomSign(a);
          if (a.status === "working" && a.currentTaskId) { const e = entryOf(a.id, a.currentTaskId, true); e.text = a.lastOutput || "";
            const t = store.tasks.get(a.currentTaskId); if (t && a.role !== "captain") { O.pin(a.id, paperOf(t, null)); pins.set(t.id, a.id); } } // board shows the running task
          else if (a.lastOutput && !entries(a.id).length) entries(a.id).push({ taskId: null, title: "ผลงานล่าสุด", attempts: 0, phase: "", progress: 1, status: "done", text: "", tools: [], review: null, output: a.lastOutput, error: "", startedAt: null, finishedAt: null, from: null });
          touch(a.id);
        });
        // the captain is in the meeting room while a job is still being planned
        if (RX.planningMeeting !== false && [...store.jobs.values()].some((j) => j.status === "planning")) { O.hold("captain", "meeting", null); act("captain → meeting (planning job in progress)"); }
        applyActivity(); applySpeed(); O.setConnection("live", connLabel());
        act(`setAgent ×${(d.agents || []).length} from snapshot`);
        break;
      }
      case "agent.updated": // idle → desk (rest) · working → desk (work) · paused → sofa ; also the captain's planning/synthesizing phases
        store.agents.set(d.agent.id, d.agent);
        O.setAgent(d.agent.id, agentPatch(d.agent));
        if (d.agent.role === "captain") { captainLog(d.agent); roomSign(d.agent); }
        act(`setAgent ${d.agent.id} status=${d.agent.status}${d.agent.phase ? " phase=" + d.agent.phase : ""}`);
        touch(d.agent.id);
        break;
      case "task.created": case "task.patch":
        store.tasks.set(d.task.id, d.task); break;
      case "task.updated": { // cancelled by the operator → the person who had it stops (agent.updated makes them idle); requeued → paper leaves the board
        const prev = store.tasks.get(d.task.id); store.tasks.set(d.task.id, d.task);
        if (!["assigned", "running"].includes(d.task.status) || d.task.assignedTo !== pins.get(d.task.id)) dropPaper(d.task);
        if (d.task.status === "cancelled" && prev?.status !== "cancelled") {
          const who = lastAgentOf(d.task);
          if (who) { closeEntry(who, d.task.id, "cancelled"); O.say(who, "ยกเลิกงาน: " + trunc(d.task.title, 22), 4); if (RX.failAlert !== false) O.alert(who, 3); act(`${who}: bubble ยกเลิกงาน + alert`); }
        }
        break;
      }
      case "task.assigned": { // the giver walks to the receiver's desk: captain hands out work, a sender hands it over, QA brings it back — the receiver stays and starts
        store.tasks.set(d.task.id, d.task);
        const from = d.from || "captain", title = trunc(d.task.title, 22);
        O.setAgent(d.to, { status: "working", task: d.task.title, progress: d.task.progress || 0, attempts: d.task.attempts, toolCalls: d.task.toolCalls || 0 });
        O.say(d.to, (from === "captain" ? "รับงาน: " : `รับต่อจาก ${name(from)}: `) + title, 3);
        const paper = paperOf(d.task, from); dropPaper(d.task); pins.set(d.task.id, d.to);
        if (RX.assignWalk !== false && from !== d.to) { // walk over, pin the paper on their board, walk straight back (no queueing)
          const isQa = store.agents.get(from)?.role === "reviewer";
          const words = from === "captain" ? "มอบหมาย: " + title : isQa ? `ส่งกลับแก้: ${title}` : `ส่งต่อ: ${title}`;
          O.visit(from, d.to, pinSecs(), words, paper); act(`${from} walks to ${d.to}'s desk, pins "${title}"`);
        } else O.pin(d.to, paper);
        break;
      }
      case "task.started": { // attempt N begins → sit down and work; a repeat attempt says so
        store.tasks.set(d.task.id, d.task);
        const who = d.task.assignedTo; if (!who) break;
        const e = entryOf(who, d.task.id, true); e.attempts = d.task.attempts; e.title = d.task.title; e.phase = d.task.phase;
        O.setAgent(who, { status: "working", task: d.task.title, phase: d.task.phase, progress: 0, attempts: d.task.attempts, toolCalls: d.task.toolCalls || 0 });
        if (d.task.attempts > 1) { // "แก้" only when QA sent it back (real review on the task); a retry / manual handoff / requeue is just another round
          const msg = d.task.review && !d.task.review.approved ? `แก้รอบที่ ${d.task.attempts}` : `รอบที่ ${d.task.attempts}`;
          O.say(who, msg, 4); act(`${who}: bubble ${msg}`);
        }
        act(`${who} → desk (work), attempt ${d.task.attempts}`);
        touch(who);
        break;
      }
      case "task.progress": { // real phase / % / tool → name tag, pose variant and desk monitor
        const t = store.tasks.get(d.taskId); if (t) { t.progress = d.progress; t.phase = d.phase; if ("tool" in d) t.activeTool = d.tool; if (d.toolCalls != null) t.toolCalls = d.toolCalls; }
        const e = entryOf(d.agentId, d.taskId, true);
        e.phase = d.phase; e.progress = d.progress; if (typeof d.text === "string") e.text = d.text.slice(-TEXT_MAX); e.tool = d.tool || null; if (d.toolCalls != null) e.toolCalls = d.toolCalls;
        if (d.toolStep) { // start → input (query / URL / command) → result
          if (d.toolStep === "start") e.tools.push({ t: ev.ts, tool: d.tool, input: "", result: "", ok: null });
          else { const last = [...e.tools].reverse().find((x) => x.tool === d.tool && (d.toolStep === "input" ? !x.input : !x.result));
            if (last) { if (d.toolStep === "input") last.input = d.toolInput || ""; else { last.result = d.toolResult || ""; last.ok = d.toolOk !== false; } }
            else e.tools.push({ t: ev.ts, tool: d.tool, input: d.toolInput || "", result: d.toolResult || "", ok: d.toolOk ?? null }); }
          if (e.tools.length > TOOLS_MAX) e.tools.splice(0, e.tools.length - TOOLS_MAX);
        }
        O.setAgent(d.agentId, { progress: d.progress, phase: d.phase, tool: "tool" in d ? d.tool : undefined, toolCalls: d.toolCalls });
        touch(d.agentId);
        return; // too frequent for the trace
      }
      case "task.completed": { // the worker walks into the captain's room to hand the work in (says "ส่งผลงาน ✓" there); agent.updated then makes them idle
        store.tasks.set(d.task.id, d.task);
        closeEntry(d.from, d.task.id, "done", { output: d.task.output || "", progress: 1, phase: d.task.phase });
        dropPaper(d.task); // the worker takes the paper off the board and brings it along
        if (RX.handInWalk !== false && d.from && d.from !== (d.to || "captain")) { O.visit(d.from, d.to || "captain", talkSecs(), "ส่งผลงาน ✓"); act(`${d.from} walks to ${d.to || "captain"}'s desk to hand in`); }
        else O.say(d.from, "ส่งผลงาน ✓", 3);
        break;
      }
      case "task.review": { // QA verdict on the producer's work (approved, or accepted with notes after the last round) — a reject comes as task.handoff {manual:false}
        store.tasks.set(d.task.id, d.task);
        const who = d.task.assignedTo || lastAgentOf(d.task);
        for (const e of (who ? entries(who) : [])) if (e.taskId === d.task.id) e.review = d.task.review;
        if (who) {
          const msg = d.approved ? `QA ผ่าน ${d.score ?? ""}` : d.accepted ? `QA รับพร้อมหมายเหตุ ${d.score ?? ""}` : `QA ให้แก้ ${d.score ?? ""}`;
          O.say(who, msg, 4); act(`${who}: bubble ${msg}`); touch(who);
        }
        break;
      }
      case "task.handoff": { // manual: the sender stops (agent.updated → idle) · QA reject (manual:false, from = reviewer): the producer sees the score; the walk comes with task.assigned
        store.tasks.set(d.task.id, d.task);
        dropPaper(d.task); // the paper travels with the hand-over (pinned on the receiver's board at task.assigned)
        if (d.manual) {
          if (d.from && d.from !== "captain") { closeEntry(d.from, d.task.id, "handoff", { phase: d.task.phase }); O.say(d.from, `ส่งต่อให้ ${name(d.to)}`, 3); act(`${d.from}: bubble ส่งต่อให้ ${d.to}`); }
        } else if (d.to) { // QA sent it back: the real review (score + feedback) is on the task
          for (const e of entries(d.to)) if (e.taskId === d.task.id && !e.review) e.review = d.task.review || { approved: false, score: d.score, feedback: d.reason };
          O.say(d.to, `QA ให้แก้ ${d.score ?? ""}`, 4); act(`${d.to}: bubble QA ให้แก้ ${d.score}`); touch(d.to);
        }
        break;
      }
      case "task.failed": { // the person stops (agent.updated → idle); red ring + the real reason
        store.tasks.set(d.task.id, d.task);
        const who = lastAgentOf(d.task); dropPaper(d.task);
        if (who) {
          closeEntry(who, d.task.id, "failed", { error: d.error || "" });
          O.say(who, d.retry ? "ล้มเหลว จะลองใหม่" : "งานล้มเหลว", 4);
          if (RX.failAlert !== false) O.alert(who, 4);
          act(`${who}: bubble ${d.retry ? "ล้มเหลว จะลองใหม่" : "งานล้มเหลว"} + alert`);
        }
        break;
      }
      case "job.created": // captain plans in the meeting room until job.planned / job.failed (captain status = working with label "วางแผน: …")
        store.jobs.set(d.job.id, d.job); applyActivity();
        if (RX.planningMeeting !== false) { O.hold("captain", "meeting", null); act("captain → meeting room (planning)"); }
        O.say("captain", "วางแผน: " + trunc(d.job.goal, 24), 4);
        break;
      case "job.planned": {
        store.jobs.set(d.job.id, d.job); applyActivity();
        O.release("captain"); act("captain leaves the meeting room → desk");
        const ce = captainEntry(); // the real plan: the sub-tasks the captain created
        if (ce && ce.status === "running") { const ts = (d.job.taskIds || []).map((id) => store.tasks.get(id)).filter(Boolean); ce.output = `แตกโจทย์เป็น ${ts.length} งานย่อย:\n` + ts.map((t, i) => `${i + 1}. ${t.title} — ${t.role}`).join("\n"); touch("captain"); }
        break;
      }
      case "job.updated": // running ↔ synthesizing (captain writes the summary at the desk: agent.updated carries status=working + phase)
        store.jobs.set(d.job.id, d.job); applyActivity();
        if (d.job.status === "synthesizing") { O.release("captain"); O.say("captain", "รวบรวมผลงาน", 3); act("captain → desk (synthesizing)"); }
        break;
      case "job.completed": {
        store.jobs.set(d.job.id, d.job); applyActivity();
        O.release("captain");
        O.say("captain", "🎉 งานเสร็จสมบูรณ์", 5);
        const ce = captainEntry(); if (ce) { ce.output = d.job.result || ""; ce.progress = 1; touch("captain"); } // the synthesized result, verbatim
        if (RX.cheerOnJobDone !== false) { const ids = [...store.agents.keys()]; O.cheer(ids, 2.5); act(`cheer ×${ids.length}`); }
        break;
      }
      case "job.failed": { // e.g. budget exceeded or a task failed for good → the server already stopped its tasks; show it on the captain
        store.jobs.set(d.job.id, d.job); applyActivity();
        O.release("captain"); O.say("captain", "❌ โจทย์ล้มเหลว", 5);
        if (RX.failAlert !== false) O.alert("captain", 4);
        act("captain leaves meeting/desk flow, alert");
        break;
      }
      case "settings.updated":
        store.speed = d.settings?.speed || 1; applySpeed(); act(`scene speed ${sceneSpeed()}× (sim speed ${store.speed})`);
        break;
      case "mode.updated":
        store.mode = d.mode; applySpeed(); O.setConnection("live", connLabel());
        break;
      default: return;
    }
    trace(ev.type, did);
  }

  // ---------- desk monitors: canvas texture per person, redrawn ≤10/s only when their data changed ----------
  const FONT = '"IBM Plex Sans Thai","Noto Sans Thai",system-ui,sans-serif';
  const screens = new Map(); // agentId -> {canvas, ctx, charW}
  function screenFor(id) {
    let s = screens.get(id); if (s) return s;
    const canvas = O.screenCanvas(id); if (!canvas) return null;
    s = { canvas, ctx: canvas.getContext("2d"), charW: 0 }; screens.set(id, s); return s;
  }
  function lastLines(text, maxChars, maxLines) { // wrap the tail of a stream into fixed-width lines (cheap: by character count, Thai has no spaces)
    const out = [];
    for (const raw of String(text || "").slice(-maxChars * maxLines * 2).split("\n")) {
      const line = raw.replace(/\s+$/, "");
      if (!line) { out.push(""); continue; }
      for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars));
    }
    return out.slice(-maxLines);
  }
  function drawScreen(id) {
    const s = screenFor(id); if (!s) return;
    const { canvas: c, ctx } = s, W = c.width, H = c.height;
    const a = store.agents.get(id), e = entries(id)[0];
    const working = a?.status === "working", paused = a?.status === "paused";
    const col = working ? "#3fd1a8" : paused ? "#8b94a3" : "#5b6880";
    ctx.fillStyle = "#0f1522"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#161c2a"; ctx.fillRect(0, 0, W, 40); ctx.fillStyle = col; ctx.fillRect(0, 0, 6, 40);
    ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
    ctx.font = "600 21px " + FONT; ctx.fillStyle = "#e6ecf5"; ctx.fillText(trunc(a?.name || id, 18), 16, 27);
    ctx.font = "500 17px " + FONT; ctx.fillStyle = col; ctx.textAlign = "right";
    ctx.fillText(working ? (e?.progress == null ? "กำลังทำ" : `${Math.round(e.progress * 100)}%`) : paused ? "หยุดพัก" : "ว่าง", W - 14, 27); ctx.textAlign = "left";
    let y = 68;
    if (working && e) {
      ctx.font = "600 18px " + FONT; ctx.fillStyle = "#ffd46b"; ctx.fillText(trunc(e.title + (e.attempts > 1 ? ` (รอบ ${e.attempts})` : ""), 36), 14, y); y += 24;
      ctx.font = "16px " + FONT; ctx.fillStyle = "#9fb0c8"; ctx.fillText(trunc(e.phase || "", 42), 14, y); y += 24;
      const tu = toolUi(e.tool), lastTool = e.tools[e.tools.length - 1];
      if (tu) { ctx.fillStyle = "#4fa3ff"; ctx.fillText(trunc(`${tu.icon} ${tu.label}${lastTool?.input ? ": " + lastTool.input : ""}`, 42), 14, y); y += 24; }
    } else {
      ctx.font = "600 18px " + FONT; ctx.fillStyle = paused ? "#8b94a3" : "#9fb0c8";
      ctx.fillText(paused ? "หยุดชั่วคราวโดยผู้ควบคุม" : e ? "ว่าง · ผลงานล่าสุด: " + trunc(e.title, 22) : "ว่าง · ยังไม่มีงาน", 14, y); y += 26;
    }
    // stream tail (running) or the final output (idle) in monospace-ish rows
    const body = working ? e?.text : e?.output || e?.text;
    ctx.font = "15px " + FONT; ctx.fillStyle = working ? "#cfe6ff" : "#6f7d93";
    const rows = Math.max(1, Math.floor((H - 22 - y) / 19));
    for (const line of lastLines(body, 48, rows)) { ctx.fillText(line, 14, y); y += 19; }
    if (working && e?.progress != null) { const pw = Math.round((W - 28) * Math.min(1, e.progress)); ctx.fillStyle = "#243049"; ctx.fillRect(14, H - 12, W - 28, 4); ctx.fillStyle = "#3fd1a8"; ctx.fillRect(14, H - 12, pw, 4); }
    O.screenDirty(id);
  }
  if (document.fonts?.ready) document.fonts.ready.then(() => store.agents.forEach((_, id) => touch(id))); // redraw with the real font once loaded

  // ---------- public surface for workscreen.js / debugging ----------
  window.Office3DBridge = {
    store, embed: EMBED, toolUi, _handle: handle, // _handle: feed a synthetic event (tests)
    entries, agent: (id) => store.agents.get(id) || null,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get trace() { return store.trace; },
  };

  if (qs.get("demo") === "1" || typeof EventSource === "undefined") { O.setMode("demo"); return; }

  let opened = false;
  const es = new EventSource(qs.get("events") || CFG.eventsUrl || "/api/events");
  const fallback = setTimeout(() => { if (!opened) { es.close(); O.setMode("demo"); O.setConnection("demo", "ไม่พบเซิร์ฟเวอร์ · โหมดสาธิต"); } }, 4000);
  es.onopen = () => { opened = true; store.connected = true; clearTimeout(fallback); O.setMode("live"); };
  es.onerror = () => { store.connected = false; if (opened) O.setConnection("reconnecting", "หลุดการเชื่อมต่อ กำลังต่อใหม่…"); };
  es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.warn("office3d bridge:", err); } };
})();
