// render-sprite.mjs — ตรวจสอบและเรนเดอร์ไฟล์สไปรต์ (public/sprites/*.js) เป็น PNG sheet เพื่อดูด้วยตา
// ใช้: node tools/render-sprite.mjs public/sprites/sniper.js [scale=4]
// ผลลัพธ์: tools/out/<id>.png  (แต่ละ layer คั่นด้วยเส้นแดง, แต่ละแถว = 1 แอนิเมชัน, แต่ละช่อง = 1 เฟรม) + สรุป JSON ทาง stdout
// รองรับทั้งไฟล์ตัวละคร (frames.idle/work/sit + station/effect), common (items/emotes/fx) และ tileset (tiles/props ที่มี size ต่างกันได้)
// ไม่มี dependency ภายนอก (เขียน PNG เองด้วย zlib)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
const SCALE = Number(process.argv[3] || 4);
if (!file) {
  console.error("usage: node tools/render-sprite.mjs <sprite.js> [scale]");
  process.exit(2);
}

const mod = await import(pathToFileURL(path.resolve(file)).href);
const sprite = mod.default;
const errors = [];
const warn = [];
const RESERVED = new Set(["id", "job", "jobTh", "size", "anchor", "palette", "frames", "meta", "zoneLabel"]);

// ---------- validation ----------
function hexToRgba(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || "");
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) : 255];
}

/** ตรวจ 1 layer = { size:{w,h}, anchor?, palette?, frames: array | {anim: array} } */
function checkLayer(name, layer, { requireAnchor = false } = {}) {
  if (!layer.size || !Number.isInteger(layer.size.w) || !Number.isInteger(layer.size.h) || layer.size.w <= 0 || layer.size.h <= 0) {
    errors.push(`${name}: size.w/size.h ต้องเป็นจำนวนเต็มบวก`);
    return null;
  }
  const { w, h } = layer.size;
  if (layer.anchor && (layer.anchor.x < 0 || layer.anchor.x >= w || layer.anchor.y < 0 || layer.anchor.y >= h)) {
    errors.push(`${name}: anchor ต้องอยู่ในขอบเขต 0..${w - 1} x 0..${h - 1}`);
  }
  if (requireAnchor && !layer.anchor) errors.push(`${name}: ต้องมี anchor`);
  const palette = { ...(sprite.palette || {}), ...(layer.palette || {}) };
  if ("." in palette) errors.push(`${name}: ห้ามกำหนด "." ใน palette`);
  const anims = Array.isArray(layer.frames) ? { main: layer.frames } : layer.frames || {};
  const summary = {};
  for (const [anim, frames] of Object.entries(anims)) {
    if (!Array.isArray(frames) || !frames.length) {
      errors.push(`${name}.${anim}: ต้องเป็น array ของเฟรม อย่างน้อย 1 เฟรม`);
      continue;
    }
    summary[anim] = frames.length;
    frames.forEach((rows, fi) => {
      if (!Array.isArray(rows) || rows.length !== h) {
        errors.push(`${name}.${anim}[${fi}]: ต้องมี ${h} แถว (พบ ${Array.isArray(rows) ? rows.length : typeof rows})`);
        return;
      }
      rows.forEach((row, ri) => {
        if (typeof row !== "string" || row.length !== w) {
          errors.push(`${name}.${anim}[${fi}] แถว ${ri}: ต้องยาว ${w} ตัวอักษร (พบ ${row?.length})`);
          return;
        }
        for (const ch of row) {
          if (ch === ".") continue;
          if (!(ch in palette)) errors.push(`${name}.${anim}[${fi}] แถว ${ri}: ตัวอักษร '${ch}' ไม่มีใน palette`);
          else if (!hexToRgba(palette[ch])) errors.push(`palette['${ch}'] = ${palette[ch]} ไม่ใช่สี #rrggbb`);
        }
      });
      if (rows.every((r) => !r.replace(/\./g, ""))) warn.push(`${name}.${anim}[${fi}] ว่างเปล่า`);
      if (fi > 0 && JSON.stringify(rows) === JSON.stringify(frames[fi - 1])) warn.push(`${name}.${anim}[${fi}] เหมือนเฟรม ${fi - 1} ทุกพิกเซล`);
    });
  }
  if (!Object.keys(anims).length) errors.push(`${name}: ไม่มี frames`);
  return { w, h, anims, palette, summary };
}

