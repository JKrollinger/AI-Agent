// test-templates.mjs — unit: แม่แบบ .grock/ ทุกประเภท init + normalize ผ่านโดยไม่มีคำเตือน, allow-list ของชื่อแม่แบบ, doctor
// รัน: node tools/tests/test-templates.mjs  หรือ  npm run test:unit   (ไม่ต้องเปิดเซิร์ฟเวอร์ ใช้ทะเบียนชั่วคราวผ่าน GROCK_DATA_DIR)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-tpl-"));
process.env.GROCK_DATA_DIR = path.join(TMP, "data"); // ต้องตั้งก่อน import projects.js
const P = await import(pathToFileURL(path.join(ROOT, "server", "projects.js")).href);

const EXPECTED = ["generic", "business", "data", "marketing", "research", "webapp"];
const REQUIRED_HEADINGS = ["เป้าหมาย", "ผู้ใช้", "กติกา", "ห้าม", "เสร็จ"];
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

function makeProject(name) {
  const root = path.join(TMP, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n\nโปรเจกต์ทดสอบแม่แบบ ${name}\n`, "utf8");
  return root;
}

test("templates: มี 6 แม่แบบ generic มาก่อน และมีชื่อ/คำอธิบาย/ตัวอย่างโจทย์ครบ", () => {
  const list = P.listTemplates();
  assert.deepEqual(list.map((t) => t.id), EXPECTED);
  for (const t of list) {
    assert.ok(t.title && t.title !== t.id, `${t.id}: ไม่มี title`);
    assert.ok(t.description.length > 20, `${t.id}: ไม่มี description`);
    assert.ok(t.examples.length >= 1, `${t.id}: ไม่มีตัวอย่างโจทย์`);
    assert.ok(Number.isInteger(t.maxTasks) && t.maxTasks >= 1 && t.maxTasks <= 8);
    if (t.id !== "generic") {
      assert.ok(t.roles.length >= 2, `${t.id}: ต้องจำกัดตำแหน่ง`);
      assert.ok(t.budget > 0, `${t.id}: ต้องมีงบแนะนำ`);
      assert.ok(t.skills.length >= 1 && t.skills.length <= 2, `${t.id}: ทักษะเฉพาะต้องมี 1-2 ไฟล์`);
    }
  }
});

test("ทุกแม่แบบ: init แล้ว loadPack ไม่มีคำเตือน และค่าใน pack ตรงกับแม่แบบ", () => {
  for (const t of P.listTemplates()) {
    const root = makeProject(`proj-${t.id}`);
    const r = P.initPack(root, { id: `t-${t.id}`, template: t.id, register: true });
    assert.equal(r.template, t.id);
    assert.deepEqual(r.skills, t.skills);
    const packDir = path.join(root, ".grock");
    for (const f of ["project.json", "brief.md", "skills/README.md"]) assert.ok(fs.existsSync(path.join(packDir, f)), `${t.id}: ไม่มี ${f}`);
    assert.ok(fs.statSync(path.join(packDir, "out")).isDirectory());
    assert.ok(!fs.existsSync(path.join(packDir, "template.json")), `${t.id}: template.json ต้องไม่ถูกคัดลอก`);
    const written = readJson(path.join(packDir, "project.json"));
    assert.equal(Object.keys(written)[0], "name");
    assert.equal(Object.keys(written)[1], "template");
    assert.equal(written.template, t.id);
    assert.equal(written.name, `proj-${t.id}`);
    assert.deepEqual(written.context.always, ["README.md"]); // ไฟล์ที่มีจริงเท่านั้น

    const pack = P.loadPack(`t-${t.id}`, { force: true });
    assert.deepEqual(pack.warnings, [], `${t.id}: ${pack.warnings.join(" | ")}`);
    assert.equal(pack.config.template, t.id);
    const tplCfg = readJson(path.join(P.TEMPLATES_DIR, t.id, "project.json"));
    assert.deepEqual(pack.config.plan.roles, tplCfg.plan.roles, `${t.id}: plan.roles`);
    assert.equal(pack.config.plan.maxTasks, tplCfg.plan.maxTasks);
    assert.equal(pack.config.qa.passScore, tplCfg.qa.passScore);
    assert.equal(pack.config.budget.maxUsdPerJob, tplCfg.budget.maxUsdPerJob);
    for (const [role, o] of Object.entries(tplCfg.roles || {})) {
      for (const [k, v] of Object.entries(o)) assert.equal(pack.config.roles[role]?.[k], v, `${t.id}: roles.${role}.${k} หาย`);
    }
    assert.deepEqual(Object.keys(pack.skills).sort(), t.skills, `${t.id}: skills`);
    for (const [role, s] of Object.entries(pack.skills)) {
      assert.ok(s.text.length > 200 && s.text.length <= 6000, `${t.id}: skills/${role}.md ยาว ${s.text.length}`);
      assert.equal(s.replace, false, "ทักษะของแม่แบบต้องต่อท้ายคู่มือกลาง ไม่แทนที่");
    }
    assert.ok(pack.brief.length > 300 && pack.brief.length <= 6000, `${t.id}: brief ยาว ${pack.brief.length}`);
    if (t.id !== "generic") for (const h of REQUIRED_HEADINGS) assert.ok(pack.brief.includes(h), `${t.id}: brief ขาดหัวข้อ "${h}"`); // generic = โครงชุดเดิม
    const ctx = P.buildProjectContext(pack, { role: "coder" });
    assert.ok(ctx.system.includes(`[โปรเจกต์: proj-${t.id}]`) && ctx.system.includes("## เป้าหมาย") || ctx.system.includes("โปรเจกต์นี้คืออะไร"));
    assert.ok(ctx.files.some((f) => f.path === "README.md" && !f.skippedReason));
  }
});

test("ค่าเฉพาะประเภท: webapp coder = sonnet/high, research ปิดเครื่องมือ finance และไม่มี coder/engineer, data coder เปิดเครื่องมือ", () => {
  const web = P.loadPack("t-webapp");
  assert.equal(web.config.roles.coder.model, "claude-sonnet-5-5");
  assert.equal(web.config.roles.coder.effort, "high");
  assert.deepEqual(web.config.plan.roles, ["researcher", "engineer", "coder"]);
  assert.equal(web.config.plan.maxTasks, 5);
  const res = P.loadPack("t-research");
  assert.equal(res.config.roles.finance.toolsEnabled, false);
  assert.ok(!res.config.plan.roles.includes("coder") && !res.config.plan.roles.includes("engineer"));
  const data = P.loadPack("t-data");
  assert.equal(data.config.roles.coder.toolsEnabled, true);
  assert.deepEqual(data.config.plan.roles, ["coder", "researcher"]);
  const mkt = P.loadPack("t-marketing");
  assert.deepEqual(mkt.config.plan.roles, ["marketer", "researcher", "finance"]);
  const biz = P.loadPack("t-business");
  assert.deepEqual(biz.config.plan.roles, ["finance", "marketer"]);
  const gen = P.loadPack("t-generic");
  assert.deepEqual(gen.config.plan.roles, []);
  // effectiveAgent นำค่าของแม่แบบไปใช้กับพนักงานจริง
  const eff = P.effectiveAgent({ id: "dev-1", role: "coder", model: "claude-opus-5-5", effort: "medium", toolsEnabled: true }, web);
  assert.equal(eff.model, "claude-sonnet-5-5");
  assert.ok(eff.projectOverrides.includes("effort"));
});

test("ชื่อแม่แบบต้องอยู่ใน allow-list (กัน path traversal และชื่อแปลก)", () => {
  const bad = ["../generic", "..\\generic", "generic/../webapp", "generic/skills", "/generic", "C:\\x", "skills-README.md", "nope", "a b", "../../package.json", ".", "..", "generic.", "-generic"];
  for (const b of bad) assert.throws(() => P.resolveTemplate(b), /ไม่ถูกต้อง|ไม่มีแม่แบบ/, `ควรปฏิเสธ "${b}"`);
  assert.equal(P.resolveTemplate("generic\u0000").id, "generic"); // control character ถูกตัดก่อนตรวจ (ไม่ใช่ path)
  assert.throws(() => P.resolveTemplate(true), /ต้องระบุชื่อแม่แบบ/); // --template ไม่มีค่า
  assert.equal(P.resolveTemplate().id, "generic");
  assert.equal(P.resolveTemplate(undefined).id, "generic");
  assert.equal(P.resolveTemplate("").id, "generic");
  assert.equal(P.resolveTemplate("WEBAPP").id, "webapp");
  assert.equal(P.resolveTemplate(" marketing ").id, "marketing");
  const root = makeProject("bad-tpl");
  assert.throws(() => P.initPack(root, { id: "badtpl", template: "../generic", register: false }), /ไม่ถูกต้อง/);
  assert.throws(() => P.initPack(root, { id: "badtpl", template: "nope", register: false }), /ไม่มีแม่แบบ/);
  assert.ok(!fs.existsSync(path.join(root, ".grock")), "ชื่อแม่แบบผิดต้องไม่สร้าง .grock/");
});

test("normalize: เก็บ template ที่ถูกต้อง, ค่าแปลก ๆ ถูกข้ามพร้อมคำเตือน", () => {
  const root = makeProject("tplname");
  P.initPack(root, { id: "tplname", template: "generic", register: true });
  const file = path.join(root, ".grock", "project.json");
  const cfg = readJson(file);
  cfg.template = "../x";
  fs.writeFileSync(file, JSON.stringify(cfg), "utf8");
  let pack = P.loadPack("tplname", { force: true });
  assert.equal(pack.config.template, "");
  assert.ok(pack.warnings.some((w) => w.includes("template")));
  cfg.template = 42;
  fs.writeFileSync(file, JSON.stringify(cfg), "utf8");
  pack = P.loadPack("tplname", { force: true });
  assert.equal(pack.config.template, "");
  delete cfg.template;
  fs.writeFileSync(file, JSON.stringify(cfg), "utf8");
  pack = P.loadPack("tplname", { force: true });
  assert.equal(pack.config.template, "");
  assert.deepEqual(pack.warnings, []);
});

test("briefPlaceholders: จับเฉพาะช่องที่ยังไม่ได้กรอก", () => {
  const ph = P.briefPlaceholders([
    "# หัวข้อ (ไม่นับ)",
    "<!-- คอมเมนต์ (ไม่นับ) -->",
    "(อธิบาย 2-3 ประโยค)",
    "- ผู้ใช้หลัก: (เช่น ลูกค้าทั่วไป)",
    "- ภาษา/เฟรมเวิร์ก:",
    "- วิธีรัน: npm run dev",
    "- กติกาเพิ่มเติม:",
    "  - ใช้ TypeScript strict",
    "- ตอบเป็นภาษาไทย (ยกเว้นโค้ด)",
    "ระบบขายของออนไลน์ เปิดใช้แล้ว 1 ปี",
  ].join("\n"));
  assert.deepEqual(ph, ["(อธิบาย 2-3 ประโยค)", "- ผู้ใช้หลัก: (เช่น ลูกค้าทั่วไป)", "- ภาษา/เฟรมเวิร์ก:"]);
});

test("doctor: pack ใหม่เตือน brief ยังเป็นโครง / งบ / ไฟล์ที่ไม่มี และผ่านเมื่อแก้ครบ", () => {
  // marketing: งบตั้งแล้ว → เตือนเฉพาะ brief
  const root = makeProject("doc-mkt");
  P.initPack(root, { id: "doc-mkt", template: "marketing", register: true });
  let d = P.doctorPack("doc-mkt");
  assert.equal(d.ok, false);
  assert.equal(d.template, "marketing");
  let warns = d.findings.filter((f) => f.level === "warn").map((f) => f.message);
  assert.ok(warns.some((m) => m.includes("โครงว่าง")), warns.join(" | "));
  assert.ok(!warns.some((m) => m.includes("งบ")), "marketing ตั้งงบไว้แล้ว ไม่ควรเตือน");
  assert.ok(d.findings.some((f) => f.level === "ok" && f.message.includes("แม่แบบ: marketing")));

  // generic: งบ 0 → เตือน + ไม่จำกัดตำแหน่ง → info
  const root2 = makeProject("doc-gen");
  P.initPack(root2, { id: "doc-gen", register: true });
  d = P.doctorPack("doc-gen");
  warns = d.findings.filter((f) => f.level === "warn").map((f) => f.message);
  assert.ok(warns.some((m) => m.includes("งบ")), warns.join(" | "));
  assert.ok(d.findings.some((f) => f.level === "info" && f.message.includes("plan.roles")));

  // กรอกบางส่วน → เตือนจำนวนช่องที่เหลือ
  const briefFile = path.join(root, ".grock", "brief.md");
  fs.writeFileSync(briefFile, "# แคมเปญ X\n\n## เป้าหมาย\n- ผลลัพธ์: lead 300 ราย\n- ค่าฐานปัจจุบัน: (เช่น 120 ราย)\n## ผู้ใช้\nพนักงานออฟฟิศ\n## กติกา\n- ตอบไทย\n## สิ่งที่ห้ามทำ\n- ห้ามแต่งรีวิว\n## เสร็จ\n- มีแผน\n", "utf8");
  d = P.doctorPack("doc-mkt");
  warns = d.findings.filter((f) => f.level === "warn").map((f) => f.message);
  assert.ok(warns.some((m) => m.includes("ยังไม่ได้กรอก 1 จุด")), warns.join(" | "));

  // กรอกครบ แต่ context.always ชี้ไฟล์ที่ไม่มี → เตือนไฟล์นั้น
  fs.writeFileSync(briefFile, "# แคมเปญ X\n\n## เป้าหมาย\n- ผลลัพธ์: lead 300 ราย\n## ผู้ใช้\nพนักงานออฟฟิศ\n## กติกา\n- ตอบไทย\n## สิ่งที่ห้ามทำ\n- ห้ามแต่งรีวิว\n## เสร็จ\n- มีแผน\n", "utf8");
  const cfgFile = path.join(root, ".grock", "project.json");
  const cfg = readJson(cfgFile);
  cfg.context.always = ["README.md", "docs/missing.md"];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
  d = P.doctorPack("doc-mkt");
  warns = d.findings.filter((f) => f.level === "warn").map((f) => f.message);
  assert.equal(warns.length, 1, warns.join(" | "));
  assert.ok(warns[0].includes("docs/missing.md"));

  // แก้ครบ → ok
  cfg.context.always = ["README.md"];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
  d = P.doctorPack("doc-mkt");
  assert.equal(d.ok, true, d.findings.filter((f) => f.level === "warn").map((f) => f.message).join(" | "));

  // ไม่มีไฟล์ใน context.always ที่อ่านได้เลย → เตือน
  cfg.context.always = [];
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), "utf8");
  d = P.doctorPack("doc-mkt");
  assert.ok(d.findings.some((f) => f.level === "warn" && f.message.includes("ไม่มีไฟล์ใน context.always")));

  // โปรเจกต์ที่ไม่ได้ลงทะเบียน → โยน
  assert.throws(() => P.doctorPack("no-such"), /ไม่พบโปรเจกต์/);
});
