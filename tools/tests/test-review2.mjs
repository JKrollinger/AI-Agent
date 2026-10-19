// test-review2.mjs — เคสจาก workflow ตรวจซ้ำ: deny-list/redact, output.dir normalize, control chars, ชื่อจาก API, ราคาแคช 1h, mergeUsage
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-rv2-"));
process.env.GROCK_DATA_DIR = path.join(TMP, "data");
process.env.LOG_EVENTS = "0";
const P = await import(new URL("../../server/projects.js", import.meta.url).href);
const A = await import(new URL("../../server/agents.js", import.meta.url).href);
const L = await import(new URL("../../server/llm.js", import.meta.url).href);

// deny-list
for (const f of ["secret.ppk", "local.env", "prod.env", ".env", ".env.local", "infra/x.tfvars", "vpn/a.ovpn", ".pgpass", "k.pem"]) assert.ok(P.isDeniedPath(f), "ต้องห้าม: " + f);
for (const f of ["README.md", "environment.md", "src/app.js", "docs/env-setup.md"]) assert.ok(!P.isDeniedPath(f), "ต้องอ่านได้: " + f);
// redact
const ppk = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nAAAAIFAKEPRIVATE\nPrivate-MAC: abcd\n";
const r1 = P.redactSecrets(ppk);
assert.ok(r1.count >= 1 && !r1.text.includes("AAAAIFAKEPRIVATE") && r1.text.includes("Private-MAC"), "PuTTY private lines ต้องถูกปิดบัง");
const r2 = P.redactSecrets("DATABASE_URL=postgres://user:hunter2@db/x\nREDIS=redis://:p4ssw0rd@cache:6379\n");
assert.ok(!r2.text.includes("hunter2") && r2.text.includes("postgres://user:[REDACTED]@db/x"), "รหัสผ่านใน URL ต้องถูกปิดบัง: " + r2.text);
const r3 = P.redactSecrets("password = abcdefgh12345\nurl = https://example.com/path\n");
assert.ok(r3.text.includes("password=[REDACTED]") && r3.text.includes("https://example.com/path"), "แพตเทิร์นเดิมยังทำงานและ URL ธรรมดาไม่ถูกแตะ");
console.log("✅ deny-list (ppk/*.env/tfvars/ovpn/pgpass) + redact (PuTTY, URL userinfo)");

// output.dir normalize / control chars / ชื่อ
const root = path.join(TMP, "Proj");
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, "README.md"), "# Proj\n", "utf8");
P.initPack(root, { id: "proj", register: true });
const load = (cfg) => { fs.writeFileSync(path.join(root, ".grock", "project.json"), JSON.stringify(cfg), "utf8"); return P.loadPack("proj", { force: true }); };
for (const dir of [".grock/./skills/coder.md", ".grock/SKILLS", ".grock/skills/./x", ".grock//skills", "./.grock/skills/"]) assert.equal(load({ output: { dir } }).config.output.dir, ".grock/out", "ต้องปฏิเสธ: " + dir);
assert.equal(load({ output: { dir: ".grock/out/./x/" } }).config.output.dir, ".grock/out/x", "normalize แล้วเก็บค่าที่สะอาด");
assert.equal(load({ output: { dir: "./.grock/results" } }).config.output.dir, ".grock/results");
const pk = load({ name: "t3\u001b]0;pwned\u0007", roles: { coder: { "weird_\u001b[31m": 1 }, "bad\u001brole": {} }, plan: { roles: ["x\u001by"] }, output: { dir: ".grock/\u001b" } });
assert.equal(pk.name, "t3]0;pwned", "ชื่อต้องไม่มี control chars");
assert.ok(pk.warnings.every((w) => !/[\u0000-\u001f\u007f-\u009f]/.test(w)), "คำเตือนต้องไม่มี control chars: " + JSON.stringify(pk.warnings));
assert.doesNotThrow(() => P.registerProject("proj", root, { name: { a: 1 } }), "ไม่ควร throw");
let reg = P.registerProject("proj", root, { name: { a: 1 } });
assert.equal(reg.name, "Proj", "ชื่อที่ไม่ใช่สตริง → คงชื่อเดิมที่เป็นสตริง (จาก initPack)");
assert.equal(typeof JSON.parse(fs.readFileSync(P.REGISTRY_FILE, "utf8")).projects.proj.name, "string");
reg = P.registerProject("proj", root, { name: "Shop\u001b[31m  " });
assert.equal(reg.name, "Shop[31m");
const lp = P.listProjects().find((p) => p.id === "proj");
assert.equal(typeof lp.name, "string");
console.log("✅ output.dir normalize/case, control chars ใน name/warnings, ชื่อจาก API");

// ราคา 1h + mergeUsage
const u1 = { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1_000_000 } };
assert.equal(A.estimateCost("claude-opus-5-5", u1), 8, "เขียนแคช 1h = 2x input");
assert.equal(A.estimateCost("claude-opus-5-5", { cache_creation_input_tokens: 1_000_000 }), 5, "เขียนแคช 5m = 1.25x");
assert.equal(A.estimateCost("claude-opus-5-5", { cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 500_000 } }), 6.5, "ผสม 50/50");
const m = L.mergeUsage(L.mergeUsage(null, { input_tokens: 10, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 60 } }), { input_tokens: 5, cache_creation_input_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50 } });
assert.deepEqual(m, { input_tokens: 15, cache_creation_input_tokens: 150, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 110 } });
assert.deepEqual(L.mergeUsage(null, { input_tokens: 1 }), { input_tokens: 1 }, "ไม่มี cache_creation → ไม่เพิ่มคีย์");
console.log("✅ ราคาเขียนแคช 1h + mergeUsage.cache_creation");

fs.rmSync(TMP, { recursive: true, force: true });
console.log("REVIEW2 UNIT ALL PASSED");
