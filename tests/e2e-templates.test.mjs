// e2e-templates.test.mjs — e2e โหมด sim: เปิดเซิร์ฟเวอร์จริง (ทะเบียนชั่วคราวผ่าน GROCK_DATA_DIR) สั่ง 1 โจทย์ต่อแม่แบบ
// แล้วตรวจว่าตำแหน่งในแผนของกัปตันเป็นไปตาม plan.roles / plan.maxTasks ของแม่แบบ และผลงานถูกเขียนกลับเข้า .grock/out
// รัน: node --test tests/e2e-templates.test.mjs   (ใช้เวลาราว 1-3 นาที ไม่ต้องมี API key)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3800 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-e2e-tpl-"));
const DATA = path.join(TMP, "data");
process.env.GROCK_DATA_DIR = DATA;
const P = await import(pathToFileURL(path.join(ROOT, "server", "projects.js")).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (p, init) => fetch(`${BASE}${p}`, init).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (p, body) => json(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ALL_ROLES = ["marketer", "researcher", "finance", "engineer", "coder", "reviewer"];

function makeProject(t) {
  const root = path.join(TMP, `e2e-${t.id}`);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), `# โปรเจกต์ทดสอบ ${t.title}\n\nใช้ทดสอบแม่แบบ ${t.id} แบบ e2e ในโหมด sim\n`, "utf8");
  fs.writeFileSync(path.join(root, "docs", "notes.md"), "# บันทึก\nไม่มีอะไรสำคัญ\n", "utf8");
  P.initPack(root, { id: `e2e-${t.id}`, template: t.id, register: true });
  // กรอก brief แบบสั้น ๆ เพื่อให้ไม่ใช่โครงว่าง
  fs.writeFileSync(path.join(root, ".grock", "brief.md"), `# ${t.title} ทดสอบ\n\n## เป้าหมาย\nทดสอบแม่แบบ ${t.id}\n## ผู้ใช้\nทีมทดสอบ\n## กติกา\n- ตอบไทย\n## สิ่งที่ห้ามทำ\n- ห้ามแตะไฟล์จริง\n## เสร็จ\n- มีผลงานใน out/\n`, "utf8");
  return root;
}

