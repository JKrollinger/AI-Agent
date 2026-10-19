// scene.js — ฉากเมืองมอร็อคแบบไอโซเมตริก + ตัวละครสไปรต์พิกเซลอาร์ต (สเปก: docs/04-scene-spec.md)
// ใช้: const scene = createScene(canvas, S, { onClick, onHover })  แล้ว app.js เรียก spawnPacket/emote/fx/burst ตามเหตุการณ์
import { MAP } from "./morroc-map.js";

const TW = 32, TH = 16;
const TAU = Math.PI * 2;
const FONT = '"Noto Sans Thai", system-ui, sans-serif';
const EMOJI_FONT = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
const CHAR_SCALE = 1.6; // ตัวละคร/สถานีใหญ่กว่ากระเบื้อง (สัดส่วนแบบ RO)
const ROLE_JOB = { captain: "lord-knight", analyst: "high-wizard", writer: "professor", coder: "whitesmith", reviewer: "high-priest" };
const RESEARCH_JOBS = ["sniper", "stalker"];
const TILE_COLORS = { sand: "#d9b875", sand2: "#d2ae6c", sandDark: "#b8945c", stone: "#b9a893", stoneLight: "#d5c8b4", water: "#3f8fb5" };
const EMOTE_GLYPH = { alert: "!", question: "?", dots: "…", sleep: "zZ", angry: "💢", heart: "♥" };
const EMOTE_COLOR = { alert: "#ff5f6d", question: "#4fa3ff", dots: "#8b97ad", sleep: "#9b7dff", angry: "#ff5f6d", heart: "#ff7eb6" };
// สีชุด/ผมสำรองเมื่อยังไม่มีสไปรต์จริงของอาชีพนั้น (ย้อมจาก _base.js)
const TINT = {
  "lord-knight": { c: "#b32b2b", C: "#7d1d1d", h: "#e8d9a8", H: "#fff2c8", p: "#4a3a2a" },
  sniper: { c: "#4f8a3a", C: "#355e27", h: "#6a4a2a", H: "#8f6a3a", p: "#5a4a30" },
  stalker: { c: "#3a2a4a", C: "#241a30", h: "#1a1a2a", H: "#3a3a5a", p: "#2a2030" },
  "high-wizard": { c: "#3b4fd8", C: "#273590", h: "#2a2a5a", H: "#4a4a8a", p: "#2a2a4a" },
  professor: { c: "#d9a53a", C: "#a07420", h: "#5a3a1e", H: "#8a5a2e", p: "#6a4a2a" },
  whitesmith: { c: "#8a6a4a", C: "#5e4630", h: "#2a1a0a", H: "#4a3a2a", p: "#3a2a1a" },
  "high-priest": { c: "#f4f1ea", C: "#c9c2b2", h: "#e8c27a", H: "#ffe0a0", p: "#d9d2c4" },
};

// ---------------------------------------------------------------------------
// โหลดโมดูลสไปรต์ (lazy) + แคชเฟรมที่เรนเดอร์แล้ว
// ---------------------------------------------------------------------------
const modules = new Map(); // name -> module | null
const loading = new Map(); // name -> Promise
function load(name) {
  if (loading.has(name)) return loading.get(name);
  const p = import(`./sprites/${name}.js`)
    .then((m) => m.default)
    .catch(() => { console.warn(`[scene] ไม่พบสไปรต์ ${name} — ใช้ fallback`); return null; })
    .then((m) => { modules.set(name, m); return m; });
  loading.set(name, p);
  return p;
}

// ---------------------------------------------------------------------------
// สไปรต์แบบไฟล์ภาพ PNG: public/sprites/png/<jobId>/idle.png, work.png|work-1.png…, sit.png (+ manifest.json ไม่บังคับ)
// ถ้ามี PNG ของอาชีพนั้น จะใช้แทนสไปรต์ที่วาดในโค้ด (sprites/<jobId>.js) ถ้าไม่มีก็ใช้ของเดิม — ดู public/sprites/png/README.md
// ---------------------------------------------------------------------------
const PNG_DIR = "./sprites/png";
const PNG_ANIMS = ["idle", "work", "sit"];
const PNG_MAX_FRAMES = 8;
const PNG_TARGET_H = 46; // ความสูงตัวละคร (px ที่ zoom 1) ให้ใกล้เคียงสไปรต์ที่วาดในโค้ด — ภาพจากตัวจำลองจะถูกย่อ/ขยายให้พอดีอัตโนมัติ
const pngs = new Map(); // jobId -> { anims: { idle: [canvas], work: [canvas]|null, sit: [canvas]|null }, scale, offsetY } | null
const pngLoading = new Map();
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}
async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}
/**
 * เตรียมภาพจากไฟล์: (1) ทำพื้นหลังสีทึบให้โปร่งใส — "auto" = ใช้สีมุมซ้ายบน, "#rrggbb" = สีที่ระบุ, false = ไม่ทำ
 * (2) ตัดขอบโปร่งใสรอบตัวละครออก (ภาพจากตัวจำลองเป็นกรอบ 240x240 ที่ตัวละครอยู่กลาง) เพื่อให้จุดยืน = กึ่งกลางด้านล่างของตัวละครจริง
 */
function keyOut(img, transparent = "auto") {
  const c = document.createElement("canvas");
  c.width = img.width; c.height = img.height;
  const g = c.getContext("2d");
  g.drawImage(img, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  const d = data.data;
  if (transparent !== false) {
    let kr, kg, kb, doKey = true;
    if (typeof transparent === "string" && transparent !== "auto") {
      const n = parseInt(transparent.replace("#", ""), 16);
      kr = (n >> 16) & 255; kg = (n >> 8) & 255; kb = n & 255;
    } else if (d[3] < 255) {
      doKey = false; // มุมซ้ายบนโปร่งใสอยู่แล้ว = ภาพมี alpha ไม่ต้องทำ
    } else {
      kr = d[0]; kg = d[1]; kb = d[2];
    }
    if (doKey) {
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - kr) + Math.abs(d[i + 1] - kg) + Math.abs(d[i + 2] - kb) <= 24) d[i + 3] = 0;
      }
    }
  }
  // ตัดขอบโปร่งใส
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return c; // ภาพว่างทั้งใบ
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext("2d").putImageData(data, -x0, -y0);
  return out;
}
async function loadPngFrames(dir, anim, manifest, transparent) {
  const frames = [];
  if (Array.isArray(manifest?.anims?.[anim])) {
    for (const name of manifest.anims[anim]) {
      const img = await loadImage(`${dir}/${name}`);
      if (img) frames.push(keyOut(img, transparent));
    }
    return frames;
  }
  const single = await loadImage(`${dir}/${anim}.png`);
  if (single) frames.push(keyOut(single, transparent));
  for (let i = 1; i <= PNG_MAX_FRAMES; i++) {
    const img = await loadImage(`${dir}/${anim}-${i}.png`);
    if (!img) break;
    frames.push(keyOut(img, transparent));
  }
  return frames;
}
function loadPng(jobId) {
  if (pngLoading.has(jobId)) return pngLoading.get(jobId);
  const p = (async () => {
    const dir = `${PNG_DIR}/${jobId}`;
    const manifest = await fetchJson(`${dir}/manifest.json`);
    const transparent = manifest?.transparent === undefined ? "auto" : manifest.transparent;
    const idle = await loadPngFrames(dir, "idle", manifest, transparent);
    if (!idle.length) { pngs.set(jobId, null); return null; }
    const anims = { idle };
    for (const anim of PNG_ANIMS.slice(1)) {
      const f = await loadPngFrames(dir, anim, manifest, transparent);
      anims[anim] = f.length ? f : null;
    }
    // ย่อ/ขยายให้ตัวละคร (หลังตัดขอบ) สูงราว PNG_TARGET_H แล้วคูณด้วย manifest.scale (ค่าเริ่มต้น 1)
    const autoScale = PNG_TARGET_H / Math.max(1, idle[0].height);
    const userScale = Number(manifest?.scale) > 0 ? Number(manifest.scale) : 1;
    const sprite = { anims, scale: autoScale * userScale, offsetY: Number(manifest?.offsetY) || 0 };
    pngs.set(jobId, sprite);
    console.info(`[scene] ใช้สไปรต์ PNG ของ ${jobId} (idle ${idle.length} เฟรม${anims.work ? `, work ${anims.work.length}` : ""}${anims.sit ? ", sit" : ""}; ตัดขอบแล้ว ${idle[0].width}x${idle[0].height} px, scale ${sprite.scale.toFixed(2)})`);
    return sprite;
  })();
  pngLoading.set(jobId, p);
  return p;
}

