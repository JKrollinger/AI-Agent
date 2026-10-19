// bridge.js — connects the 3D office to the Grock Agent server.
// Listens to the same SSE stream as the dashboard (/api/events) and turns events into Office3D calls.
// Open with ?demo=1 to skip the server, or ?events=<url> to use another stream.
(function () {
  const O = window.Office3D, CFG = window.OFFICE3D_CONFIG || {}, RX = CFG.reactions || {};
  if (!O) return console.error("office3d.js must load before bridge.js");
  const qs = new URLSearchParams(location.search);
  if (qs.get("demo") === "1" || typeof EventSource === "undefined") { O.setMode("demo"); return; }

  const tasks = new Map();
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
  const lastAgentOf = (t) => t.assignedTo || [...(t.history || [])].reverse().find((h) => h.agentId)?.agentId || null;

  function agentPatch(a) {
    const t = a.currentTaskId && tasks.get(a.currentTaskId);
    return {
      status: a.status,                                   // idle | working | paused
      name: a.name, role: a.roleLabel,
      task: a.currentTaskTitle || (t && t.title) || "",
      phase: a.phase || (t && t.phase) || "",
      progress: t ? t.progress || 0 : a.status === "working" ? 0 : undefined,
      tool: a.activeTool || null,
      stats: a.metrics ? { done: a.metrics.tasksDone, cost: a.metrics.costUsd } : undefined,
    };
  }

  function handle(ev) {
    const d = ev.data || {};
    switch (ev.type) {
      case "snapshot":
        (d.tasks || []).forEach((t) => tasks.set(t.id, t));
        (d.agents || []).forEach((a) => O.setAgent(a.id, agentPatch(a)));
        O.setConnection("live", d.mode === "live" ? "เชื่อมต่อแล้ว · Claude จริง" : "เชื่อมต่อแล้ว · โหมดจำลอง");
        break;
      case "agent.updated":
        O.setAgent(d.agent.id, agentPatch(d.agent));
        break;
      case "task.created": case "task.started": case "task.updated": case "task.patch":
        if (d.task) tasks.set(d.task.id, d.task);
        break;
      case "task.progress": {
        const t = tasks.get(d.taskId); if (t) { t.progress = d.progress; t.phase = d.phase; }
        O.setAgent(d.agentId, { progress: d.progress, phase: d.phase, tool: "tool" in d ? d.tool : undefined });
        break;
      }
      case "task.assigned":
        tasks.set(d.task.id, d.task);
        O.setAgent(d.to, { status: "working", task: d.task.title, progress: d.task.progress || 0 });
        if (RX.assignWalk !== false && d.from !== d.to) O.visit(d.to, d.from || "captain", 3);
        O.say(d.to, "รับงาน: " + trunc(d.task.title, 24), 3);
        break;
      case "task.completed":
        tasks.set(d.task.id, d.task);
        if (RX.handInWalk !== false && d.from && d.from !== (d.to || "captain")) O.visit(d.from, d.to || "captain", 3);
        O.say(d.from, "ส่งผลงาน ✓", 3);
        break;
      case "task.handoff":
        tasks.set(d.task.id, d.task);
        if (RX.handoffWalk !== false && d.from && d.to && d.from !== "captain") O.visit(d.to, d.from, 4);
        O.say(d.to, "รับงานส่งต่อ" + (d.score != null ? ` (QA ${d.score})` : ""), 4);
        break;
      case "task.review": {
        tasks.set(d.task.id, d.task);
        const who = d.task.assignedTo || lastAgentOf(d.task);
        if (who) O.say(who, d.approved ? `QA ผ่าน ${d.score ?? ""}` : `QA ให้แก้ ${d.score ?? ""}`, 4);
        break;
      }
      case "task.failed": {
        const who = lastAgentOf(d.task);
        if (who && !d.retry) O.say(who, "งานล้มเหลว", 4);
        break;
      }
      case "job.created":
        if (RX.planningMeeting !== false) O.hold("captain", "meeting", null);
        O.say("captain", "วางแผนงานใหม่", 4);
        break;
      case "job.planned":
        O.release("captain");
        break;
      case "job.completed":
        O.release("captain");
        O.say("captain", "🎉 งานเสร็จสมบูรณ์", 5);
        break;
      case "job.failed":
        O.release("captain");
        break;
      case "mode.updated":
        O.setConnection("live", d.mode === "live" ? "เชื่อมต่อแล้ว · Claude จริง" : "เชื่อมต่อแล้ว · โหมดจำลอง");
        break;
    }
  }

  let opened = false;
  const es = new EventSource(qs.get("events") || CFG.eventsUrl || "/api/events");
  const fallback = setTimeout(() => { if (!opened) { es.close(); O.setMode("demo"); O.setConnection("demo", "ไม่พบเซิร์ฟเวอร์ · โหมดสาธิต"); } }, 4000);
  es.onopen = () => { opened = true; clearTimeout(fallback); O.setMode("live"); };
  es.onerror = () => { if (opened) O.setConnection("reconnecting", "หลุดการเชื่อมต่อ กำลังต่อใหม่…"); };
  es.onmessage = (e) => { try { handle(JSON.parse(e.data)); } catch (err) { console.warn("office3d bridge:", err); } };
})();
