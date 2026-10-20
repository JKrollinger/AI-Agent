// test-plan-rules.mjs — maxTasks นับเฉพาะงานผลิต, งานผลิตชิ้นสุดท้ายมี QA เสมอ, ดัชนี dependencies ถูกต้องหลังตัด (ทั้ง live normalizePlan และ sim applyPlanRules),
// แผนจำลอง (simPlanTasks) เมื่อโปรเจกต์จำกัด plan.roles ต้องได้ชื่อ/คำอธิบายงานของตำแหน่งนั้นจริง
import assert from "node:assert/strict";
process.env.LOG_EVENTS = "0";
const X = await import(new URL("../../server/executor.js", import.meta.url).href);
const L = await import(new URL("../../server/llm.js", import.meta.url).href);
const A = await import(new URL("../../server/agents.js", import.meta.url).href);

const producers = (ts) => ts.filter((t) => t.role !== "reviewer");
const reviewers = (ts) => ts.filter((t) => t.role === "reviewer");
const checkIndices = (ts) => ts.forEach((t, i) => {
  for (const d of t.dependsOn) assert.ok(Number.isInteger(d) && d >= 0 && d < i, `dependsOn ผิดที่ ${i}: ${t.dependsOn}`);
  if (t.role === "reviewer") assert.ok(t.reviewOf !== null && t.reviewOf < i && ts[t.reviewOf].role !== "reviewer", `reviewOf ผิดที่ ${i}`);
});
const lastReviewed = (ts) => { let last = ts.length - 1; while (last >= 0 && ts[last].role === "reviewer") last--; return ts.some((t) => t.role === "reviewer" && t.reviewOf === last); };

// live: แผนดิบจาก LLM [A, B, QA(B), C, D, QA(D)]
const raw = [
  { title: "A วิจัย", role: "researcher" },
  { title: "B โค้ด", role: "coder", depends_on: [0] },
  { title: "QA B", role: "reviewer", depends_on: [1] },
  { title: "C การเงิน", role: "finance", depends_on: [2] },
  { title: "D การตลาด", role: "marketer", depends_on: [3] },
  { title: "QA D", role: "reviewer", depends_on: [4] },
];
let p = X.normalizePlan(raw, undefined, { maxTasks: 4 });
assert.equal(producers(p).length, 4); assert.equal(reviewers(p).length, 2); checkIndices(p); assert.ok(lastReviewed(p));
p = X.normalizePlan(raw, undefined, { maxTasks: 2 });
assert.deepEqual(p.map((t) => t.title), ["A วิจัย", "B โค้ด", "QA B"], "maxTasks=2 → A,B + QA ของ B (QA D ถูกตัดตาม D)");
checkIndices(p); assert.ok(lastReviewed(p));
p = X.normalizePlan(raw, undefined, { maxTasks: 3 });
assert.equal(producers(p).length, 3); assert.ok(lastReviewed(p), "C เป็นงานสุดท้ายที่ไม่มี QA → ต้องเติม QA ให้"); checkIndices(p);
assert.equal(p[p.length - 1].role, "reviewer");
const eight = Array.from({ length: 8 }, (_, i) => ({ title: `งาน ${i}`, role: "coder", depends_on: i ? [i - 1] : [] }));
p = X.normalizePlan(eight, undefined, { maxTasks: 8 });
assert.equal(producers(p).length, 8); assert.equal(reviewers(p).length, 1, "8 งานผลิตไม่มี QA → เติม QA ปิดท้าย (รวม 9)"); checkIndices(p); assert.ok(lastReviewed(p));
p = X.normalizePlan([{ title: "x", role: "coder" }, { title: "qa x", role: "reviewer", depends_on: [0] }, { title: "y", role: "finance", depends_on: [1] }], undefined, {});
assert.ok(lastReviewed(p), "มี QA แต่ไม่ได้ตรวจชิ้นสุดท้าย → เติม QA ให้ชิ้นสุดท้าย"); checkIndices(p);
// allowedRoles
p = X.normalizePlan(raw, undefined, { maxTasks: 8, allowedRoles: ["coder"] });
assert.ok(producers(p).every((t) => t.role === "coder") && reviewers(p).length === 2); checkIndices(p);
console.log("✅ normalizePlan: maxTasks นับเฉพาะงานผลิต, QA ปิดท้ายเสมอ, ดัชนีถูกต้อง, allowedRoles");

