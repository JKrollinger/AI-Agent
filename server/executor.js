// executor.js — "ลงมือทำงาน" จริงของพนักงาน AI แต่ละคน
// มี 2 โหมด:
//   live : เรียก Claude ผ่าน Anthropic SDK (streaming) — ต้องมี ANTHROPIC_API_KEY
//   sim  : จำลองการทำงานเป็นเฟส ๆ พร้อมข้อความค่อย ๆ พิมพ์ออกมา เพื่อให้เห็นภาพการทำงานบน dashboard ได้ทันที
import { ROLES, CAPTAIN_MODEL, TOOL_META, estimateCost, toolsFor, toolHintFor } from "./agents.js";
import { state, workers, captain } from "./state.js";
import * as llm from "./llm.js";

export const isLive = () => state.mode === "live";

const VALID_ROLES = ["researcher", "analyst", "writer", "coder", "reviewer"];
const MAX_PLAN_TASKS = 8;

// ---------- utilities ----------
const abortErr = () => Object.assign(new Error("งานถูกยกเลิก"), { name: "AbortError" });
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortErr());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortErr());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const speed = () => Math.max(0.25, Number(state.settings.speed) || 1);
const shorten = (s, n = 42) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ====================================================================
// 1) การวางแผน (Captain แตกงาน)
// ====================================================================
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "role", "assignee", "depends_on"],
        properties: {
          title: { type: "string", description: "ชื่องานสั้น ๆ ภาษาไทย ไม่เกิน 60 ตัวอักษร" },
          description: { type: "string", description: "รายละเอียดสิ่งที่ต้องส่งมอบ" },
          role: { type: "string", enum: VALID_ROLES },
          assignee: {
            type: "string",
            description: "id ของพนักงานที่หน้าที่ตรงกับงานนี้ที่สุด (เลือกจากรายชื่อทีม ต้องมีตำแหน่งตรงกับ role) หรือ \"\" ถ้าให้ระบบเลือกเอง",
          },
          depends_on: {
            type: "array",
            items: { type: "integer" },
            description: "index (เริ่ม 0) ของงานก่อนหน้าที่ต้องเสร็จก่อน",
          },
        },
      },
    },
  },
};

/** รายชื่อทีม (ไม่รวมกัปตัน) พร้อมหน้าที่ สำหรับให้กัปตันวางแผน/มอบหมาย */
export function rosterFor() {
  return workers().map((a) => ({
    id: a.id,
    name: a.name,
    nick: a.nick,
    role: a.role,
    roleLabel: a.roleLabel,
    duties: a.duties || "",
    status: a.status,
  }));
}

// ตัดคำไทย/อังกฤษด้วย Intl.Segmenter (Node มี ICU เต็ม) เพื่อเทียบ "หน้าที่" กับชื่อ/รายละเอียดงานระดับคำ ไม่ใช่ทั้งวลี
const STOPWORDS = new Set(["และ", "หรือ", "ของ", "ที่", "ใน", "กับ", "ให้", "จาก", "เป็น", "การ", "ความ", "ต่อ", "เพื่อ", "ได้", "ไม่", "ทุก", "แต่ละ", "ผล", "งาน", "ทีม", "the", "and", "for", "with"]);
let segmenter = null;
try {
  segmenter = new Intl.Segmenter("th", { granularity: "word" });
} catch {
  segmenter = null;
}
export function dutyWords(s) {
  const text = String(s || "").toLowerCase();
  const words = segmenter
    ? [...segmenter.segment(text)].filter((x) => x.isWordLike).map((x) => x.segment.trim())
    : text.split(/[\s,.;:/()·•\-–—]+/);
  return new Set(words.filter((w) => w.length >= 2 && !STOPWORDS.has(w)));
}

/**
 * เลือกคนในตำแหน่งนั้นที่ "หน้าที่" ตรงกับงานที่สุด: นับคำในหน้าที่ที่ปรากฏในชื่อ/รายละเอียดงาน
 * ถ้าคะแนนเท่ากัน ให้คนที่ได้รับงานในแผนนี้น้อยกว่า (กระจายงาน ไม่กองที่คนเดียว)
 * ใช้เมื่อกัปตันไม่ได้ระบุ assignee (หรือระบุผิด) และในโหมด sim
 * @param {Map<string, number>} [load] จำนวนงานที่แต่ละคนได้รับไปแล้วในแผนนี้ (ฟังก์ชันจะอัปเดตให้)
 * @returns {string|null} agent id
 */
export function suggestAssignee(role, text, roster = rosterFor(), load = null) {
  const candidates = roster.filter((r) => r.role === role);
  if (!candidates.length) return null;
  let best = candidates[0];
  if (candidates.length > 1) {
    const hay = dutyWords(text);
    let bestKey = null;
    for (const c of candidates) {
      const matches = [...dutyWords(c.duties)].filter((w) => hay.has(w)).length;
      const key = matches * 100 - (load?.get(c.id) || 0);
      if (bestKey === null || key > bestKey) {
        best = c;
        bestKey = key;
      }
    }
  }
  if (load) load.set(best.id, (load.get(best.id) || 0) + 1);
  return best.id;
}

