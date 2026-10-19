// llm.js — ตัวกลางเรียก Claude ผ่าน Anthropic SDK (โหมด live)
// ใช้ streaming เสมอ เพื่อให้ dashboard เห็นความคืบหน้าแบบเรียลไทม์
// รองรับ server tools ของ Claude (web_search / web_fetch / code_execution) ซึ่งรันฝั่ง Anthropic
// ไม่ต้องมี tool loop ฝั่งเรา — แค่ส่ง tools ไปใน params แล้วอ่านผลจาก content block ที่ stream กลับมา
// และจัดการ stop_reason "pause_turn" (ฝั่ง server หยุดพักหลังใช้เครื่องมือหลายรอบ) ด้วยการต่อ turn ให้จนจบ
import Anthropic from "@anthropic-ai/sdk";

let client = null;
const MAX_CONTINUATIONS = 5; // จำนวนครั้งสูงสุดที่จะต่อ turn หลัง pause_turn (กันวนไม่รู้จบ)

/** มี credentials สำหรับโหมด live หรือไม่ (API key หรือ auth token ใน environment) */
export function liveAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient() {
  if (!client) {
    // อ่าน ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN จาก environment เอง
    client = new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
  }
  return client;
}

// โมเดลที่รองรับ server-side fallback (ถ้าถูก safety classifier ปฏิเสธ ระบบจะลองโมเดลสำรองให้เอง)
const SERVER_FALLBACK_MODELS = new Set([
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-fable-5",
]);

