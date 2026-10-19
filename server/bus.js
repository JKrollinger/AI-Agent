// bus.js — Event bus กลางของระบบ
// ทุกการเปลี่ยนแปลงสถานะ (agent/task/job) จะถูก emit เป็น event ที่นี่
// แล้วส่งต่อให้ dashboard ผ่าน SSE และบันทึกลง logs/events.jsonl เพื่อวัดผลย้อนหลัง
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(here, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "events.jsonl");
const HISTORY_LIMIT = 600;

class Bus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
    this.history = [];
    this.seq = 0;
    this.persist = process.env.LOG_EVENTS !== "0";
    this.stream = null;
    if (this.persist) {
      try {
        fs.mkdirSync(LOG_DIR, { recursive: true });
        // write stream รักษาลำดับ event ในไฟล์ให้ตรงกับลำดับที่เกิดจริง
        this.stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
        this.stream.on("error", () => (this.persist = false));
      } catch {
        this.persist = false;
      }
    }
  }

  /**
   * ส่ง event ออกไปทุกช่องทาง
   * @param {string} type  เช่น task.assigned, task.handoff, agent.updated
   * @param {object} data  payload (entity ที่เปลี่ยน + ข้อความภาษาไทยสำหรับ log)
   */
  publish(type, data = {}) {
    const event = { id: ++this.seq, ts: Date.now(), type, data };
    this.history.push(event);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit("event", event);
    // event ที่ยิงถี่มาก (progress / metrics tick) ไม่ต้องเก็บลงไฟล์
    if (this.persist && this.stream && type !== "task.progress" && type !== "metrics.updated") {
      this.stream.write(JSON.stringify(event) + "\n");
    }
    return event;
  }

  /** ข้อความ log ภาษาไทยที่อ่านง่าย แสดงในแท็บ "บันทึก" */
  log(message, extra = {}) {
    return this.publish("log", { message, ...extra });
  }

  recent(limit = 200) {
    return this.history.slice(-limit);
  }
}

export const bus = new Bus();
