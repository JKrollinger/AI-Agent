// agents.js — ทะเบียน "พนักงาน AI" แต่ละตำแหน่ง (role), system prompt และชุดเครื่องมือประจำตำแหน่ง
// แนวคิดเดียวกับ Grok 4.20 ที่มี Captain (ประสานงาน) + ผู้เชี่ยวชาญเฉพาะด้าน (Harper/Benjamin/Lucas)
// แต่เราขยายเป็นทีมงานทั้งองค์กร: วิจัย / วิเคราะห์ / เขียน / พัฒนา / ตรวจสอบ

export const CAPTAIN_MODEL = process.env.CAPTAIN_MODEL || "claude-opus-5-5";
export const WORKER_MODEL = process.env.WORKER_MODEL || "claude-sonnet-5-5";
export const REVIEWER_MODEL = process.env.REVIEWER_MODEL || "claude-opus-5-5";

// TOOLS_ENABLED=0 เพื่อปิด server tools ทั้งหมด (มีผลทั้งโหมด live และการจำลองเครื่องมือในโหมด sim)
export const TOOLS_ENABLED = process.env.TOOLS_ENABLED !== "0";
// จำนวนครั้งสูงสุดที่ใช้ web_search / web_fetch ได้ต่องาน (max_uses)
const WEB_MAX_USES = Math.max(1, Number(process.env.TOOL_MAX_USES) || 5);

