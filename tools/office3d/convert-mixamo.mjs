// convert-mixamo.mjs — Mixamo FBX folder → public/office3d/models/<name>.json (+ textures)
//
//   cd tools/office3d && npm install
//   node convert-mixamo.mjs ../../public/sprites/png/high-wizard high-wizard
//
// The folder holds one Mixamo character downloaded "With Skin" plus any number of animations.
// File names decide which scene state each animation plays (see CLIP_NAMES below). Unknown names are skipped.
// The FBX2glTF converter is downloaded automatically the first time (or set FBX2GLTF=/path/to/binary).
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, resample, textureCompress } from "@gltf-transform/functions";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [srcDir, outName] = process.argv.slice(2);
if (!srcDir || !outName) {
  console.log("usage: node convert-mixamo.mjs <folder with .fbx files> <output name, e.g. high-wizard>");
  process.exit(1);
}
const OUT_DIR = path.resolve(here, "../../public/office3d/models");
const PREFIX = outName.replace(/[^a-z0-9]+/gi, "").slice(0, 6).toLowerCase() || "m";

// Mixamo animation name (lower case, without .fbx) → clip name used by office3d.js
// Scene states pick clips in this order (office3d.js CLIP_FOR):
//   work: work · walk: walk · meet: meet, meet2, sit · lounge: lounge, sitdrink, meet2, sit
//   coffee: coffee · phone: phone, talk · printer/visitor: idle, coffee · visit: talk, idle · rest: meet, meet2, lounge, sit
//   cheer (optional, job completed) · sad (optional, task failed) — without these clips the scene hops / shows a red ring instead
const CLIP_NAMES = [
  [/^typing/, "work"],
  [/^(walking|happy walk|texting and walking|walk)/, "walk"],
  [/^(having a meeting|sitting talking|asking question)/, "meet"],
  [/^sitting idle/, "lounge"],
  [/^sitting drinking/, "sitdrink"],
  [/^sitting$/, "sit"],                 // checked below: a sit-down clip becomes "sit", a seated loop "meet2"
  [/^drinking/, "coffee"],
  [/(talking on (a )?phone|phone pacing|talking phone)/, "phone"],
  [/^talking/, "talk"],
  [/^(cheering|victory|happy|excited|fist pump)/, "cheer"],      // optional: job completed
  [/^(defeated|sad|disappointed|rejected|frustrated)/, "sad"],   // optional: task failed / cancelled
  [/(idle)$/, "idle"],
];

function fbx2gltf() {
  if (process.env.FBX2GLTF) return process.env.FBX2GLTF;
  const name = { win32: "FBX2glTF-windows-x64.exe", linux: "FBX2glTF-linux-x64", darwin: "FBX2glTF-darwin-x64" }[process.platform];
  if (!name) throw new Error("no FBX2glTF build for " + process.platform + " — set FBX2GLTF");
  const bin = path.join(here, ".bin", name);
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    const url = `https://github.com/facebookincubator/FBX2glTF/releases/download/v0.9.7/${name}`;
    console.log("downloading", url);
    execFileSync(process.platform === "win32" ? "curl.exe" : "curl", ["-sSL", "-o", bin, url], { stdio: "inherit" });
    if (process.platform !== "win32") fs.chmodSync(bin, 0o755);
  }
  return bin;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "office3d-"));
