// team-store.js — บันทึก/โหลดการตั้งค่าต่อคน (โมเดล ความลึก เครื่องมือ หน้าที่) ลงไฟล์ data/team.json
// เพื่อให้หน้าที่ที่ผู้ใช้กำหนดบน dashboard ไม่หายเมื่อรีสตาร์ตเซิร์ฟเวอร์
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(here, "..", "data");
export const TEAM_FILE = path.join(DATA_DIR, "team.json");

// ฟิลด์ที่อนุญาตให้ override จากไฟล์ (id/ตำแหน่ง/jobId ยังมาจาก DEFAULT_TEAM ในโค้ด) — name/nick = ชื่อที่ผู้ใช้ตั้งเองจาก dashboard
const OVERRIDE_KEYS = ["name", "nick", "model", "effort", "toolsEnabled", "duties"];

/** อ่าน overrides ต่อคนจากไฟล์ → { [agentId]: { model?, effort?, toolsEnabled?, duties? } } (ไม่มีไฟล์ = {}) */
export function loadTeamOverrides() {
  try {
    if (!fs.existsSync(TEAM_FILE)) return {};
    const json = JSON.parse(fs.readFileSync(TEAM_FILE, "utf8"));
    return json && typeof json === "object" && json.agents && typeof json.agents === "object" ? json.agents : {};
  } catch (err) {
    console.warn(`⚠️ อ่าน ${TEAM_FILE} ไม่ได้ (${err.message}) — ใช้ค่าเริ่มต้นแทน`);
    return {};
  }
}

/** คืน def ใหม่ที่ผสาน overrides ของคนนั้นแล้ว (ไม่แก้ def เดิม) */
export function applyTeamOverrides(def, overrides) {
  const o = overrides?.[def.id];
  if (!o || typeof o !== "object") return def;
  const out = { ...def };
  for (const k of OVERRIDE_KEYS) if (o[k] !== undefined && o[k] !== null) out[k] = o[k];
  return out;
}

/** เขียนการตั้งค่าปัจจุบันของทุกคนลงไฟล์ (เรียกทุกครั้งที่มีการแก้จาก dashboard) */
export function saveTeamOverrides(agents) {
  const data = { savedAt: new Date().toISOString(), agents: {} };
  for (const a of agents) {
    data.agents[a.id] = { name: a.name, nick: a.nick, model: a.model, effort: a.effort, toolsEnabled: a.toolsEnabled, duties: a.duties };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TEAM_FILE, JSON.stringify(data, null, 2) + "\n", "utf8");
  return TEAM_FILE;
}