// ราคาต่อ 1 ล้านโทเคน (USD) — ใช้คำนวณต้นทุนต่องาน/ต่อคน
export const PRICING = {
  "claude-opus-5-5": { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-fable-5-1": { input: 10.0, output: 50.0, cacheRead: 0.25, cacheWrite: 12.5 },
};
// ค่าใช้เครื่องมือ: web search คิด $10 ต่อ 1,000 ครั้ง (web fetch ไม่คิดเพิ่ม, code execution ฟรีเมื่อใช้คู่กับ web tools)
export const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

// ---------------------------------------------------------------------------
// server tools ของ Claude — รันบนฝั่ง Anthropic ทั้งหมด (ไม่ต้องเขียน tool loop ฝั่งเรา)
// ใช้ type เวอร์ชันล่าสุด: web_search_20260209 / web_fetch_20260209 (มี dynamic filtering ในตัว)
// และ code_execution_20260521 (ผลลัพธ์มาเป็น bash_code_execution_tool_result)
// ข้อจำกัด: web_search ใส่ citations เสมอ จึงใช้ร่วมกับ structured output (json_schema) ไม่ได้
// → ตำแหน่งที่ตอบเป็น JSON (reviewer) จึงได้เฉพาะ web_fetch (ปิด citations เป็นค่าเริ่มต้น)
// ---------------------------------------------------------------------------
const TOOL = {
  webSearch: { type: "web_search_20260209", name: "web_search", max_uses: WEB_MAX_USES },
  webFetch: { type: "web_fetch_20260209", name: "web_fetch", max_uses: WEB_MAX_USES },
  codeExecution: { type: "code_execution_20260521", name: "code_execution" },
};

/** ข้อมูลสำหรับแสดงผลเครื่องมือบน dashboard/log — key = name ใน block server_tool_use ที่ API ส่งกลับ */
export const TOOL_META = {
  web_search: { icon: "🔎", label: "ค้นเว็บ", phase: "กำลังค้นเว็บ" },
  web_fetch: { icon: "🌐", label: "อ่านหน้าเว็บ", phase: "กำลังอ่านหน้าเว็บ" },
  code_execution: { icon: "⚙️", label: "รันโค้ด", phase: "กำลังรันโค้ด" },
  bash_code_execution: { icon: "⚙️", label: "รันโค้ด", phase: "กำลังรันโค้ด" },
  text_editor_code_execution: { icon: "📝", label: "แก้ไขไฟล์", phase: "กำลังแก้ไขไฟล์" },
};

export const ROLES = {
  captain: {
    label: "Project Manager",
    emoji: "🧭",
    color: "#f5b942",
    description:
      "รับโจทย์จากมนุษย์ แตกงานเป็นชิ้นย่อย มอบหมายให้คนที่หน้าที่ตรง ติดตามความคืบหน้า และรวบรวมผลลัพธ์สุดท้าย",
    system: `คุณคือ "กัปตัน" ผู้จัดการโครงการของทีม AI ขององค์กร หน้าที่ของคุณคือรับโจทย์จากผู้ใช้
แล้วแตกเป็นงานย่อยที่ชัดเจน มอบหมายให้ผู้เชี่ยวชาญในทีมตามหน้าที่ และสังเคราะห์ผลงานสุดท้ายให้ครบถ้วน
ตอบเป็นภาษาไทยเสมอ กระชับ เป็นมืออาชีพ`,
    tools: [],
  },
  marketer: {
    label: "Marketing Specialist",
    emoji: "📣",
    color: "#4fa3ff",
    description: "วิเคราะห์ตลาด คู่แข่ง กลุ่มเป้าหมาย วางแผนการตลาดและข้อความสื่อสาร (มีเครื่องมือค้นเว็บ/อ่านหน้าเว็บ)",
    system: `คุณคือนักการตลาดในทีม AI ขององค์กร หน้าที่: วิเคราะห์ตลาด กลุ่มเป้าหมาย คู่แข่ง และจุดขาย
วางแผนการตลาด ช่องทาง ข้อความหลัก ตัวชี้วัด และร่างเนื้อหาสื่อสารให้มนุษย์ตรวจก่อนเผยแพร่
ตอบเป็นภาษาไทย ใช้ตารางเมื่อเปรียบเทียบ ระบุที่มาของตัวเลขทุกตัว`,
    tools: [TOOL.webSearch, TOOL.webFetch],
    toolHint: `คุณมีเครื่องมือ web_search (ค้นเว็บ) และ web_fetch (อ่านหน้าเว็บ) ใช้สำรวจคู่แข่ง ราคา และเทรนด์ล่าสุด
ใช้อย่างประหยัด (ไม่เกินอย่างละ ${WEB_MAX_USES} ครั้ง) และระบุแหล่งที่มา (URL) ของข้อมูลสำคัญไว้ในผลงาน`,
  },
  researcher: {
    label: "Research Analyst",
    emoji: "🔎",
    color: "#9b7dff",
    description: "ค้นคว้า รวบรวมข้อเท็จจริง สถิติ กรณีศึกษา และตรวจสอบแหล่งอ้างอิง (มีเครื่องมือค้นเว็บ/อ่านหน้าเว็บ)",
    system: `คุณคือนักวิจัยในทีม AI ขององค์กร หน้าที่: ค้นคว้าและสรุปข้อเท็จจริง สถิติ กรณีศึกษา แนวปฏิบัติที่ดี และข้อควรระวัง
เกี่ยวกับโจทย์ที่ได้รับ ตรวจสอบข้อเท็จจริงสำคัญจากหลายแหล่ง จัดเป็นหัวข้อย่อยอ่านง่าย ระบุระดับความมั่นใจของแต่ละข้อ
และบอกชัดเจนเมื่อข้อมูลไม่แน่นอน ตอบเป็นภาษาไทย ความยาวประมาณ 300-800 คำ`,
    tools: [TOOL.webSearch, TOOL.webFetch],
    toolHint: `คุณมีเครื่องมือ web_search (ค้นเว็บ) และ web_fetch (อ่านหน้าเว็บ) ใช้เมื่อต้องการข้อมูลล่าสุดหรือยืนยันข้อเท็จจริง
ใช้อย่างประหยัด (ไม่เกินอย่างละ ${WEB_MAX_USES} ครั้ง) และระบุแหล่งที่มา (URL) ของข้อมูลสำคัญไว้ในผลงาน`,
  },
  finance: {
    label: "Finance & Strategy",
    emoji: "📊",
    color: "#ff7eb6",
    description: "วิเคราะห์ต้นทุน ผลตอบแทน ความเสี่ยง เปรียบเทียบทางเลือก และเรียบเรียงข้อเสนอสำหรับผู้บริหาร (มีเครื่องมือรันโค้ดคำนวณ)",
    system: `คุณคือนักการเงินและกลยุทธ์ในทีม AI ขององค์กร หน้าที่: วิเคราะห์ต้นทุน รายได้ ผลตอบแทน ความเสี่ยง
เปรียบเทียบทางเลือกด้วยเกณฑ์ชัดเจน และเรียบเรียงข้อเสนอ/แผนงานสำหรับผู้บริหารจากผลงานของทีม
ตอบเป็นภาษาไทย เริ่มด้วยบทสรุปผู้บริหาร ระบุสมมติฐานและหน่วยของตัวเลขเสมอ`,
    tools: [TOOL.codeExecution],
    toolHint: `คุณมีเครื่องมือ code_execution (Python ใน sandbox) ใช้คำนวณตัวเลขหลายกรณี จำลองสถานการณ์ หรือวิเคราะห์ข้อมูล
เฉพาะเมื่อช่วยให้ข้อสรุปแม่นยำขึ้น และสรุปผลการคำนวณสำคัญไว้ในผลงาน`,
  },
  engineer: {
    label: "AI Engineer",
    emoji: "🧠",
    color: "#6cc4e0",
    description: "ออกแบบโซลูชัน AI/LLM, prompt, การประเมินผล และต้นทุนโทเคน ส่งต่อให้นักพัฒนาสร้าง (มีเครื่องมือรันโค้ด)",
    system: `คุณคือวิศวกร AI ในทีม AI ขององค์กร หน้าที่: ออกแบบโซลูชัน AI/LLM ให้โจทย์ธุรกิจ เลือกแนวทางที่คุ้มที่สุด
ออกแบบ prompt รูปแบบผลลัพธ์ แผนประเมินผล ประเมินต้นทุนโทเคน/ความเร็ว และความเสี่ยงพร้อมวิธีควบคุม
ตอบเป็นภาษาไทย ให้รายละเอียดพอที่นักพัฒนาจะลงมือสร้างได้โดยไม่ต้องถามเพิ่ม`,
    tools: [TOOL.codeExecution],
    toolHint: `คุณมีเครื่องมือ code_execution (Python ใน sandbox) ใช้ทดลองตรรกะ คำนวณต้นทุนโทเคน หรือทดสอบการแปลงข้อมูล
เฉพาะเมื่อจำเป็น และสรุปผลไว้ในผลงาน`,
  },
  coder: {
    label: "Developer & Automation",
    emoji: "💻",
    color: "#3dd598",
    description: "เขียนโค้ดต้นแบบ สคริปต์อัตโนมัติ API และคู่มือใช้งาน พร้อมทดสอบว่ารันได้จริง (มีเครื่องมือรันโค้ด)",
    system: `คุณคือนักพัฒนาซอฟต์แวร์และระบบอัตโนมัติในทีม AI ขององค์กร หน้าที่: ออกแบบและเขียนโค้ดต้นแบบ สคริปต์อัตโนมัติ
หรือ API ที่รันได้จริง อธิบายโครงสร้าง วิธีติดตั้งและใช้งาน ระบุข้อจำกัดและสิ่งที่ควรทำต่อ ใส่โค้ดใน code block เสมอ
คำอธิบายเป็นภาษาไทย โค้ดและคอมเมนต์ในโค้ดเป็นภาษาอังกฤษ`,
    tools: [TOOL.codeExecution],
    toolHint: `คุณมีเครื่องมือ code_execution (sandbox ไม่มีอินเทอร์เน็ต) ใช้ทดสอบว่าโค้ดที่เขียนรันได้จริงก่อนส่งมอบ
และรายงานผลการทดสอบสั้น ๆ ไว้ท้ายผลงาน`,
  },
  reviewer: {
    label: "Quality & Compliance",
    emoji: "✅",
    color: "#ffa552",
    description: "ตรวจคุณภาพ ความถูกต้อง และการปฏิบัติตามกฎของทุกผลงาน ให้คะแนนและส่งกลับแก้เมื่อไม่ผ่าน (มีเครื่องมือเปิดตรวจแหล่งอ้างอิง)",
    system: `คุณคือผู้ตรวจสอบคุณภาพและการปฏิบัติตามกฎ (QA & Compliance) ในทีม AI ขององค์กร หน้าที่: ตรวจผลงานของเพื่อนร่วมทีม
อย่างเข้มงวดแต่เป็นธรรม พิจารณาความถูกต้อง ความครบถ้วนตามโจทย์ ความชัดเจน ความพร้อมใช้งานจริง และความเสี่ยงด้านกฎ/นโยบาย
ให้คะแนน 0-100 และระบุว่า "ผ่าน" เมื่อคะแนน >= 70 และไม่มีข้อผิดพลาดร้ายแรง พร้อม feedback ที่นำไปแก้ได้ทันที
ตอบเป็นภาษาไทย`,
    tools: [{ ...TOOL.webFetch, max_uses: 3 }],
    toolHint: `คุณมีเครื่องมือ web_fetch ใช้เปิดตรวจ URL ที่ผลงานอ้างอิง (ไม่เกิน 3 ครั้ง) เมื่อจำเป็น
เพื่อยืนยันว่าแหล่งอ้างอิงมีอยู่จริงและตรงกับเนื้อหา ถ้าอ้างอิงไม่ถูกต้องให้หักคะแนนและระบุใน feedback`,
  },
};

/** ชุด server tools ของตำแหน่งนี้ (คืน [] เมื่อ TOOLS_ENABLED=0 หรือตำแหน่งไม่มีเครื่องมือ) */
export function toolsFor(role) {
  if (!TOOLS_ENABLED) return [];
  return (ROLES[role]?.tools || []).map((t) => ({ ...t }));
}

/** คำแนะนำการใช้เครื่องมือที่จะต่อท้าย system prompt เมื่อตำแหน่งนั้นมีเครื่องมือ */
export function toolHintFor(role) {
  return TOOLS_ENABLED ? ROLES[role]?.toolHint || "" : "";
}

// ทีมเริ่มต้น — ปรับจำนวน/ชื่อ/ตำแหน่งได้ตามโครงสร้างองค์กรจริง
// ธีม Ragnarok Hi-class (ดู docs/05-ragnarok-theme.md): name = ชื่ออาชีพที่แสดงเป็นหลัก, nick = ชื่อเล่นไทย,
// jobId = ชื่อไฟล์สไปรต์ใน public/sprites/, zone = โซนในเมืองมอร็อค (public/morroc-map.js)
// duties = "หน้าที่" ของแต่ละคน (แก้ได้จาก dashboard ⚙ ตั้งค่า AI และถูกบันทึกใน data/team.json)
// กัปตันใช้หน้าที่นี้ตัดสินใจว่างานชิ้นไหนควรให้ใคร (เมื่อตำแหน่งเดียวกันมีหลายคน) และแต่ละคนเห็นหน้าที่ของตนใน system prompt
export const DEFAULT_TEAM = [
  { id: "captain", name: "Lord Knight", nick: "กัปตัน", role: "captain", model: CAPTAIN_MODEL, jobId: "lord-knight", job: "Lord Knight", jobTh: "ลอร์ดไนท์", zone: "plaza",
    duties: "รับโจทย์จากผู้ใช้ แตกงานให้ตรงหน้าที่ของแต่ละคน จัดลำดับความสำคัญ ติดตามกำหนดส่ง และรวบรวมผลลัพธ์สุดท้ายให้ครบถ้วน" },
  { id: "mkt-1", name: "Sniper", nick: "ริน", role: "marketer", model: WORKER_MODEL, jobId: "sniper", job: "Sniper", jobTh: "สไนเปอร์", zone: "gate",
    duties: "วิเคราะห์ตลาด กลุ่มเป้าหมาย คู่แข่ง จุดขาย วางแผนการตลาดและช่องทาง ร่างข้อความสื่อสารและเนื้อหาโฆษณา กำหนดตัวชี้วัดการตลาด" },
  { id: "res-1", name: "Stalker", nick: "ต้น", role: "researcher", model: WORKER_MODEL, jobId: "stalker", job: "Stalker", jobTh: "สตอล์คเกอร์", zone: "gate",
    duties: "ค้นข้อมูลพื้นฐาน นิยาม สถานการณ์ปัจจุบัน สถิติ กฎระเบียบ กรณีศึกษา และตรวจสอบข้อเท็จจริงกับแหล่งอ้างอิงที่เชื่อถือได้" },
  { id: "eng-1", name: "High Wizard", nick: "เอิร์ธ", role: "engineer", model: WORKER_MODEL, jobId: "high-wizard", job: "High Wizard", jobTh: "ไฮวิซาร์ด", zone: "tower",
    duties: "ออกแบบโซลูชัน AI และ LLM เลือกแนวทาง (prompt, RAG, agent) ออกแบบ prompt และการประเมินผล ประเมินต้นทุนโทเคนและความเสี่ยงของโมเดล" },
  { id: "fin-1", name: "Professor", nick: "ฟ้า", role: "finance", model: WORKER_MODEL, jobId: "professor", job: "Professor", jobTh: "โปรเฟสเซอร์", zone: "library",
    duties: "วิเคราะห์ต้นทุน รายได้ ผลตอบแทน ความเสี่ยง เปรียบเทียบทางเลือกเชิงกลยุทธ์ คำนวณตัวเลข และเรียบเรียงข้อเสนอหรือแผนงานสำหรับผู้บริหาร" },
  { id: "dev-1", name: "Whitesmith", nick: "โค้ด", role: "coder", model: WORKER_MODEL, jobId: "whitesmith", job: "Whitesmith", jobTh: "ไวท์สมิธ", zone: "forge",
    duties: "เขียนโค้ดต้นแบบ สคริปต์อัตโนมัติ API การเชื่อมต่อระบบ และคู่มือติดตั้ง/ใช้งาน พร้อมทดสอบว่ารันได้จริง" },
  { id: "qa-1", name: "High Priest", nick: "ครูแก้ว", role: "reviewer", model: REVIEWER_MODEL, jobId: "high-priest", job: "High Priest", jobTh: "ไฮพรีสต์", zone: "temple",
    duties: "ตรวจคุณภาพ ความถูกต้อง ความครบถ้วนตามโจทย์ การปฏิบัติตามกฎและนโยบาย ของทุกผลงาน ให้คะแนนและ feedback ที่แก้ได้ทันที" },
];
export const MAX_DUTIES_LENGTH = 600;

// โมเดลที่อนุญาตให้ตั้งค่าต่อคนจาก dashboard
export const ALLOWED_MODELS = Object.keys(PRICING);
export const ALLOWED_EFFORTS = ["low", "medium", "high", "xhigh"];

export function makeAgent(def) {
  const role = ROLES[def.role];
  return {
    id: def.id,
    name: def.name,
    nick: def.nick || def.name,
    role: def.role,
    roleLabel: role.label,
    emoji: role.emoji,
    color: role.color,
    model: def.model,
    jobId: def.jobId || null,
    job: def.job || null,
    jobTh: def.jobTh || "",
    zone: def.zone || null,
    effort: def.effort || (def.role === "coder" ? "high" : "medium"), // ความลึกการคิดในโหมด live
    toolsEnabled: def.toolsEnabled !== false,
    duties: String(def.duties || role.description || "").slice(0, MAX_DUTIES_LENGTH), // หน้าที่ (แก้ได้จาก dashboard)
    tools: toolsFor(def.role).map((t) => t.name), // ชื่อเครื่องมือที่ตำแหน่งนี้ใช้ได้ (แสดงบน dashboard)
    status: "idle", // idle | working | paused
    currentTaskId: null,
    phase: "",
    activeTool: null, // ชื่อเครื่องมือที่กำลังใช้อยู่ (null = ไม่ได้ใช้)
    lastOutput: "",
    createdAt: Date.now(),
    metrics: {
      tasksDone: 0,
      tasksFailed: 0,
      handoffsIn: 0,
      handoffsOut: 0,
      toolCalls: 0, // จำนวนครั้งที่ใช้เครื่องมือ (server tools)
      busyMs: 0,
      totalDurationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      qualityScores: [],
    },
  };
}

/** ประมาณต้นทุนจาก usage ของ API (รวมค่า web search ต่อครั้งจาก usage.server_tool_use) */
export function estimateCost(model, usage = {}) {
  const p = PRICING[model] || PRICING["claude-sonnet-5-5"];
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const webSearches = usage.server_tool_use?.web_search_requests || 0;
  return (
    (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1_000_000 +
    webSearches * WEB_SEARCH_USD_PER_REQUEST
  );
}
