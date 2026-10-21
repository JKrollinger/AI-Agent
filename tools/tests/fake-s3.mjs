// fake-s3.mjs — S3 จำลองในเครื่องสำหรับเทสต์ (PUT/GET/HEAD path-style) ตรวจ SigV4 จริงด้วยคีย์ที่ตั้งไว้:
//   หัว Authorization ต้อง parse ได้ · accessKeyId ตรง · x-amz-content-sha256 = sha256(body) · ลายเซ็นคำนวณใหม่จาก SignedHeaders แล้วตรงกัน · x-amz-date ไม่ห่างเกิน 15 นาที
// ใช้: const s3 = await createFakeS3({ accessKeyId, secretAccessKey, region: "auto" }); s3.failNext(2) → 2 คำขอถัดไปตอบ 500; s3.objects Map(key → { body, contentType }); s3.close()
import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import { signV4, parseAuthorization } from "../../server/storage.js";

const freePort = (start) => new Promise((resolve) => { const tryPort = (p) => { const s = net.createServer(); s.once("error", () => tryPort(p + 1)); s.listen(p, "127.0.0.1", () => s.close(() => resolve(p))); }; tryPort(start); });

export async function createFakeS3({ accessKeyId, secretAccessKey, region = "auto", bucket = null, port = 0, maxSkewMs = 15 * 60_000 } = {}) {
  const objects = new Map();
  const requests = [];
  let failNext = 0;
  const state = { objects, requests, failNext: (n) => { failNext = n; } };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      const entry = { method: req.method, path: url.pathname, headers: req.headers, size: body.length, status: 0, error: "" };
      requests.push(entry);
      const fail = (status, msg) => { entry.status = status; entry.error = msg; res.writeHead(status, { "content-type": "application/xml" }); res.end(`<Error><Code>${status}</Code><Message>${msg}</Message></Error>`); };
      // ---- ตรวจลายเซ็น ----
      const auth = parseAuthorization(req.headers.authorization);
      if (!auth) return fail(403, "InvalidAuthorization");
      if (auth.accessKeyId !== accessKeyId) return fail(403, "InvalidAccessKeyId");
      const amzDate = String(req.headers["x-amz-date"] || "");
      if (!/^\d{8}T\d{6}Z$/.test(amzDate)) return fail(403, "MissingAmzDate");
      const when = Date.parse(`${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`);
      if (Math.abs(Date.now() - when) > maxSkewMs) return fail(403, "RequestTimeTooSkewed");
      const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
      if (req.headers["x-amz-content-sha256"] !== bodyHash && req.headers["x-amz-content-sha256"] !== "UNSIGNED-PAYLOAD") return fail(400, "XAmzContentSHA256Mismatch");
      const expectedScope = `${amzDate.slice(0, 8)}/${region}/s3/aws4_request`;
      if (auth.scope !== expectedScope) return fail(403, `ScopeMismatch ${auth.scope} != ${expectedScope}`);
      const hdrs = {};
      for (const h of auth.signedHeaders.split(";")) hdrs[h] = req.headers[h] ?? "";
      const { signature } = signV4({ method: req.method, path: url.pathname, query: url.search.slice(1), headers: hdrs, signedHeaders: auth.signedHeaders, payloadHash: req.headers["x-amz-content-sha256"], amzDate, accessKeyId, secretAccessKey, region });
      if (signature !== auth.signature) return fail(403, "SignatureDoesNotMatch");
      // ---- bucket/key ----
      const m = /^\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (!m) return fail(400, "InvalidPath");
      if (bucket && m[1] !== bucket) return fail(404, "NoSuchBucket");
      const key = decodeURIComponent(m[2]);
      if (failNext > 0) { failNext--; return fail(500, "InternalError (injected)"); }
      if (req.method === "PUT") {
        objects.set(key, { body, contentType: req.headers["content-type"] || "" });
        entry.status = 200; res.writeHead(200, { etag: `"${crypto.createHash("md5").update(body).digest("hex")}"` }); return res.end();
      }
      const obj = objects.get(key);
      if (!obj) return fail(404, "NoSuchKey");
      entry.status = 200;
      res.writeHead(200, { "content-type": obj.contentType || "application/octet-stream", "content-length": String(obj.body.length) });
      return req.method === "HEAD" ? res.end() : res.end(obj.body);
    });
  });
  const p = port || (await freePort(9400));
  await new Promise((r) => server.listen(p, "127.0.0.1", r));
  return { ...state, port: p, endpoint: `http://127.0.0.1:${p}`, server, close: () => new Promise((r) => server.close(() => r())) };
}