// sim: applyPlanRules กับแผนจำลอง (dependsOn/reviewOf)
const sim = [
  { title: "s0", role: "researcher", dependsOn: [], reviewOf: null, description: "" },
  { title: "s1", role: "marketer", dependsOn: [0], reviewOf: null, description: "" },
  { title: "s2", role: "finance", dependsOn: [0], reviewOf: null, description: "" },
  { title: "s3", role: "coder", dependsOn: [1, 2], reviewOf: null, description: "" },
  { title: "qa3", role: "reviewer", dependsOn: [3], reviewOf: 3, description: "" },
  { title: "s5", role: "finance", dependsOn: [4], reviewOf: null, description: "" },
  { title: "qa5", role: "reviewer", dependsOn: [5], reviewOf: 5, description: "" },
];
let s = X.applyPlanRules(sim, { maxTasks: 2, allowedRoles: ["coder"] });
assert.deepEqual(s.map((t) => t.title), ["s0", "s1", "ตรวจคุณภาพ: s1"]); checkIndices(s); assert.ok(lastReviewed(s));
assert.ok(producers(s).every((t) => t.role === "coder") && s.every((t) => t.assignee));
s = X.applyPlanRules(sim, { maxTasks: 4 });
assert.deepEqual(s.map((t) => t.title), ["s0", "s1", "s2", "s3", "qa3"]); checkIndices(s); assert.ok(lastReviewed(s));
s = X.applyPlanRules(sim, { maxTasks: 5 });
assert.deepEqual(s.map((t) => t.title), ["s0", "s1", "s2", "s3", "qa3", "s5", "qa5"]); checkIndices(s);
assert.equal(s[6].reviewOf, 5);
assert.equal(X.applyPlanRules(sim, {}), sim, "ไม่มีกติกา → คืนแผนเดิม");
console.log("✅ applyPlanRules (sim): ตัดงานเกิน + QA ตาม, เติม QA ปิดท้าย, ดัชนีถูกต้อง");

// sim: โปรเจกต์จำกัด plan.roles → simPlanTasks สร้างงานจากแม่แบบของตำแหน่งที่อนุญาตเอง ไม่ใช่แผนทั่วไปที่ถูกเปลี่ยน role ทีหลัง
// (เดิม roles ["coder"] + maxTasks 1 ได้งาน coder ชื่อ "ค้นข้อมูลพื้นฐาน: …" คำอธิบายของนักวิจัย → ชื่อไฟล์ patch/การ์ดงาน/prompt ที่ส่งให้ Claude Code สับสน)
{
  const goal = "เพิ่มฟังก์ชัน add(a, b) ใน src/math.js";
  const plan = (roles, maxTasks) => X.applyPlanRules(X.simPlanTasks(goal, { allowedRoles: roles }), { allowedRoles: roles, maxTasks });
  let t = plan(["coder"], 1);
  assert.equal(producers(t).length, 1); assert.equal(reviewers(t).length, 1); checkIndices(t); assert.ok(lastReviewed(t));
  assert.equal(t[0].role, "coder");
  assert.ok(t[0].title.startsWith("เขียนโค้ด:") && !t[0].title.startsWith("ค้นข้อมูลพื้นฐาน"), `title ต้องเป็นของนักพัฒนา: ${t[0].title}`);
  assert.ok(t[0].description.includes(goal) && t[0].description.includes("แก้ไฟล์") && !t[0].description.includes("รวบรวมข้อเท็จจริง"), `description ต้องเป็นของนักพัฒนา: ${t[0].description}`);
  assert.ok(t.every((x) => x.assignee), "ทุกงานต้องมีคนรับ");
  assert.ok(t[1].title.startsWith("ตรวจคุณภาพ: เขียนโค้ด") && t[1].reviewOf === 0 && t[1].description.includes("เขียนโค้ด:"), `QA ปิดท้ายต้องอ้างชื่องานใหม่: ${t[1].title}`);
  // สองตำแหน่ง → ต่อกันเป็นลำดับตามที่ตั้งใน plan.roles ข้อความตรงตำแหน่งทุกชิ้น
  t = plan(["marketer", "coder"], 8);
  assert.deepEqual(t.map((x) => x.role), ["marketer", "coder", "reviewer"]);
  assert.ok(t[0].title.startsWith("วิเคราะห์ตลาดและคู่แข่ง:") && t[0].description.includes("กลุ่มเป้าหมาย"), t[0].title);
  assert.ok(t[1].title.startsWith("เขียนโค้ด:") && t[1].description.includes("แก้ไฟล์"), t[1].title);
  assert.deepEqual(t[1].dependsOn, [0]); assert.equal(t[2].reviewOf, 1); checkIndices(t); assert.ok(lastReviewed(t));
  // maxTasks ตัดเหลือตำแหน่งแรก → QA ที่ตรวจงานที่ถูกตัดหายไป ระบบเติม QA ให้งานที่เหลือ
  t = plan(["marketer", "coder"], 1);
  assert.deepEqual(t.map((x) => x.role), ["marketer", "reviewer"]); assert.ok(t[1].title.includes("วิเคราะห์ตลาด") && t[1].reviewOf === 0, t[1].title); checkIndices(t);
  // reviewer / ตำแหน่งซ้ำใน plan.roles ไม่นับเป็นงานผลิต
  assert.deepEqual(producers(X.simPlanTasks(goal, { allowedRoles: ["reviewer", "coder", "coder"] })).map((x) => x.role), ["coder"]);
  // ไม่จำกัดตำแหน่ง → แผนทั่วไปเดิม (เริ่มด้วยนักวิจัย มีต้นแบบเมื่อโจทย์ต้องการโค้ด QA ปิดท้าย)
  const g = X.simPlanTasks("ทำ dashboard ยอดขาย");
  assert.equal(g[0].role, "researcher"); assert.ok(g[0].title.startsWith("ค้นข้อมูลพื้นฐาน:"));
  assert.ok(g.some((x) => x.role === "coder" && x.title.includes("ต้นแบบ")) && lastReviewed(g) && g.every((x) => x.assignee)); checkIndices(g);
  assert.deepEqual(X.simPlanTasks("ทำ dashboard ยอดขาย", { allowedRoles: [] }).map((x) => x.title), g.map((x) => x.title), "allowedRoles ว่าง = ไม่จำกัด");
  console.log("✅ simPlanTasks: plan.roles จำกัด → ชื่อ/คำอธิบายตรงตำแหน่ง (coder ไม่ได้แม่แบบนักวิจัย), ลำดับตาม plan.roles, QA อ้างชื่องานใหม่, ไม่จำกัด = แผนทั่วไป");
}

