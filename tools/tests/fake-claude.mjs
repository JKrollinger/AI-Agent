#!/usr/bin/env node
// fake-claude.mjs — เลียนแบบ `claude -p --output-format stream-json` สำหรับทดสอบ adapter (server/apply.js) โดยไม่เรียก API จริง
// ใช้ผ่าน CLAUDE_BIN=<พาธไฟล์นี้>  (apply.js รันไฟล์ .mjs ด้วย node ให้เอง)
// ควบคุมพฤติกรรมด้วย env:
//   FAKE_CLAUDE_EDITS   JSON [{ path, content | append | delete }] = ไฟล์ที่จะแก้ใน cwd (sandbox)
//   FAKE_CLAUDE_LOG     ไฟล์ที่บันทึก argv + prompt ที่ได้รับ (ไว้ assert)
//   FAKE_CLAUDE_SLEEP   หน่วง ms ก่อนตอบ (ทดสอบ timeout/ยกเลิก)
//   FAKE_CLAUDE_NO_RESULT=1  จบโดยไม่ส่ง result (จำลอง crash), FAKE_CLAUDE_ERROR=1 ส่ง is_error
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("9.9.9 (fake-claude)"); process.exit(0); }
let prompt = "";
for await (const c of process.stdin) prompt += c;
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, prompt }) + "\n", "utf8");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
emit({ type: "system", subtype: "init", session_id: "fake-session", model: "claude-fake-1", tools: ["Read", "Edit", "Write", "Bash"] });
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP || 0);
if (sleep) await new Promise((r) => setTimeout(r, sleep));
const cwd = process.cwd();
const edits = JSON.parse(process.env.FAKE_CLAUDE_EDITS || "[]");
for (const e of edits) {
  const abs = path.join(cwd, e.path);
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: e.delete ? "Bash" : "Edit", input: e.delete ? { command: `rm ${e.path}` } : { file_path: abs } }] } });
  if (e.delete) fs.rmSync(abs, { force: true });
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (e.append) fs.appendFileSync(abs, e.append, "utf8");
    else fs.writeFileSync(abs, e.content ?? "", "utf8");
  }
}
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "แก้ไฟล์เสร็จแล้ว (fake)" }] } });
if (process.env.FAKE_CLAUDE_NO_RESULT === "1") process.exit(1);
emit({
  type: "result",
  subtype: process.env.FAKE_CLAUDE_SUBTYPE || "success",
  is_error: process.env.FAKE_CLAUDE_ERROR === "1",
  result: "สรุป: แก้ไฟล์ตามโจทย์แล้ว (fake) — ทดสอบด้วย npm test",
  duration_ms: 1234,
  num_turns: edits.length + 1,
  total_cost_usd: 0.0123,
  usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 500 },
  modelUsage: { "claude-fake-1": { inputTokens: 1000, outputTokens: 200 } },
  permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf /" } }],
  session_id: "fake-session",
});