// ---------------------------------------------------------------------------
// ฉากหลังแบบภาพ (แผนที่จริง): public/sprites/png/map/morroc.png + manifest.json
// ถ้ามีภาพ จะใช้แทนกระเบื้อง/อาคารที่วาดในโค้ดทั้งหมด ตัวละครยืนตามสัดส่วนของภาพ (0–1) ใน manifest.spots
// โหมดช่วยปรับพิกัด: กด D บนแผนที่ → เห็นพิกัดที่เมาส์ชี้ + จุดยืนทุกคน, คลิกเพื่อคัดลอก [x, y] — ดู public/sprites/png/README.md
// ---------------------------------------------------------------------------
const MAP_DIR = "./sprites/png/map";
const MAP_IMAGE_CANDIDATES = ["morroc.png", "morroc.jpg", "map.png", "map.jpg"];
async function loadMapImage() {
  const manifest = (await fetchJson(`${MAP_DIR}/manifest.json`)) || {};
  const names = manifest.image ? [manifest.image] : MAP_IMAGE_CANDIDATES;
  let img = null;
  for (const name of names) {
    img = await loadImage(`${MAP_DIR}/${name}`);
    if (img) break;
  }
  if (!img) return null;
  const frac = (v) => (Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(Number(n))) ? [Math.min(1, Math.max(0, Number(v[0]))), Math.min(1, Math.max(0, Number(v[1])))] : null);
  const spots = {};
  for (const [k, v] of Object.entries(manifest.spots || {})) { const f = frac(v); if (f) spots[k] = f; }
  const zones = {};
  for (const [k, v] of Object.entries(manifest.zones || {})) { const f = frac(v); if (f) zones[k] = f; }
  const spare = (manifest.spare || []).map(frac).filter(Boolean);
  const map = { img, spots, zones, spare, charScale: Number(manifest.charScale) > 0 ? Number(manifest.charScale) : 1, fit: manifest.fit === "cover" ? "cover" : "contain" };
  console.info(`[scene] ใช้ภาพแผนที่ ${img.width}x${img.height} px เป็นฉากหลัง (จุดยืน ${Object.keys(spots).length} อาชีพ) — กด D บนแผนที่เพื่อดู/ปรับพิกัด`);
  return map;
}

function hexToRgba(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex || "");
  if (!m) return [255, 0, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255, m[2] ? parseInt(m[2], 16) : 255];
}

