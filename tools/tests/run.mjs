#!/usr/bin/env node
// run.mjs — รันชุดเทสต์ทั้งหมดทีละไฟล์ (unit ก่อน e2e) ใช้: npm test  หรือ  node tools/tests/run.mjs [ชื่อไฟล์บางส่วน]
// ทุกเทสต์ใช้โฟลเดอร์ชั่วคราว (GROCK_DATA_DIR/โปรเจกต์ใน temp) ไม่แตะ data/ ของศูนย์ควบคุม และไม่เรียก API จริง
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ALL = ["test-projects.mjs", "test-plan-rules.mjs", "test-review2.mjs", "test-apply.mjs", "e2e-projects.mjs", "e2e-apply.mjs"];
const filter = process.argv.slice(2);
const files = filter.length ? ALL.filter((f) => filter.some((x) => f.includes(x))) : ALL;
const results = [];
for (const f of files) {
  const t0 = Date.now();
  process.stdout.write(`\n━━━ ${f} ━━━\n`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: "inherit", env: { ...process.env, LOG_EVENTS: "0" } });
  results.push({ f, ok: r.status === 0, ms: Date.now() - t0 });
}
process.stdout.write("\n");
for (const r of results) process.stdout.write(`${r.ok ? "✅" : "❌"} ${r.f.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s\n`);
const failed = results.filter((r) => !r.ok);
process.stdout.write(failed.length ? `\n${failed.length} ไฟล์ล้มเหลว\n` : "\nผ่านทั้งหมด\n");
process.exit(failed.length ? 1 : 0);