function rosterText(roster) {
  return roster
    .map((r) => `- id="${r.id}" ${r.name}${r.nick && r.nick !== r.name ? ` (${r.nick})` : ""} ตำแหน่ง ${r.role} (${r.roleLabel})${r.status === "paused" ? " [หยุดพักอยู่]" : ""}: หน้าที่ — ${r.duties || "-"}`)
    .join("\n");
}

function planPrompt(goal, roster = rosterFor()) {
  return `โจทย์จากผู้ใช้: "${goal}"

ทีมของคุณและหน้าที่ของแต่ละคน:
${rosterText(roster)}

แตกโจทย์นี้เป็นงานย่อย 3-7 ชิ้นสำหรับทีม ซึ่งมีตำแหน่ง: researcher (นักวิจัย), analyst (นักวิเคราะห์), writer (นักเขียน), coder (นักพัฒนา), reviewer (QA)
กติกา:
- ทุกงานต้องระบุ assignee เป็น id ของคนที่หน้าที่ตรงกับงานนั้นที่สุด (ตำแหน่งต้องตรงกับ role) ถ้าตำแหน่งเดียวกันมีหลายคน ให้แบ่งงานตามหน้าที่ที่แต่ละคนรับผิดชอบ ไม่ให้งานกองอยู่ที่คนเดียว
- งานต้องเป็นลำดับที่สมเหตุสมผล ระบุ depends_on เป็น index ของงานก่อนหน้าเท่านั้น (ห้ามอ้างงานที่อยู่ถัดไป)
- งานที่ทำพร้อมกันได้ ให้ไม่ต้องพึ่งพากัน เพื่อให้ทีมทำคู่ขนาน
- ต้องมีงาน reviewer อย่างน้อย 1 ชิ้นเพื่อตรวจผลงานชิ้นสุดท้าย (depends_on ชิ้นที่ถูกตรวจ)
- ใช้ coder เฉพาะเมื่อโจทย์ต้องการโค้ด/ระบบ/ต้นแบบจริง
- ชื่องานและรายละเอียดเป็นภาษาไทย`;
}

/** ทำให้แผนจาก LLM ใช้งานได้แน่นอน: role ถูกต้อง, dependencies ไม่วน, มี QA ปิดท้าย, งานถัดไปรอผล QA, assignee ตรงตำแหน่งและหน้าที่ */
export function normalizePlan(rawTasks, roster = rosterFor()) {
  const load = new Map(); // งานที่แต่ละคนได้รับในแผนนี้ (ใช้กระจายงานเมื่อหน้าที่ไม่ชี้ชัด)
  let tasks = (Array.isArray(rawTasks) ? rawTasks : []).slice(0, MAX_PLAN_TASKS).map((t, i) => {
    let role = String(t.role || "").toLowerCase();
    if (/qa|review|ตรวจ/.test(role)) role = "reviewer";
    if (/research|วิจัย|ค้น/.test(role)) role = "researcher";
    if (/analy|วิเคราะห์/.test(role)) role = "analyst";
    if (/code|dev|engineer|พัฒนา|โปรแกรม/.test(role)) role = "coder";
    if (!VALID_ROLES.includes(role)) role = "writer";
    const deps = [...new Set((t.depends_on || t.dependsOn || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d < i))];
    const title = shorten(String(t.title || `งานที่ ${i + 1}`), 70);
    const description = String(t.description || t.title || "");
    // assignee ที่กัปตันเลือกต้องมีอยู่จริงและตำแหน่งตรง ไม่งั้นเลือกจากหน้าที่ให้
    const wanted = String(t.assignee || t.assigned_to || "").trim();
    const valid = roster.find((r) => r.id === wanted && r.role === role);
    let assignee;
    if (valid) {
      assignee = valid.id;
      load.set(assignee, (load.get(assignee) || 0) + 1);
    } else {
      assignee = suggestAssignee(role, `${title} ${description}`, roster, load);
    }
    return { title, description, role, assignee, dependsOn: deps, reviewOf: null };
  });
  if (!tasks.length) return tasks;

  // reviewer ตรวจงานล่าสุดที่มันพึ่งพา (ถ้าไม่มี ให้ตรวจชิ้นก่อนหน้า)
  tasks.forEach((t, i) => {
    if (t.role !== "reviewer") return;
    const producers = t.dependsOn.filter((d) => tasks[d].role !== "reviewer");
    t.reviewOf = producers.length ? producers[producers.length - 1] : i > 0 ? i - 1 : null;
    if (t.reviewOf !== null && !t.dependsOn.includes(t.reviewOf)) t.dependsOn.push(t.reviewOf);
  });

  // ถ้าไม่มี QA เลย เพิ่มให้ตรวจชิ้นสุดท้ายที่ไม่ใช่ QA
  if (!tasks.some((t) => t.role === "reviewer")) {
    let last = tasks.length - 1;
    while (last >= 0 && tasks[last].role === "reviewer") last--;
    if (last >= 0 && tasks.length < MAX_PLAN_TASKS) {
      const title = `ตรวจคุณภาพ: ${shorten(tasks[last].title, 40)}`;
      tasks.push({
        title,
        description: `ตรวจสอบความถูกต้อง ครบถ้วน และความพร้อมใช้งานของ "${tasks[last].title}"`,
        role: "reviewer",
        assignee: suggestAssignee("reviewer", title, roster, load),
        dependsOn: [last],
        reviewOf: last,
      });
    }
  }

  // งานที่พึ่งพาชิ้นที่ "ถูกตรวจ" ให้ไปรอผลตรวจแทน (ป้องกันงานปลายน้ำวิ่งก่อน QA ส่งกลับแก้)
  const reviewIndexOf = new Map();
  tasks.forEach((t, i) => {
    if (t.role === "reviewer" && t.reviewOf !== null) reviewIndexOf.set(t.reviewOf, i);
  });
  tasks.forEach((t, i) => {
    if (t.role === "reviewer") return;
    t.dependsOn = [...new Set(t.dependsOn.map((d) => (reviewIndexOf.has(d) && reviewIndexOf.get(d) < i ? reviewIndexOf.get(d) : d)))];
  });
  return tasks;
}