// llm.systemBlocks: เลือก breakpoint ตามเครื่องหมาย cache, ลิมิต 3, ttl 1h
delete process.env.PROMPT_CACHE;
let b = L.systemBlocks(["a", { text: "b", cache: true }, "", { text: "c", cache: true }, "d"]);
assert.deepEqual(b.map((x) => Boolean(x.cache_control)), [false, true, true, false]);
b = L.systemBlocks(["a", "b"]);
assert.deepEqual(b.map((x) => Boolean(x.cache_control)), [false, true], "ไม่มีเครื่องหมาย → บล็อกสุดท้าย");
b = L.systemBlocks([{ text: "1", cache: true }, { text: "2", cache: true }, { text: "3", cache: true }, { text: "4", cache: true }]);
assert.equal(b.filter((x) => x.cache_control).length, 3, "ไม่เกิน 3 breakpoint ใน system");
b = L.systemBlocks([{ text: "x", cache: true }], { ttl: "1h" });
assert.deepEqual(b[0].cache_control, { type: "ephemeral", ttl: "1h" });
assert.deepEqual(L.cachedTextBlock("y", { ttl: "1h" }).cache_control, { type: "ephemeral", ttl: "1h" });
assert.deepEqual(L.cachedTextBlock("y").cache_control, { type: "ephemeral" });
process.env.PROMPT_CACHE = "0";
assert.ok(L.systemBlocks(["a", { text: "b", cache: true }]).every((x) => !x.cache_control) && !L.cachedTextBlock("z").cache_control);
delete process.env.PROMPT_CACHE;
console.log("✅ systemBlocks/cachedTextBlock: breakpoint ตามเครื่องหมาย, ลิมิต 3, ttl, PROMPT_CACHE=0");

// ราคา: โมเดล fallback / suffix / ไม่รู้จัก
const u = { input_tokens: 1_000_000 };
assert.equal(A.estimateCost("claude-opus-5-5", u), 4);
assert.equal(A.estimateCost("claude-opus-4-8", u), 4, "ตระกูล opus → ราคา opus ไม่ใช่ sonnet");
assert.equal(A.estimateCost("claude-haiku-5-5-20260601", u), 0.1, "id มี suffix → ตรงตามขึ้นต้น");
assert.equal(A.estimateCost("mystery-model", u, "claude-fable-5-1"), 10, "ไม่รู้จัก → ราคาของโมเดลที่ตั้งใจเรียก");
assert.equal(A.estimateCost("mystery-model", u), 2, "ไม่รู้จักและไม่มี fallback → sonnet");
assert.equal(A.priceFor("nope"), null);
console.log("✅ estimateCost/priceFor: ตระกูล, suffix, fallback");
console.log("PLAN RULES ALL PASSED");