/** แปลง rows (string[]) + palette → canvas ขนาด w*s x h*s */
function renderRows(rows, palette, s) {
  const h = rows.length, w = rows[0]?.length || 1;
  const c = document.createElement("canvas");
  c.width = w * s; c.height = h * s;
  const cx = c.getContext("2d");
  const img = cx.createImageData(w * s, h * s);
  const d = img.data;
  const colors = new Map();
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    for (let x = 0; x < w; x++) {
      const ch = row[x];
      if (ch === ".") continue;
      let col = colors.get(ch);
      if (!col) { col = hexToRgba(palette[ch]); colors.set(ch, col); }
      for (let sy = 0; sy < s; sy++) {
        let i = ((y * s + sy) * w * s + x * s) * 4;
        for (let sx = 0; sx < s; sx++) { d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = col[3]; i += 4; }
      }
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

const cache = new Map(); // rows -> Map(palette -> Map(scale -> canvas))
function frameCanvas(rows, palette, s) {
  let byPal = cache.get(rows); if (!byPal) { byPal = new Map(); cache.set(rows, byPal); }
  let byScale = byPal.get(palette); if (!byScale) { byScale = new Map(); byPal.set(palette, byScale); }
  let c = byScale.get(s); if (!c) { c = renderRows(rows, palette, s); byScale.set(s, c); }
  return c;
}

/** ทำ layer มาตรฐาน { w, h, anchor, palette, anims } จากส่วนต่าง ๆ ของโมดูล */
function layerOf(size, anchor, palette, frames) {
  if (!size || !frames) return null;
  const anims = Array.isArray(frames) ? { main: frames } : frames;
  return { w: size.w, h: size.h, anchor: anchor || { x: Math.floor(size.w / 2), y: size.h - 1 }, palette, anims };
}
function characterLayers(m, tint) {
  if (!m) return null;
  const palette = tint ? { ...m.palette, ...tint } : m.palette;
  return {
    body: layerOf(m.size, m.anchor, palette, m.frames),
    station: m.station ? layerOf(m.station.size, m.station.anchor, { ...palette, ...(m.station.palette || {}) }, m.station.frames) : null,
    effect: m.effect ? layerOf(m.effect.size, m.effect.anchor, { ...palette, ...(m.effect.palette || {}) }, m.effect.frames) : null,
  };
}

// ---------------------------------------------------------------------------
export function createScene(canvas, S, hooks = {}) {
  const ctx = canvas.getContext("2d");
  const V = { dpr: 1, W: 1, H: 1, scale: 2, px: 2, ox: 0, oy: 0, hover: null, last: 0, raf: 0 };
  const positions = new Map(); // agentId -> { tx, ty, jobId }
  const charCache = new Map(); // jobId -> layers (รวม tint fallback)
  const tiles = new Map(); // tileName -> layer
  const props = new Map(); // propName -> layer
  let common = null; // { items, emotes, fx } layers
  let bg = null; // offscreen พื้น + ตึกฉากหลัง
  let mapImg = null; // ฉากหลังแบบภาพ { img, spots, zones, spare, charScale, fit } | null — ถ้ามี พิกัดตำแหน่ง (tx, ty) = เปอร์เซ็นต์ของภาพ (0–100)
  const packets = [], ripples = [], particles = [], fxList = [], floats = [], bubbles = [];
  const emotes = new Map(); // agentId -> { type, t0, loop }
  let destroyed = false;

  const toScreen = (tx, ty) =>
    mapImg && V.img
      ? { x: V.img.x + (tx / 100) * V.img.w, y: V.img.y + (ty / 100) * V.img.h }
      : { x: V.ox + (tx - ty) * (TW / 2) * V.scale, y: V.oy + (tx + ty) * (TH / 2) * V.scale };
  const cs = () => V.scale * CHAR_SCALE * (mapImg?.charScale || 1);
  // ลำดับการวาด (ไกล → ใกล้): กริดไอโซใช้ tx+ty, ภาพแผนที่ใช้แกน y ของภาพ
  const depthOf = (pos) => (mapImg ? pos.ty + pos.tx * 0.001 : pos.tx + pos.ty + pos.ty * 0.001);

  // ----- สไปรต์ -----
  function jobOf(agent, researchIndex) {
    if (agent.jobId) return agent.jobId;
    if (agent.role === "researcher") return RESEARCH_JOBS[researchIndex % RESEARCH_JOBS.length];
    return ROLE_JOB[agent.role] || "_base";
  }
  function layersFor(jobId) {
    const hit = charCache.get(jobId);
    if (hit) return hit;
    const real = modules.get(jobId);
    const base = modules.get("_base");
    const l = real ? characterLayers(real) : base ? characterLayers(base, TINT[jobId]) : null;
    if (l && (real || base)) charCache.set(jobId, l);
    return l;
  }
  async function loadTileset() {
    for (const name of ["morroc-ground", "morroc-buildings", "morroc-buildings2"]) {
      const m = await load(name);
      if (!m) continue;
      const basePal = m.palette || {};
      if (m.tiles?.frames) {
        const pal = { ...basePal, ...(m.tiles.palette || {}) };
        for (const [k, frames] of Object.entries(m.tiles.frames)) tiles.set(k, layerOf(m.tiles.size, { x: m.tiles.size.w / 2, y: m.tiles.size.h / 2 }, pal, frames));
      }
      if (m.props) for (const [k, p] of Object.entries(m.props)) props.set(k, layerOf(p.size, p.anchor, { ...basePal, ...(p.palette || {}) }, p.frames));
    }
  }
  async function loadCommon() {
    const m = await load("common");
    if (!m) return;
    const pal = m.palette || {};
    common = {
      items: m.items ? layerOf(m.items.size, m.items.anchor, { ...pal, ...(m.items.palette || {}) }, m.items.frames) : null,
      emotes: m.emotes ? layerOf(m.emotes.size, m.emotes.anchor, { ...pal, ...(m.emotes.palette || {}) }, m.emotes.frames) : null,
      fx: m.fx ? layerOf(m.fx.size, m.fx.anchor, { ...pal, ...(m.fx.palette || {}) }, m.fx.frames) : null,
    };
  }
  const ready = (async () => {
    await load("_base");
    await Promise.all([loadTileset(), loadCommon()]);
    await Promise.all([...positions.values()].map((p) => load(p.jobId)));
    await Promise.all([...positions.values()].map((p) => loadPng(p.jobId)));
    mapImg = await loadMapImage();
    charCache.clear();
    if (mapImg) { assignSpots(); layout(); }
    buildBackground();
  })();

  // ----- เลย์เอาต์ -----
  function assignSpots() {
    positions.clear();
    const used = new Set();
    let spare = 0, resIdx = 0;
    for (const a of S.agents.values()) {
      const jobId = jobOf(a, resIdx);
      if (a.role === "researcher") resIdx++;
      let spot;
      if (mapImg) {
        // ภาพแผนที่: จุดยืนเป็นสัดส่วนของภาพ → เก็บเป็นเปอร์เซ็นต์ (0–100) เพื่อใช้ toScreen ร่วมกับโค้ดเดิม
        const f = mapImg.spots[jobId] || mapImg.spots[a.id];
        const spareList = mapImg.spare.length ? mapImg.spare : [[0.2, 0.9], [0.4, 0.9], [0.6, 0.9], [0.8, 0.9], [0.3, 0.1], [0.7, 0.1]];
        const pick = f && !used.has(f.join()) ? f : spareList[spare++ % spareList.length];
        spot = [pick[0] * 100, pick[1] * 100];
      } else {
        spot = MAP.spots[jobId];
        if (!spot || used.has(spot.join())) spot = MAP.spareSpots[spare++ % MAP.spareSpots.length];
      }
      used.add(spot.join());
      positions.set(a.id, { tx: spot[0], ty: spot[1], jobId });
      if (!modules.has(jobId)) load(jobId).then(() => { charCache.delete(jobId); hooks.onSpriteLoaded?.(jobId); });
      if (!pngs.has(jobId)) loadPng(jobId).then((p) => { if (p) { charCache.delete(jobId); hooks.onSpriteLoaded?.(jobId); } });
    }
  }
  function layout() {
    const r = canvas.parentElement.getBoundingClientRect();
    V.dpr = Math.min(2, window.devicePixelRatio || 1);
    V.W = Math.max(1, r.width); V.H = Math.max(1, r.height);
    canvas.width = Math.floor(V.W * V.dpr); canvas.height = Math.floor(V.H * V.dpr);
    canvas.style.width = `${V.W}px`; canvas.style.height = `${V.H}px`;
    const mapW = MAP.w * TW, mapH = ((MAP.w + MAP.h) * TH) / 2 + 70;
    V.scale = Math.max(1.1, Math.min(3, Math.min(V.W / mapW, V.H / mapH)));
    V.px = Math.max(1, Math.round(V.scale));
    const screenH = ((MAP.w + MAP.h) * TH) / 2 * V.scale;
    V.ox = V.W / 2;
    V.oy = (V.H - screenH) / 2 + (TH / 2) * V.scale + 18 * V.scale;
    if (mapImg) {
      // วางภาพให้พอดีกับเวที (contain = เห็นทั้งภาพ, cover = เต็มเวทีตัดขอบ) เว้นขอบ 6px
      const pad = 6, iw = mapImg.img.width, ih = mapImg.img.height;
      const k = mapImg.fit === "cover" ? Math.max((V.W - pad * 2) / iw, (V.H - pad * 2) / ih) : Math.min((V.W - pad * 2) / iw, (V.H - pad * 2) / ih);
      const w = iw * k, h = ih * k;
      V.img = { x: (V.W - w) / 2, y: (V.H - h) / 2, w, h, k };
      // ขนาดตัวละครอิงความสูงของภาพบนจอ (ภาพสูง ~ 600px → ตัวละครขนาดปกติ) ปรับเพิ่มได้ด้วย charScale ใน manifest
      V.scale = Math.max(1.1, Math.min(3, h / 300));
      V.px = Math.max(1, Math.round(V.scale));
    } else {
      V.img = null;
    }
    assignSpots();
    buildBackground();
  }

  // ----- พื้นหลัง -----
  // พื้นกระเบื้องวาดครั้งเดียวที่ scale จำนวนเต็ม (V.px) ลง offscreen แล้วค่อยย่อ/ขยายทั้งผืนตอนวาดจริง
  // → กระเบื้องต่อกันสนิทไม่มีรอยต่อแม้ V.scale เป็นทศนิยม ; มี 2 ผืนสำหรับน้ำ 2 เฟรม
  let bgs = [];
  function buildBackground() {
    const px = V.px;
    const bw = Math.ceil(((MAP.w + MAP.h) * TW) / 2) * px;
    const bh = Math.ceil(((MAP.w + MAP.h) * TH) / 2 + TH) * px;
    V.bgOx = ((MAP.h * TW) / 2) * px; V.bgOy = (TH / 2) * px; // กึ่งกลางกระเบื้อง (0,0) ในภาพพื้น
    const at = (tx, ty) => ({ x: V.bgOx + (tx - ty) * (TW / 2) * px, y: V.bgOy + (tx + ty) * (TH / 2) * px });
    const water = tiles.get("water");
    const frames = water && water.anims.main.length > 1 ? 2 : 1;
    bgs = [];
    for (let fi = 0; fi < frames; fi++) {
      const c0 = document.createElement("canvas"); c0.width = bw; c0.height = bh;
      const c = c0.getContext("2d"); c.imageSmoothingEnabled = false;
      for (let ty = 0; ty < MAP.h; ty++) for (let tx = 0; tx < MAP.w; tx++) {
        const { x, y } = at(tx, ty);
        const name = MAP.ground[ty][tx];
        const l = tiles.get(name);
        if (l) {
          const f = l.anims.main[name === "water" ? fi % l.anims.main.length : 0];
          c.drawImage(frameCanvas(f, l.palette, px), x - (TW / 2) * px, y - (TH / 2) * px);
        } else {
          c.beginPath();
          c.moveTo(x, y - (TH / 2) * px); c.lineTo(x + (TW / 2) * px, y); c.lineTo(x, y + (TH / 2) * px); c.lineTo(x - (TW / 2) * px, y); c.closePath();
          c.fillStyle = TILE_COLORS[name] || (name.startsWith("carpet") ? "#8e1f2a" : "#d9b875");
          c.fill();
          if (name.startsWith("carpet") && name !== "carpet") { c.strokeStyle = "#e8b74a"; c.lineWidth = 1; c.stroke(); }
        }
      }
      bgs.push(c0);
    }
    bg = bgs[0];
  }
  function drawSky(ts) {
    const g = ctx.createLinearGradient(0, 0, 0, V.H);
    g.addColorStop(0, "#2b1d2e"); g.addColorStop(0.45, "#4a2f2a"); g.addColorStop(1, "#3a2a1c");
    ctx.fillStyle = g; ctx.fillRect(0, 0, V.W, V.H);
    ctx.fillStyle = "rgba(255,170,90,0.18)"; ctx.beginPath(); ctx.arc(V.W * 0.78, V.H * 0.12, 60 * V.scale, 0, TAU); ctx.fill();
    ctx.fillStyle = "#5a3f2a";
    ctx.beginPath(); ctx.moveTo(0, V.H * 0.3); ctx.quadraticCurveTo(V.W * 0.25, V.H * 0.2, V.W * 0.5, V.H * 0.3); ctx.quadraticCurveTo(V.W * 0.75, V.H * 0.4, V.W, V.H * 0.28); ctx.lineTo(V.W, V.H); ctx.lineTo(0, V.H); ctx.fill();
    for (const b of MAP.backdrop) {
      const { x, y } = toScreen(b.tx, b.ty);
      const l = props.get(b.name);
      if (l) drawLayer(l, l.anims.main[0], x, y, V.scale);
      else {
        ctx.fillStyle = "#8a6a44"; ctx.beginPath(); ctx.moveTo(x - 48 * V.scale, y); ctx.lineTo(x, y - 60 * V.scale); ctx.lineTo(x + 48 * V.scale, y); ctx.closePath(); ctx.fill();
        ctx.fillStyle = "#5e4630"; ctx.beginPath(); ctx.moveTo(x, y - 60 * V.scale); ctx.lineTo(x + 48 * V.scale, y); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
      }
    }
    void ts;
  }
  function drawMapImage() {
    if (!mapImg || !V.img) return;
    ctx.save();
    ctx.imageSmoothingEnabled = true; // ภาพแผนที่จริงไม่ใช่พิกเซลอาร์ต ย่อ/ขยายแบบเนียน
    if (mapImg.fit === "cover") { ctx.beginPath(); ctx.rect(0, 0, V.W, V.H); ctx.clip(); }
    ctx.drawImage(mapImg.img, V.img.x, V.img.y, V.img.w, V.img.h);
    ctx.restore();
    ctx.imageSmoothingEnabled = false;
  }
  function drawGround(ts) {
    if (mapImg) return drawMapImage();
    if (!bgs.length) return;
    const b = bgs[Math.floor(ts / 600) % bgs.length];
    const k = V.scale / V.px;
    ctx.drawImage(b, V.ox - V.bgOx * k, V.oy - V.bgOy * k, b.width * k, b.height * k);
  }

  // ----- วาด layer ที่ตำแหน่ง anchor -----
  function drawLayerOn(c, l, rows, ax, ay, scale) {
    const img = frameCanvas(rows, l.palette, V.px);
    const w = l.w * scale, h = l.h * scale;
    c.drawImage(img, Math.round(ax - l.anchor.x * scale), Math.round(ay - (l.anchor.y + 1) * scale), Math.round(w), Math.round(h));
  }
  const drawLayer = (l, rows, ax, ay, scale) => drawLayerOn(ctx, l, rows, ax, ay, scale);

  // ----- ข้อความ/กล่อง -----
  function text(str, x, y, { size = 12, weight = 600, fill = "#fff", stroke = "rgba(0,0,0,0.85)", align = "center", font = FONT } = {}) {
    ctx.font = `${weight} ${size}px ${font}`; ctx.textAlign = align; ctx.textBaseline = "middle";
    if (stroke) { ctx.lineWidth = 3; ctx.lineJoin = "round"; ctx.strokeStyle = stroke; ctx.strokeText(str, x, y); }
    ctx.fillStyle = fill; ctx.fillText(str, x, y);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  const alpha = (hex, a) => {
    if (/^#[0-9a-f]{3}$/i.test(hex)) hex = "#" + [...hex.slice(1)].map((c) => c + c).join("");
    return hex.slice(0, 7) + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0");
  };
  const trunc = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
  const dots = (ts) => ".".repeat(1 + (Math.floor(ts / 400) % 3));

  // ----- ตัวละคร -----
  function charMetrics(a) {
    const pos = positions.get(a.id); if (!pos) return null;
    const { x, y } = toScreen(pos.tx, pos.ty);
    const s = cs();
    return { pos, x, y, s, w: 24 * s, h: 32 * s, headY: y - 32 * s };
  }
  function drawCharacter(a, ts) {
    const m = charMetrics(a); if (!m) return;
    const L = layersFor(m.pos.jobId);
    const working = a.status === "working", paused = a.status === "paused";
    // เงา + ออร่ากัปตัน
    ctx.save();
    if (a.role === "captain") {
      const pulse = 0.25 + 0.15 * Math.sin(ts / 400);
      ctx.strokeStyle = alpha("#f5b942", pulse); ctx.lineWidth = 2 * V.scale;
      ctx.beginPath(); ctx.ellipse(m.x, m.y, 18 * m.s, 8 * m.s, 0, 0, TAU); ctx.stroke();
    }
    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.beginPath(); ctx.ellipse(m.x, m.y + 1, 9 * m.s, 3.5 * m.s, 0, 0, TAU); ctx.fill();
    ctx.restore();
    const P = pngs.get(m.pos.jobId);
    if (P) { // มีสไปรต์ PNG ของอาชีพนี้ → ใช้ภาพแทนสไปรต์ที่วาดในโค้ด
      drawPngCharacter(a, m, P, ts);
      if (working && L?.effect) { const f = L.effect.anims.main; drawLayer(L.effect, f[Math.floor(ts / 150) % f.length], m.x, m.y, m.s); }
      return;
    }
    if (!L) { // ยังไม่โหลด: วงกลมสีประจำตำแหน่ง
      ctx.fillStyle = a.color || "#8b97ad"; ctx.beginPath(); ctx.arc(m.x, m.y - 14 * m.s, 10 * m.s, 0, TAU); ctx.fill();
      return;
    }
    let rows, dy = 0;
    if (paused) rows = L.body.anims.sit?.[0] || L.body.anims.idle[0];
    else if (working) { const f = L.body.anims.work || L.body.anims.idle; rows = f[Math.floor(ts / 180) % f.length]; }
    else { const f = L.body.anims.idle; rows = f[Math.floor(ts / 500) % f.length]; if (f.length === 1) dy = Math.floor(ts / 500) % 2 ? -1 * V.scale : 0; }
    if (V.hover === a.id) { ctx.save(); ctx.shadowColor = a.color || "#fff"; ctx.shadowBlur = 16; drawLayer(L.body, rows, m.x, m.y + dy, m.s); ctx.restore(); }
    else drawLayer(L.body, rows, m.x, m.y + dy, m.s);
    if (working && L.effect) {
      const f = L.effect.anims.main; drawLayer(L.effect, f[Math.floor(ts / 150) % f.length], m.x, m.y, m.s);
    }
  }
  function drawPngCharacter(a, m, P, ts) {
    const working = a.status === "working", paused = a.status === "paused";
    let frames = P.anims.idle, period = 500;
    if (paused && P.anims.sit) frames = P.anims.sit;
    else if (working && P.anims.work) { frames = P.anims.work; period = 180; }
    const img = frames[Math.floor(ts / period) % frames.length];
    const k = V.scale * P.scale * (mapImg?.charScale || 1);
    const w = img.width * k, h = img.height * k;
    const dy = !working && !paused && frames.length === 1 && Math.floor(ts / 500) % 2 ? -1 * V.scale : 0; // โยกตัวเบา ๆ ตอนว่างถ้ามีเฟรมเดียว
    ctx.save();
    ctx.imageSmoothingEnabled = false; // พิกเซลอาร์ตขยายแล้วต้องคม
    if (V.hover === a.id) { ctx.shadowColor = a.color || "#fff"; ctx.shadowBlur = 16; }
    ctx.drawImage(img, Math.round(m.x - w / 2), Math.round(m.y - h + P.offsetY * V.scale + dy), Math.round(w), Math.round(h));
    ctx.restore();
  }
  function drawStation(a, ts) {
    if (mapImg) return; // ภาพแผนที่จริงมีอาคารอยู่แล้ว ไม่วาดสถานี
    const m = charMetrics(a); if (!m) return;
    const L = layersFor(m.pos.jobId); if (!L?.station) return;
    const { x, y } = toScreen(m.pos.tx - 1, m.pos.ty - 1);
    const f = L.station.anims.main;
    const fi = f.length > 1 ? (a.status === "working" ? 1 + (Math.floor(ts / 300) % (f.length - 1)) : 0) : 0;
    drawLayer(L.station, f[fi], x, y, m.s);
  }
  function drawProp(p, ts) {
    const l = props.get(p.name); if (!l) return;
    const f = l.anims.main; const rows = f[f.length > 1 ? Math.floor(ts / 320) % f.length : 0];
    const { x, y } = toScreen(p.tx, p.ty);
    drawLayer(l, rows, x, y, V.scale);
  }

  // ----- UI ซ้อนทับของตัวละคร -----
  function drawTags(a, ts) {
    const m = charMetrics(a); if (!m) return;
    const task = a.currentTaskId ? S.tasks.get(a.currentTaskId) : null;
    const working = a.status === "working", paused = a.status === "paused";
    const col = a.color || "#8b97ad";
    // ป้ายชื่อใต้เท้า
    const ny = m.y + 12 * V.scale + 6;
    text(a.name || a.id, m.x, ny, { size: 12, weight: 700 });
    const sub = [a.nick && a.nick !== a.name ? a.nick : "", a.roleLabel].filter(Boolean).join(" · ");
    text(sub, m.x, ny + 14, { size: 10, weight: 500, fill: "#ffd86b" });
    // HP (ความคืบหน้างาน) / SP (อัตราใช้งาน)
    const bw = 60, bx = m.x - bw / 2, by = ny + 24;
    const hp = working ? Math.max(0.02, task?.progress || 0) : 1;
    const sp = Math.max(0, Math.min(1, a.computed?.utilization || 0));
    ctx.fillStyle = "rgba(0,0,0,0.75)"; ctx.fillRect(bx - 1, by - 1, bw + 2, 12);
    ctx.fillStyle = "#1a2a1a"; ctx.fillRect(bx, by, bw, 4);
    ctx.fillStyle = paused ? "#6b7280" : "#3dd598"; ctx.fillRect(bx, by, Math.round(bw * hp), 4);
    ctx.fillStyle = "#101a2e"; ctx.fillRect(bx, by + 6, bw, 4);
    ctx.fillStyle = paused ? "#6b7280" : "#4fa3ff"; ctx.fillRect(bx, by + 6, Math.round(bw * sp), 4);
    // สถานะเล็ก ๆ ท้ายบาร์
    const st = paused ? "หยุดพัก" : working ? `${Math.round((task?.progress || 0) * 100)}%` : "ว่าง";
    text(st, m.x + bw / 2 + 4, by + 5, { size: 9, weight: 700, fill: paused ? "#ffa552" : working ? "#3dd598" : "#8b97ad", align: "left" });

    // เหนือหัว: cast bar + กล่องแชต
    let top = m.headY - 8;
    if (working && task) {
      const cw = 88, ch = 12, cx = m.x - cw / 2, cy = top - ch;
      ctx.fillStyle = "rgba(5,10,20,0.85)"; ctx.fillRect(cx - 1, cy - 1, cw + 2, ch + 2);
      ctx.fillStyle = "#1f6b45"; ctx.fillRect(cx, cy, Math.round(cw * (task.progress || 0)), ch);
      ctx.strokeStyle = "#3dd598"; ctx.lineWidth = 1; ctx.strokeRect(cx + 0.5, cy + 0.5, cw - 1, ch - 1);
      text(trunc(task.title, 18), m.x, cy + ch / 2 + 0.5, { size: 9, weight: 600, stroke: "rgba(0,0,0,0.6)" });
      top = cy - 4;
    }
    // กล่องแชต (วาดในรอบหลังสุดเพื่อให้อยู่บนสุด) — ว่างไม่ต้องมีกล่อง ยกเว้นกัปตันที่มีคิวงาน
    bubbles.push({ a, m, top });
    void col;
  }
  function drawBubble({ a, m, top }, ts) {
    const task = a.currentTaskId ? S.tasks.get(a.currentTaskId) : null;
    const working = a.status === "working", paused = a.status === "paused";
    let phrase = "";
    if (paused) phrase = "ขอพักก่อนนะ zZ";
    else if (working) phrase = (a.phase || (task ? task.title : "กำลังทำงาน")) + dots(ts);
    else if (a.role === "captain" && S.totals?.queued) phrase = `คิวงาน ${S.totals.queued} ชิ้น`;
    if (!phrase) { const e0 = emotes.get(a.id); if (e0) drawEmote(a, e0, m, top - 4, ts); return; }
    const maxW = Math.min(160, Math.max(110, V.W * 0.16));
    ctx.font = `500 11px ${FONT}`;
    const lines = wrap(phrase, maxW - 14);
    const bh = lines.length * 14 + 8, bwid = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14);
    const bx2 = m.x - bwid / 2, by2 = top - bh - 6;
    roundRect(bx2, by2, bwid, bh, 6); ctx.fillStyle = paused ? "#e6e0d0" : "#fff"; ctx.fill(); ctx.strokeStyle = "#1b1b1f"; ctx.lineWidth = 1; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(m.x - 4, by2 + bh); ctx.lineTo(m.x, by2 + bh + 5); ctx.lineTo(m.x + 4, by2 + bh); ctx.closePath(); ctx.fillStyle = paused ? "#e6e0d0" : "#fff"; ctx.fill();
    lines.forEach((l, i) => text(l, m.x, by2 + 11 + i * 14, { size: 11, weight: 500, fill: "#1b1b1f", stroke: null }));
    const e = emotes.get(a.id);
    if (e) drawEmote(a, e, m, by2 - 6, ts);
  }
  /** ตัดบรรทัดไม่เกิน 2 บรรทัด — ข้อความไทยไม่มีช่องว่าง จึงตัดตามความกว้างจริงด้วย */
  function wrap(str, maxW) {
    const fitWidth = (s) => {
      let w = ctx.measureText(s).width;
      if (w <= maxW) return [s, ""];
      let n = Math.max(4, Math.floor(s.length * (maxW / w)));
      while (n > 4 && ctx.measureText(s.slice(0, n)).width > maxW) n--;
      return [s.slice(0, n), s.slice(n)];
    };
    const words = str.split(/\s+/).filter(Boolean);
    const lines = []; let cur = "";
    for (const w of words) {
      const tryLine = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(tryLine).width > maxW && cur) { lines.push(cur); cur = w; } else cur = tryLine;
      if (lines.length >= 2) break;
    }
    if (cur && lines.length < 2) lines.push(cur);
    // บรรทัดที่ยังยาวเกิน (คำไทยยาว) ตัดตามความกว้าง และบรรทัดสุดท้ายใส่ …
    const out = [];
    for (const l of lines) {
      const [head, rest] = fitWidth(l);
      out.push(head);
      if (rest && out.length < 2) out.push(fitWidth(rest)[0]);
      if (out.length >= 2) break;
    }
    if (!out.length) out.push(trunc(str, 24));
    if (out.length === 2 && (ctx.measureText(out[1]).width >= maxW - 8 || lines.length > 2 || out.join("").length < str.replace(/\s+/g, "").length)) out[1] = fitWidth(out[1].slice(0, -1))[0] + "…";
    return out.slice(0, 2);
  }
  function drawEmote(a, e, m, yTop, ts) {
    const age = ts - e.t0;
    const dur = e.loop ? Infinity : 1400;
    if (age > dur) { emotes.delete(a.id); return; }
    const bounce = age < 400 ? -(1 - age / 400) * 10 : 0;
    const y = yTop - 10 + bounce;
    if (common?.emotes?.anims?.[e.type]) {
      const f = common.emotes.anims[e.type]; const rows = f[Math.floor(ts / 250) % f.length];
      drawLayer(common.emotes, rows, m.x + 18 * V.scale, y, V.scale * 1.4);
      return;
    }
    const glyph = EMOTE_GLYPH[e.type] || "!";
    ctx.beginPath(); ctx.arc(m.x + 18 * V.scale, y - 8, 10, 0, TAU); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#1b1b1f"; ctx.lineWidth = 1; ctx.stroke();
    text(glyph, m.x + 18 * V.scale, y - 7.5, { size: 11, weight: 800, fill: EMOTE_COLOR[e.type] || "#1b1b1f", stroke: null, font: e.type === "angry" ? EMOJI_FONT : FONT });
  }

  // ----- ป้ายโซน -----
  function drawZoneLabels() {
    for (const z of MAP.zones) {
      let x, y;
      if (mapImg) {
        const f = mapImg.zones[z.id]; if (!f) continue; // ภาพแผนที่: วาดเฉพาะโซนที่ manifest.zones ระบุตำแหน่ง
        ({ x, y } = toScreen(f[0] * 100, f[1] * 100));
      } else {
        ({ x, y } = toScreen(z.labelAt[0], z.labelAt[1]));
      }
      ctx.font = `700 11px ${FONT}`;
      const w = ctx.measureText(z.label).width + 18;
      roundRect(x - w / 2, y - 10, w, 20, 10);
      ctx.fillStyle = "rgba(8,12,22,0.82)"; ctx.fill(); ctx.strokeStyle = alpha(z.color, 0.9); ctx.lineWidth = 1.5; ctx.stroke();
      text(z.label, x, y + 0.5, { size: 11, weight: 700, fill: z.color, stroke: null });
    }
  }

  // ----- ไอเท็มบิน / เอฟเฟกต์ -----
  function headPoint(id) {
    if (id === "captain" && !positions.has("captain")) {
      const cap = [...S.agents.values()].find((a) => a.role === "captain");
      id = cap?.id;
    }
    const a = S.agents.get(id); const m = a && charMetrics(a);
    return m ? { x: m.x, y: m.headY - 4 } : null;
  }
  function spawnPacket(fromId, toId, label, color, kind) {
    const a = headPoint(fromId), b = headPoint(toId);
    if (!a || !b) return;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const off = (kind === "handoff" ? 70 : 34) * (V.scale / 2);
    const side = kind === "return" ? -1 : 1;
    packets.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, cx: mx - (dy / len) * off * side - (kind === "return" ? 0 : 0), cy: my + (dx / len) * off * side - 40, t: 0, dur: kind === "handoff" ? 1400 : 1000, label, color: color || "#fff", kind, to: toId });
  }
  function drawPackets(dt, ts) {
    for (const p of packets) {
      p.t += dt / p.dur;
      const t = Math.min(1, p.t);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const bez = (u) => ({ x: (1 - u) ** 2 * p.ax + 2 * (1 - u) * u * p.cx + u * u * p.bx, y: (1 - u) ** 2 * p.ay + 2 * (1 - u) * u * p.cy + u * u * p.by });
      const q = bez(e);
      // เงาบนพื้นใต้ไอเท็ม
      const gy = p.ay + (p.by - p.ay) * e + 30 * V.scale;
      ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.beginPath(); ctx.ellipse(p.ax + (p.bx - p.ax) * e, gy, 6, 2.5, 0, 0, TAU); ctx.fill();
      for (let k = 5; k >= 1; k--) {
        const r = bez(Math.max(0, e - k * 0.035));
        ctx.beginPath(); ctx.arc(r.x, r.y, 5 - k * 0.6, 0, TAU); ctx.fillStyle = alpha(p.color, 0.45 - k * 0.07); ctx.fill();
      }
      const itemAnim = p.kind === "return" ? "letter" : "scroll";
      if (common?.items?.anims?.[itemAnim]) {
        const f = common.items.anims[itemAnim]; drawLayer(common.items, f[Math.floor(ts / 160) % f.length], q.x, q.y + 6 * V.scale, V.scale * 1.3);
      } else {
        ctx.save(); ctx.shadowColor = p.color; ctx.shadowBlur = 14;
        ctx.fillStyle = "#f6e7c1"; ctx.fillRect(q.x - 6, q.y - 5, 12, 10);
        ctx.fillStyle = p.kind === "return" ? "#c0392b" : "#8e1f2a"; ctx.fillRect(q.x - 6, q.y - 1, 12, 2);
        ctx.restore();
      }
      if (p.label) {
        ctx.font = `600 11px ${FONT}`;
        const w = ctx.measureText(p.label).width + 16;
        roundRect(q.x - w / 2, q.y - 30, w, 20, 10);
        ctx.fillStyle = "rgba(11,15,23,0.9)"; ctx.fill(); ctx.strokeStyle = alpha(p.color, 0.85); ctx.lineWidth = 1; ctx.stroke();
        text((p.kind === "handoff" ? "🔁 " : "") + p.label, q.x, q.y - 20, { size: 11, weight: 600, stroke: null });
      }
      if (p.t >= 1) {
        const n = headPoint(p.to);
        if (n) { ripples.push({ x: n.x, y: n.y + 20 * V.scale, r: 6, a: 0.9, color: p.color }); emote(p.to, "alert"); }
      }
    }
    for (let i = packets.length - 1; i >= 0; i--) if (packets[i].t >= 1) packets.splice(i, 1);
    for (const r of ripples) {
      r.r += dt * 0.08 * V.scale; r.a -= dt / 650;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, r.r, r.r * 0.5, 0, 0, TAU); ctx.strokeStyle = alpha(r.color, Math.max(0, r.a)); ctx.lineWidth = 2; ctx.stroke();
    }
    for (let i = ripples.length - 1; i >= 0; i--) if (ripples[i].a <= 0) ripples.splice(i, 1);
  }
  function fx(agentId, type) {
    const m = charMetrics(S.agents.get(agentId) || {}); if (!m) return;
    fxList.push({ id: agentId, type, t0: null, dur: type === "levelup" ? 800 : type === "bless" ? 650 : 500 });
    if (type === "levelup") for (let i = 0; i < 26; i++) particles.push({ x: m.x + (Math.random() - 0.5) * 30, y: m.y, vx: (Math.random() - 0.5) * 0.08, vy: -0.12 - Math.random() * 0.15, life: 1, color: ["#f5b942", "#fff2c8", "#ffd86b"][i % 3] });
  }
  function drawFx(dt, ts) {
    for (const f of fxList) {
      if (f.t0 == null) f.t0 = ts;
      const k = (ts - f.t0) / f.dur; if (k >= 1) continue;
      const a = S.agents.get(f.id); const m = a && charMetrics(a); if (!m) continue;
      if (common?.fx?.anims?.[f.type]) {
        const fr = common.fx.anims[f.type]; drawLayer(common.fx, fr[Math.min(fr.length - 1, Math.floor(k * fr.length))], m.x, m.y, m.s);
        continue;
      }
      ctx.save();
      if (f.type === "levelup") {
        ctx.strokeStyle = alpha("#f5b942", 1 - k); ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(m.x, m.y, 10 + 40 * k * V.scale, 5 + 18 * k * V.scale, 0, 0, TAU); ctx.stroke();
        ctx.fillStyle = alpha("#ffe9a0", 0.35 * (1 - k)); ctx.fillRect(m.x - 14 * m.s, m.y - 34 * m.s - 60 * k, 28 * m.s, 34 * m.s + 60 * k);
      } else if (f.type === "bless") {
        const g = ctx.createLinearGradient(0, m.headY - 90, 0, m.y);
        g.addColorStop(0, alpha("#fff7d6", 0.0)); g.addColorStop(0.5, alpha("#ffe08a", 0.55 * (1 - k))); g.addColorStop(1, alpha("#fff", 0));
        ctx.fillStyle = g; ctx.fillRect(m.x - 12 * m.s, m.headY - 90, 24 * m.s, 90 + 32 * m.s);
        for (let i = 0; i < 5; i++) { const px = m.x + Math.sin(ts / 200 + i) * 12 * m.s, py = m.y - (k * 60 + i * 12); ctx.fillStyle = alpha("#ffd86b", 1 - k); ctx.fillRect(px, py, 3, 3); }
      } else if (f.type === "fail") {
        const sh = Math.sin(ts / 30) * 3 * (1 - k);
        ctx.strokeStyle = alpha("#ff5f6d", 1 - k * 0.6); ctx.lineWidth = 4; ctx.lineCap = "round";
        const cx = m.x + sh, cy = m.headY - 16, r = 9;
        ctx.beginPath(); ctx.moveTo(cx - r, cy - r); ctx.lineTo(cx + r, cy + r); ctx.moveTo(cx + r, cy - r); ctx.lineTo(cx - r, cy + r); ctx.stroke();
      }
      ctx.restore();
    }
    for (let i = fxList.length - 1; i >= 0; i--) if (fxList[i].t0 != null && ts - fxList[i].t0 >= fxList[i].dur) fxList.splice(i, 1);
    for (const s of particles) {
      s.x += s.vx * dt; s.y += s.vy * dt; s.vy += 0.00025 * dt; s.life -= dt / 1400;
      ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = s.color; ctx.fillRect(s.x, s.y, 3, 3);
    }
    ctx.globalAlpha = 1;
    for (let i = particles.length - 1; i >= 0; i--) if (particles[i].life <= 0) particles.splice(i, 1);
    for (const fl of floats) {
      fl.t += dt / 1500; if (fl.t >= 1) continue;
      text(fl.text, fl.x, fl.y - fl.t * 50, { size: 22 + fl.t * 6, weight: 800, fill: alpha("#ffd86b", 1 - fl.t * fl.t), stroke: alpha("#1b1b1f", 1 - fl.t) });
    }
    for (let i = floats.length - 1; i >= 0; i--) if (floats[i].t >= 1) floats.splice(i, 1);
  }
  function emote(agentId, type) {
    const id = agentId === "captain" && !S.agents.has("captain") ? [...S.agents.values()].find((a) => a.role === "captain")?.id : agentId;
    if (!id || !S.agents.has(id)) return;
    emotes.set(id, { type, t0: performance.now(), loop: type === "sleep" });
  }
  function burst(agentId) {
    const id = S.agents.has(agentId) ? agentId : [...S.agents.values()].find((a) => a.role === "captain")?.id;
    if (!id) return;
    fx(id, "levelup");
    const m = charMetrics(S.agents.get(id)); if (m) floats.push({ text: "LEVEL UP!", x: m.x, y: m.headY - 30, t: 0 });
    for (let i = 0; i < 40; i++) {
      const ang = Math.random() * TAU, sp = 0.1 + Math.random() * 0.22;
      particles.push({ x: m ? m.x : V.W / 2, y: m ? m.headY : V.H / 2, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 0.1, life: 1, color: ["#f5b942", "#3dd598", "#4fa3ff", "#ff7eb6", "#fff"][i % 5] });
    }
  }

  // ----- เฟรมหลัก -----
  function frame(ts) {
    if (destroyed) return;
    const dt = Math.min(50, ts - (V.last || ts)); V.last = ts;
    ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, V.W, V.H);
    drawSky(ts);
    drawGround(ts);
    const drawables = [];
    if (!mapImg) for (const p of MAP.props) if (props.has(p.name)) drawables.push({ d: p.tx + p.ty + p.ty * 0.001, fn: () => drawProp(p, ts) });
    for (const a of S.agents.values()) {
      const pos = positions.get(a.id); if (!pos) continue;
      if (!mapImg) drawables.push({ d: depthOf(pos) - 2 + 0.5, fn: () => drawStation(a, ts) });
      drawables.push({ d: depthOf(pos) + 0.6, fn: () => drawCharacter(a, ts) });
    }
    drawables.sort((p, q) => p.d - q.d);
    for (const d of drawables) d.fn();
    // paused → อีโมตหลับวนซ้ำ
    for (const a of S.agents.values()) {
      if (a.status === "paused" && !emotes.has(a.id)) emote(a.id, "sleep");
      if (a.status !== "paused" && emotes.get(a.id)?.type === "sleep") emotes.delete(a.id);
    }
    drawFx(dt, ts);
    drawZoneLabels();
    bubbles.length = 0;
    for (const a of S.agents.values()) drawTags(a, ts);
    for (const b of bubbles) drawBubble(b, ts);
    drawPackets(dt, ts);
    if (V.debug) drawDebug();
    V.raf = requestAnimationFrame(frame);
  }

  // ----- โหมดช่วยปรับพิกัด (กด D) -----
  function fracAt(x, y) {
    if (!(mapImg && V.img)) return null;
    return [Math.min(1, Math.max(0, (x - V.img.x) / V.img.w)), Math.min(1, Math.max(0, (y - V.img.y) / V.img.h))];
  }
  function drawDebug() {
    const z = mapImg ? "ภาพแผนที่: พิกัด = สัดส่วนของภาพ (0–1) คัดลอกไปใส่ manifest.spots" : "กริดไอโซ (ไม่มีภาพแผนที่): พิกัด = ช่อง (tx, ty)";
    text(`โหมดปรับพิกัด (กด D เพื่อปิด) — ${z}`, V.W / 2, 14, { size: 12, weight: 700, fill: "#ffd166" });
    // จุดยืนทุกคน
    for (const a of S.agents.values()) {
      const m = charMetrics(a); if (!m) continue;
      ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(m.x - 8, m.y); ctx.lineTo(m.x + 8, m.y); ctx.moveTo(m.x, m.y - 8); ctx.lineTo(m.x, m.y + 8); ctx.stroke();
      const label = mapImg ? `${m.pos.jobId} [${(m.pos.tx / 100).toFixed(2)}, ${(m.pos.ty / 100).toFixed(2)}]` : `${m.pos.jobId} (${m.pos.tx}, ${m.pos.ty})`;
      text(label, m.x, m.y + 14, { size: 10, weight: 600, fill: "#ffd166" });
    }
    // ตำแหน่งเมาส์
    if (V.mx != null) {
      ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(V.mx, 0); ctx.lineTo(V.mx, V.H); ctx.moveTo(0, V.my); ctx.lineTo(V.W, V.my); ctx.stroke(); ctx.setLineDash([]);
      const f = fracAt(V.mx, V.my);
      const label = f ? `[${f[0].toFixed(2)}, ${f[1].toFixed(2)}]  คลิกเพื่อคัดลอก` : "ไม่มีภาพแผนที่";
      text(label, V.mx + 12, V.my - 12, { size: 12, weight: 700, fill: "#fff", align: "left" });
    }
    if (V.copied && performance.now() - V.copied.t < 1500) text(`คัดลอกแล้ว: ${V.copied.s}`, V.W / 2, V.H - 16, { size: 12, weight: 700, fill: "#3dd598" });
  }
  const onKey = (e) => {
    if (e.key !== "d" && e.key !== "D") return;
    const t = e.target; if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    V.debug = !V.debug;
    console.info(V.debug ? "[scene] เปิดโหมดปรับพิกัด (กด D เพื่อปิด)" : "[scene] ปิดโหมดปรับพิกัด");
  };
  window.addEventListener("keydown", onKey);

  // ----- อินพุต -----
  function hit(x, y) {
    let found = null, best = -Infinity;
    for (const a of S.agents.values()) {
      const m = charMetrics(a); if (!m) continue;
      if (x >= m.x - m.w / 2 && x <= m.x + m.w / 2 && y >= m.headY - 4 && y <= m.y + 4) {
        const d = m.pos.tx + m.pos.ty; if (d > best) { best = d; found = a.id; }
      }
    }
    return found;
  }
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    V.mx = e.clientX - r.left; V.my = e.clientY - r.top;
    const id = hit(e.clientX - r.left, e.clientY - r.top);
    if (id !== V.hover) { V.hover = id; hooks.onHover?.(id); }
    canvas.style.cursor = id ? "pointer" : "default";
  };
  const onClick = (e) => {
    const r = canvas.getBoundingClientRect();
    if (V.debug) { // โหมดปรับพิกัด: คัดลอกพิกัดแทนการเปิด drawer
      const f = fracAt(e.clientX - r.left, e.clientY - r.top);
      const s = f ? `[${f[0].toFixed(2)}, ${f[1].toFixed(2)}]` : "";
      if (s) { navigator.clipboard?.writeText(s).catch(() => {}); V.copied = { s, t: performance.now() }; console.info(`[scene] พิกัด ${s}`); }
      return;
    }
    hooks.onClick?.(hit(e.clientX - r.left, e.clientY - r.top));
  };
  const onLeave = () => { V.hover = null; V.mx = null; V.my = null; hooks.onHover?.(null); };
  canvas.addEventListener("mousemove", onMove);
  canvas.addEventListener("mouseleave", onLeave);
  canvas.addEventListener("click", onClick);
  const ro = new ResizeObserver(() => layout());
  ro.observe(canvas.parentElement);

  function spriteDataUrl(jobId, anim = "idle", frameIndex = 0, scale = 2) {
    const P = pngs.get(jobId);
    if (P) { const f = P.anims[anim] || P.anims.idle; return f[Math.min(frameIndex, f.length - 1)].toDataURL(); }
    const L = layersFor(jobId); if (!L) return null;
    const f = L.body.anims[anim] || L.body.anims.idle;
    return frameCanvas(f[Math.min(frameIndex, f.length - 1)], L.body.palette, scale).toDataURL();
  }
  function destroy() {
    destroyed = true; cancelAnimationFrame(V.raf); ro.disconnect(); window.removeEventListener("keydown", onKey);
    canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("mouseleave", onLeave); canvas.removeEventListener("click", onClick);
  }

  layout();
  V.raf = requestAnimationFrame(frame);
  return { ready, layout, spawnPacket, emote, fx, burst, hit, setHover: (id) => { V.hover = id; }, spriteDataUrl, hasSprite: (jobId) => !!modules.get(jobId) || !!pngs.get(jobId), hasPng: (jobId) => !!pngs.get(jobId), hasMapImage: () => !!mapImg, jobOf: (a) => positions.get(a.id)?.jobId || null, destroy };
}