async function simPlan(job, onPhase, signal, roster = rosterFor()) {
  const goal = job.goal;
  const wantsCode = /โค้ด|code|แอป|app|เว็บ|web|ระบบ|api|สคริปต์|script|โปรแกรม|bot|บอท|dashboard|แดชบอร์ด|automation|อัตโนมัติ/i.test(goal);
  for (const phase of ["กำลังอ่านโจทย์ (Concentration)", "กำลังแตกงานย่อย (Aura Blade)", "กำลังจัดลำดับและมอบหมาย (Spear Boomerang)"]) {
    onPhase?.(phase);
    await sleep(rand(600, 1100) / speed(), signal);
  }
  const s = shorten(goal, 36);
  const tasks = [
    { title: `ค้นข้อมูลพื้นฐาน: ${s}`, role: "researcher", dependsOn: [], description: `รวบรวมข้อเท็จจริง นิยาม สถานการณ์ปัจจุบัน และแหล่งอ้างอิงเกี่ยวกับ "${goal}"` },
    { title: `สำรวจตัวอย่างและคู่เทียบ`, role: "researcher", dependsOn: [], description: `หาตัวอย่างการทำจริง คู่เทียบ และบทเรียนที่เกี่ยวกับ "${goal}"` },
    { title: `วิเคราะห์และสรุป insight`, role: "analyst", dependsOn: [0, 1], description: `นำข้อมูลจากนักวิจัยทั้งสองคนมาวิเคราะห์ เปรียบเทียบตัวเลือก และสรุปข้อเสนอแนะ` },
  ];
  if (wantsCode) {
    tasks.push({ title: `สร้างต้นแบบ (prototype)`, role: "coder", dependsOn: [2], description: `ออกแบบและเขียนโค้ดต้นแบบตามข้อเสนอของนักวิเคราะห์ พร้อมคู่มือใช้งาน` });
    tasks.push({ title: `ตรวจสอบโค้ดต้นแบบ`, role: "reviewer", dependsOn: [3], reviewOf: 3, description: `ตรวจความถูกต้อง ความปลอดภัย และความพร้อมใช้งานของต้นแบบ` });
  }
  const writerDeps = wantsCode ? [2, 4] : [2];
  tasks.push({ title: `เรียบเรียงเอกสารข้อเสนอ`, role: "writer", dependsOn: writerDeps, description: `เรียบเรียงผลงานทั้งหมดเป็นเอกสารข้อเสนอสำหรับผู้บริหาร` });
  const w = tasks.length - 1;
  tasks.push({ title: `ตรวจคุณภาพเอกสารข้อเสนอ`, role: "reviewer", dependsOn: [w], reviewOf: w, description: `ตรวจความครบถ้วน ความถูกต้อง และความพร้อมส่งมอบของเอกสาร` });
  // กัปตัน (จำลอง) เลือกคนตามหน้าที่ เช่น งานค้นข้อมูลพื้นฐาน → คนที่หน้าที่ระบุ "ค้นข้อมูลพื้นฐาน", งานคู่เทียบ → คนที่หน้าที่ระบุ "คู่เทียบ"
  const load = new Map();
  for (const t of tasks) t.assignee = suggestAssignee(t.role, `${t.title} ${t.description}`, roster, load);
  return { tasks, usage: { input_tokens: 900, output_tokens: 380 } };
}

/** system prompt ของกัปตัน + หน้าที่ที่ผู้ใช้กำหนด */
function captainSystem() {
  const cap = captain();
  return cap?.duties ? `${ROLES.captain.system}\n\nหน้าที่ประจำของคุณ: ${cap.duties}` : ROLES.captain.system;
}