test("e2e sim: 1 โจทย์ต่อแม่แบบ → ตำแหน่งในแผนตรง plan.roles และผลงานเขียนกลับเข้า .grock/out", { timeout: 8 * 60_000 }, async () => {
  const templates = P.listTemplates();
  assert.equal(templates.length, 6);
  const projects = templates.map((t) => ({ t, root: makeProject(t), id: `e2e-${t.id}` }));

  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), MODE: "sim", LOG_EVENTS: "0", GROCK_DATA_DIR: DATA, PROMPT_CACHE: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stdout.on("data", () => {});
  const events = [];
  const ac = new AbortController();
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${BASE}/api/health`)).ok; } catch {} if (!up) await sleep(250); }
    assert.ok(up, `เซิร์ฟเวอร์ไม่ขึ้นที่ ${BASE}: ${stderr}`);
    const health = await json("/api/health");
    assert.equal(health.body.mode, "sim");
    assert.equal((await post("/api/settings", { speed: 6 })).status, 200);

    // รับเหตุการณ์ทาง SSE
    const res = await fetch(`${BASE}/api/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const l = chunk.split("\n").find((x) => x.startsWith("data: "));
            if (l) { try { events.push(JSON.parse(l.slice(6))); } catch {} }
          }
        }
      } catch {}
    })();
    const waitFor = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const hit = events.find(pred); if (hit) return hit; await sleep(200); } return null; };

    // ทะเบียนที่ init ไว้ก่อนเปิดเซิร์ฟเวอร์ต้องเห็นครบ
    const listed = (await json("/api/projects")).body.projects;
    for (const p of projects) assert.ok(listed.some((x) => x.id === p.id && x.ok), `ไม่เห็นโปรเจกต์ ${p.id}`);

    // สั่ง 1 โจทย์ต่อแม่แบบ (ใช้ตัวอย่างโจทย์ของแม่แบบนั้นเอง)
    for (const p of projects) {
      const r = await post("/api/jobs", { goal: p.t.examples[0], project: p.id });
      assert.equal(r.status, 202, `${p.id}: ${JSON.stringify(r.body)}`);
      p.job = r.body.job;
      assert.ok(p.job.outputDir.replace(/\\/g, "/").endsWith(`/.grock/out/${p.job.id}`));
    }

    // แผนของกัปตันต้องใช้เฉพาะตำแหน่งที่แม่แบบอนุญาต (+reviewer) และงานผลิตไม่เกิน maxTasks
    for (const p of projects) {
      const planned = await waitFor((e) => e.type === "job.planned" && e.data?.job?.id === p.job.id, 90_000);
      assert.ok(planned, `${p.id}: กัปตันไม่วางแผนภายในเวลา`);
      const detail = (await json(`/api/jobs/${p.job.id}`)).body;
      const tasks = detail.tasks;
      assert.ok(tasks.length >= 2, `${p.id}: งานน้อยเกิน`);
      const allowed = p.t.roles.length ? [...p.t.roles, "reviewer"] : ALL_ROLES;
      const producers = tasks.filter((t) => t.role !== "reviewer");
      for (const t of tasks) assert.ok(allowed.includes(t.role), `${p.id}: ตำแหน่ง "${t.role}" (${t.title}) ไม่อยู่ใน plan.roles ${JSON.stringify(allowed)}`);
      assert.ok(producers.length >= 1 && producers.length <= p.t.maxTasks, `${p.id}: งานผลิต ${producers.length} ชิ้น เกิน maxTasks ${p.t.maxTasks}`);
      assert.ok(tasks.some((t) => t.role === "reviewer"), `${p.id}: ไม่มีงาน QA`);
      p.planRoles = tasks.map((t) => t.role);
      // แม่แบบที่จำกัดตำแหน่งต้องมีงานของตำแหน่งแรกในรายการเสมอ (งานที่ถูกย้ายมาจากตำแหน่งอื่น)
      if (p.t.roles.length) assert.ok(producers.some((t) => t.role === p.t.roles[0]), `${p.id}: ไม่มีงานของ ${p.t.roles[0]}`);
    }
    // research ต้องไม่มีงานโค้ด/AI, data ต้องมีงาน coder
    const research = projects.find((p) => p.t.id === "research");
    assert.ok(!research.planRoles.some((r) => r === "coder" || r === "engineer"));
    assert.ok(projects.find((p) => p.t.id === "data").planRoles.includes("coder"));

    // รอจนทุกโจทย์จบ แล้วตรวจไฟล์ผลงาน
    for (const p of projects) {
      const done = await waitFor((e) => (e.type === "job.completed" || e.type === "job.failed") && e.data?.job?.id === p.job.id, 5 * 60_000);
      assert.ok(done, `${p.id}: โจทย์ไม่จบภายในเวลา`);
      assert.equal(done.type, "job.completed", `${p.id}: โจทย์ล้มเหลว ${JSON.stringify(done.data?.job?.error || "")}`);
      const outDir = path.join(p.root, ".grock", "out", p.job.id);
      for (const f of ["plan.json", "job.json", "result.md"]) assert.ok(fs.existsSync(path.join(outDir, f)), `${p.id}: ไม่มี ${f}`);
      assert.ok(fs.existsSync(path.join(p.root, ".grock", "out", "latest.md")));
      const plan = JSON.parse(fs.readFileSync(path.join(outDir, "plan.json"), "utf8"));
      assert.deepEqual(plan.tasks.map((t) => t.role), p.planRoles, `${p.id}: plan.json ไม่ตรงกับแผนที่เห็นผ่าน API`);
      const jobJson = JSON.parse(fs.readFileSync(path.join(outDir, "job.json"), "utf8"));
      assert.equal(jobJson.project, p.id);
      assert.equal(jobJson.status, "done");
      assert.ok(fs.readdirSync(path.join(outDir, "tasks")).length >= 2);
    }
  } finally {
    ac.abort();
    child.kill();
  }
});