const isLayer = (v) => v && typeof v === "object" && v.size && v.frames;
/** เก็บ layer ทั้งหมดในไฟล์: ตัวละครหลัก, station/effect, items/emotes/fx, tiles, props.* (ซ้อนได้ 1 ชั้น) */
function collectLayers() {
  const out = [];
  if (!sprite || typeof sprite !== "object") {
    errors.push("ไฟล์ต้อง export default เป็น object");
    return out;
  }
  if (!sprite.id) errors.push("ต้องมี id");
  if (sprite.frames) {
    const main = checkLayer("character", { size: sprite.size, anchor: sprite.anchor, frames: sprite.frames }, { requireAnchor: true });
    if (main) {
      out.push(["character", main]);
      for (const n of ["idle", "work", "sit"]) if (!main.anims[n]) errors.push(`frames.${n} จำเป็นต้องมีสำหรับตัวละคร`);
      if (main.anims.work && main.anims.work.length < 2) errors.push("frames.work ต้องมีอย่างน้อย 2 เฟรม");
      if (sprite.size?.w !== 24 || sprite.size?.h !== 32) warn.push("ตัวละครควรเป็น 24x32 ตามสเปก");
    }
  }
  for (const [key, val] of Object.entries(sprite)) {
    if (RESERVED.has(key) || !val || typeof val !== "object") continue;
    if (isLayer(val)) {
      const l = checkLayer(key, val, { requireAnchor: key === "station" || key === "effect" });
      if (l) out.push([key, l]);
    } else {
      for (const [sub, v] of Object.entries(val)) {
        if (!isLayer(v)) { errors.push(`${key}.${sub}: ต้องเป็น layer ที่มี size และ frames`); continue; }
        const l = checkLayer(`${key}.${sub}`, v, { requireAnchor: key === "props" });
        if (l) out.push([`${key}.${sub}`, l]);
      }
    }
  }
  if (!out.length) errors.push("ไม่พบ layer ใด ๆ (frames / station / effect / items / emotes / fx / tiles / props)");
  return out;
}

const layers = collectLayers();
if (errors.length) {
  console.log(JSON.stringify({ ok: false, errors: errors.slice(0, 60), errorCount: errors.length, warnings: warn }, null, 2));
  process.exit(1);
}

// ---------- render ----------
function drawLayerSheet(l) {
  const animList = Object.entries(l.anims);
  const maxFrames = Math.max(...animList.map(([, f]) => f.length));
  const gap = 2;
  const cellW = l.w * SCALE + gap * SCALE;
  const cellH = l.h * SCALE + gap * SCALE;
  const W = cellW * maxFrames;
  const H = cellH * animList.length;
  const px = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const c = ((x >> 3) + (y >> 3)) & 1 ? 0x2a : 0x22;
      px[i] = c; px[i + 1] = c; px[i + 2] = c + 6; px[i + 3] = 255;
    }
  animList.forEach(([, frames], ai) => {
    frames.forEach((rows, fi) => {
      const ox = fi * cellW + (gap * SCALE) / 2, oy = ai * cellH + (gap * SCALE) / 2;
      rows.forEach((row, ry) => {
        for (let rx = 0; rx < row.length; rx++) {
          const ch = row[rx];
          if (ch === ".") continue;
          const [r, g, b, a] = hexToRgba(l.palette[ch]);
          for (let sy = 0; sy < SCALE; sy++)
            for (let sx = 0; sx < SCALE; sx++) {
              const X = ox + rx * SCALE + sx, Y = oy + ry * SCALE + sy;
              const i = (Y * W + X) * 4;
              const al = a / 255;
              px[i] = Math.round(r * al + px[i] * (1 - al));
              px[i + 1] = Math.round(g * al + px[i + 1] * (1 - al));
              px[i + 2] = Math.round(b * al + px[i + 2] * (1 - al));
              px[i + 3] = 255;
            }
        }
      });
    });
  });
  return { W, H, px, rows: animList.map(([a, f]) => `${a}: ${f.length} เฟรม (${l.w}x${l.h})`) };
}

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(W, H, px) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sheets = layers.map(([name, l]) => ({ name, ...drawLayerSheet(l) }));
const W = Math.max(...sheets.map((s) => s.W));
const H = sheets.reduce((s, x) => s + x.H + 8, 0);
const px = Buffer.alloc(W * H * 4);
let oy = 0;
for (const s of sheets) {
  for (let y = 0; y < s.H; y++) s.px.copy(px, (oy + y) * W * 4, y * s.W * 4, (y + 1) * s.W * 4);
  oy += s.H;
  for (let y = 0; y < 8; y++) for (let x = 0; x < W; x++) { const i = ((oy + y) * W + x) * 4; px[i] = 0x70; px[i + 1] = 0x28; px[i + 2] = 0x28; px[i + 3] = 255; }
  oy += 8;
}
const outDir = path.join(here, "out");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${sprite.id}.png`);
fs.writeFileSync(out, encodePng(W, H, px));
console.log(JSON.stringify({
  ok: true,
  id: sprite.id,
  png: out,
  scale: SCALE,
  sheetOrderTopToBottom: sheets.map((s) => s.name),
  layers: Object.fromEntries(sheets.map((s) => [s.name, s.rows])),
  warnings: warn,
}, null, 2));