export async function planJob(job, { onPhase, signal } = {}) {
  const roster = rosterFor();
  if (!isLive()) return simPlan(job, onPhase, signal, roster);
  onPhase?.("กำลังวิเคราะห์โจทย์");
  const cap = captain();
  const { text, usage } = await llm.streamText({
    model: cap?.model || CAPTAIN_MODEL,
    system: captainSystem(),
    prompt: planPrompt(job.goal, roster),
    effort: cap?.effort || "medium",
    maxTokens: 8000,
    outputSchema: PLAN_SCHEMA,
    signal,
    onText: () => onPhase?.("กำลังแตกงานย่อย"),
  });
  const parsed = JSON.parse(text);
  return { tasks: normalizePlan(parsed.tasks, roster), usage };
}

// ====================================================================
// 2) การลงมือทำงานของพนักงานแต่ละคน
// ====================================================================
// เฟสงานในโหมดจำลอง ใส่ชื่อสกิลประจำอาชีพ Ragnarok (docs/05-ragnarok-theme.md ข้อ 4) เพื่อให้ dashboard มีกลิ่นเกม
const SIM_PHASES = {
  researcher: ["กำลังค้นหาแหล่งข้อมูล (Falcon Eyes)", "กำลังอ่านและคัดกรอง (Double Strafe)", "กำลังตรวจสอบข้อเท็จจริง (True Sight)", "กำลังเขียนสรุป (Sharp Shooting)"],
  analyst: ["กำลังรวบรวมข้อมูลจากทีม (Storm Gust)", "กำลังเปรียบเทียบตัวเลือก (Meteor Storm)", "กำลังประเมินความเสี่ยง (Jupitel Thunder)", "กำลังสรุป insight (Mystical Amplification)"],
  writer: ["กำลังวางโครงเรื่อง (Memorize)", "กำลังร่างเนื้อหา (Double Casting)", "กำลังปรับภาษา (Dispel)", "กำลังจัดรูปแบบเอกสาร (Land Protector)"],
  coder: ["กำลังออกแบบโครงสร้าง (Weapon Perfection)", "กำลังเขียนโค้ด (Mammonite)", "กำลังทดสอบ (Weapon Refine)", "กำลังเขียนคู่มือใช้งาน (Cart Boost)"],
  reviewer: ["กำลังอ่านผลงาน (Lex Aeterna)", "กำลังตรวจตามเกณฑ์ (Assumptio)", "กำลังให้คะแนน (Magnificat)", "กำลังเขียน feedback (Blessing)"],
};
// สกิลของ Stalker (นักวิจัยคนที่ 2) ต่างจาก Sniper
const SIM_PHASES_BY_JOB = {
  stalker: ["กำลังแอบสำรวจ (Chase Walk)", "กำลังเก็บข้อมูลเชิงลึก (Intimidate)", "กำลังเทียบแหล่งข้อมูล (Preserve)", "กำลังเขียนสรุป (Full Strip)"],
};

// การจำลองการใช้เครื่องมือ (โหมด sim) เพื่อให้ dashboard แสดงไอคอนได้โดยไม่ต้องมี API key
// after = index ของเฟสใน SIM_PHASES ที่ทำเสร็จก่อนจะใช้เครื่องมือ, chance = โอกาสที่จะเกิดในงานนั้น
function simToolPhases(role, context, agent) {
  if (agent?.toolsEnabled === false || !toolsFor(role).length) return []; // เคารพ TOOLS_ENABLED=0, การปิดต่อคน และตำแหน่งที่ไม่มีเครื่องมือ
  const topic = shorten(String(context.goal || ""), 28);
  const sites = ["th.wikipedia.org", "www.bot.or.th", "www.nstda.or.th", "hbr.org", "github.com", "docs.python.org"];
  const all = {
    researcher: [
      {
        after: 0,
        tool: "web_search",
        chance: 1,
        summary: () => pick([`${topic} แนวปฏิบัติที่ดี`, `${topic} กรณีศึกษา`, `${topic} สถิติล่าสุด`]),
        result: () => `พบผลค้นหา ${Math.round(rand(4, 10))} รายการ`,
      },
      { after: 1, tool: "web_fetch", chance: 0.65, summary: () => pick(sites), result: (s) => `อ่าน ${s} แล้ว` },
    ],
    analyst: [
      {
        after: 1,
        tool: "bash_code_execution",
        chance: 0.7,
        summary: () => pick(["python analyze.py --scenario base", "python -c 'import pandas as pd; ...'"]),
        result: () => "รันโค้ดสำเร็จ",
      },
    ],
    coder: [
      {
        after: 1,
        tool: "bash_code_execution",
        chance: 1,
        summary: () => pick(["node --check server.js", "npm test", "python -m pytest -q"]),
        result: () => "รันโค้ดสำเร็จ",
      },
      { after: 2, tool: "bash_code_execution", chance: 0.5, summary: () => "node smoke-test.js", result: () => "รันโค้ดสำเร็จ" },
    ],
  };
  return (all[role] || []).filter((t) => Math.random() < t.chance);
}

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "score", "summary", "feedback"],
  properties: {
    approved: { type: "boolean", description: "ผ่านเกณฑ์หรือไม่ (คะแนน >= 70)" },
    score: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string", description: "สรุปผลการตรวจ 1-2 ประโยค" },
    feedback: { type: "string", description: "สิ่งที่ต้องแก้ เป็นข้อ ๆ (ว่างได้ถ้าผ่านโดยไม่มีข้อแก้)" },
  },
};

