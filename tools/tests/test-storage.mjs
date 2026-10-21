// test-storage.mjs — unit: storage adapter (SigV4 ตรง test vector ของ AWS, encodeKey, storageConfig, S3Client + fake S3 ตรวจลายเซ็น, ลองใหม่ 3 ครั้ง, uploadFiles/listFilesRecursive, workspaceFiles, attachStorage)
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createFakeS3 } from "./fake-s3.mjs";

process.env.LOG_EVENTS = "0";
const S = await import(new URL("../../server/storage.js", import.meta.url).href);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "grock-storage-unit-"));
const AK = "AKIAFAKEKEY0000001", SK = "fake-secret-key-0123456789abcdef";
const s3 = await createFakeS3({ accessKeyId: AK, secretAccessKey: SK, region: "auto", bucket: "grock-test" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ---------- SigV4 ตรง test vector ของ AWS (S3 docs "Signature Calculations: GET/PUT Object") ----------
  const r = S.signV4({ method: "GET", path: "/test.txt", query: "", headers: { host: "examplebucket.s3.amazonaws.com", range: "bytes=0-9", "x-amz-content-sha256": S.EMPTY_SHA256, "x-amz-date": "20130524T000000Z" }, payloadHash: S.EMPTY_SHA256, amzDate: "20130524T000000Z", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" });
  assert.equal(r.signature, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
  assert.equal(r.signedHeaders, "host;range;x-amz-content-sha256;x-amz-date");
  assert.ok(r.authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature="));
  const h = crypto.createHash("sha256").update("Welcome to Amazon S3.").digest("hex");
  const r2 = S.signV4({ method: "PUT", path: "/test%24file.text", headers: { host: "examplebucket.s3.amazonaws.com", date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-content-sha256": h, "x-amz-date": "20130524T000000Z", "x-amz-storage-class": "REDUCED_REDUNDANCY" }, payloadHash: h, amzDate: "20130524T000000Z", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" });
  assert.equal(r2.signature, "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  const parsed = S.parseAuthorization(r2.authorization);
  assert.deepEqual(parsed, { accessKeyId: "AKIAIOSFODNN7EXAMPLE", scope: "20130524/us-east-1/s3/aws4_request", signedHeaders: "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class", signature: r2.signature });
  assert.equal(S.parseAuthorization("Bearer x"), null);
  assert.equal(S.encodeKey("grock/my proj/job-1/ผลงาน (1)*.md"), "grock/my%20proj/job-1/%E0%B8%9C%E0%B8%A5%E0%B8%87%E0%B8%B2%E0%B8%99%20%281%29%2A.md");
  console.log("✅ SigV4: ลายเซ็นตรง test vector ของ AWS (GET + PUT), parseAuthorization, encodeKey แบบ RFC 3986");

  // ---------- storageConfig ----------
  const none = S.storageConfig({});
  assert.equal(none.provider, "none"); assert.deepEqual(none.errors, []);
  const bad = S.storageConfig({ STORAGE_PROVIDER: "s3", S3_ENDPOINT: "ftp://x", S3_BUCKET: "Bad_Bucket", S3_ACCESS_KEY_ID: "a", S3_SECRET_ACCESS_KEY: "", S3_PREFIX: "../x", S3_PUBLIC_URL: "pub.example" });
  assert.equal(bad.errors.length, 5, bad.errors.join(" | "));
  assert.equal(bad.publicUrl, ""); assert.equal(bad.warnings.length, 1);
  assert.equal(S.storageConfig({ STORAGE_PROVIDER: "gcs" }).errors.length, 1);
  const good = S.storageConfig({ STORAGE_PROVIDER: "s3", S3_ENDPOINT: "https://acc.r2.cloudflarestorage.com/", S3_BUCKET: "grock-results", S3_ACCESS_KEY_ID: AK, S3_SECRET_ACCESS_KEY: SK, S3_PREFIX: "/grock/", S3_MAX_MB: "2", S3_PUBLIC_URL: "https://pub-1.r2.dev/" });
  assert.deepEqual(good.errors, []); assert.deepEqual(good.warnings, []);
  assert.equal(good.endpoint, "https://acc.r2.cloudflarestorage.com"); assert.equal(good.prefix, "grock"); assert.equal(good.region, "auto"); assert.equal(good.maxBytes, 2 * 1024 * 1024); assert.equal(good.publicUrl, "https://pub-1.r2.dev");
  assert.equal(S.createStorage(none), null); assert.equal(S.createStorage(bad), null); assert.ok(S.createStorage(good) instanceof S.S3Client);
  const localCfg = S.storageConfig({ STORAGE_PROVIDER: "s3", S3_ENDPOINT: s3.endpoint, S3_BUCKET: "grock-test", S3_ACCESS_KEY_ID: AK, S3_SECRET_ACCESS_KEY: SK, S3_PREFIX: "grock", S3_RETRY_MS: "20", S3_MAX_MB: "2" });
  assert.deepEqual(localCfg.errors, []); assert.deepEqual(localCfg.warnings, []);
  assert.equal(S.jobKeyPrefix(localCfg, { id: "job-1", project: "shop" }), "grock/shop/job-1");
  assert.equal(S.jobKeyPrefix(localCfg, { id: "job-2", project: null }), "grock/workspace/job-2");
  assert.equal(S.jobKeyPrefix({ ...localCfg, prefix: "" }, { id: "job-3", project: "../x" }), "workspace/job-3");
  const pub = new S.S3Client(good);
  assert.equal(pub.objectUrl("grock/shop/job-1/result.md"), "https://pub-1.r2.dev/grock/shop/job-1/result.md");
  assert.equal(new S.S3Client({ ...good, publicUrl: "" }).objectUrl("a b/c.md"), "https://acc.r2.cloudflarestorage.com/grock-results/a%20b/c.md");
  console.log("✅ storageConfig: ตรวจ endpoint/bucket/คีย์/prefix, createStorage เฉพาะเมื่อค่าครบ, jobKeyPrefix → <prefix>/<project|workspace>/<jobId>, objectUrl");

  // ---------- S3Client กับ fake S3 (ตรวจลายเซ็นจริง) ----------
  const client = new S.S3Client(localCfg);
  const put = await client.putObject("grock/shop/job-1/result.md", "# ผลลัพธ์\nสวัสดี\n");
  assert.deepEqual(put, { ok: true, status: 200, error: "" });
  assert.equal(s3.objects.get("grock/shop/job-1/result.md").body.toString("utf8"), "# ผลลัพธ์\nสวัสดี\n");
  assert.equal(s3.objects.get("grock/shop/job-1/result.md").contentType, "text/markdown; charset=utf-8");
  const head = await client.headObject("grock/shop/job-1/result.md");
  assert.equal(head.ok, true); assert.equal(head.size, Buffer.byteLength("# ผลลัพธ์\nสวัสดี\n"));
  const got = await client.getObject("grock/shop/job-1/result.md");
  assert.equal(got.body.toString("utf8"), "# ผลลัพธ์\nสวัสดี\n");
  assert.equal((await client.headObject("grock/none")).status, 404);
  const wrongKey = new S.S3Client({ ...localCfg, secretAccessKey: "wrong-secret-0123456789" });
  const badPut = await wrongKey.putObject("grock/x.txt", "x");
  assert.equal(badPut.ok, false); assert.equal(badPut.status, 403); assert.match(badPut.error, /SignatureDoesNotMatch/);
  const wrongId = new S.S3Client({ ...localCfg, accessKeyId: "AKIAOTHER000000000" });
  assert.match((await wrongId.putObject("grock/x.txt", "x")).error, /InvalidAccessKeyId/);
  assert.ok(!s3.objects.has("grock/x.txt"));
  const noServer = new S.S3Client({ ...localCfg, endpoint: "http://127.0.0.1:1", timeoutMs: 1000 });
  const down = await noServer.putObject("grock/y.txt", "y");
  assert.equal(down.ok, false); assert.equal(down.status, 0); assert.ok(down.error);
  console.log("✅ S3Client: PUT/HEAD/GET ผ่าน fake S3 ที่ตรวจ SigV4, คีย์ผิด → 403 ไม่เขียน, เซิร์ฟเวอร์ล่ม → error ไม่โยน");

  // ---------- ลองใหม่ ----------
  s3.failNext(2);
  const attempts = [];
  const retry = await S.putWithRetry(client, "grock/retry.txt", "r", { attempts: 3, retryMs: 10, onAttempt: (a) => attempts.push(a) });
  assert.deepEqual(retry, { ok: true, attempts: 3, error: "" });
  assert.deepEqual(attempts.map((a) => a.ok), [false, false, true]);
  assert.match(attempts[0].error, /HTTP 500/);
  s3.failNext(5);
  const gaveUp = await S.putWithRetry(client, "grock/fail.txt", "f", { attempts: 3, retryMs: 10 });
  assert.equal(gaveUp.ok, false); assert.equal(gaveUp.attempts, 3); assert.match(gaveUp.error, /500/);
  s3.failNext(0);
  assert.ok(!s3.objects.has("grock/fail.txt"));
  console.log("✅ ลองใหม่: 500 สองครั้งแล้วสำเร็จครั้งที่ 3, ล้มเหลวครบ 3 ครั้ง → ok=false ไม่โยน");

  // ---------- listFilesRecursive + uploadFiles ----------
  const dir = path.join(TMP, "out", "job-9");
  fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "patches"), { recursive: true });
  fs.writeFileSync(path.join(dir, "result.md"), "# ผล\n", "utf8");
  fs.writeFileSync(path.join(dir, "job.json"), '{"id":"job-9"}\n', "utf8");
  fs.writeFileSync(path.join(dir, "tasks", "01-researcher-วิจัย.md"), "# วิจัย\n", "utf8");
  fs.writeFileSync(path.join(dir, "patches", "01-x.diff"), "diff --git a/x b/x\n", "utf8");
  fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(3 * 1024 * 1024));
  try { fs.symlinkSync(path.join(dir, "result.md"), path.join(dir, "link.md"), "file"); } catch { /* ไม่มีสิทธิ์ทำ symlink บน Windows — ข้าม */ }
  const files = S.listFilesRecursive(dir);
  assert.deepEqual(files.map((f) => f.rel), ["big.bin", "job.json", "patches/01-x.diff", "result.md", "tasks/01-researcher-วิจัย.md"], "เรียงตามชื่อ ไม่ตาม symlink");
  const up = await S.uploadFiles(client, files, "grock/shop/job-9", { attempts: 3, retryMs: 10, concurrency: 3, maxBytes: 2 * 1024 * 1024 });
  assert.equal(up.ok, true); assert.equal(up.files, 4); assert.deepEqual(up.failed, []);
  assert.deepEqual(up.skipped, [{ rel: "big.bin", reason: "ใหญ่เกิน 2 MB" }]);
  assert.deepEqual([...up.keys].sort(), ["grock/shop/job-9/job.json", "grock/shop/job-9/patches/01-x.diff", "grock/shop/job-9/result.md", "grock/shop/job-9/tasks/01-researcher-วิจัย.md"]);
  assert.equal(s3.objects.get("grock/shop/job-9/tasks/01-researcher-วิจัย.md").body.toString("utf8"), "# วิจัย\n");
  assert.equal(s3.objects.get("grock/shop/job-9/patches/01-x.diff").contentType, "text/x-diff; charset=utf-8");
  s3.failNext(9);
  const upFail = await S.uploadFiles(client, [{ rel: "a.md", body: "a" }, { rel: "b.md", body: "b" }], "grock/p/j", { attempts: 2, retryMs: 10, concurrency: 1 });
  s3.failNext(0);
  assert.equal(upFail.ok, false); assert.equal(upFail.files, 0); assert.equal(upFail.failed.length, 2); assert.equal(upFail.failed[0].attempts, 2);
  const upMem = await S.uploadFiles(client, [{ rel: "x.json", body: Buffer.from("{}") }, { rel: "none.md", abs: path.join(TMP, "missing.md") }], "", { attempts: 1, retryMs: 10 });
  assert.equal(upMem.files, 1); assert.deepEqual(upMem.keys, ["x.json"]); assert.equal(upMem.skipped.length, 1); assert.match(upMem.skipped[0].reason, /อ่านไม่ได้/);
  console.log("✅ uploadFiles: อัปโหลดทั้งโฟลเดอร์ (tasks/, patches/), ข้ามไฟล์ใหญ่/อ่านไม่ได้, ล้มเหลวรายไฟล์ไม่หยุดไฟล์อื่น, prefix ว่างได้");

  // ---------- workspaceFiles (โจทย์ไม่มีโปรเจกต์) ----------
  const job = { id: "job-w", goal: "โจทย์ทดสอบ", status: "done", result: "## สรุป\nเสร็จ", createdAt: 1_700_000_000_000, finishedAt: 1_700_000_100_000, costUsd: 0.1234, source: "local" };
  const tasks = [{ id: "t2", jobId: "job-w", seq: 2, role: "reviewer", title: "ตรวจ", status: "done", attempts: 1, output: "ผ่าน", usage: { costUsd: 0.01 }, review: null, assignedTo: "qa-1" }, { id: "t1", jobId: "job-w", seq: 1, role: "researcher", title: "วิจัย ตลาด", status: "done", attempts: 2, output: "ข้อมูล", usage: { costUsd: 0.1 }, review: { score: 88, approved: true }, assignedTo: "res-1", description: "หาข้อมูล" }];
  const wf = S.workspaceFiles(job, tasks, { agentNameOf: (id) => ({ "res-1": "นักวิจัย" })[id] || "" });
  assert.deepEqual(wf.map((f) => f.rel), ["result.md", "tasks/01-researcher-วิจัย-ตลาด.md", "tasks/02-reviewer-ตรวจ.md", "job.json"]);
  assert.ok(wf[0].body.startsWith("# ผลลัพธ์: โจทย์ทดสอบ\n") && wf[0].body.includes("workspace") && wf[0].body.includes("## สรุป\nเสร็จ") && wf[0].body.includes("วิจัย ตลาด [done QA 88]"));
  assert.ok(wf[1].body.includes("ผู้ทำ: นักวิจัย") && wf[1].body.includes("ผลตรวจ QA: 88/100 ผ่าน") && wf[1].body.includes("## ผลงาน\nข้อมูล"));
  const wj = JSON.parse(wf[3].body);
  assert.equal(wj.project, "workspace"); assert.equal(wj.tasks.length, 2); assert.equal(wj.tasks[0].file, "tasks/01-researcher-วิจัย-ตลาด.md"); assert.equal(wj.createdAt, "2023-11-14T22:13:20.000Z");
  console.log("✅ workspaceFiles: result.md/tasks/*.md/job.json จากหน่วยความจำ เรียงตาม seq");

  // ---------- attachStorage: โจทย์จบ → อัปโหลด async → job.storage + event ----------
  class Bus extends EventEmitter { constructor() { super(); this.events = []; this.logs = []; } publish(type, data) { const ev = { id: this.events.length + 1, ts: Date.now(), type, data }; this.events.push(ev); this.emit("event", ev); return ev; } log(message, extra = {}) { this.logs.push({ message, ...extra }); } }
  const bus = new Bus();
  const uploadedCalls = [];
  const detach = S.attachStorage(bus, { client, cfg: localCfg, outDirOf: (j) => (j.project ? dir : null), tasksOf: () => tasks, onUploaded: (j, info) => { uploadedCalls.push({ id: j.id, keyPrefix: info.keyPrefix }); } });
  const pj = { id: "job-p", goal: "โจทย์โปรเจกต์", project: "shop", status: "done", result: "x", createdAt: Date.now(), finishedAt: Date.now(), costUsd: 0 };
  bus.publish("job.completed", { job: pj });
  assert.equal(pj.storage.status, "uploading"); assert.equal(pj.storage.uploaded, false); assert.equal(pj.storage.keyPrefix, "grock/shop/job-p");
  assert.equal(pj.storage.url, `${s3.endpoint}/grock-test/grock/shop/job-p/`); assert.equal(pj.storage.resultUrl, `${s3.endpoint}/grock-test/grock/shop/job-p/result.md`);
  assert.equal(bus.events.filter((e) => e.type === "job.storage").length, 1, "ยิง job.storage (uploading) ทันทีแบบ sync");
  bus.publish("job.completed", { job: pj }); // ซ้ำระหว่างอัปโหลด → ไม่เริ่มใหม่
  for (let i = 0; i < 100 && pj.storage.status === "uploading"; i++) await sleep(20);
  assert.equal(pj.storage.status, "uploaded"); assert.equal(pj.storage.uploaded, true); assert.equal(pj.storage.files, 4); assert.equal(pj.storage.error, "");
  assert.deepEqual(pj.storage.skipped.map((s) => s.rel), ["big.bin"]);
  assert.ok(s3.objects.has("grock/shop/job-p/result.md") && s3.objects.has("grock/shop/job-p/tasks/01-researcher-วิจัย.md"));
  assert.equal(bus.events.filter((e) => e.type === "job.storage").length, 2);
  assert.deepEqual(uploadedCalls, [{ id: "job-p", keyPrefix: "grock/shop/job-p" }]);
  assert.ok(bus.logs.some((l) => l.message.includes("☁️ อัปโหลดผลงาน") && l.message.includes("4 ไฟล์") && l.jobId === "job-p"));
  bus.publish("job.completed", { job: pj }); // จบแล้วอัปโหลดแล้ว → ไม่ทำซ้ำ
  await sleep(50);
  assert.equal(bus.events.filter((e) => e.type === "job.storage").length, 2);
  // workspace (ไม่มีโปรเจกต์) + โจทย์ล้มเหลวก็อัปโหลด
  const wjob = { id: "job-w2", goal: "โจทย์ workspace ล้ม", project: null, status: "failed", error: "เกินงบ", result: "", createdAt: Date.now(), finishedAt: Date.now(), costUsd: 0 };
  bus.publish("job.failed", { job: wjob });
  for (let i = 0; i < 100 && wjob.storage.status === "uploading"; i++) await sleep(20);
  assert.equal(wjob.storage.status, "uploaded"); assert.equal(wjob.storage.keyPrefix, "grock/workspace/job-w2"); assert.equal(wjob.storage.files, 4);
  assert.ok(s3.objects.get("grock/workspace/job-w2/result.md").body.toString("utf8").includes("สถานะ: failed — เกินงบ"));
  // ล้มเหลวทั้งหมด → status failed + error
  s3.failNext(50);
  const fjob = { id: "job-f", goal: "อัปโหลดล้ม", project: "shop", status: "done", result: "x", createdAt: Date.now(), finishedAt: Date.now(), costUsd: 0 };
  bus.publish("job.completed", { job: fjob });
  for (let i = 0; i < 200 && fjob.storage.status === "uploading"; i++) await sleep(20);
  s3.failNext(0);
  assert.equal(fjob.storage.status, "failed"); assert.equal(fjob.storage.uploaded, false); assert.match(fjob.storage.error, /อัปโหลดไม่สำเร็จ 4 ไฟล์/); assert.equal(fjob.storage.failed.length, 4);
  assert.ok(bus.logs.some((l) => l.level === "warn" && l.message.includes("ครั้งที่ 1 ไม่สำเร็จ")));
  assert.ok(bus.logs.some((l) => l.level === "error" && l.jobId === "job-f"));
  detach();
  bus.publish("job.completed", { job: { id: "job-after", goal: "x", project: "shop", status: "done" } });
  await sleep(30);
  assert.equal(bus.events.filter((e) => e.type === "job.storage" && e.data.job.id === "job-after").length, 0, "detach แล้วไม่ทำงาน");
  console.log("✅ attachStorage: uploading → uploaded (event 2 ครั้ง, ไม่ซ้ำ), workspace สำหรับโจทย์ไม่มีโปรเจกต์, โจทย์ล้มเหลวก็อัปโหลด, ล้มเหลว → status failed + error, detach");

  console.log("STORAGE UNIT ALL PASSED");
} finally {
  await s3.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