const bin = fbx2gltf();
const files = fs.readdirSync(srcDir).filter((f) => f.toLowerCase().endsWith(".fbx"));
const clips = {};
for (const f of files) {
  const key = f.slice(0, -4).toLowerCase().replace(/_/g, " ").trim();
  let clip = CLIP_NAMES.find(([re]) => re.test(key))?.[1];
  if (!clip) { console.log("skip (unknown name):", f); continue; }
  const out = path.join(tmp, clip + "-" + Object.keys(clips).length);
  execFileSync(bin, ["--binary", "--pbr-metallic-roughness", "-o", out, path.join(srcDir, f)], { stdio: "ignore" });
  const doc = await io.read(out + ".glb");
  const anim = doc.getRoot().listAnimations()[0];
  const hips = anim?.listChannels().find((c) => /Hips$/.test(c.getTargetNode().getName()) && c.getTargetPath() === "translation");
  const ys = hips ? [hips.getSampler().getOutput().getElement(0, [])[1], hips.getSampler().getOutput().getElement(hips.getSampler().getOutput().getCount() - 1, [])[1]] : [0, 0];
  if (clip === "sit" && ys[1] > ys[0] * 0.8) clip = "meet2";       // already seated the whole time → a loop
  if (clip === "meet" && clips.meet) clip = "meet2";
  if (clips[clip]) { console.log("skip (duplicate", clip + "):", f); continue; }
  clips[clip] = out + ".glb";
  console.log(`${f.padEnd(40)} → ${clip}`);
}
if (!clips.work && !clips.walk) throw new Error("need at least Typing or Walking");

const base = await io.read(clips.work || clips.walk);
const root = base.getRoot(), buf = root.listBuffers()[0];
const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
root.listAnimations()[0].setName(clips.work ? "work" : "walk");
for (const [clip, file] of Object.entries(clips)) {
  if (file === (clips.work || clips.walk)) continue;
  const a = (await io.read(file)).getRoot().listAnimations()[0];
  const na = base.createAnimation(clip);
  for (const ch of a.listChannels()) {
    const tgt = byName.get(ch.getTargetNode().getName());
    if (!tgt) continue;
    const s = ch.getSampler(), inA = s.getInput(), outA = s.getOutput(), arr = outA.getArray().slice();
    // the scene moves people itself: keep the body's bounce, drop sideways/forward travel
    if (ch.getTargetPath() === "translation" && /Hips$/.test(tgt.getName())) for (let i = 0; i < arr.length; i += 3) { arr[i] = 0; arr[i + 2] = 0; }
    const ni = base.createAccessor().setType(inA.getType()).setArray(inA.getArray().slice()).setBuffer(buf);
    const no = base.createAccessor().setType(outA.getType()).setArray(arr).setBuffer(buf);
    const ns = base.createAnimationSampler().setInput(ni).setOutput(no).setInterpolation(s.getInterpolation());
    na.addSampler(ns).addChannel(base.createAnimationChannel().setTargetNode(tgt).setTargetPath(ch.getTargetPath()).setSampler(ns));
  }
}
await base.transform(
  dedup(), resample(), prune(),
  textureCompress({ encoder: sharp, targetFormat: "jpeg", resize: [1024, 1024], quality: 82, slots: /^(?!normal).*/ }),
  textureCompress({ encoder: sharp, targetFormat: "jpeg", resize: [512, 512], quality: 85, slots: /normal/ }),
  textureCompress({ encoder: sharp, resize: [1024, 1024] }),
);
root.listTextures().forEach((t, i) => t.setURI(`${PREFIX}_tex${i}.${t.getMimeType() === "image/png" ? "png" : "jpg"}`));
root.listBuffers().forEach((b) => b.setURI(PREFIX + ".bin"));
const { json, resources } = await io.writeJSON(base);
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [uri, data] of Object.entries(resources)) {
  if (uri.endsWith(".bin")) json.buffers.forEach((b) => { if (b.uri === uri) b.uri = "data:application/octet-stream;base64," + Buffer.from(data).toString("base64"); });
  else fs.writeFileSync(path.join(OUT_DIR, uri), data);
}
fs.writeFileSync(path.join(OUT_DIR, outName + ".json"), JSON.stringify(json));
const mb = (fs.statSync(path.join(OUT_DIR, outName + ".json")).size / 1e6).toFixed(1);
console.log(`\nwrote public/office3d/models/${outName}.json (${mb} MB) with clips: ${root.listAnimations().map((a) => a.getName()).join(", ")}`);
console.log(`now point the team member at it in public/office3d/config.js:  model: { file: "${outName}.json", height: 1.75 }`);