function taskPrompt(task, context) {
  const inputs = (context.inputs || [])
    .map((i) => `--- ผลงานจาก ${i.agentName} (${i.roleLabel}) — "${i.title}" ---\n${i.output}`)
    .join("\n\n");
  return [
    `โจทย์หลักของทีม: "${context.goal}"`,
    `งานของคุณ: ${task.title}`,
    `รายละเอียด: ${task.description}`,
    inputs ? `\nผลงานจากเพื่อนร่วมทีมที่ต้องใช้ประกอบ:\n${inputs}` : "",
    task.feedback ? `\nงานนี้ถูก QA ส่งกลับมาแก้ (รอบที่ ${task.attempts}) โดยมี feedback ที่ต้องแก้ให้ครบ:\n${task.feedback}` : "",
    `\nส่งผลงานฉบับสมบูรณ์เป็นภาษาไทย`,
  ]
    .filter(Boolean)
    .join("\n");
}

function reviewPrompt(task, context) {
  const target = context.reviewTarget;
  return [
    `โจทย์หลักของทีม: "${context.goal}"`,
    `งานตรวจสอบ: ${task.title}`,
    `รายละเอียด: ${task.description}`,
    target
      ? `\nผลงานที่ต้องตรวจ — "${target.title}" โดย ${target.agentName} (${target.roleLabel}) รอบที่ ${target.attempts}:\n${target.output}`
      : "\n(ไม่พบผลงานที่ต้องตรวจ ให้ประเมินจากบริบทที่มี)",
    `\nให้คะแนน 0-100 และตัดสินว่าผ่านเมื่อ >= 70 ถ้าไม่ผ่านให้ feedback เป็นข้อ ๆ ที่แก้ได้ทันที`,
  ].join("\n");
}

// ลักษณะงานกำหนดจาก role ของ "งาน" (ถ้าส่งต่องานข้ามตำแหน่ง คนรับจะสวมบทบาทตามงานนั้น)
const workRole = (agent, task) => (ROLES[task.role] ? task.role : agent.role);

async function liveRun({ agent, task, context, signal, onProgress }) {
  const role = workRole(agent, task);
  const roleDef = ROLES[role] || ROLES.writer;
  const isReview = role === "reviewer";
  const effort = agent.effort || (role === "coder" ? "high" : "medium");
  const expectedChars = isReview ? 900 : 3200;
  // server tools ตามตำแหน่งของ "งาน" (researcher = ค้นเว็บ/อ่านเว็บ, analyst/coder = รันโค้ด, reviewer = อ่านเว็บตรวจอ้างอิง)
  const tools = agent.toolsEnabled === false ? [] : toolsFor(role); // ปิดเครื่องมือต่อคนได้จากหน้าตั้งค่า AI
  const toolHint = tools.length ? toolHintFor(role) : "";
  // หน้าที่ประจำของคนนี้ (ผู้ใช้กำหนดได้) ต่อท้าย system prompt ประจำตำแหน่ง
  const who = agent.nick && agent.nick !== agent.name ? `${agent.name} (${agent.nick})` : agent.name;
  const dutyLine = agent.duties ? `\n\nคุณคือ ${who} หน้าที่ประจำของคุณในทีม: ${agent.duties}\nทำงานชิ้นนี้ตามขอบเขตหน้าที่ของคุณ และถ้างานเกินหน้าที่ให้ทำเท่าที่ทำได้พร้อมระบุส่วนที่ควรส่งต่อให้คนอื่น` : "";
  let lastPhase = "กำลังคิด";
  let toolCalls = 0;
  const { text, usage, model } = await llm.streamText({
    model: agent.model,
    system: `${roleDef.system}${dutyLine}${toolHint ? `\n\n${toolHint}` : ""}`,
    prompt: isReview ? reviewPrompt(task, context) : taskPrompt(task, context),
    effort,
    maxTokens: 16000,
    outputSchema: isReview ? REVIEW_SCHEMA : undefined,
    tools,
    signal,
    onThinking: (summary) => {
      lastPhase = "กำลังคิด";
      onProgress?.({ phase: "กำลังคิด", progress: 0.08, text: summary.slice(-600), tool: null });
    },
    onText: (full) => {
      lastPhase = isReview ? "กำลังตรวจและให้คะแนน" : "กำลังเขียนผลงาน";
      onProgress?.({ phase: lastPhase, progress: Math.min(0.95, 0.1 + (full.length / expectedChars) * 0.85), text: full, tool: null });
    },
    // เหตุการณ์ของ server tools ระหว่าง stream: start (เริ่มเรียก) → input (รู้คำค้น/URL/คำสั่งแล้ว) → result (ได้ผลกลับมา)
    onTool: ({ name, phase, summary }) => {
      if (phase === "continue") return onProgress?.({ phase: `กำลังทำงานต่อ (${summary})` });
      const meta = TOOL_META[name] || { label: name, phase: `กำลังใช้ ${name}` };
      if (phase === "start") {
        toolCalls += 1;
        onProgress?.({ phase: meta.phase, tool: name, toolStarted: true, progress: 0.12 });
      } else if (phase === "input") {
        onProgress?.({ phase: summary ? `${meta.phase}: ${summary}` : meta.phase, tool: name });
      } else if (phase === "result") {
        onProgress?.({ phase: summary || `${meta.label} เสร็จ`, tool: name });
      }
    },
  });
  const result = { output: text, usage, model, toolCalls };
  if (isReview) {
    let review;
    try {
      review = JSON.parse(text);
    } catch {
      review = { approved: true, score: 70, summary: text.slice(0, 200), feedback: "" };
    }
    review.approved = review.approved && review.score >= 70;
    result.review = review;
    result.output = `คะแนน ${review.score}/100 — ${review.approved ? "ผ่าน ✅" : "ส่งกลับแก้ 🔁"}\n${review.summary}${review.feedback ? `\n\nสิ่งที่ต้องแก้:\n${review.feedback}` : ""}`;
  }
  return result;
}

