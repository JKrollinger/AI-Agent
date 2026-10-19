// morroc-map.js — ผังเมืองมอร็อคสำหรับฉากไอโซเมตริก (ข้อมูลล้วน แก้ผังได้โดยไม่แตะ engine)
// พิกัดกระเบื้อง (tx, ty): tx เพิ่ม = ไปทางขวา-ล่างบนจอ, ty เพิ่ม = ไปทางซ้าย-ล่างบนจอ
export const W = 20;
export const H = 20;

// โซน = สี่เหลี่ยมของกระเบื้อง [x0, y0, x1, y1] (รวมปลาย) + ป้าย + สี + กระเบื้องที่ใช้ปูพื้น
export const ZONES = [
  { id: "plaza", label: "ลานกลางเมือง · บัญชาการ", color: "#f5b942", rect: [7, 7, 12, 12], floor: "stone", labelAt: [9.5, 6.0] },
  { id: "gate", label: "ประตูเมือง · หน่วยสอดแนม", color: "#4fa3ff", rect: [1, 1, 6, 6], floor: null, labelAt: [3.5, 0.0] },
  { id: "tower", label: "หอเวทมนตร์ · วิเคราะห์", color: "#9b7dff", rect: [13, 1, 18, 6], floor: "sandDark", labelAt: [17.5, 0.5] },
  { id: "library", label: "ห้องสมุด · เอกสาร", color: "#ff7eb6", rect: [13, 13, 18, 18], floor: "stone", labelAt: [18.5, 12.5] },
  { id: "forge", label: "โรงตีเหล็ก · พัฒนา", color: "#3dd598", rect: [1, 13, 6, 18], floor: "sandDark", labelAt: [1.5, 12.5] },
  { id: "temple", label: "วิหาร · ตรวจสอบ", color: "#ffa552", rect: [7, 14, 12, 19], floor: "stoneLight", labelAt: [6.5, 14.0] },
  { id: "oasis", label: "โอเอซิส", color: "#6cc4e0", rect: [0, 8, 4, 11], floor: "water", labelAt: [0.5, 7.5] },
];

// จุดยืนของแต่ละอาชีพ (ตัวละครยืนหน้าสถานีของตน; engine วางสถานีที่ (tx-1, ty-1) คือด้านหลังบนจอ)
export const SPOTS = {
  "lord-knight": [11, 11],
  sniper: [2, 6],
  stalker: [6, 2],
  "high-wizard": [16, 5],
  professor: [16, 16],
  whitesmith: [4, 16],
  "high-priest": [10, 18],
};
export const SPARE_SPOTS = [[7, 15], [13, 10], [6, 9], [14, 8], [2, 12], [17, 10]];

// ของตกแต่ง/อาคาร: name ต้องตรงกับ props ใน tileset (ถ้าไม่มีสไปรต์ engine จะข้าม)
export const PROPS = [
  // ลานกลางเมือง
  { name: "well", tx: 9, ty: 9 },
  { name: "brazier", tx: 7, ty: 7 }, { name: "brazier", tx: 12, ty: 7 }, { name: "brazier", tx: 7, ty: 12 }, { name: "brazier", tx: 12, ty: 12 },
  // ประตูเมือง (หน่วยสอดแนม)
  { name: "gate", tx: 2, ty: 1 }, { name: "wall", tx: 4, ty: 0 }, { name: "wall", tx: 5, ty: 0 }, { name: "wallCorner", tx: 6, ty: 0 },
  { name: "wall", tx: 0, ty: 3 }, { name: "wall", tx: 0, ty: 4 }, { name: "wall", tx: 0, ty: 5 }, { name: "crates", tx: 6, ty: 5 }, { name: "palm", tx: 6, ty: 7 },
  // หอเวทมนตร์
  { name: "tower", tx: 17, ty: 2 }, { name: "cactus", tx: 13, ty: 2 }, { name: "palm", tx: 18, ty: 6 },
  // ห้องสมุด
  { name: "domeHouse", tx: 17, ty: 14 }, { name: "shelf", tx: 14, ty: 14 }, { name: "palm", tx: 18, ty: 18 },
  // โรงตีเหล็ก
  { name: "forge", tx: 2, ty: 14 }, { name: "crates", tx: 6, ty: 13 }, { name: "cactus", tx: 1, ty: 18 },
  // วิหาร
  { name: "temple", tx: 10, ty: 15 }, { name: "brazier", tx: 8, ty: 19 }, { name: "brazier", tx: 12, ty: 19 },
  // โอเอซิส + ตลาด
  { name: "palm", tx: 0, ty: 7 }, { name: "palm", tx: 5, ty: 11 }, { name: "palm", tx: 0, ty: 12 },
  { name: "stall", tx: 14, ty: 9 }, { name: "stall", tx: 14, ty: 11 }, { name: "rug", tx: 13, ty: 10 }, { name: "house", tx: 18, ty: 9 },
  { name: "cactus", tx: 7, ty: 19 }, { name: "cactus", tx: 19, ty: 0 }, { name: "crates", tx: 19, ty: 19 },
];

// ปิรามิดและเนินทรายนอกแผนที่ (ตกแต่งฉากหลัง) — engine วาดด้วย prop "pyramid" ถ้ามี
export const BACKDROP = [{ name: "pyramid", tx: 24, ty: -2 }, { name: "pyramid", tx: 20, ty: -6 }];

const inRect = (tx, ty, [x0, y0, x1, y1]) => tx >= x0 && tx <= x1 && ty >= y0 && ty <= y1;

/** สร้างตารางพื้น W x H: ground[ty][tx] = ชื่อ tile */
export function buildGround() {
  const g = [];
  for (let ty = 0; ty < H; ty++) {
    const row = [];
    for (let tx = 0; tx < W; tx++) {
      // ทรายพื้นฐาน สลับลายแบบ deterministic ไม่ให้ซ้ำเป็นแพตเทิร์นชัด
      const n = (tx * 7 + ty * 13 + ((tx * ty) % 5)) % 9;
      let tile = n < 2 ? "sand2" : n === 4 ? "sandDark" : "sand";
      for (const z of ZONES) {
        if (z.floor && inRect(tx, ty, z.rect)) tile = z.floor;
      }
      // พรมแดงขอบทองกลางลาน (4x4 ภายใน plaza)
      const c = [8, 8, 11, 11];
      if (inRect(tx, ty, c)) {
        const left = tx === c[0], right = tx === c[2], top = ty === c[1], bottom = ty === c[3];
        if (top && left) tile = "carpetCornerNW";
        else if (top && right) tile = "carpetCornerNE";
        else if (bottom && left) tile = "carpetCornerSW";
        else if (bottom && right) tile = "carpetCornerSE";
        else if (top) tile = "carpetEdgeN";
        else if (bottom) tile = "carpetEdgeS";
        else if (left) tile = "carpetEdgeW";
        else if (right) tile = "carpetEdgeE";
        else tile = "carpet";
      }
      row.push(tile);
    }
    g.push(row);
  }
  return g;
}

export const MAP = { w: W, h: H, ground: buildGround(), zones: ZONES, spots: SPOTS, spareSpots: SPARE_SPOTS, props: PROPS, backdrop: BACKDROP };
export default MAP;
