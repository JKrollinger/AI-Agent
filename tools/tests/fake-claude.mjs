#!/usr/bin/env node
// fake-claude.mjs — เลียนแบบ `claude -p --output-format stream-json --verbose` ของ Claude Code 2.1.157 (เทียบกับของจริงเมื่อ 2026-10-20)
// สำหรับทดสอบ adapter (server/apply.js) โดยไม่เรียก API จริง — ใช้ผ่าน CLAUDE_BIN=<พาธไฟล์นี้> (apply.js รันไฟล์ .mjs ด้วย node ให้เอง)
// ลำดับ event ของจริง: system/hook_started+hook_response (hook ของ setting ผู้ใช้/plugin ถ้ามี) → system/init → assistant(thinking) → assistant(tool_use)
//   → rate_limit_event → user(tool_result) → … → assistant(text) → result (สำเร็จ: subtype success + result; หยุดเพราะงบ/ข้อผิดพลาด: is_error + errors[] ไม่มี result)
// ควบคุมพฤติกรรมด้วย env:
//   FAKE_CLAUDE_EDITS   JSON [{ path, content | append | delete }] = ไฟล์ที่จะแก้ใน cwd (sandbox)
//   FAKE_CLAUDE_LOG     ไฟล์ที่บันทึก argv + prompt ที่ได้รับ (ไว้ assert)
//   FAKE_CLAUDE_SLEEP   หน่วง ms ก่อนตอบ (ทดสอบ timeout/ยกเลิก)
//   FAKE_CLAUDE_NO_RESULT=1  จบโดยไม่ส่ง result (จำลอง crash)
//   FAKE_CLAUDE_ERROR=1      จบแบบ is_error (subtype จาก FAKE_CLAUDE_SUBTYPE หรือ error_max_budget_usd): เหมือนของจริง ไม่มี field result, มี errors[],
//                            และ result.usage เป็นแค่ turn แรก (modelUsage ยังเป็นยอดรวม)
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("9.9.9 (fake-claude)"); process.exit(0); }
let prompt = "";
for await (const c of process.stdin) prompt += c;
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args, prompt }) + "\n", "utf8");
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const SID = "fake-session", MODEL = "claude-fake-1", cwd = process.cwd();
let seq = 0;
const uuid = () => `fake-uuid-${++seq}`;
const firstTurnUsage = { input_tokens: 22, cache_creation_input_tokens: 500, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 500 }, output_tokens: 2, service_tier: "standard", inference_geo: "global", speed: "standard" };
const laterTurnUsage = { input_tokens: 32, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 16, service_tier: "standard", inference_geo: "global", speed: "standard" };
let msgs = 0;
const assistant = (content) => emit({ type: "assistant", message: { model: MODEL, id: `msg_fake_${++msgs}`, type: "message", role: "assistant", content, stop_reason: null, stop_sequence: null, usage: msgs === 1 ? firstTurnUsage : laterTurnUsage }, parent_tool_use_id: null, session_id: SID, uuid: uuid() });

emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup", hook_event: "SessionStart", hook_id: "fake-hook-1", uuid: uuid(), session_id: SID });
emit({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", hook_event: "SessionStart", hook_id: "fake-hook-1", output: "", exit_code: 0, uuid: uuid(), session_id: SID });
emit({ type: "system", subtype: "init", cwd, session_id: SID, tools: ["Edit", "Glob", "Grep", "Read", "Write", "Bash"], mcp_servers: [], model: MODEL, permissionMode: "dontAsk", slash_commands: [], apiKeySource: "none", claude_code_version: "9.9.9", output_style: "default", agents: [], skills: [], plugins: [], analytics_disabled: false, product_feedback_disabled: false, uuid: uuid(), memory_paths: [], fast_mode_state: "off" });
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP || 0);
if (sleep) await new Promise((r) => setTimeout(r, sleep));
const edits = JSON.parse(process.env.FAKE_CLAUDE_EDITS || "[]");
assistant([{ type: "thinking", thinking: "วางแผนแก้ไฟล์ตามโจทย์ (fake)", signature: "" }]);
let n = 0;
for (const e of edits) {
  const abs = path.join(cwd, e.path);
  const id = `toolu_fake_${++n}`;
  assistant([{ type: "tool_use", id, name: e.delete ? "Bash" : "Edit", input: e.delete ? { command: `rm ${e.path}` } : { file_path: abs } }]);
  if (n === 1) emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 0, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false }, uuid: uuid(), session_id: SID });
  if (e.delete) fs.rmSync(abs, { force: true });
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (e.append) fs.appendFileSync(abs, e.append, "utf8");
    else fs.writeFileSync(abs, e.content ?? "", "utf8");
  }
  emit({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: e.delete ? "" : `The file ${abs} has been updated.` }] }, parent_tool_use_id: null, session_id: SID, uuid: uuid(), timestamp: new Date().toISOString(), tool_use_result: {} });
}
assistant([{ type: "text", text: "แก้ไฟล์เสร็จแล้ว (fake)" }]);
if (process.env.FAKE_CLAUDE_NO_RESULT === "1") process.exit(1);
const isError = process.env.FAKE_CLAUDE_ERROR === "1";
const totalUsage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 200, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: "standard", cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 }, inference_geo: "global", iterations: [], speed: "standard" };
emit({
  type: "result",
  subtype: isError ? process.env.FAKE_CLAUDE_SUBTYPE || "error_max_budget_usd" : "success",
  duration_ms: 1234,
  duration_api_ms: 900,
  is_error: isError,
  num_turns: edits.length + 1,
  stop_reason: isError ? "tool_use" : "end_turn",
  session_id: SID,
  total_cost_usd: 0.0123,
  usage: isError ? firstTurnUsage : totalUsage,
  modelUsage: { [MODEL]: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 500, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0123, contextWindow: 200000, maxOutputTokens: 32000 } },
  permission_denials: [{ tool_name: "Bash", tool_use_id: "toolu_fake_denied", tool_input: { command: "rm -rf /" } }],
  fast_mode_state: "off",
  uuid: uuid(),
  ...(isError ? { errors: ["Reached maximum budget ($1)"] } : { result: "สรุป: แก้ไฟล์ตามโจทย์แล้ว (fake) — ทดสอบด้วย npm test", errors: [] }),
});