// ---------- simulation ----------
function simOutput(agent, task, context) {
  const g = context.goal;
  const refs = (context.inputs || []).map((i) => `"${i.title}"`).join(", ");
  switch (agent.role) {
    case "researcher":
      return `# สรุปงานวิจัย: ${task.title}

## ภาพรวม
จากการค้นคว้าเกี่ยวกับ "${g}" พบว่าองค์กรส่วนใหญ่ที่ทำเรื่องนี้สำเร็จมักเริ่มจากการกำหนดเป้าหมายที่วัดผลได้ก่อน แล้วค่อยขยายขอบเขตทีละขั้น

## ข้อเท็จจริงสำคัญ (ความมั่นใจสูง)
1. ปัจจัยความสำเร็จอันดับแรกคือการมีเจ้าของงานที่ชัดเจนและตัวชี้วัดที่ตกลงร่วมกัน
2. ต้นทุนเริ่มต้นมักต่ำกว่าที่คาด แต่ต้นทุนการดูแลระยะยาวสูงกว่าที่คาดราว 1.5-2 เท่า
3. การทดลองในวงเล็ก (pilot) 4-6 สัปดาห์ ช่วยลดความเสี่ยงได้มากที่สุด

## ข้อสังเกต (ความมั่นใจปานกลาง)
- ตัวอย่างจากหลายอุตสาหกรรมชี้ว่าการสื่อสารกับผู้มีส่วนได้ส่วนเสียตั้งแต่ต้นลดแรงต้านได้ชัดเจน
- ควรเตรียมแผนสำรองกรณีเครื่องมือหรือผู้ให้บริการเปลี่ยนเงื่อนไข

## แหล่งอ้างอิงที่ควรตรวจสอบต่อ
- รายงานอุตสาหกรรมล่าสุด, กรณีศึกษาจากองค์กรขนาดใกล้เคียง, มาตรฐาน/ข้อกำหนดที่เกี่ยวข้อง`;
    case "analyst":
      return `# บทวิเคราะห์: ${task.title}

อ้างอิงข้อมูลจาก ${refs || "ทีมวิจัย"}

## ตัวเลือกที่พิจารณา
| ตัวเลือก | ข้อดี | ข้อเสีย | ความเสี่ยง |
|---|---|---|---|
| A. เริ่มเล็ก ขยายทีละขั้น | เรียนรู้เร็ว ต้นทุนต่ำ | เห็นผลภาพรวมช้า | ต่ำ |
| B. ลงทุนเต็มรูปแบบทันที | เห็นผลเร็ว | ต้นทุนสูง แก้ทิศทางยาก | สูง |
| C. จ้างภายนอกบางส่วน | ได้ความเชี่ยวชาญทันที | พึ่งพาภายนอก | ปานกลาง |

## Insight หลัก
1. สำหรับโจทย์ "${g}" ตัวเลือก A ให้ผลตอบแทนต่อความเสี่ยงดีที่สุดในระยะ 6 เดือนแรก
2. ควรกำหนดตัวชี้วัด 3 ตัว: เวลาที่ประหยัดได้, คุณภาพผลงาน (คะแนน QA), และต้นทุนต่องาน
3. จุดที่ต้องระวังที่สุดคือการเปลี่ยนแปลงกระบวนการของคนในองค์กร ไม่ใช่ตัวเทคโนโลยี

## ข้อเสนอแนะเรียงตามความสำคัญ
1. เริ่ม pilot กับทีมเดียวภายใน 30 วัน
2. ตั้ง dashboard ติดตามตัวชี้วัดตั้งแต่วันแรก
3. ทบทวนผลทุก 2 สัปดาห์และตัดสินใจขยาย/หยุด`;
    case "writer":
      return `# ข้อเสนอ: ${g}

## บทสรุปผู้บริหาร
เอกสารนี้เรียบเรียงจากผลงานของทีม (${refs || "วิจัยและวิเคราะห์"}) เพื่อเสนอแนวทางดำเนินการเรื่อง "${g}" โดยแนะนำให้เริ่มจากโครงการนำร่องขนาดเล็กที่วัดผลได้ภายใน 30 วัน

## สาระสำคัญ
1. **เหตุผลที่ต้องทำตอนนี้** — องค์กรที่เริ่มก่อนได้เปรียบด้านการเรียนรู้และต้นทุนต่อหน่วยที่ลดลงเรื่อย ๆ
2. **แนวทางที่เสนอ** — เริ่มเล็ก วัดผลจริง ขยายเมื่อตัวชี้วัดถึงเกณฑ์
3. **ทรัพยากรที่ต้องใช้** — เจ้าของงาน 1 คน ทีมนำร่อง 3-5 คน และงบประมาณขั้นต้นที่จำกัดวงไว้ชัดเจน

## ตัวชี้วัดความสำเร็จ
- เวลาที่ประหยัดได้ต่อสัปดาห์
- คะแนนคุณภาพผลงานจาก QA (เป้าหมาย >= 80)
- ต้นทุนต่องานที่ลดลงเทียบกับก่อนเริ่ม

## ขั้นตอนถัดไป
1. อนุมัติโครงการนำร่อง
2. แต่งตั้งเจ้าของงานและทีม
3. เริ่มดำเนินการและรายงานผลทุก 2 สัปดาห์`;
    case "coder":
      return `# ต้นแบบสำหรับ: ${g}

## โครงสร้าง
\`\`\`
prototype/
  server.js      # API + event stream
  worker.js      # หน่วยประมวลผลงาน
  public/        # หน้าเว็บแสดงผล
\`\`\`

## โค้ดหลัก (ย่อ)
\`\`\`js
import http from "node:http";
const tasks = [];
http.createServer((req, res) => {
  if (req.url === "/api/tasks" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const task = { id: Date.now(), ...JSON.parse(body), status: "queued" };
      tasks.push(task);
      res.end(JSON.stringify(task));
    });
    return;
  }
  res.end(JSON.stringify(tasks));
}).listen(3000);
\`\`\`

## วิธีใช้งาน
1. \`node server.js\`
2. เรียก \`POST /api/tasks\` เพื่อสร้างงาน และ \`GET /api/tasks\` เพื่อดูสถานะ

## ข้อจำกัด / สิ่งที่ควรทำต่อ
- ยังเก็บข้อมูลในหน่วยความจำ ควรต่อฐานข้อมูลจริง
- ยังไม่มีการยืนยันตัวตน (auth)`;
    default:
      return `ผลงานสำหรับ "${task.title}" ภายใต้โจทย์ "${g}"`;
  }
}

