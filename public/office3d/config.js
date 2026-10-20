// config.js — settings for the 3D office (public/office3d/).
// Edit this file to change the team, desks, character models or behaviour. No other file needs to change.
// Full guide: docs/09-office3d.md
window.OFFICE3D_CONFIG = {
  // "live" = follow the Grock Agent server (/api/events); "demo" = people wander on their own.
  // bridge.js switches to live automatically when the server answers, and back to demo if it doesn't.
  mode: "demo",
  eventsUrl: "/api/events",     // SSE endpoint of server/index.js
  clock: "real",                // live mode: "real" = use the wall clock for daylight, "sim" = fast office clock
  modelBase: "models/",         // where the converted Mixamo files live (see tools/office3d/)

  // One entry per agent. `id` must match the agent id in server/agents.js (DEFAULT_TEAM).
  // Order = desk order (see `desks`). `look` is used for the built-in figure while/if the model can't load.
  team: [
    { id: "captain", jobId: "lord-knight", name: "ผู้จัดการโครงการ", role: "Project Manager",
      model: { file: "lord-knight.json", height: 1.78 },
      look: { skin: 0xe8b896, shirt: 0xf2f0ea, jacket: 0x7a1f1f, pants: 0x23262d, hair: 0x3b2a1e, style: 0, iris: 0x3b2618, shoe: 0x1b1b1d } },
    { id: "qa-1", jobId: "high-priest", name: "ผู้ตรวจคุณภาพ", role: "Quality & Compliance",
      model: { file: "high-priest.json", height: 1.66 },
      look: { skin: 0xf1c9a5, shirt: 0xf4f1ea, jacket: 0xe3cfd6, pants: 0x8a7d86, hair: 0xd9a066, style: 1, iris: 0x4f7aa3, shoe: 0xd8c8c0 } },
    { id: "mkt-1", jobId: "sniper", name: "นักการตลาด", role: "Marketing Specialist",
      model: { file: "sniper.json", height: 1.80 },
      look: { skin: 0xc99470, shirt: 0x4f6b3a, pants: 0xa8946e, hair: 0x5b3d26, style: 0, iris: 0x3b2618, sleeves: "short", shoe: 0x6b4a32 } },
    { id: "eng-1", jobId: "high-wizard", name: "วิศวกร AI", role: "AI Engineer",
      model: { file: "high-wizard.json", height: 1.68 },
      look: { skin: 0xf1d2b6, shirt: 0x5a5470, jacket: 0x2b2440, pants: 0x1f2228, hair: 0xe3dccf, style: 3, iris: 0x6b5a8a, glasses: true, hat: true, shoe: 0x1b1b1d } },
    { id: "res-1", jobId: "stalker", name: "นักวิจัย", role: "Research Analyst",
      model: { file: "stalker.json", height: 1.76 },
      look: { skin: 0xb5835a, shirt: 0x2a2d33, pants: 0x2b2424, hair: 0x111111, style: 2, iris: 0x2a1a10, shoe: 0x1b1b1d } },
    { id: "fin-1", jobId: "professor", name: "นักวิเคราะห์การเงิน", role: "Finance & Strategy",
      model: { file: "professor.json", height: 1.68, phoneWalk: true },
      look: { skin: 0xf1c9a5, shirt: 0xe6e0d4, jacket: 0x8a6e52, pants: 0x5a4636, hair: 0xf0c27a, style: 1, iris: 0x4a6a3a, glasses: true, shoe: 0x6b4a32 } },
    { id: "dev-1", jobId: "whitesmith", name: "นักพัฒนา", role: "Developer & Automation",
      model: { file: "whitesmith.json", height: 1.78 },
      look: { skin: 0xe8b896, shirt: 0xf2f2ef, pants: 0xa37f5a, hair: 0xd9a8a0, style: 4, iris: 0x8a4a3a, sleeves: "short", shoe: 0xf0eeea } },
  ],

  // Desk positions [x, z, facing] in metres, one per team member, same order as `team`.
  // facing 1 = person sits on the +z side, -1 = on the -z side. The floor runs x -13..13, z -9..9.
  // desks[0] (the captain) sits inside the manager's room below; the other six are the open-plan desks on the left.
  desks: [[-0.4, 6.6, 1], [-10, -5.5, -1], [-6, -4.7, 1], [-6, -5.5, -1], [-10, 4.7, -1], [-10, 5.5, 1], [-6, 4.7, -1]],

  // Glass office for the captain (front-centre, door toward the main aisle). People hand work in by walking through the door
  // to a spot in front of the desk. false = no room (captain at an open desk). x0/x1/z0/z1 = walls, doorX = door centre on the z0 wall.
  managerRoom: { x0: -2.0, x1: 1.6, z0: 4.0, z1: 8.9, doorX: 1.0, doorW: 1.1, label: "ห้องผู้จัดการ · Project Manager" },

  // Live mode: chance of a short break each time an idle agent re-thinks (every 15–30 s).
  // Breaks happen only when the person has no task AND (idleBreaksOnlyWhenTeamIdle) no job is planning/running/synthesizing —
  // never while working. Set all to 0 to keep everyone at their desk.
  idleBreaks: { coffee: 0.12, lounge: 0.06, phone: 0.05, printer: 0.04 },
  idleBreaksOnlyWhenTeamIdle: true,

  // What the scene does on server events (bridge.js). Set an entry to false to turn it off. Full table: docs/09-office3d.md §2
  reactions: {
    assignWalk: true,      // task.assigned  → the giver walks to the receiver's desk (captain hands out, a sender hands over, QA brings it back); the receiver stays and starts
    handInWalk: true,      // task.completed → worker walks into the captain's room to hand in
    planningMeeting: true, // job.created    → captain plans in the meeting room until job.planned / job.failed
    failAlert: true,       // task.failed / cancelled / job.failed → red ring + bubble on the person affected
    cheerOnJobDone: true,  // job.completed  → whole team celebrates for a moment
    screens: true          // desk monitors show the live stream / tool / % of the person sitting there
  },

  // A random walk-in guest is not a real event, so it is off in live mode by default (turn on for the ?demo=1 showcase).
  visitor: { enabled: false, name: "แขก", role: "ผู้มาติดต่อจากบริษัทลูกค้า",
    look: { skin: 0xd9a47c, shirt: 0xdfe7f0, jacket: 0x3c4a5e, pants: 0x3c4a5e, hair: 0x2a1f18, style: 2, iris: 0x3b2618, shoe: 0x1b1b1d } },

  // When embedded in an <iframe>: only accept postMessage commands from these origins ([] = the page's own origin only, i.e. the dashboard).
  allowedOrigins: [],
};
