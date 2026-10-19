// skills.js — โหลด "คู่มือทักษะ" ประจำตำแหน่งจาก server/skills/<role>.md
// แนวคิดเดียวกับ SKILL.md ของ Agent Skills: เก็บขั้นตอน เกณฑ์คุณภาพ และรูปแบบผลงานของแต่ละตำแหน่งเป็นไฟล์ข้อความ
// แก้ไฟล์ได้โดยไม่ต้องแตะโค้ด (รีสตาร์ตเซิร์ฟเวอร์ หรือเรียก reloadSkills()) แล้วถูกต่อท้าย system prompt ของคนในตำแหน่งนั้น
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(here, "skills");
const MAX_SKILL_CHARS = 6000; // กันไฟล์ยาวเกินจนกิน context
const cache = new Map();

/** เนื้อหาคู่มือทักษะของตำแหน่ง (ว่าง = ไม่มีไฟล์) */
export function skillFor(role) {
  if (cache.has(role)) return cache.get(role);
  let text = "";
  try {
    const file = path.join(SKILLS_DIR, `${role}.md`);
    if (fs.existsSync(file)) text = fs.readFileSync(file, "utf8").trim().slice(0, MAX_SKILL_CHARS);
  } catch {
    text = "";
  }
  cache.set(role, text);
  return text;
}

/** รายชื่อตำแหน่งที่มีไฟล์ทักษะ */
export function listSkills() {
  try {
    return fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

export function reloadSkills() {
  cache.clear();
}