const REJECT_REASONS = [
  "ขาดตัวอย่างประกอบที่เป็นรูปธรรม ควรเพิ่มกรณีตัวอย่างอย่างน้อย 1 กรณี",
  "ยังไม่ระบุขั้นตอนถัดไปที่วัดผลได้พร้อมกรอบเวลา",
  "ควรแยกบทสรุปผู้บริหารให้สั้นลงและชี้ข้อตัดสินใจให้ชัด",
  "ยังไม่ได้อ้างอิงข้อมูลจากทีมวิจัยให้ครบทุกชิ้น",
  "ตารางเปรียบเทียบยังไม่มีเกณฑ์ต้นทุน ควรเพิ่มคอลัมน์ต้นทุนโดยประมาณ",
  "ภาษายังปนศัพท์เทคนิคมาก ควรปรับให้ผู้บริหารอ่านเข้าใจได้โดยไม่ต้องมีพื้นฐาน",
];

function simReview(context) {
  const target = context.reviewTarget;
  const attempts = target?.attempts || 1;
  const passProb = attempts >= 2 ? 0.92 : 0.62;
  const approved = Math.random() < passProb;
  const score = approved ? Math.round(rand(72, 96)) : Math.round(rand(48, 68));
  const reasons = approved ? [] : [pick(REJECT_REASONS), pick(REJECT_REASONS)].filter((v, i, a) => a.indexOf(v) === i);
  return {
    approved,
    score,
    summary: approved
      ? `ผลงาน "${target?.title || ""}" ครบถ้วนตามโจทย์ โครงสร้างชัดเจน พร้อมส่งมอบ`
      : `ผลงาน "${target?.title || ""}" ยังไม่ผ่านเกณฑ์ มีจุดที่ต้องปรับ ${reasons.length} ข้อ`,
    feedback: reasons.map((r, i) => `${i + 1}. ${r}`).join("\n"),
  };
}