function translateError(err) {
  if (err instanceof Anthropic.APIUserAbortError) {
    return Object.assign(new Error("งานถูกยกเลิก"), { name: "AbortError" });
  }
  if (err instanceof Anthropic.AuthenticationError) return new Error("API key ไม่ถูกต้องหรือหมดอายุ (ตรวจ ANTHROPIC_API_KEY)");
  if (err instanceof Anthropic.PermissionDeniedError) return new Error("บัญชีนี้ไม่มีสิทธิ์ใช้โมเดลที่เลือก");
  if (err instanceof Anthropic.RateLimitError) return new Error("ถูกจำกัดอัตราการเรียกใช้ (rate limit) — จะลองใหม่");
  if (err instanceof Anthropic.BadRequestError) return new Error(`คำขอไม่ถูกต้อง: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError) return new Error("เชื่อมต่อ API ไม่ได้ (เครือข่าย/timeout)");
  if (err instanceof Anthropic.APIError) return new Error(`API error ${err.status}: ${err.message}`);
  return err;
}

// ====================================================================
// server tools: แปลง event ระหว่าง stream เป็นข้อความสั้น ๆ สำหรับ dashboard
// ====================================================================
// block ผลลัพธ์ของเครื่องมือ → ชื่อเครื่องมือที่ใช้ (ตรงกับ name ใน server_tool_use)
const RESULT_BLOCK_TOOL = {
  web_search_tool_result: "web_search",
  web_fetch_tool_result: "web_fetch",
  bash_code_execution_tool_result: "bash_code_execution",
  text_editor_code_execution_tool_result: "text_editor_code_execution",
  code_execution_tool_result: "code_execution",
};

const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "");
  } catch {
    return String(url || "").slice(0, 60);
  }
};
const oneLine = (s, n = 80) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** สรุป input ของ server_tool_use (เรียกหลังรับ input_json_delta ครบแล้ว) */
function summarizeInput(name, input = {}) {
  switch (name) {
    case "web_search":
      return oneLine(input.query);
    case "web_fetch":
      return hostOf(input.url);
    case "bash_code_execution":
      return oneLine(input.command, 60);
    case "text_editor_code_execution":
      return oneLine(`${input.command || ""} ${input.path || ""}`, 60);
    case "code_execution":
      return oneLine(input.code, 60);
    default:
      return "";
  }
}

/** สรุปผลลัพธ์ของเครื่องมือ — block ผลลัพธ์มาครบในเหตุการณ์ content_block_start */
function summarizeResult(block) {
  const c = block.content;
  switch (block.type) {
    case "web_search_tool_result":
      // สำเร็จ = array ของ web_search_result, ผิดพลาด = object { error_code } (HTTP 200 ไม่ throw)
      return Array.isArray(c)
        ? { ok: true, summary: `พบผลค้นหา ${c.length} รายการ` }
        : { ok: false, summary: `ค้นเว็บไม่สำเร็จ (${c?.error_code || "error"})` };
    case "web_fetch_tool_result":
      return c?.type === "web_fetch_result"
        ? { ok: true, summary: `อ่าน ${hostOf(c.url)} แล้ว` }
        : { ok: false, summary: `อ่านหน้าเว็บไม่สำเร็จ (${c?.error_code || "error"})` };
    case "bash_code_execution_tool_result":
      if (c?.type === "bash_code_execution_result") {
        return c.return_code === 0
          ? { ok: true, summary: "รันโค้ดสำเร็จ" }
          : { ok: false, summary: `รันโค้ดผิดพลาด (exit ${c.return_code})` };
      }
      return { ok: false, summary: `รันโค้ดไม่สำเร็จ (${c?.error_code || "error"})` };
    case "text_editor_code_execution_tool_result":
      return c?.error_code ? { ok: false, summary: `แก้ไขไฟล์ไม่สำเร็จ (${c.error_code})` } : { ok: true, summary: "จัดการไฟล์แล้ว" };
    default:
      return { ok: true, summary: "" };
  }
}

/** รวม usage จากหลาย request (กรณีต่อ turn หลัง pause_turn) */
export function mergeUsage(acc, u) {
  if (!u) return acc;
  const out = { ...(acc || {}) };
  for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    if (typeof u[k] === "number") out[k] = (out[k] || 0) + u[k];
  }
  if (u.cache_creation) { // รายละเอียดการเขียนแคชแยกตาม ttl (ใช้คิดราคา 1h)
    out.cache_creation = {
      ephemeral_5m_input_tokens: (out.cache_creation?.ephemeral_5m_input_tokens || 0) + (u.cache_creation.ephemeral_5m_input_tokens || 0),
      ephemeral_1h_input_tokens: (out.cache_creation?.ephemeral_1h_input_tokens || 0) + (u.cache_creation.ephemeral_1h_input_tokens || 0),
    };
  }
  if (u.server_tool_use) {
    out.server_tool_use = {
      web_search_requests: (out.server_tool_use?.web_search_requests || 0) + (u.server_tool_use.web_search_requests || 0),
      web_fetch_requests: (out.server_tool_use?.web_fetch_requests || 0) + (u.server_tool_use.web_fetch_requests || 0),
    };
  }
  return out;
}

/**
 * สร้าง system prompt แบบหลายบล็อก (ใช้ prompt cache): บล็อกสุดท้ายได้ cache_control ยกเว้นตั้ง PROMPT_CACHE=0
 * @param {Array<string|null|undefined>} parts  ข้อความแต่ละบล็อก (ว่าง/null ถูกตัดทิ้ง)
 * @returns {Array<{type:"text", text:string, cache_control?:object}>|string}
 */
const cacheControl = (ttl) => ({ type: "ephemeral", ...(ttl === "1h" ? { ttl: "1h" } : {}) }); // 1h ใช้ได้โดยไม่ต้องมี beta header (เขียนแคชแพงกว่า 5m)
export function systemBlocks(parts, { ttl = "5m" } = {}) {
  // part เป็น string (ไม่ทำเครื่องหมาย) หรือ { text, cache: true } (ขอ breakpoint ที่บล็อกนี้) — ถ้าไม่มีใครขอเลย ใช้บล็อกสุดท้าย
  const items = (parts || [])
    .map((p) => (p && typeof p === "object" ? { text: String(p.text || "").trim(), cache: Boolean(p.cache) } : { text: typeof p === "string" ? p.trim() : "", cache: false }))
    .filter((p) => p.text);
  if (!items.length) return "";
  const blocks = items.map((p) => ({ type: "text", text: p.text }));
  if (process.env.PROMPT_CACHE !== "0") {
    const marked = items.map((p, i) => (p.cache ? i : -1)).filter((i) => i >= 0);
    for (const i of marked.length ? marked.slice(-3) : [blocks.length - 1]) blocks[i].cache_control = cacheControl(ttl); // ไม่เกิน 3 ใน system (+1 ใน user) = ลิมิต 4 ของ API
  }
  return blocks;
}

/** บล็อกข้อมูลอ้างอิงฝั่ง user (เช่น <project_files>) ที่ให้ cache ได้ */
export function cachedTextBlock(text, { ttl = "5m" } = {}) {
  const block = { type: "text", text: String(text) };
  if (process.env.PROMPT_CACHE !== "0") block.cache_control = cacheControl(ttl);
  return block;
}

/** นับโทเคนจริงของคำขอ (ฟรี) — ใช้ดูว่าบริบทโปรเจกต์กินเท่าไร */
export async function countTokens({ model, system, messages, tools }) {
  const params = { model, messages, ...(system ? { system } : {}), ...(tools?.length ? { tools } : {}) };
  const r = await getClient().messages.countTokens(params);
  return r.input_tokens;
}

/**
 * เรียกโมเดลแบบ streaming (รองรับ server tools และต่อ turn อัตโนมัติเมื่อ pause_turn)
 * system รับได้ทั้ง string และ array ของ text block (จาก systemBlocks) ; prompt รับได้ทั้ง string และ array ของ content block
 * @param {object} opts
 * @param {string} opts.model
 * @param {string} opts.system
 * @param {string} opts.prompt
 * @param {"low"|"medium"|"high"|"xhigh"|"max"} [opts.effort]
 * @param {number} [opts.maxTokens]
 * @param {object} [opts.outputSchema]  JSON schema → บังคับให้ตอบเป็น JSON ตาม schema
 * @param {object[]} [opts.tools]       server tools ของ Claude เช่น { type: "web_search_20260209", name: "web_search", max_uses: 5 }
 * @param {AbortSignal} [opts.signal]
 * @param {(fullText:string, delta:string)=>void} [opts.onText]
 * @param {(summary:string)=>void} [opts.onThinking]
 * @param {(ev:{name:string, phase:"start"|"input"|"result"|"continue", summary:string, input?:object, ok?:boolean})=>void} [opts.onTool]
 *   start    = โมเดลเริ่มเรียกเครื่องมือ (ยังไม่รู้ input)
 *   input    = รับ input ครบแล้ว (summary = คำค้น / โดเมน / คำสั่ง)
 *   result   = ได้ผลลัพธ์กลับมา (summary = สรุปผล, ok = สำเร็จหรือไม่)
 *   continue = ต่อ turn ใหม่หลัง pause_turn
 * @returns {Promise<{text:string, thinking:string, usage:object, model:string, stopReason:string, toolCalls:number}>}
 */
export async function streamText({
  model,
  system,
  prompt,
  effort = "medium",
  maxTokens = 16000,
  outputSchema,
  tools = [],
  signal,
  onText,
  onThinking,
  onTool,
}) {
  // structured output ใช้ร่วมกับ citations ไม่ได้ (API ตอบ 400) และ web_search ใส่ citations เสมอ
  // → ถ้ามี schema ให้ตัด web_search ออก (web_fetch ปิด citations เป็นค่าเริ่มต้น จึงใช้ได้)
  const toolList = (tools || []).filter((t) => !(outputSchema && t.name === "web_search"));
  const messages = [{ role: "user", content: prompt }];
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: {
      effort,
      ...(outputSchema ? { format: { type: "json_schema", schema: outputSchema } } : {}),
    },
    ...(toolList.length ? { tools: toolList } : {}),
  };
  const useBeta = SERVER_FALLBACK_MODELS.has(model);
  const openStream = () =>
    useBeta
      ? getClient().beta.messages.stream(
          { ...params, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" },
          { signal },
        )
      : getClient().messages.stream(params, { signal });

  let text = "";
  let thinking = "";
  let usage = null;
  let final = null;
  let toolCalls = 0;

  try {
    for (let turn = 0; ; turn++) {
      const stream = openStream();
      const pending = new Map(); // index ของ block → { name, json } ของ server_tool_use ที่กำลังรับ input

      for await (const event of stream) {
        switch (event.type) {
          case "content_block_start": {
            const cb = event.content_block;
            if (cb.type === "server_tool_use") {
              // input ของ server_tool_use มาทีหลังเป็น input_json_delta → เริ่มสะสมไว้ก่อน
              pending.set(event.index, { name: cb.name, json: "" });
              toolCalls += 1;
              onTool?.({ name: cb.name, phase: "start", summary: "", input: null });
            } else if (RESULT_BLOCK_TOOL[cb.type]) {
              const r = summarizeResult(cb);
              onTool?.({ name: RESULT_BLOCK_TOOL[cb.type], phase: "result", summary: r.summary, ok: r.ok });
            }
            break;
          }
          case "content_block_delta": {
            const d = event.delta;
            if (d.type === "text_delta") {
              text += d.text;
              onText?.(text, d.text);
            } else if (d.type === "thinking_delta") {
              thinking += d.thinking;
              onThinking?.(thinking);
            } else if (d.type === "input_json_delta") {
              const p = pending.get(event.index);
              if (p) p.json += d.partial_json;
            }
            break;
          }
          case "content_block_stop": {
            const p = pending.get(event.index);
            if (p) {
              pending.delete(event.index);
              let input = {};
              try {
                input = p.json ? JSON.parse(p.json) : {};
              } catch {
                input = {};
              }
              onTool?.({ name: p.name, phase: "input", summary: summarizeInput(p.name, input), input });
            }
            break;
          }
          default:
            break;
        }
      }

      final = await stream.finalMessage();
      usage = mergeUsage(usage, final.usage);

      if (final.stop_reason !== "pause_turn") break;
      if (turn >= MAX_CONTINUATIONS) {
        text += "\n\n[หยุดต่อ turn เพราะใช้เครื่องมือหลายรอบเกินกำหนด]";
        break;
      }
      // pause_turn: ส่ง content ของ assistant กลับไปทั้งก้อน (รวม server_tool_use/ผลลัพธ์/thinking)
      // ห้ามเพิ่ม user message เช่น "ทำต่อ" — API เห็น block ท้ายสุดเป็น server tool แล้วจะทำต่อให้เอง
      messages.push({ role: "assistant", content: final.content });
      onTool?.({ name: "pause_turn", phase: "continue", summary: `รอบที่ ${turn + 2}` });
    }

    if (final.stop_reason === "refusal") {
      const category = final.stop_details?.category || "ไม่ระบุ";
      throw new Error(`โมเดลปฏิเสธคำขอด้วยเหตุผลด้านความปลอดภัย (หมวด ${category})`);
    }
    if (final.stop_reason === "max_tokens") {
      text += "\n\n[ข้อความถูกตัดเพราะถึงขีดจำกัดโทเคน]";
    }
    return { text, thinking, usage, model: final.model, stopReason: final.stop_reason, toolCalls };
  } catch (err) {
    throw translateError(err);
  }
}
