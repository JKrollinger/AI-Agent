// smoke-live.mjs — ทดสอบเส้นทาง LIVE กับ API จริงด้วยคำขอเล็ก ๆ บน claude-haiku-5-5 (ราคาไม่กี่เซนต์)
// ตรวจ 3 อย่างพร้อมกัน: system prompt แบบหลายบล็อก + cache_control, beta server-side fallback, และการนับ usage/แคช
// ใช้: node --env-file-if-exists=.env tools/smoke-live.mjs
import { streamText, liveAvailable } from "../server/llm.js";

if (!liveAvailable()) {
  console.error("✖ ไม่มี ANTHROPIC_API_KEY (ตั้งใน .env หรือ environment ก่อน)");
  process.exit(1);
}
const model = process.env.SMOKE_MODEL || "claude-haiku-5-5";
// บล็อกยาวพอให้เกินขั้นต่ำของ prompt cache (หลายพันโทเคน) — ข้อความไทยซ้ำ ๆ ไม่มีค่าอะไร
const filler = "บริบทโปรเจกต์ทดสอบ: ระบบศูนย์ควบคุมพนักงาน AI ของเรามีกัปตันและทีม 6 ตำแหน่ง ".repeat(260);
const system = [
  { type: "text", text: "คุณคือผู้ช่วยทดสอบระบบ ตอบสั้นที่สุด" },
  { type: "text", text: filler, cache_control: { type: "ephemeral" } },
];
async function once(n) {
  const t0 = Date.now();
  const r = await streamText({ model, system, prompt: "ตอบคำเดียวว่า: พร้อม", effort: "low", maxTokens: 64 });
  const u = r.usage || {};
  console.log(`ครั้งที่ ${n}: โมเดลที่ตอบ ${r.model} | ${Date.now() - t0} ms | input ${u.input_tokens} | cache_write ${u.cache_creation_input_tokens || 0} | cache_read ${u.cache_read_input_tokens || 0} | output ${u.output_tokens} | ตอบ: ${r.text.trim().slice(0, 40)}`);
  return u;
}
const a = await once(1);
const b = await once(2);
if ((b.cache_read_input_tokens || 0) > 0) console.log("✔ prompt cache ทำงาน (ครั้งที่ 2 อ่านจากแคช)");
else console.log("⚠ ครั้งที่ 2 ไม่ได้อ่านจากแคช — บล็อกอาจสั้นกว่าขั้นต่ำของโมเดล หรือ PROMPT_CACHE=0");