async function simRun({ agent, task, context, signal, onProgress }) {
  const role = workRole(agent, task);
  const phases = (role === agent.role && SIM_PHASES_BY_JOB[agent.jobId]) || SIM_PHASES[role] || SIM_PHASES.writer;
  const toolPhases = simToolPhases(role, context, agent);
  const output = role === "reviewer" ? "" : simOutput({ ...agent, role }, task, context);
  const review = role === "reviewer" ? simReview(context) : null;
  const finalText = review
    ? `คะแนน ${review.score}/100 — ${review.approved ? "ผ่าน ✅" : "ส่งกลับแก้ 🔁"}\n${review.summary}${review.feedback ? `\n\nสิ่งที่ต้องแก้:\n${review.feedback}` : ""}`
    : output;
  const totalMs = rand(7000, 14000) * (role === "reviewer" ? 0.6 : 1); // ก่อนหารด้วย speed
  const steps = 6;
  const toolUsage = { web_search_requests: 0, web_fetch_requests: 0 };
  let toolCalls = 0;
  for (let i = 0; i < phases.length; i++) {
    const phaseMs = (totalMs / phases.length) * rand(0.75, 1.25);
    for (let s = 0; s < steps; s++) {
      await sleep(phaseMs / steps / speed(), signal);
      const progress = (i + (s + 1) / steps) / phases.length;
      onProgress?.({ phase: phases[i], progress: Math.min(0.98, progress), text: finalText.slice(0, Math.floor(finalText.length * progress)), tool: null });
    }
    // จำลองการใช้เครื่องมือหลังเฟสนี้ (ลำดับเหตุการณ์เหมือนโหมด live: start → input → result)
    for (const tp of toolPhases.filter((t) => t.after === i)) {
      const progress = Math.min(0.98, (i + 1) / phases.length);
      const text = finalText.slice(0, Math.floor(finalText.length * progress));
      const meta = TOOL_META[tp.tool];
      const summary = tp.summary();
      toolCalls += 1;
      if (tp.tool === "web_search") toolUsage.web_search_requests += 1;
      if (tp.tool === "web_fetch") toolUsage.web_fetch_requests += 1;
      onProgress?.({ phase: meta.phase, tool: tp.tool, toolStarted: true, progress, text });
      await sleep(rand(250, 450) / speed(), signal);
      onProgress?.({ phase: `${meta.phase}: ${summary}`, tool: tp.tool, progress, text });
      await sleep(rand(900, 1700) / speed(), signal);
      onProgress?.({ phase: tp.result(summary), tool: tp.tool, progress, text });
      await sleep(rand(350, 600) / speed(), signal);
    }
  }
  const usage = {
    input_tokens: Math.round(rand(1200, 4200) + (context.inputs?.length || 0) * 800),
    output_tokens: Math.round(finalText.length / 3.2),
    ...(toolCalls ? { server_tool_use: toolUsage } : {}),
  };
  return { output: finalText, usage, model: agent.model, review, toolCalls };
}

/**
 * ทำงาน 1 ชิ้น
 * onProgress รับ { phase, progress, text, tool, toolStarted }:
 *   tool        = ชื่อเครื่องมือที่กำลังใช้ (null = ไม่ได้ใช้, undefined = ไม่เปลี่ยน)
 *   toolStarted = true เมื่อเริ่มใช้เครื่องมือครั้งใหม่ (orchestrator ใช้นับ task.toolCalls / agent.metrics.toolCalls)
 * @returns {{output:string, usage:object, model:string, review?:object, toolCalls:number}}
 */
export async function runTask(args) {
  return isLive() ? liveRun(args) : simRun(args);
}

// ====================================================================
// 3) การสังเคราะห์ผลลัพธ์สุดท้าย (Captain รวบรวม)
// ====================================================================
export async function synthesizeJob(job, tasks, { onPhase, signal } = {}) {
  const parts = tasks
    .filter((t) => t.status === "done")
    .map((t) => `## ${t.title} (${ROLES[t.role]?.label || t.role})\n${t.output}`);
  if (!isLive()) {
    for (const phase of ["กำลังรวบรวมผลงานจากทีม (Parrying)", "กำลังสังเคราะห์ข้อสรุป (Concentration)"]) {
      onPhase?.(phase);
      await sleep(rand(700, 1200) / speed(), signal);
    }
    const reviews = tasks.filter((t) => t.review).map((t) => `- ${t.title}: ${t.review.score}/100`);
    return {
      text: `# ผลลัพธ์สุดท้าย: ${job.goal}\n\n## บทสรุปจากกัปตัน\nทีมทำงานครบ ${tasks.length} ชิ้น ผ่านการตรวจคุณภาพแล้ว\n${reviews.join("\n")}\n\n${parts.join("\n\n")}`,
      usage: { input_tokens: 2500 + parts.length * 600, output_tokens: 900 },
    };
  }
  onPhase?.("กำลังสังเคราะห์ผลลัพธ์สุดท้าย");
  const { text, usage } = await llm.streamText({
    model: captain()?.model || CAPTAIN_MODEL,
    system: captainSystem(),
    prompt: `โจทย์จากผู้ใช้: "${job.goal}"\n\nผลงานทั้งหมดจากทีม:\n\n${parts.join("\n\n")}\n\nสังเคราะห์เป็นผลลัพธ์สุดท้ายฉบับสมบูรณ์สำหรับส่งมอบผู้ใช้ (ภาษาไทย) ให้ครบถ้วน อ่านง่าย มีบทสรุปผู้บริหารตอนต้น`,
    effort: captain()?.effort || "medium",
    maxTokens: 16000,
    signal,
    onText: () => onPhase?.("กำลังเขียนบทสรุปสุดท้าย"),
  });
  return { text, usage };
}

export { estimateCost };
