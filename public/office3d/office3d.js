// office3d.js — 3D office scene for the AI team.
// Reads window.OFFICE3D_CONFIG (config.js) and exposes window.Office3D (see docs/09-office3d.md).
// Two modes: "demo" (people wander on their own) and "live" (bridge.js feeds real agent status).
(function(){
const CFG = window.OFFICE3D_CONFIG || {};
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const stage = document.getElementById('stage');

// ---------- Renderer ----------
const renderer = new THREE.WebGLRenderer({antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
// ความคมชัด: เรนเดอร์ละเอียดกว่าจอ (อย่างน้อย 1.5 เท่า) แล้วให้เบราว์เซอร์ย่อลง = ขอบวัตถุ/ตัวหนังสือบนป้ายคมขึ้น
// จำกัดจำนวนพิกเซลรวมไว้ ~4.6 ล้าน (≈2480×1860) เพื่อไม่ให้ GPU อ่อน ๆ หรือมือถือกระตุก
const MAX_RENDER_PX = 4.6e6;
function fitPixelRatio(w,h){ const want=Math.max(devicePixelRatio||1, 1.5); const cap=Math.sqrt(MAX_RENDER_PX/Math.max(1,w*h)); return Math.max(1, Math.min(want, cap, 3)); }
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38,1,0.5,200);
camera.position.set(20,19,22);
const EMBED=document.documentElement.dataset.embed==='1';   // ?embed=1 = inside the dashboard: start closer so people stay readable in a small frame
if(EMBED) camera.position.set(14,12,15);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(-0.5,0.4,0);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI*0.45;
controls.minDistance = 2.5; controls.maxDistance = 55;
controls.autoRotate = true; controls.autoRotateSpeed = 0.3;
// free camera: left-drag = orbit · right-drag / two fingers = pan along the floor · wheel / pinch = zoom · arrow keys = pan
controls.enablePan = true; controls.screenSpacePanning = false; controls.panSpeed = 1.1; controls.keyPanSpeed = 18;
if(controls.listenToKeyEvents) controls.listenToKeyEvents(window);
const HOME = { pos: camera.position.clone(), target: controls.target.clone() };
// smooth camera moves (focus on a desk / back to the home view) — cancelled as soon as the user grabs the camera
let camTween=null;
function flyTo(pos,target,dur=0.9){ camTween={start:performance.now(),dur,p0:camera.position.clone(),p1:pos.clone(),g0:controls.target.clone(),g1:target.clone()}; } // wall-clock based so a slow frame rate cannot stretch it
function focusOn(w,dist=5.5){ if(!w||!w.seat) return false;
  const tgt=new THREE.Vector3(w.seat.x,0.9,w.seat.z);
  const dir=camera.position.clone().sub(controls.target); dir.y=Math.max(dir.y,0.35*dir.length()); dir.setLength(dist);
  const pos=tgt.clone().add(dir); if(pos.y<2.0) pos.y=2.0;
  controls.autoRotate=false; flyTo(pos,tgt,0.9); return true; }
function resetView(){ flyTo(HOME.pos,HOME.target,1.0); controls.autoRotate=!matchMedia('(prefers-reduced-motion: reduce)').matches; }
controls.addEventListener('start',()=>{ controls.autoRotate=false; camTween=null; }); // the user took over

function applyTheme(){
  const bg = new THREE.Color(css('--bg'));
  scene.background = bg; scene.fog = new THREE.Fog(bg, 50, 95);
}
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});

// Seeded random so the layout is the same every visit
let seed = 7;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// ---------- Environment lighting (soft studio reflections) ----------
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(30,12,30), new THREE.MeshBasicMaterial({color:0x6e7378, side:THREE.BackSide}));
  env.add(room);
  const panel = (w,h,c,x,y,z,ry,rx) => { const m=new THREE.Mesh(new THREE.PlaneGeometry(w,h), new THREE.MeshBasicMaterial({color:c, side:THREE.DoubleSide}));
    m.position.set(x,y,z); m.rotation.set(rx||0,ry||0,0); env.add(m); };
  panel(20,4,0xffffff,0,5.9,0,0,Math.PI/2);
  panel(26,8,0xd9ecff,0,2,-14.9,0);
  panel(26,8,0xe6f1ff,-14.9,2,0,Math.PI/2);
  panel(26,4,0x8b7a68,0,-5.9,0,0,Math.PI/2);
  scene.environment = pmrem.fromScene(env, 0.04).texture;
  pmrem.dispose();
}

// ---------- Texture helpers ----------
const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy()); // ลายพื้น/ไม้คมเมื่อมองเฉียง
function canvas(w,h,draw){ const c=document.createElement('canvas'); c.width=w; c.height=h; draw(c.getContext('2d'),w,h); return c; }
function tex(c,rep){ const t=new THREE.CanvasTexture(c); t.encoding=THREE.sRGBEncoding; t.anisotropy=maxAniso;
  if(rep){ t.wrapS=t.wrapT=THREE.RepeatWrapping; t.repeat.set(rep[0],rep[1]); } return t; }
function noise(ctx,w,h,amt){ const d=ctx.getImageData(0,0,w,h); for(let i=0;i<d.data.length;i+=4){ const n=(Math.random()-0.5)*amt;
  d.data[i]+=n; d.data[i+1]+=n; d.data[i+2]+=n; } ctx.putImageData(d,0,0); }

// Oak plank floor (texture = 4 m square) — 2048² เพื่อให้ร่องไม้/ลายเสี้ยนคมเมื่อซูมเข้าโต๊ะ
const floorTex = tex(canvas(2048,2048,(g,w,h)=>{
  const S=w/1024, rows=22, ph=h/rows;
  for(let r=0;r<rows;r++){
    let x=rnd()*w; const y=r*ph;
    while(x < w*2){
      const len = (300 + rnd()*220)*S, L=52+rnd()*10, Sat=28+rnd()*14;
      const draw = ox => {
        g.fillStyle=`hsl(${30+rnd()*6},${Sat}%,${L}%)`; g.fillRect(ox,y,len,ph);
        for(let k=0;k<18;k++){ g.strokeStyle=`rgba(90,55,25,${0.05+rnd()*0.1})`; g.lineWidth=(0.6+rnd()*1.4)*S; g.beginPath();
          const y0=y+rnd()*ph, f=(0.004+rnd()*0.01)/S, a=(1+rnd()*3)*S, p=rnd()*6;
          for(let xx=0;xx<=len;xx+=8*S) g.lineTo(ox+xx, y0+Math.sin(xx*f+p)*a); g.stroke(); }
        g.fillStyle='rgba(50,30,15,.55)'; g.fillRect(ox,y,1.5*S,ph);
        g.fillStyle='rgba(255,255,255,.06)'; g.fillRect(ox+1.5*S,y,1.2*S,ph); // ขอบไม้รับแสง
      };
      draw(x-w*2); draw(x-w); draw(x);
      x += len;
    }
    g.fillStyle='rgba(50,30,15,.5)'; g.fillRect(0,y,w,1.2*S);
  }
  noise(g,w,h,10);
}),[26/4,18/4]);

// Carpet tiles (texture = 1 m, four 50 cm tiles) — 1024²
const carpetTex = tex(canvas(1024,1024,(g,w,h)=>{
  const T=w/2; g.fillStyle='#5a636f'; g.fillRect(0,0,w,h);
  for(let tx=0;tx<2;tx++) for(let ty=0;ty<2;ty++){
    const vert=(tx+ty)%2; g.save(); g.beginPath(); g.rect(tx*T,ty*T,T,T); g.clip();
    for(let i=0;i<T;i+=3){ g.fillStyle=`rgba(255,255,255,${0.02+Math.random()*0.03})`;
      vert? g.fillRect(tx*T+i,ty*T,1.4,T) : g.fillRect(tx*T,ty*T+i,T,1.4); }
    g.restore(); g.strokeStyle='rgba(0,0,0,.18)'; g.lineWidth=2; g.strokeRect(tx*T+1,ty*T+1,T-2,T-2);
  }
  noise(g,w,h,26);
}),[14,17.4]);

function woodTex(hue,sat,light,spanX,spanY){
  return tex(canvas(2048,1024,(g,w,h)=>{
    g.fillStyle=`hsl(${hue},${sat}%,${light}%)`; g.fillRect(0,0,w,h);
    for(let k=0;k<320;k++){ g.strokeStyle=`rgba(60,35,15,${0.03+rnd()*0.09})`; g.lineWidth=0.5+rnd()*2; g.beginPath();
      const y0=rnd()*h, f=0.002+rnd()*0.006, a=2+rnd()*8, p=rnd()*6;
      for(let x=0;x<=w;x+=10) g.lineTo(x, y0+Math.sin(x*f+p)*a); g.stroke(); }
    noise(g,w,h,8);
  }),[1/spanX,1/spanY]);
}
const oakTex = woodTex(34,38,68,1.6,0.8);
const walnutTex = woodTex(22,35,30,4.4,1.6);

// Contact-shadow blobs (cheap ambient occlusion)
const blobRound = tex(canvas(128,128,(g,w)=>{ const gr=g.createRadialGradient(w/2,w/2,0,w/2,w/2,w/2);
  gr.addColorStop(0,'rgba(0,0,0,.55)'); gr.addColorStop(.55,'rgba(0,0,0,.25)'); gr.addColorStop(1,'rgba(0,0,0,0)'); g.fillStyle=gr; g.fillRect(0,0,w,w); }));
const blobRect = tex(canvas(256,256,(g,w)=>{ g.filter='blur(22px)'; g.fillStyle='rgba(0,0,0,.6)'; g.fillRect(40,40,w-80,w-80); }));

// Screen content
function screenTex(kind){
  return tex(canvas(512,300,(g,w,h)=>{
    if(kind===0){ // code editor
      g.fillStyle='#1d2330'; g.fillRect(0,0,w,h); g.fillStyle='#161b25'; g.fillRect(0,0,70,h);
      const cols=['#7aa2f7','#9ece6a','#e0af68','#bb9af7','#c0caf5','#7dcfff'];
      for(let y=14;y<h-8;y+=13){ let x=86+Math.floor(rnd()*4)*16; g.fillStyle='#3b4252'; g.fillRect(20,y,24,5);
        const n=1+Math.floor(rnd()*4); for(let i=0;i<n;i++){ const l=20+rnd()*90; g.fillStyle=cols[Math.floor(rnd()*cols.length)]; g.fillRect(x,y,l,6); x+=l+10; } }
    } else if(kind===1){ // spreadsheet
      g.fillStyle='#ffffff'; g.fillRect(0,0,w,h); g.fillStyle='#1f8a4c'; g.fillRect(0,0,w,22);
      g.strokeStyle='#dfe3e6'; for(let x=0;x<w;x+=64){ g.beginPath(); g.moveTo(x,22); g.lineTo(x,h); g.stroke(); }
      for(let y=22;y<h;y+=16){ g.beginPath(); g.moveTo(0,y); g.lineTo(w,y); g.stroke(); }
      g.fillStyle='#55606b'; for(let y=27;y<h-160;y+=16) for(let x=6;x<w-64;x+=64) if(rnd()>.25) g.fillRect(x,y,20+rnd()*34,5);
      g.fillStyle='#f4f6f7'; g.fillRect(260,150,230,140);
      for(let i=0;i<8;i++){ const bh=20+rnd()*90; g.fillStyle=i%2?'#7fb8e6':'#2f6fde'; g.fillRect(278+i*26,280-bh,16,bh); }
    } else { // dashboard
      g.fillStyle='#eef1f6'; g.fillRect(0,0,w,h); g.fillStyle='#2a3242'; g.fillRect(0,0,90,h);
      g.fillStyle='#ffffff'; [[104,14,120,60],[236,14,120,60],[368,14,130,60],[104,86,394,200]].forEach(r=>g.fillRect(...r));
      g.fillStyle='#2f6fde'; g.fillRect(114,40,60,14); g.fillStyle='#d9822b'; g.fillRect(246,40,50,14); g.fillStyle='#2b9a76'; g.fillRect(378,40,70,14);
      g.strokeStyle='#2f6fde'; g.lineWidth=3; g.beginPath(); for(let x=0;x<=360;x+=20) g.lineTo(120+x, 250-40-Math.sin(x*0.02)*40-x*0.15-rnd()*20); g.stroke();
    }
  }));
}
const screens=[0,1,2,0,2,1].map(screenTex);
screens[0].wrapT=screens[3].wrapT=THREE.RepeatWrapping;
const slideTex = tex(canvas(800,450,(g,w,h)=>{
  g.fillStyle='#fbfaf7'; g.fillRect(0,0,w,h); g.fillStyle='#d9822b'; g.fillRect(0,0,w,14);
  g.fillStyle='#1d2430'; g.font='600 38px sans-serif'; g.fillText('Q4 Roadmap',48,82);
  g.fillStyle='#8a93a0'; g.fillRect(48,104,280,10);
  const v=[60,95,80,140,170,210]; v.forEach((b,i)=>{ g.fillStyle=i===5?'#d9822b':'#c9d2de'; g.fillRect(60+i*72,400-b,48,b); });
  g.strokeStyle='#1d2430'; g.lineWidth=2; g.beginPath(); g.moveTo(48,400); g.lineTo(500,400); g.stroke();
  g.fillStyle='#e9ecf1'; g.fillRect(540,150,210,250); g.fillStyle='#5d6878'; for(let y=175;y<380;y+=34) g.fillRect(560,y,140+Math.random()*30,10);
}));

// ---------- Material & geometry helpers ----------
const lin = c => new THREE.Color(c).convertSRGBToLinear();
const mat = (c,o={}) => new THREE.MeshStandardMaterial(Object.assign({color:lin(c), roughness:0.75, metalness:0}, o));
function add(geo,m,x,y,z,parent=scene,opts={}){
  const mesh=new THREE.Mesh(geo,m); mesh.position.set(x,y,z);
  mesh.castShadow = opts.cast!==false; mesh.receiveShadow = opts.receive!==false; parent.add(mesh); return mesh;
}
const B = (w,h,d) => new THREE.BoxGeometry(w,h,d);
function roundRect(w,d,r){ const s=new THREE.Shape(), x=-w/2, y=-d/2;
  s.moveTo(x+r,y); s.lineTo(x+w-r,y); s.quadraticCurveTo(x+w,y,x+w,y+r); s.lineTo(x+w,y+d-r); s.quadraticCurveTo(x+w,y+d,x+w-r,y+d);
  s.lineTo(x+r,y+d); s.quadraticCurveTo(x,y+d,x,y+d-r); s.lineTo(x,y+r); s.quadraticCurveTo(x,y,x+r,y); return s; }
// Rounded slab: w (x) × h (y) × d (z), soft bevelled edges
function slab(w,h,d,r,bev=0.008){
  const g=new THREE.ExtrudeGeometry(roundRect(w-2*bev,d-2*bev,Math.max(0.002,r-bev)),
    {depth:Math.max(0.001,h-2*bev), bevelEnabled:true, bevelThickness:bev, bevelSize:bev, bevelSegments:3, curveSegments:8});
  g.rotateX(-Math.PI/2); g.translate(0,-(h-2*bev)/2,0); return g;
}
function blob(x,z,sx,sz,round,parent=scene,y=0.012,op=1){
  const m=new THREE.Mesh(new THREE.PlaneGeometry(sx,sz), new THREE.MeshBasicMaterial({map:round?blobRound:blobRect, transparent:true, depthWrite:false, opacity:op}));
  m.rotation.x=-Math.PI/2; m.position.set(x,y,z); m.renderOrder=1; parent.add(m); return m;
}

// Shared materials
const M = {
  black: mat(0x1e2126,{roughness:0.5, metalness:0.4}),
  alu: mat(0xb9bec4,{roughness:0.35, metalness:0.85}),
  steel: mat(0xc9ced3,{roughness:0.3, metalness:0.7}),
  oak: mat(0xffffff,{map:oakTex, bumpMap:oakTex, bumpScale:0.004, roughness:0.55}),
  walnut: mat(0xffffff,{map:walnutTex, bumpMap:walnutTex, bumpScale:0.004, roughness:0.45}),
  white: mat(0xf2f1ee,{roughness:0.5}),
  fabric: mat(0x2f343c,{roughness:0.95}),
  leather: mat(0x8a5233,{roughness:0.55}),
  sage: mat(0x8fa596,{roughness:0.95}),
  plastic: mat(0x2a2d33,{roughness:0.45}),
  lightPlastic: mat(0xdfe2e6,{roughness:0.45}),
  ceramic: mat(0xf4f2ee,{roughness:0.25}),
  terracotta: mat(0xb86e4b,{roughness:0.8}),
  quartz: mat(0xe9e7e2,{roughness:0.18}),
  leaf: mat(0x3f7a3a,{roughness:0.6, side:THREE.DoubleSide}),
  leaf2: mat(0x5c8f3e,{roughness:0.6, side:THREE.DoubleSide}),
  paper: mat(0xfbfbf8,{roughness:0.9}),
  frame: mat(0x2b2f35,{roughness:0.4, metalness:0.6}),
  glass: new THREE.MeshStandardMaterial({color:lin(0xcfe6f5), transparent:true, opacity:0.16, roughness:0.05, metalness:0.2, depthWrite:false}),
  frost: new THREE.MeshStandardMaterial({color:0xffffff, transparent:true, opacity:0.55, roughness:0.6, depthWrite:false}),
  screenOff: mat(0x0b0d10,{roughness:0.2, metalness:0.3}),
  lampGlow: new THREE.MeshStandardMaterial({color:0xffffff, emissive:lin(0xffd8a0), emissiveIntensity:0.3}),
};
const screenMats = screens.map(t=>new THREE.MeshBasicMaterial({map:t}));
const lamps=[];

// ---------- Building shell ----------
const W=26, D=18;
add(B(W+0.6,0.5,D+0.6), mat(0x9a9d9f,{roughness:0.9}), 0,-0.25,0, scene,{cast:false});
const floor = add(new THREE.PlaneGeometry(W,D), new THREE.MeshStandardMaterial({map:floorTex, bumpMap:floorTex, bumpScale:0.012, roughness:0.45}), 0,0.001,0, scene,{cast:false});
floor.rotation.x=-Math.PI/2;
const carpet = add(new THREE.PlaneGeometry(14,17.4), new THREE.MeshStandardMaterial({map:carpetTex, bumpMap:carpetTex, bumpScale:0.02, roughness:1}), -6,0.008,0, scene,{cast:false});
carpet.rotation.x=-Math.PI/2;

// Curtain-wall glazing on the back (north) and left (west) sides
function curtainWall(len, along){ // along: 'x' at z=-D/2, 'z' at x=-W/2
  const H=3.1, g=new THREE.Group(); scene.add(g);
  if(along==='z'){ g.rotation.y=Math.PI/2; g.position.set(-W/2,0,0); } else g.position.set(0,0,-D/2);
  add(B(len,0.35,0.25), M.white, 0,0.175,0, g);              // sill
  add(B(len,0.12,0.18), M.frame, 0,H,0, g);                 // head
  add(B(len,0.06,0.1), M.frame, 0,2.35,0, g);               // transom
  for(let x=-len/2; x<=len/2+0.01; x+=1.625){ add(B(0.07,H,0.16), M.frame, x,H/2,0, g); add(B(0.05,H-0.4,0.05), M.alu, x,0.35+(H-0.35)/2,0.1, g,{cast:false}); } // เสาเฟรม + ฝาครอบอลูมิเนียม
  add(B(len,0.03,0.3), M.alu, 0,0.36,0, g,{cast:false});                                 // ฝาครอบขอบหน้าต่าง
  add(B(len,0.05,0.14), M.alu, 0,2.35,0.06, g,{cast:false});                             // ฝาครอบคานกลาง
  const gl=add(B(len,H-0.35,0.02), M.glass, 0,0.35+(H-0.35)/2,0, g,{cast:false,receive:false});
  // roller blinds pulled halfway on some bays
  for(let x=-len/2+0.81, i=0; x<len/2; x+=1.625, i++){
    if(i%3===1){ add(B(1.5,0.9,0.02), mat(0xe8e2d6,{roughness:1, transparent:true, opacity:0.85}), x,2.0,0.08, g,{receive:false}); }
  }
}
curtainWall(W,'x'); curtainWall(D,'z');
// structural columns
[[-W/2+0.2,-D/2+0.2],[1.6,-D/2+0.2],[-W/2+0.2,0.4]].forEach(([x,z])=>{ add(B(0.45,3.1,0.45), M.white, x,1.55,z);
  add(B(0.53,0.1,0.53), M.steel, x,0.05,z, scene,{cast:false}); add(B(0.5,0.06,0.5), M.steel, x,3.07,z, scene,{cast:false}); }); // ฐาน/หัวเสาสแตนเลส
// ด้านใต้ (z=+D/2) เปิดโล่งมองเห็นเมือง: ขอบพื้นชั้น + ราวกันตกกระจก (ออฟฟิศอยู่ชั้นสูงของตึก)
{ const EDGE=D/2+0.1, Hh=1.02;
  add(B(W+0.3,0.08,0.12), M.alu, 0,0.04,EDGE-0.06, scene,{cast:false});
  for(let x=-W/2; x<=W/2+0.01; x+=2.6) add(B(0.05,Hh,0.05), M.steel, x,Hh/2,EDGE, scene);
  add(B(W,0.78,0.014), M.glass, 0,0.56,EDGE, scene,{cast:false,receive:false});
  add(B(W+0.1,0.05,0.07), M.steel, 0,Hh,EDGE, scene,{cast:false});
  add(B(W+0.1,0.03,0.05), M.steel, 0,0.14,EDGE, scene,{cast:false});
}
// แถบอลูมิเนียมรอยต่อพรม–พื้นไม้
add(B(0.06,0.014,17.4), M.alu, 1.0,0.012,0, scene,{cast:false});
add(B(14,0.014,0.06), M.alu, -6,0.012,8.7, scene,{cast:false});
add(B(14,0.014,0.06), M.alu, -6,0.012,-8.7, scene,{cast:false});

// ---------- Office chair ----------
const G = {
  starLeg: B(0.3,0.03,0.045), caster: new THREE.SphereGeometry(0.03,8,6), gas: new THREE.CylinderGeometry(0.025,0.03,0.32,10),
  seat: slab(0.5,0.08,0.48,0.08,0.025), back: slab(0.46,0.06,0.52,0.1,0.025), arm: B(0.04,0.03,0.26), armPost: B(0.03,0.2,0.03),
};
function officeChair(x,z,backDir,fabric=M.fabric){
  const c=new THREE.Group(); c.position.set(x,0,z); c.rotation.y = backDir>0?0:Math.PI; scene.add(c);
  for(let i=0;i<5;i++){ const a=i/5*Math.PI*2; const l=add(G.starLeg,M.black, Math.cos(a)*0.15,0.07,Math.sin(a)*0.15, c,{receive:false});
    l.rotation.y=-a; add(G.caster,M.plastic, Math.cos(a)*0.29,0.03,Math.sin(a)*0.29, c,{cast:false}); }
  add(G.gas,M.alu, 0,0.25,0, c);
  add(G.seat,fabric, 0,0.40,0, c);
  const back=add(G.back,fabric, 0,0.76,0.24, c); back.rotation.x=-Math.PI/2+0.12;
  add(B(0.05,0.32,0.03),M.black, 0,0.54,0.25, c);
  [-1,1].forEach(s=>{ add(G.armPost,M.black, s*0.25,0.52,0, c); add(G.arm,M.plastic, s*0.25,0.63,-0.02, c); });
  blob(x,z,0.75,0.75,true,scene,0.013,0.7);
  return c;
}

// ---------- Desk workstation ----------
const deskTopGeo = slab(1.6,0.03,0.8,0.03,0.006);
const seats=[];
const DESK_DROP=0.045; // desks sit 4.5 cm lower than the original 74.5 cm top so the Mixamo typing pose puts the hands on the keyboard, not under the desk
function workstation(x,z,face,i){
  const g=new THREE.Group(); g.position.set(x,-DESK_DROP,z); scene.add(g);
  add(deskTopGeo, M.oak, 0,0.745,0, g);
  [-0.74,0.74].forEach(lx=>{ add(B(0.05,0.72,0.05),M.black, lx,0.37,0, g); add(B(0.06,0.025,0.72),M.black, lx,0.012,0, g); });
  add(B(1.45,0.04,0.04),M.black, 0,0.68,-0.3*face, g);
  // monitor
  const mon=new THREE.Group(); mon.position.set(0,0,-0.24*face); mon.rotation.y = face>0?0:Math.PI; g.add(mon);
  add(B(0.2,0.012,0.16),M.alu, 0,0.766,0, mon);
  add(B(0.04,0.2,0.02),M.alu, 0,0.86,-0.02, mon);
  add(B(0.6,0.36,0.025),M.black, 0,1.08,0, mon);
  const scr=add(new THREE.PlaneGeometry(0.575,0.335), screenMats[i%screenMats.length], 0,1.08,0.0135, mon,{cast:false,receive:false});
  if(i%3===0){ // second monitor angled
    const m2=new THREE.Group(); m2.position.set(-0.55,0,-0.08); m2.rotation.y=0.35; mon.add(m2);
    add(B(0.16,0.012,0.14),M.alu, 0,0.766,0, m2); add(B(0.035,0.18,0.02),M.alu,0,0.85,-0.02,m2);
    add(B(0.5,0.3,0.022),M.black, 0,1.03,0, m2);
    add(new THREE.PlaneGeometry(0.48,0.28), screenMats[(i+1)%screenMats.length], 0,1.03,0.012, m2,{cast:false,receive:false});
  }
  // keyboard, mouse, mug, papers
  const fwd=face; // toward the person
  add(slab(0.42,0.018,0.13,0.01,0.004), M.lightPlastic, 0,0.769,0.26*fwd, g);
  add(new THREE.SphereGeometry(0.03,12,8), M.lightPlastic, 0.3,0.765,0.26*fwd, g).scale.set(0.8,0.45,1.3);
  if(rnd()>0.3){ const mugMat = rnd()>0.5?M.ceramic:mat([0x2f6fde,0xd9822b,0x2b9a76,0xc85a8f][Math.floor(rnd()*4)],{roughness:0.3});
    const mx=-0.5+rnd()*0.15; add(new THREE.CylinderGeometry(0.04,0.036,0.095,16),mugMat, mx,0.807,0.18*fwd, g);
    const h=add(new THREE.TorusGeometry(0.025,0.007,6,12),mugMat, mx+0.045,0.81,0.18*fwd, g); h.rotation.y=Math.PI/2; }
  if(rnd()>0.4){ for(let k=0;k<3;k++){ const p=add(B(0.21,0.004,0.297),M.paper, 0.52+rnd()*0.03,0.762+k*0.004,0.05*fwd, g,{cast:false}); p.rotation.y=(rnd()-0.5)*0.4; } }
  if(i%4===1){ // desk lamp
    const lamp=new THREE.Group(); lamp.position.set(0.62,0.76,-0.22*fwd); g.add(lamp);
    add(new THREE.CylinderGeometry(0.06,0.07,0.02,16),M.black,0,0.01,0,lamp);
    const arm=add(B(0.015,0.4,0.015),M.black,0,0.2,0,lamp); arm.rotation.z=0.25;
    const head=add(new THREE.ConeGeometry(0.06,0.1,16,1,true),M.black,-0.07,0.39,0,lamp); head.rotation.z=-0.9;
    const bulb=add(new THREE.SphereGeometry(0.025,10,8),M.lampGlow,-0.09,0.37,0,lamp,{cast:false});
    lamps.push(bulb);
  }
  if(i%5===2){ // small succulent
    add(new THREE.CylinderGeometry(0.05,0.04,0.08,14),M.ceramic, -0.66,0.8,-0.2*fwd, g);
    for(let k=0;k<6;k++){ const lf=add(new THREE.SphereGeometry(0.03,8,6),M.leaf2, -0.66+Math.cos(k)*0.02,0.86,-0.2*fwd+Math.sin(k)*0.02, g,{cast:false}); lf.scale.set(0.6,1.4,0.6); lf.rotation.z=Math.cos(k*2)*0.6; }
  }
  if(i%2===0) add(new THREE.CylinderGeometry(0.13,0.11,0.32,16), mat(0x4a4f57,{roughness:0.6}), 0.58,0.16,-0.12*fwd, g); // bin
  if(i%3===1){ const bp=add(slab(0.3,0.4,0.17,0.06,0.03), mat([0x2f4f7a,0x7a2f3a,0x3d5a3a,0x5a4a3a][i%4],{roughness:0.9}), -0.62,0.2,0.6*fwd, g); bp.rotation.y=0.4; }
  if(i%4===2){ const hp=new THREE.Group(); hp.position.set(0.48,0.775,-0.08*fwd); hp.rotation.x=-Math.PI/2; g.add(hp);
    add(new THREE.TorusGeometry(0.08,0.012,8,20,Math.PI),M.black,0,0,0,hp);
    [-1,1].forEach(sd=>{ const c=add(new THREE.CylinderGeometry(0.04,0.04,0.03,14),M.plastic,sd*0.08,0,0,hp); c.rotation.z=Math.PI/2; }); }
  if(i%3===0) add(B(0.07,0.008,0.15),M.black, 0.36,0.765,0.02*fwd, g);
  [[0.24,1.2,0x7ad3e0],[0.18,1.2,0xffe06b],[0.24,1.14,0xff9fb8]].slice(0,1+i%3).forEach(([nx,ny,c])=>{
    const n=add(new THREE.PlaneGeometry(0.05,0.05), mat(c,{roughness:1}), nx,ny,0.0135, mon,{cast:false}); n.rotation.z=(rnd()-0.5)*0.2; });
  // desk name plate at the +x end (canvas, readable from the usual camera side) — text set from the real agent name/role (bridge.js → Office3D.setDeskLabel)
  const npc=document.createElement('canvas'); npc.width=512; npc.height=128; // drawn at 2× of the logical 256×64
  const nptex=new THREE.CanvasTexture(npc); nptex.encoding=THREE.sRGBEncoding; nptex.anisotropy=maxAniso;
  const np=new THREE.Group(); np.position.set(0.6,0.745,0.08*face); np.rotation.y=Math.PI/2; g.add(np);
  add(B(0.27,0.01,0.09),M.black,0,0.005,0,np);
  const npBack=add(B(0.26,0.075,0.012),mat(0x23262d,{roughness:0.45,metalness:0.3}),0,0.047,0,np); npBack.rotation.x=-0.28;
  add(new THREE.PlaneGeometry(0.245,0.062), new THREE.MeshBasicMaterial({map:nptex}),0,0,0.0065,npBack,{cast:false,receive:false});
  const plate={canvas:npc,ctx:npc.getContext('2d'),tex:nptex,name:'',role:''};
  // pedestal drawers under the right side of the desk
  const ped=new THREE.Group(); ped.position.set(0.5,0,0); g.add(ped);
  add(B(0.42,0.6,0.52),M.white,0,0.33,0,ped); add(B(0.44,0.02,0.54),M.oak,0,0.64,0,ped);
  for(let k=0;k<3;k++){ add(B(0.4,0.17,0.01),mat(0xe9e6df,{roughness:0.8}),0,0.14+k*0.185,0.265*face,ped,{cast:false}); add(B(0.12,0.012,0.012),M.alu,0,0.2+k*0.185,0.275*face,ped,{cast:false}); }
  // small things on the desk (deterministic per desk)
  if(i%2===0){ const nb=add(B(0.21,0.012,0.28),mat([0x2f4f7a,0x7a2f3a,0x3d5a3a][i%3],{roughness:0.85}),-0.5,0.752,0.1*face,g); nb.rotation.y=0.18;
    const pen=add(new THREE.CylinderGeometry(0.005,0.005,0.14,8),mat(0x1d2430,{roughness:0.4,metalness:0.4}),-0.45,0.765,0.12*face,g,{cast:false}); pen.rotation.set(Math.PI/2,0,0.6); }
  else { const ph=add(B(0.07,0.008,0.145),M.black,-0.42,0.75,0.3*face,g,{cast:false}); ph.rotation.y=-0.25; add(new THREE.PlaneGeometry(0.06,0.13),new THREE.MeshBasicMaterial({color:0x1a2230}),0,0.0045,0,ph,{cast:false,receive:false}).rotation.x=-Math.PI/2; }
  if(i%3!==1) add(new THREE.CylinderGeometry(0.03,0.028,0.22,14),new THREE.MeshStandardMaterial({color:lin(0xbfe3f5),transparent:true,opacity:0.5,roughness:0.08}),0.42,0.86,-0.12*face,g); // water bottle
  if(i%3===1){ const fr=add(B(0.11,0.13,0.012),mat(0x3a2c22,{roughness:0.7}),-0.62,0.81,-0.18*face,g,{cast:false}); fr.rotation.y=face>0?0.5:Math.PI-0.5; add(new THREE.PlaneGeometry(0.085,0.1),mat([0x9fd3f0,0xf2a7b8,0xe9c46a][i%3],{roughness:1}),0,0,0.007,fr,{cast:false,receive:false}); } // photo frame
  // task pinboard on a stand at the end of the desk: the captain pins assignments here (bridge.js → Office3D.pin), the worker takes them to hand in
  const bg=new THREE.Group(); bg.position.set(1.08,0,0.1*face); bg.rotation.y=Math.PI/2; g.add(bg);
  add(B(0.3,0.03,0.3),M.black,0,0.015,0,bg); add(B(0.04,1.0,0.04),M.alu,0,0.52,0,bg);
  add(B(0.62,0.48,0.03),M.walnut,0,1.26,0,bg);
  const bc=document.createElement('canvas'); bc.width=512; bc.height=384; // drawn at 2× of the logical 256×192
  const btex=new THREE.CanvasTexture(bc); btex.encoding=THREE.sRGBEncoding; btex.anisotropy=maxAniso;
  const bplane=add(new THREE.PlaneGeometry(0.56,0.42), new THREE.MeshBasicMaterial({map:btex}), 0,1.26,0.017, bg,{cast:false,receive:false});
  const board={canvas:bc,ctx:bc.getContext('2d'),tex:btex,mesh:bplane,notes:[]};
  const sz = z+0.74*face;
  officeChair(x+(rnd()-0.5)*0.08, sz, face);
  seats.push({x, z:sz, h: face>0?Math.PI:0, monitor:scr, board, plate});
}
let wi=0;
// 7 desks for the team: two facing pairs at the back, a pair and a single desk at the front
(CFG.desks || [[-10,-4.7,1],[-10,-5.5,-1],[-6,-4.7,1],[-6,-5.5,-1],[-10,4.7,-1],[-10,5.5,1],[-6,4.7,-1]]).forEach(([x,z,f])=>workstation(x,z,f,wi++));
[[-10,-5.1],[-6,-5.1],[-10,5.1],[-6,5.1]].forEach(([cx,dz])=>{
  if(!(cx===-6&&dz>0)) add(slab(1.6,0.42,0.035,0.015,0.006), M.sage, cx,0.98,dz);
  blob(cx,dz,2.2,2.2,false);
});
const deferredPlants=[[-2,-5.1,0],[1.25,8.5,1]]; // second one stands in the back-right corner of the manager's room
// seats are pushed per desk; facing: person at +face side looks toward desk

// ---------- Meeting room (glass box) ----------
const MR={x0:3,x1:11,z0:-D/2,z1:-1.6};
function glassWall(len,x,z,rot,doorGap){
  const g=new THREE.Group(); g.position.set(x,0,z); g.rotation.y=rot; scene.add(g);
  const segs = doorGap ? [[-len/2,doorGap[0]],[doorGap[1],len/2]] : [[-len/2,len/2]];
  segs.forEach(([a,b])=>{ const l=b-a, c=(a+b)/2;
    add(B(l,2.75,0.02),M.glass,c,1.375,0,g,{cast:false,receive:false});
    add(B(l,0.18,0.03),M.frost,c,1.15,0,g,{cast:false,receive:false});
    add(B(l,0.05,0.06),M.frame,c,2.77,0,g); add(B(l,0.04,0.06),M.frame,c,0.02,0,g);
    add(B(0.05,2.8,0.06),M.frame,a,1.4,0,g); add(B(0.05,2.8,0.06),M.frame,b,1.4,0,g);
  });
}
glassWall(MR.x1-MR.x0,(MR.x0+MR.x1)/2,MR.z1,0,[-4,-2.95]);
glassWall(MR.z1-MR.z0,MR.x0,(MR.z0+MR.z1)/2,Math.PI/2);
glassWall(MR.z1-MR.z0,MR.x1,(MR.z0+MR.z1)/2,Math.PI/2);
const rug=add(new THREE.PlaneGeometry(6.2,4.6), mat(0x6f7a72,{roughness:1}), 7,0.01,-5.2, scene,{cast:false}); rug.rotation.x=-Math.PI/2;
add(slab(4.4,0.05,1.6,0.35,0.012), M.walnut, 7,0.75,-5.1);
[-1.4,1.4].forEach(dx=>{ add(B(0.08,0.72,1.0),M.black,7+dx,0.36,-5.1); add(B(0.1,0.02,1.2),M.black,7+dx,0.01,-5.1); });
blob(7,-5.1,5.2,2.6,false);
const meetSeats=[];
[-1.5,0,1.5].forEach(dx=>{ [[-1.2,1],[1.2,-1]].forEach(([dz,f])=>{
  const s={x:7+dx, z:-5.1+dz, h: f>0?0:Math.PI, f}; meetSeats.push(s);
  officeChair(s.x, s.z, -f, M.leather);
});});
// display on a stand at the east end
const tvGroup=new THREE.Group(); tvGroup.position.set(10.55,0,-5.1); tvGroup.rotation.y=-Math.PI/2; scene.add(tvGroup);
add(B(0.6,0.03,0.4),M.black,0,0.015,0,tvGroup); add(B(0.08,1.3,0.06),M.alu,0,0.66,-0.05,tvGroup);
add(B(1.9,1.1,0.05),M.black,0,1.55,0,tvGroup);
const tvScreen=add(new THREE.PlaneGeometry(1.84,1.04),M.screenOff,0,1.55,0.026,tvGroup,{cast:false});
const tvOn=new THREE.MeshBasicMaterial({map:slideTex});
const meetLight=new THREE.PointLight(lin(0xffd9a8),0.6,7,2); meetLight.position.set(7,2.6,-5.1); scene.add(meetLight);
// flipchart easel in the corner with a sketched chart, water jug + glasses on the table
{ const fc=new THREE.Group(); fc.position.set(3.9,0,-8.2); fc.rotation.y=Math.PI/4; scene.add(fc);
  [-0.28,0.28].forEach(x=>{ const l=add(B(0.03,1.9,0.03),M.alu,x,0.95,-0.12,fc); l.rotation.x=-0.12; }); const bl=add(B(0.03,1.9,0.03),M.alu,0,0.95,0.3,fc); bl.rotation.x=0.3;
  const chart=tex(canvas(256,320,(g,w,h)=>{ g.fillStyle='#fbfaf5'; g.fillRect(0,0,w,h); g.strokeStyle='#2f6fde'; g.lineWidth=5; g.beginPath(); g.moveTo(30,250); g.lineTo(90,190); g.lineTo(140,210); g.lineTo(220,90); g.stroke();
    g.strokeStyle='#1d2430'; g.lineWidth=3; g.beginPath(); g.moveTo(30,40); g.lineTo(30,260); g.lineTo(230,260); g.stroke(); g.fillStyle='#d9822b'; g.font='600 24px sans-serif'; g.fillText('Q4',36,34); [60,100,140,180].forEach((x,i)=>{ g.fillStyle=['#2f6fde','#d9822b','#2b9a76','#8b94a3'][i]; g.fillRect(x,270,30,8); }); }));
  add(B(0.7,0.95,0.025),M.white,0,1.35,-0.17,fc).rotation.x=-0.12; const pad=add(new THREE.PlaneGeometry(0.62,0.82),new THREE.MeshStandardMaterial({map:chart,roughness:0.9}),0,1.33,-0.14,fc,{cast:false}); pad.rotation.x=-0.12;
  blob(3.9,-8.2,0.9,0.9,true); }
add(new THREE.CylinderGeometry(0.07,0.06,0.24,16),new THREE.MeshStandardMaterial({color:lin(0xd6eefa),transparent:true,opacity:0.5,roughness:0.05}),5.6,0.9,-5.4,scene,{cast:false});
[[5.95,-5.6],[6.1,-5.25],[5.8,-4.75]].forEach(([x,z])=>add(new THREE.CylinderGeometry(0.03,0.025,0.09,12),new THREE.MeshStandardMaterial({color:lin(0xe8f4fb),transparent:true,opacity:0.5,roughness:0.05}),x,0.825,z,scene,{cast:false}));
const MEET_DOOR={x:3.5,z:-1.0};

// ---------- Manager's room (glass office for the captain, front-centre, door toward the main aisle) ----------
// The captain's desk (config desks[0]) must lie inside this box; people hand work in by walking through the door to a spot in front of the desk.
const MG = CFG.managerRoom===false ? null : Object.assign({x0:-2.0,x1:1.6,z0:4.0,z1:8.9,doorX:1.0,doorW:1.1,label:'ห้องผู้จัดการ · Project Manager'}, CFG.managerRoom||{});
const MGR_DOOR = MG ? {x:MG.doorX, z:MG.z0} : null;
const mgrVisitSpots=[]; // where visitors stand (in front of the desk, facing the captain) — several so people handing in at once don't overlap
if(MG){
  const cx=(MG.x0+MG.x1)/2, cz=(MG.z0+MG.z1)/2, wx=MG.x1-MG.x0, wz=MG.z1-MG.z0, g0=MG.doorX-MG.doorW/2-cx, g1=MG.doorX+MG.doorW/2-cx;
  glassWall(wx,cx,MG.z0,0,[g0,g1]);                 // front wall with the door gap
  glassWall(wx,cx,MG.z1,0);                          // back wall
  glassWall(wz,MG.x0,cz,Math.PI/2); glassWall(wz,MG.x1,cz,Math.PI/2);
  const mrug=add(new THREE.PlaneGeometry(wx-0.5,wz-0.5), mat(0x7a6a5a,{roughness:1}), cx,0.01,cz, scene,{cast:false}); mrug.rotation.x=-Math.PI/2;
  // name sign above the door — redrawn with the captain's real name/role from the server (bridge.js → Office3D.setManagerLabel)
  const signC=document.createElement('canvas'); signC.width=512; signC.height=96;
  const signTex=new THREE.CanvasTexture(signC); signTex.encoding=THREE.sRGBEncoding; signTex.anisotropy=maxAniso;
  MG.drawSign=(text)=>{ const g=signC.getContext('2d'), w=signC.width, h=signC.height; g.fillStyle='#1d2430'; g.fillRect(0,0,w,h); g.fillStyle='#ffd46b';
    let size=40; g.font=`600 ${size}px "IBM Plex Sans Thai","Noto Sans Thai",system-ui,sans-serif`; while(size>22 && g.measureText(text).width>w-40){ size-=2; g.font=`600 ${size}px "IBM Plex Sans Thai","Noto Sans Thai",system-ui,sans-serif`; }
    g.textAlign='center'; g.textBaseline='middle'; g.fillText(text,w/2,h/2+2); signTex.needsUpdate=true; };
  MG.drawSign(MG.label);
  const sign=add(new THREE.PlaneGeometry(1.6,0.3), new THREE.MeshBasicMaterial({map:signTex}), MG.doorX,2.98,MG.z0-0.05, scene,{cast:false}); sign.rotation.y=Math.PI;
  // low credenza + award shelf along the side wall
  add(B(0.45,0.75,1.6),M.white, MG.x0+0.3,0.375,cz+1.2); add(B(0.47,0.03,1.62),M.oak, MG.x0+0.3,0.765,cz+1.2);
  const desk=(CFG.desks||[])[0]||[-0.4,6.6,1]; const vz = desk[1]-1.1*desk[2]; // in front of the desk (the side opposite the captain)
  [[desk[0],vz,0],[desk[0]-0.85,vz+0.1,0.35],[desk[0]+0.85,vz+0.1,-0.35]].forEach(([x,z,h])=>mgrVisitSpots.push({x,z,h: desk[2]>0 ? h : h+Math.PI}));
  const mgrLight=new THREE.PointLight(lin(0xfff1dc),0.5,6,2); mgrLight.position.set(cx,2.6,cz); scene.add(mgrLight);
  // bookshelf along the back wall (behind the captain, clear of the walking line at z≈7.9) with binders and a trophy
  { const bs=new THREE.Group(); bs.position.set(-0.7,0,MG.z1-0.19); bs.rotation.y=Math.PI; scene.add(bs);
    [-0.9,0.9].forEach(x=>add(B(0.03,1.9,0.34),M.walnut,x,0.95,0,bs));
    for(let y=0.02;y<1.95;y+=0.46) add(B(1.8,0.03,0.34),M.walnut,0,y,0,bs);
    add(B(1.8,1.9,0.01),mat(0x4a3a2e,{roughness:0.9}),0,0.95,-0.165,bs);
    const cols=[0x2f6fde,0x1d2430,0xd9822b,0xe8e4dc,0x3d5a3a,0x7a2f3a];
    for(let row=0;row<4;row++){ let x=-0.84; while(x<0.78){ const bw=0.03+rnd()*0.035, bh=0.22+rnd()*0.12; if(rnd()<0.82) add(B(bw,bh,0.22),mat(cols[Math.floor(rnd()*cols.length)],{roughness:0.8}),x+bw/2,0.04+row*0.46+bh/2,0.02,bs,{cast:false}); x+=bw+0.004; } }
    add(new THREE.CylinderGeometry(0.05,0.07,0.04,16),M.black,0.6,1.42,0.02,bs,{cast:false}); add(new THREE.CylinderGeometry(0.02,0.03,0.12,10),mat(0xf0c060,{roughness:0.25,metalness:0.8}),0.6,1.5,0.02,bs,{cast:false});
    add(new THREE.SphereGeometry(0.06,16,10),mat(0xf0c060,{roughness:0.25,metalness:0.8}),0.6,1.6,0.02,bs,{cast:false}); // trophy
    blob(-0.7,MG.z1-0.19,2.0,0.6,false); }
  // framed certificates on the credenza, a desk clock and a pen holder on the captain's desk
  [[cz+0.9,0x9fd3f0],[cz+1.5,0xf2d6a0]].forEach(([z,c])=>{ const fr=add(B(0.012,0.24,0.32),mat(0x3a2c22,{roughness:0.7}),MG.x0+0.3,0.92,z); add(new THREE.PlaneGeometry(0.26,0.18),mat(c,{roughness:1}),0.007,0,0,fr,{cast:false,receive:false}).rotation.y=Math.PI/2; fr.rotation.z=0.06; });
  add(new THREE.CylinderGeometry(0.035,0.035,0.09,14),mat(0x5a4632,{roughness:0.7}),desk[0]-0.55,0.79,desk[1]-0.05*desk[2],scene,{cast:false});
  for(let k=0;k<3;k++) add(new THREE.CylinderGeometry(0.004,0.004,0.13,6),mat([0x1d2430,0xd9822b,0x2f6fde][k],{roughness:0.4}),desk[0]-0.55+(k-1)*0.012,0.86,desk[1]-0.05*desk[2]+(k%2)*0.01,scene,{cast:false});
}
const inManagerRoom=(x,z)=> !!MG && x>MG.x0 && x<MG.x1 && z>MG.z0 && z<MG.z1;
const roomDoorFor=(spot)=> spot && inManagerRoom(spot.x,spot.z) ? MGR_DOOR : undefined; // spots inside the glass office are reached through its door

// ---------- Pantry ----------
add(B(4.0,0.86,0.66),M.white, 8.5,0.43,8.2);
add(slab(4.1,0.04,0.72,0.02,0.006),M.quartz, 8.5,0.88,8.2);
add(B(4.0,0.08,0.6),M.black, 8.5,0.04,8.2);
add(B(0.5,0.02,0.36),M.steel, 9.6,0.905,8.2); // sink
const tap=add(new THREE.TorusGeometry(0.1,0.012,8,16,Math.PI),M.steel, 9.6,1.0,8.38); tap.rotation.y=Math.PI/2;
// espresso machine
const cm=new THREE.Group(); cm.position.set(7.3,0.9,8.25); scene.add(cm);
add(slab(0.42,0.42,0.38,0.04,0.01),M.steel,0,0.21,0,cm);
add(B(0.42,0.06,0.38),M.black,0,0.45,0,cm);
add(B(0.3,0.02,0.15),M.black,0,0.05,-0.18,cm);
add(new THREE.CylinderGeometry(0.03,0.03,0.08,10),M.black,0,0.22,-0.21,cm);
const cmLed=add(new THREE.SphereGeometry(0.012,8,6),new THREE.MeshBasicMaterial({color:0x5bf08a}),0.15,0.35,-0.195,cm,{cast:false});
for(let k=0;k<4;k++) add(new THREE.CylinderGeometry(0.035,0.03,0.08,12),M.ceramic, 7.85+k*0.1,0.94,8.32);
add(new THREE.CylinderGeometry(0.075,0.09,0.2,16),M.steel, 8.4,1.0,8.3); // kettle
add(slab(0.5,0.3,0.4,0.02,0.008),M.steel, 10.3,1.05,8.2); // microwave
add(new THREE.PlaneGeometry(0.3,0.2),new THREE.MeshStandardMaterial({color:lin(0x11161e),roughness:0.2,metalness:0.4}),10.22,1.05,7.995,scene,{cast:false}).rotation.y=Math.PI;
add(B(0.03,0.08,0.012),M.black,10.5,1.05,7.99,scene,{cast:false});
add(new THREE.CylinderGeometry(0.055,0.055,0.24,16),M.paper,7.0,1.02,8.3,scene,{cast:false}); // paper towel roll
add(slab(0.8,1.9,0.72,0.04,0.012),M.steel, 11.85,0.95,8.15); // fridge
add(B(0.02,0.8,0.03),M.black, 11.5,1.15,7.78); add(B(0.02,0.4,0.03),M.black, 11.5,0.4,7.78);
blob(8.5,8.2,4.8,1.4,false); blob(11.85,8.15,1.2,1.1,false);
// water cooler
add(B(0.32,0.95,0.32),M.white, 11.9,0.475,6.7);
add(new THREE.CylinderGeometry(0.13,0.13,0.4,16), new THREE.MeshStandardMaterial({color:lin(0x9fd3f0),transparent:true,opacity:0.55,roughness:0.1}), 11.9,1.16,6.7);
// round high table
add(new THREE.CylinderGeometry(0.55,0.55,0.04,32),M.oak, 8,1.05,4.8);
add(new THREE.CylinderGeometry(0.035,0.035,1.03,12),M.black, 8,0.52,4.8);
add(new THREE.CylinderGeometry(0.25,0.27,0.02,24),M.black, 8,0.01,4.8);
blob(8,4.8,1.4,1.4,true);
const pantryLight=new THREE.PointLight(lin(0xffe2b8),0.45,7,2); pantryLight.position.set(8.5,2.6,6.5); scene.add(pantryLight);
const coffeeSpots=[{x:7.3,z:7.45,h:0},{x:8.6,z:7.45,h:0},{x:7.25,z:4.8,h:Math.PI/2},{x:8.75,z:4.8,h:-Math.PI/2},{x:8,z:5.55,h:Math.PI},{x:8,z:4.05,h:0}];

// ---------- Printer & storage ----------
const pr=new THREE.Group(); pr.position.set(1.3,0,-8.15); scene.add(pr);
add(slab(0.62,0.62,0.55,0.03,0.01),M.lightPlastic,0,0.31,0,pr);
add(B(0.6,0.02,0.52),M.plastic,0,0.2,0.005,pr); add(B(0.6,0.02,0.52),M.plastic,0,0.42,0.005,pr);
add(slab(0.64,0.18,0.56,0.03,0.01),M.lightPlastic,0,0.71,0,pr);
add(B(0.5,0.02,0.36),M.lightPlastic,0,0.82,0,pr);
add(B(0.4,0.015,0.25),M.paper,0,0.635,0.12,pr);
const prPanel=add(B(0.16,0.08,0.02),new THREE.MeshBasicMaterial({color:lin(0x2b9a76)}),0.2,0.72,0.29,pr,{cast:false});
const printLight=prPanel.material;
blob(1.3,-8.15,1.0,0.9,false);
for(let k=0;k<3;k++) add(B(0.3,0.22,0.22),mat(0xd8c7a6,{roughness:0.9}), 2.05,0.11+k*0.22,-8.25);
const printSpots=[{x:1.3,z:-7.35,h:Math.PI},{x:0.45,z:-7.3,h:Math.PI*0.85}];
// low storage cabinets with binders along the west glass
function cabinet(z){
  add(B(0.45,0.75,1.4),M.white, -12.55,0.375,z); add(B(0.47,0.03,1.42),M.oak, -12.55,0.765,z);
  for(let k=0;k<8;k++) add(B(0.28,0.3,0.06),mat([0x2f6fde,0x1d2430,0xd9822b,0xe8e4dc][k%4],{roughness:0.6}), -12.6,0.93,z-0.5+k*0.08);
  blob(-12.55,z,0.9,1.7,false);
}
cabinet(-1.9); cabinet(1.9);

// ---------- Plants ----------
const leafGeo = new THREE.SphereGeometry(1,10,6);
function plant(x,z,kind){
  const p=new THREE.Group(); p.position.set(x,0,z); scene.add(p);
  add(new THREE.CylinderGeometry(0.26,0.2,0.48,20), kind? M.ceramic : M.terracotta, 0,0.24,0, p);
  add(new THREE.CylinderGeometry(0.24,0.24,0.02,20), mat(0x3a2c22,{roughness:1}), 0,0.47,0, p,{cast:false});
  if(kind===1){ // snake plant
    for(let k=0;k<11;k++){ const a=rnd()*Math.PI*2, r=rnd()*0.12, hgt=0.5+rnd()*0.55;
      const l=add(new THREE.ConeGeometry(0.045,hgt,4),k%2?M.leaf:M.leaf2, Math.cos(a)*r,0.47+hgt/2,Math.sin(a)*r, p);
      l.scale.z=0.35; l.rotation.set((rnd()-0.5)*0.25,a,(rnd()-0.5)*0.25); }
  } else { // leafy fig
    add(new THREE.CylinderGeometry(0.02,0.025,1.0,8),mat(0x5a4632), 0,0.95,0, p);
    for(let k=0;k<26;k++){ const a=rnd()*Math.PI*2, yy=0.85+rnd()*0.75, r=0.12+rnd()*0.22;
      const l=add(leafGeo,k%3?M.leaf:M.leaf2, Math.cos(a)*r,yy,Math.sin(a)*r, p);
      l.scale.set(0.13,0.015,0.08); l.rotation.set((rnd()-0.5)*0.9,-a,(rnd()-0.3)*0.9); }
  }
  blob(x,z,0.9,0.9,true);
}
plant(-12.3,-8.2,0); plant(-12.3,8.2,1); plant(2.4,8.3,0); plant(12.4,2.5,1); deferredPlants.forEach(p=>plant(...p)); plant(-0.3,-8.3,1); plant(4.8,-8.2,0);

// ---------- Lounge corner ----------
const rugTex = tex(canvas(512,512,(g,w,h)=>{
  g.fillStyle='#c9b79c'; g.fillRect(0,0,w,h);
  g.strokeStyle='#8e6f4e'; g.lineWidth=10; g.strokeRect(24,24,w-48,h-48);
  g.lineWidth=3; g.strokeRect(50,50,w-100,h-100);
  g.fillStyle='rgba(142,111,78,.35)'; for(let y=90;y<h-90;y+=48) for(let x=90;x<w-90;x+=48){ g.beginPath(); g.moveTo(x+24,y); g.lineTo(x+48,y+24); g.lineTo(x+24,y+48); g.lineTo(x,y+24); g.fill(); }
  noise(g,w,h,22);
}));
const lrug=add(new THREE.PlaneGeometry(3.8,3.2), new THREE.MeshStandardMaterial({map:rugTex, roughness:1}), 4.2,0.012,6.3, scene,{cast:false});
lrug.rotation.x=-Math.PI/2;
const sofaM=mat(0x3d6b6a,{roughness:0.95}), chairM=mat(0xb3653f,{roughness:0.9});
// sofa (back to the front edge, faces -z)
add(slab(2.3,0.24,0.9,0.08,0.03),sofaM, 4.2,0.24,7.55);
for(let k=-1;k<=1;k++) add(slab(0.72,0.13,0.72,0.08,0.04),sofaM, 4.2+k*0.73,0.42,7.45);
add(slab(2.3,0.5,0.22,0.08,0.05),sofaM, 4.2,0.62,7.92);
[-1,1].forEach(sd=>add(slab(0.2,0.55,0.9,0.06,0.04),sofaM, 4.2+sd*1.1,0.36,7.55));
for(let k=0;k<2;k++){ const c=add(slab(0.38,0.36,0.12,0.08,0.05), mat(k?0xe9c46a:0xf2efe8,{roughness:1}), 3.4+k*1.55,0.66,7.74); c.rotation.set(-0.25,(k?-0.2:0.25),0); }
[[-1.05,0.2],[1.05,0.2],[-1.05,-0.3],[1.05,-0.3]].forEach(([dx,dz])=>add(new THREE.CylinderGeometry(0.025,0.02,0.12,8),M.black,4.2+dx,0.06,7.55+dz));
blob(4.2,7.55,2.8,1.4,false);
function armchair(x,z,rotY){
  const a=new THREE.Group(); a.position.set(x,0,z); a.rotation.y=rotY; scene.add(a);
  add(slab(0.8,0.24,0.78,0.08,0.03),chairM,0,0.24,0,a);
  add(slab(0.6,0.12,0.6,0.08,0.04),chairM,0,0.42,0.04,a);
  add(slab(0.8,0.45,0.18,0.08,0.05),chairM,0,0.6,-0.32,a);
  [-1,1].forEach(sd=>add(slab(0.14,0.5,0.78,0.05,0.04),chairM,sd*0.36,0.36,0,a));
  [[-0.32,0.3],[0.32,0.3],[-0.32,-0.3],[0.32,-0.3]].forEach(([dx,dz])=>add(new THREE.CylinderGeometry(0.022,0.018,0.12,8),M.oak,dx,0.06,dz,a));
  blob(x,z,1.1,1.1,true);
}
armchair(2.95,5.9,Math.PI/2); armchair(5.45,5.9,-Math.PI/2);
// coffee table with magazines and a plant
add(slab(1.15,0.04,0.6,0.04,0.008),M.oak, 4.2,0.4,5.9);
[[-0.5,-0.24],[0.5,-0.24],[-0.5,0.24],[0.5,0.24]].forEach(([dx,dz])=>add(B(0.03,0.38,0.03),M.black,4.2+dx,0.19,5.9+dz));
add(B(1.05,0.015,0.5),M.oak,4.2,0.1,5.9);
[[0x2f6fde,-0.2,0.15],[0xe8e2d6,-0.24,0.12],[0xd9822b,0.25,-0.3]].forEach(([c,dx,r])=>{ const m=add(B(0.24,0.008,0.32),mat(c,{roughness:0.7}),4.2+dx,0.425+Math.abs(dx)*0.02,5.9,scene,{cast:false}); m.rotation.y=r; });
add(new THREE.CylinderGeometry(0.06,0.05,0.1,14),M.ceramic,4.55,0.47,5.85);
for(let k=0;k<7;k++){ const l=add(leafGeo,M.leaf2,4.55+Math.cos(k*0.9)*0.04,0.57+(k%3)*0.03,5.85+Math.sin(k*0.9)*0.04,scene,{cast:false}); l.scale.set(0.05,0.01,0.03); l.rotation.set(0.5,k,0.4); }
blob(4.2,5.9,1.5,0.9,false);
// floor lamp
add(new THREE.CylinderGeometry(0.14,0.16,0.03,20),M.black,5.7,0.015,7.6);
add(new THREE.CylinderGeometry(0.012,0.012,1.5,8),M.black,5.7,0.77,7.6);
add(new THREE.CylinderGeometry(0.17,0.22,0.28,24,1,true), mat(0xf3e7cf,{roughness:1, side:THREE.DoubleSide, emissive:lin(0xffd8a0), emissiveIntensity:0.15}),5.7,1.55,7.6);
lamps.push(add(new THREE.SphereGeometry(0.05,10,8),M.lampGlow,5.7,1.5,7.6,scene,{cast:false}));
const loungeLight=new THREE.PointLight(lin(0xffd2a0),0.2,5,2); loungeLight.position.set(5.6,1.45,7.5); scene.add(loungeLight);
// bookshelf
{ const bs=new THREE.Group(); bs.position.set(2.25,0,5.9); bs.rotation.y=Math.PI/2; scene.add(bs);
  [-0.8,0.8].forEach(x=>add(B(0.03,1.8,0.34),M.oak,x,0.9,0,bs));
  for(let y=0.02;y<1.85;y+=0.44) add(B(1.6,0.03,0.34),M.oak,0,y,0,bs);
  add(B(1.6,1.8,0.01),M.white,0,0.9,-0.165,bs);
  const bookCols=[0x2f4f7a,0x8a3b2e,0xd9b36b,0x3d5a3a,0xe8e2d6,0x1d2430,0xb0568f,0x6b8fd1];
  for(let shelf=0;shelf<4;shelf++){ let x=-0.75; const y0=0.035+shelf*0.44;
    while(x<0.72){ if(rnd()<0.12){ x+=0.15; continue; }
      const bw=0.025+rnd()*0.03, bh=0.22+rnd()*0.12;
      const b=add(B(bw,bh,0.22),mat(bookCols[Math.floor(rnd()*bookCols.length)],{roughness:0.8}),x+bw/2,y0+bh/2,0.02,bs,{cast:false});
      if(rnd()<0.06){ b.rotation.z=0.25; x+=0.04; } x+=bw+0.003; } }
  add(new THREE.SphereGeometry(0.07,14,10),M.ceramic,0.55,1.82+0.07,0,bs);
  blob(2.25,5.9,0.8,1.9,false); }
const loungeSpots=[
  {x:3.45,z:7.3,h:Math.PI, via:[{x:6.2,z:6.65},{x:3.45,z:6.65}]},
  {x:4.2,z:7.3,h:Math.PI, via:[{x:6.2,z:6.65},{x:4.2,z:6.65}]},
  {x:4.95,z:7.3,h:Math.PI, via:[{x:6.2,z:6.65},{x:4.95,z:6.65}]},
  {x:2.95,z:5.9,h:Math.PI/2, via:[{x:6.2,z:4.95},{x:2.95,z:4.95}]},
  {x:5.45,z:5.9,h:-Math.PI/2, via:[{x:6.2,z:4.95},{x:5.45,z:4.95}]},
];
const phoneSpots=[{x:-12.3,z:-3.1,h:-Math.PI/2},{x:-12.3,z:3.3,h:-Math.PI/2},{x:-4,z:-8.3,h:Math.PI},{x:-8,z:-8.3,h:Math.PI}];

// ---------- Pantry extras ----------
add(slab(0.5,0.29,0.38,0.02,0.008),M.white,10.22,1.045,8.27);
{ const win=add(new THREE.PlaneGeometry(0.3,0.19),mat(0x1a1d22,{roughness:0.15,metalness:0.4}),10.17,1.05,8.078,scene,{cast:false}); win.rotation.y=Math.PI; }
add(B(0.08,0.2,0.01),M.black,10.4,1.05,8.077);
const bowl=add(new THREE.SphereGeometry(0.15,20,10,0,Math.PI*2,Math.PI/2,Math.PI/2),mat(0xf4f2ee,{roughness:0.3,side:THREE.DoubleSide}),8,1.2,4.8);
[[0xf0a020,0.04,0.02],[0xd23a2a,-0.05,0.03],[0x8cc04a,0.0,-0.06],[0xf0a020,-0.02,-0.01]].forEach(([c,dx,dz],k)=>
  add(new THREE.SphereGeometry(0.045,12,10),mat(c,{roughness:0.4}),8+dx,1.12+(k===3?0.05:0),4.8+dz));
for(let k=0;k<5;k++) add(new THREE.CylinderGeometry(0.03,0.025,0.1,10),mat([0xd9822b,0x2f6fde,0xf4f2ee,0x2b9a76,0xf4f2ee][k],{roughness:0.3}),9.0+k*0.08,0.95,8.42);
// steam above the espresso machine
const steamTex = tex(canvas(64,64,(g,w)=>{ const gr=g.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,'rgba(255,255,255,.9)'); gr.addColorStop(1,'rgba(255,255,255,0)'); g.fillStyle=gr; g.fillRect(0,0,64,64); }));
const steam=[]; for(let k=0;k<8;k++){ const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:steamTex, transparent:true, depthWrite:false, opacity:0}));
  sp.userData.life=k/8; scene.add(sp); steam.push(sp); }

// ---------- Kanban board, clock, extinguisher, robot vacuum ----------
const boardTex = tex(canvas(640,400,(g,w,h)=>{
  g.fillStyle='#fbfbf9'; g.fillRect(0,0,w,h);
  g.fillStyle='#1d2430'; g.font='600 22px sans-serif';
  ['TO DO','DOING','DONE'].forEach((t,k)=>{ g.fillText(t,20+k*213,34); if(k){ g.fillStyle='#c5cad1'; g.fillRect(k*213,10,2,h-20); g.fillStyle='#1d2430'; } });
  const cols=['#ffe06b','#7ad3e0','#ff9fb8','#b6e38a'];
  for(let k=0;k<3;k++) for(let r=0;r<(k===1?3:4);r++) for(let c=0;c<2;c++){ if(rnd()<0.25) continue;
    const x=18+k*213+c*96, y=54+r*84; g.save(); g.translate(x+40,y+34); g.rotate((rnd()-0.5)*0.12);
    g.fillStyle=cols[Math.floor(rnd()*4)]; g.fillRect(-40,-34,80,68); g.fillStyle='rgba(0,0,0,.35)';
    for(let l=0;l<3;l++) g.fillRect(-30,-20+l*14,30+rnd()*28,4); g.restore(); }
}));
{ const kb=new THREE.Group(); kb.position.set(1.0,0,-3.0); kb.rotation.y=Math.PI/2; scene.add(kb);
  add(B(1.6,1.0,0.03),M.white,0,1.35,0,kb);
  const front=add(new THREE.PlaneGeometry(1.56,0.96),new THREE.MeshStandardMaterial({map:boardTex,roughness:0.5}),0,1.35,0.017,kb,{cast:false});
  const back=front.clone(); back.position.z=-0.017; back.rotation.y=Math.PI; kb.add(back);
  add(B(1.62,0.03,0.05),M.alu,0,0.84,0,kb);
  [-0.78,0.78].forEach(x=>{ add(B(0.03,1.85,0.03),M.alu,x,0.93,0,kb); add(B(0.03,0.03,0.5),M.alu,x,0.04,0,kb); });
  blob(1.0,-3.0,0.7,1.8,false); }
// wall clock on the column, showing office time
const clockG=new THREE.Group(); clockG.position.set(1.6,2.35,-8.54); scene.add(clockG);
{ const face=add(new THREE.CylinderGeometry(0.2,0.2,0.035,40),M.white,0,0,0,clockG); face.rotation.x=Math.PI/2;
  const rim=add(new THREE.TorusGeometry(0.2,0.015,8,40),M.black,0,0,0.005,clockG);
  for(let k=0;k<12;k++){ const a=k/12*Math.PI*2; const tk=add(B(0.012,k%3?0.025:0.045,0.004),M.black,Math.sin(a)*0.165,Math.cos(a)*0.165,0.02,clockG,{cast:false}); tk.rotation.z=-a; } }
const hHand=new THREE.Group(), mHand=new THREE.Group(); [hHand,mHand].forEach(h=>{ h.position.z=0.022; clockG.add(h); });
add(B(0.014,0.1,0.004),M.black,0,0.045,0,hHand,{cast:false}); add(B(0.009,0.15,0.004),M.black,0,0.07,0.004,mHand,{cast:false});
add(new THREE.CylinderGeometry(0.075,0.08,0.45,16),mat(0xc8231c,{roughness:0.35}),-12.5,0.25,0.95);
add(new THREE.CylinderGeometry(0.03,0.03,0.06,10),M.black,-12.5,0.5,0.95);
// lobby: welcome mat in front of the lifts and a framed poster on the lift wall
{ const matT=tex(canvas(256,160,(g,w,h)=>{ g.fillStyle='#2b3038'; g.fillRect(0,0,w,h); g.strokeStyle='#6d7682'; g.lineWidth=10; g.strokeRect(12,12,w-24,h-24); noise(g,w,h,20); }));
  const wm=add(new THREE.PlaneGeometry(1.3,0.85),new THREE.MeshStandardMaterial({map:matT,roughness:1}),12.3,0.012,0.85,scene,{cast:false}); wm.rotation.x=-Math.PI/2;
  const art=tex(canvas(256,352,(g,w,h)=>{ g.fillStyle='#f4efe6'; g.fillRect(0,0,w,h); [[70,110,70,'#2f6fde'],[160,150,55,'#d9822b'],[110,230,85,'#2b9a76']].forEach(([x,y,r,c])=>{ g.fillStyle=c; g.globalAlpha=0.85; g.beginPath(); g.arc(x,y,r,0,Math.PI*2); g.fill(); }); g.globalAlpha=1; g.fillStyle='#1d2430'; g.fillRect(40,300,176,6); }));
  add(B(0.03,1.0,0.74),mat(0x1d2430,{roughness:0.6}),12.955,1.65,-0.9); const po=add(new THREE.PlaneGeometry(0.66,0.92),new THREE.MeshStandardMaterial({map:art,roughness:0.9}),12.935,1.65,-0.9,scene,{cast:false}); po.rotation.y=-Math.PI/2; }
// robot vacuum doing laps of the corridor
const vac=new THREE.Group(); scene.add(vac);
add(new THREE.CylinderGeometry(0.17,0.17,0.08,32),mat(0x2a2d33,{roughness:0.35}),0,0.045,0,vac);
add(new THREE.CylinderGeometry(0.12,0.12,0.012,32),mat(0x9aa0a8,{roughness:0.3,metalness:0.5}),0,0.09,0,vac);
const vacLed=add(new THREE.SphereGeometry(0.012,8,6),new THREE.MeshBasicMaterial({color:0x45d1ff}),0,0.1,0.13,vac,{cast:false});
blob(0,0,0.5,0.5,true,vac,0.006,0.7);
const vacPath=[[-11.3,1.0],[5.2,1.0],[5.2,-1.0],[-11.3,-1.0]].map(([x,z])=>new THREE.Vector3(x,0,z));
let vacI=0; vac.position.copy(vacPath[0]); let vacH=0;
// printed sheet sliding out
const sheet=add(B(0.21,0.003,0.29),M.paper,0,0.66,0,pr,{cast:false}); sheet.visible=false;

function updateDetails(dt,t,hour,printing){
  // robot vacuum
  const tg=vacPath[(vacI+1)%vacPath.length]; tmpV.subVectors(tg,vac.position); const d=tmpV.length(), mv=0.32*dt;
  if(d<=mv){ vac.position.copy(tg); vacI=(vacI+1)%vacPath.length; }
  else { vac.position.addScaledVector(tmpV.normalize(),mv); const th=Math.atan2(tmpV.x,tmpV.z); let dh=th-vacH; dh=Math.atan2(Math.sin(dh),Math.cos(dh)); vacH+=dh*Math.min(1,dt*3); }
  vac.rotation.y=vacH; vacLed.visible = Math.sin(t*4)>-0.3;
  // steam while someone is at the counter
  const brewing = workers.some(w=>w.state==='coffee' && w.spot && w.spot.z>7);
  steam.forEach(sp=>{ sp.userData.life+=dt*0.45; if(sp.userData.life>1) sp.userData.life-=1;
    const l=sp.userData.life; sp.position.set(7.3+Math.sin(l*6+sp.id)*0.03,1.38+l*0.45,8.13);
    const sc=0.06+l*0.18; sp.scale.set(sc,sc,1); sp.material.opacity = brewing ? 0.28*Math.sin(l*Math.PI) : Math.max(0,sp.material.opacity-dt); });
  // clock hands
  const mins=(hour%12)*60; mHand.rotation.z=-(mins%60)/60*Math.PI*2; hHand.rotation.z=-(mins/720)*Math.PI*2;
  // printer output
  sheet.visible=printing; if(printing){ const k=(t*0.6)%1; sheet.position.z=-0.12+k*0.3; sheet.position.y=0.66-k*0.02; }
  const evening=Math.max(0,(hour-15.5)/2.5); loungeLight.intensity=0.2+evening*0.8;
  liftLeaves.forEach(l=>l.position.z=l.userData.z0+l.userData.dir*0.4*elevator.open);
  liftLamp.material.color.setHex(elevator.open>0.01||elevator.target>0 ? 0xffd27a : 0x6b7280);
  const nightK=Math.min(1,Math.max(0,(hour-14.5)/3.5));
  cityMats.forEach(m=>m.emissiveIntensity=0.08+nightK*1.1);
}

// ---------- Reception & elevator lobby ----------
const elevator={open:0,target:0};
{ // elevator wall on the east edge
  add(B(0.22,3.1,3.6),mat(0xe4e0d8,{roughness:0.8}),13.08,1.55,0.2);
  add(B(0.24,0.12,3.6),M.frame,13.08,3.1,0.2);
}
const liftLeaves=[];
[0.35,1.35].forEach(zc=>{
  add(B(0.06,2.25,1.04),M.frame,12.95,1.125,zc);
  [-1,1].forEach(dir=>{ const leaf=add(B(0.03,2.1,0.45),M.steel,12.92,1.05,zc+dir*0.225,scene,{cast:false});
    leaf.userData={z0:zc+dir*0.225,dir}; if(zc>1) liftLeaves.push(leaf); });
  add(B(0.03,0.16,0.08),M.black,12.93,1.15,zc-0.62);
});
const liftLamp=add(new THREE.BoxGeometry(0.02,0.05,0.3),new THREE.MeshBasicMaterial({color:0x6b7280}),12.93,2.32,1.35,scene,{cast:false});
const signTex=tex(canvas(1024,224,(g,w,h)=>{
  g.fillStyle='#1d2430'; g.fillRect(0,0,w,h);
  g.fillStyle='#7fc4f0'; g.beginPath(); g.arc(112,112,62,0,Math.PI*2); g.fill();
  g.fillStyle='#1d2430'; g.beginPath(); g.arc(138,96,46,0,Math.PI*2); g.fill();
  const SG=Object.assign({title:'AI Workforce Control Center',subtitle:'ศูนย์ควบคุมพนักงาน AI'},CFG.companySign||{}); // lobby sign text comes from config.js
  g.fillStyle='#f4f2ee'; let fs=74; g.font=`600 ${fs}px "IBM Plex Sans Thai","Noto Sans Thai",sans-serif`; while(fs>34 && g.measureText(SG.title).width>w-240){ fs-=4; g.font=`600 ${fs}px "IBM Plex Sans Thai","Noto Sans Thai",sans-serif`; } g.fillText(SG.title,210,112);
  g.fillStyle='#9aa5b5'; g.font='500 36px "IBM Plex Sans Thai","Noto Sans Thai",sans-serif'; g.fillText(SG.subtitle,212,176);
}));
{ const sg=add(new THREE.PlaneGeometry(2.2,0.48),new THREE.MeshStandardMaterial({map:signTex,emissive:0xffffff,emissiveMap:signTex,emissiveIntensity:0.35,roughness:0.4}),12.955,2.68,0.85,scene,{cast:false});
  sg.rotation.y=-Math.PI/2; }
// reception desk (front faces the lifts)
{ const rd=new THREE.Group(); rd.position.set(11.2,0,-0.75); rd.rotation.y=Math.PI/2; scene.add(rd);
  [-0.75,0.75].forEach(x=>add(B(0.05,1.05,0.75),M.white,x,0.525,0,rd));
  add(B(1.55,1.05,0.05),M.walnut,0,0.525,0.35,rd);
  for(let x=-0.7;x<=0.71;x+=0.1) add(B(0.04,0.98,0.03),M.oak,x,0.52,0.39,rd,{cast:false});
  add(slab(1.65,0.04,0.32,0.02,0.006),M.quartz,0,1.08,0.3,rd);
  add(B(1.5,0.03,0.6),M.white,0,0.745,0,rd);
  const m=new THREE.Group(); m.position.set(0.15,0,0.05); m.rotation.y=Math.PI; rd.add(m);
  add(B(0.2,0.012,0.16),M.alu,0,0.766,0,m); add(B(0.04,0.2,0.02),M.alu,0,0.86,-0.02,m);
  add(B(0.6,0.36,0.025),M.black,0,1.08,0,m);
  add(new THREE.PlaneGeometry(0.575,0.335),screenMats[2],0,1.08,0.0135,m,{cast:false});
  add(slab(0.42,0.018,0.13,0.01,0.004),M.lightPlastic,0.15,0.769,-0.2,rd);
  add(new THREE.SphereGeometry(0.045,16,8,0,Math.PI*2,0,Math.PI/2),M.steel,0.5,1.1,0.3,rd);
  add(new THREE.CylinderGeometry(0.045,0.035,0.18,14),new THREE.MeshStandardMaterial({color:lin(0xcfe6f5),transparent:true,opacity:0.5,roughness:0.05}),-0.55,1.19,0.3,rd);
  for(let k=0;k<7;k++) add(new THREE.SphereGeometry(0.03,10,8),mat([0xf2a7b8,0xffffff,0xf7d36b][k%3],{roughness:0.6}),-0.55+Math.cos(k)*0.045,1.32+(k%2)*0.03,0.3+Math.sin(k)*0.045,rd,{cast:false});
  for(let k=0;k<3;k++){ const b=add(B(0.15,0.006,0.21),mat([0x2f6fde,0xf4f2ee,0xd9822b][k],{roughness:0.7}),0.05+k*0.02,1.103+k*0.006,0.32,rd,{cast:false}); b.rotation.y=k*0.15; }
  blob(11.2,-0.75,1.2,2.0,false); }
{ const c=officeChair(10.55,-0.75,1); c.rotation.y=-Math.PI/2; }

// ---------- City outside the windows ----------
const cityMats=[];
// texture หนึ่งผืน = ผนัง 12 ม. × 12 ม. (16 × 8 ช่องหน้าต่าง) ที่ 1024² → 1 px ≈ 1.2 ซม. ตึกคมแม้ซูมเข้าหน้าต่าง
function facade(base,glass,litP,style=0){
  const W=1024,H=1024, cols=16, rows=8, cw=W/cols, rh=H/rows;
  const map=canvas(W,H,(g)=>{ g.fillStyle=base; g.fillRect(0,0,W,H);
    for(let r=0;r<rows;r++){ g.fillStyle='rgba(0,0,0,.10)'; g.fillRect(0,r*rh,W,3); g.fillStyle='rgba(255,255,255,.07)'; g.fillRect(0,r*rh+rh-14,W,2); } // คานพื้นแต่ละชั้น
    for(let c=0;c<cols;c++){ g.fillStyle='rgba(0,0,0,.08)'; g.fillRect(c*cw,0,2,H); }                                                       // รอยต่อแผ่นผนัง
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++){ const x=c*cw+8, y=r*rh+18, w=cw-16, h=rh-44;
      g.fillStyle='rgba(0,0,0,.35)'; g.fillRect(x-2,y-2,w+4,h+4);                                   // กรอบหน้าต่าง (เงา)
      g.fillStyle=glass; g.fillRect(x,y,w,h);
      const grd=g.createLinearGradient(0,y,0,y+h); grd.addColorStop(0,'rgba(255,255,255,.22)'); grd.addColorStop(.5,'rgba(255,255,255,.04)'); grd.addColorStop(1,'rgba(0,0,0,.12)');
      g.fillStyle=grd; g.fillRect(x,y,w,h);                                                          // เงาสะท้อนท้องฟ้า
      g.fillStyle='rgba(255,255,255,.18)'; g.fillRect(x+w/2-1,y,2,h);                                // เสากลางหน้าต่าง
      if(style===1){ g.fillStyle='rgba(255,255,255,.14)'; g.fillRect(x,y+h*0.5-1,w,2); }
      if(rnd()<0.3){ const bh=h*(0.25+rnd()*0.5); g.fillStyle='rgba(230,226,214,.55)'; g.fillRect(x+2,y+2,w-4,bh);
        g.fillStyle='rgba(0,0,0,.12)'; for(let yy=y+6;yy<y+bh;yy+=6) g.fillRect(x+2,yy,w-4,1); }     // มู่ลี่บางห้อง
    }
    noise(g,W,H,6); });
  const em=canvas(W,H,(g)=>{ g.fillStyle='#000'; g.fillRect(0,0,W,H);
    for(let r=0;r<rows;r++) for(let c=0;c<cols;c++) if(rnd()<litP){ const x=c*cw+8, y=r*rh+18, w=cw-16, h=rh-44;
      g.fillStyle=rnd()<0.8?'#ffd9a0':'#cfe6ff'; g.fillRect(x,y,w,h);
      g.fillStyle='rgba(0,0,0,.35)'; if(rnd()<0.5) g.fillRect(x,y,w,h*0.45); else g.fillRect(x+w*0.55,y,w*0.45,h); // ห้องสว่างไม่เท่ากัน
    } });
  const t1=tex(map), t2=tex(em); [t1,t2].forEach(t=>{ t.wrapS=t.wrapT=THREE.RepeatWrapping; });
  const m=new THREE.MeshStandardMaterial({map:t1, emissive:0xffffff, emissiveMap:t2, emissiveIntensity:0.12, roughness:0.4, metalness:0.2});
  cityMats.push(m); return m;
}
const facades=[facade('#b9bcc0','#3d4a5a',0.35),facade('#d8cfc2','#4a5563',0.45),facade('#7f8a96','#2a3644',0.3),facade('#9fb3c4','#5a7189',0.4),facade('#2f3540','#1b2230',0.5,1)];
const parapetM=mat(0x6d7075,{roughness:0.85});
const roofM=mat(0x8a8d90,{roughness:0.9});
function building(x,z,w,d,top,fm){
  const base=-62, h=top-base, geo=new THREE.BoxGeometry(w,h,d);
  const uv=geo.attributes.uv, dims=[[d,h],[d,h],[w,d],[w,d],[w,h],[w,h]];
  for(let f=0;f<6;f++) for(let v=0;v<4;v++){ const i=f*4+v; uv.setXY(i, uv.getX(i)*dims[f][0]/12, uv.getY(i)*dims[f][1]/12); }
  const b=new THREE.Mesh(geo,[fm,fm,roofM,roofM,fm,fm]); b.position.set(x,base+h/2,z); b.receiveShadow=true; scene.add(b);
  const rim=new THREE.Mesh(B(w+0.3,0.5,d+0.3),parapetM); rim.position.set(x,top+0.1,z); scene.add(rim);              // ขอบกันตกบนดาดฟ้า
  const n=1+Math.floor(rnd()*3);                                                                                       // เครื่องปรับอากาศ/ห้องเครื่องบนดาดฟ้า
  for(let i=0;i<n;i++){ const u=new THREE.Mesh(B(w*(0.12+rnd()*0.18),0.9+rnd()*1.2,d*(0.12+rnd()*0.18)),roofM); u.position.set(x+(rnd()-0.5)*w*0.6,top+0.8,z+(rnd()-0.5)*d*0.6); scene.add(u); }
  if(rnd()<0.35){ const rr=Math.min(w,d)*0.1, tank=new THREE.Mesh(new THREE.CylinderGeometry(rr,rr,1.8,12),M.alu); tank.position.set(x+(rnd()-0.5)*w*0.5,top+1.2,z+(rnd()-0.5)*d*0.5); scene.add(tank); } // ถังน้ำ
  if(rnd()<0.3){ const a=new THREE.Mesh(new THREE.CylinderGeometry(0.06,0.12,7,6),M.frame); a.position.set(x,top+3.5,z); scene.add(a);
    const beacon=new THREE.Mesh(new THREE.SphereGeometry(0.18,8,6),new THREE.MeshBasicMaterial({color:0xff3b3b})); beacon.position.set(x,top+7.1,z); scene.add(beacon); } // เสาอากาศ + ไฟแดง
}
// our own tower below the office floor
{ const tw=new THREE.BoxGeometry(W+0.6,61.5,D+0.6), uv=tw.attributes.uv, dims=[[D,61.5],[D,61.5],[W,D],[W,D],[W,61.5],[W,61.5]];
  for(let f=0;f<6;f++) for(let v=0;v<4;v++){ const i=f*4+v; uv.setXY(i,uv.getX(i)*dims[f][0]/12,uv.getY(i)*dims[f][1]/12); }
  const t=new THREE.Mesh(tw,facades[3]); t.position.set(0,-62+61.5/2,0); scene.add(t); }
for(let k=0;k<120;k++){
  const a=rnd()*Math.PI*2, r=24+rnd()*50;
  const x=Math.cos(a)*r, z=Math.sin(a)*r;
  if(Math.abs(x)<20 && Math.abs(z)<16) continue;
  const tall=rnd(); const top = (tall<0.3 && r>48) ? 4+rnd()*22 : -40+rnd()*36;
  building(x,z,6+rnd()*10,6+rnd()*10,top,facades[Math.floor(rnd()*facades.length)]);
}
const ground=new THREE.Mesh(new THREE.PlaneGeometry(400,400),mat(0x5b6158,{roughness:1})); ground.rotation.x=-Math.PI/2; ground.position.y=-62; scene.add(ground);

// ---------- Lighting & sun cycle ----------
const hemi = new THREE.HemisphereLight(lin(0xe6eeff), lin(0x8a7a66), 0.35); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
const SHADOW_RES = (Math.min(screen.width,screen.height)>=700 && renderer.capabilities.maxTextureSize>=8192) ? 4096 : 2048; // เงาคมขึ้นบนเดสก์ท็อป
sun.castShadow = true; sun.shadow.mapSize.set(SHADOW_RES,SHADOW_RES);
Object.assign(sun.shadow.camera,{left:-18,right:18,top:18,bottom:-18,near:1,far:90});
sun.shadow.bias=-0.0004; sun.shadow.normalBias=0.025; sun.shadow.radius=3;
scene.add(sun); scene.add(sun.target);
const warm=new THREE.Color(0xffa860), noon=new THREE.Color(0xfff4e6), tmpC=new THREE.Color();
function updateSun(hour){
  const k=(hour-9)/9;                         // 0 at 09:00 → 1 at 18:00
  const el=Math.max(0.12, Math.sin(Math.PI*(hour-6)/12)*1.05);
  const az=0.35+k*1.75;
  const R=40;
  sun.position.set(-Math.cos(az)*Math.cos(el)*R, Math.sin(el)*R, -Math.sin(az)*Math.cos(el)*R);
  const warmth=Math.min(1,Math.max(0,(k-0.55)/0.45));
  tmpC.copy(noon).lerp(warm,warmth); sun.color.copy(tmpC);
  sun.intensity=1.2+1.6*Math.sin(el);
  hemi.intensity=0.3+0.12*Math.sin(el);
  const evening=Math.max(0,(hour-15.5)/2.5);
  M.lampGlow.emissiveIntensity=0.3+evening*2.2;
  meetLight.intensity=0.5+evening*0.9; pantryLight.intensity=0.4+evening*0.8;
}

// ---------- People ----------
const shirts=[0x3b6fd8,0xf2f2ef,0x2b9a76,0xe0a030,0x7b5cc4,0x9fb4c9,0xc85a8f,0x5c7a3a,0x3a4a6b,0xd07b3c,0xece6da,0x9c4f4f];
const pantsCols=[0x2d3340,0x4a4d52,0xb9a98d,0x1f2228,0x3c4a5e];
const skins=[0xf1c9a5,0xd9a47c,0xb5835a,0x8d5b3c,0xe8b896];
const hairCols=[0x1e1712,0x3b2a1e,0x5b3d26,0x111111,0x6b4a2f];
const STATE_COL={rest:css('--rest'),visit:css('--visit'),work:css('--work'),meet:css('--meet'),coffee:css('--coffee'),print:css('--print'),walk:css('--walk'),lounge:css('--lounge'),phone:css('--phone')};
// ---------- Human model builders ----------
const V2=(x,y)=>new THREE.Vector2(x,y);
const lathe=(pts,seg=22,ps=0,pl=Math.PI*2)=>new THREE.LatheGeometry(pts.map(([r,y])=>V2(r,y)),seg,ps,pl);
// tapered capsule that hangs down from its joint (pivot at y = 0)
function capsule(r1,r2,len,seg=16){ const p=[], n=6;
  for(let k=0;k<=n;k++){ const a=k/n*Math.PI/2; p.push([r2*Math.sin(a), -len-r2*Math.cos(a)]); }
  for(let k=0;k<=n;k++){ const a=k/n*Math.PI/2; p.push([r1*Math.cos(a), r1*Math.sin(a)]); }
  return lathe(p,seg); }
function headGeo(fem){
  const g=new THREE.SphereGeometry(0.1,36,28), p=g.attributes.position;
  for(let i=0;i<p.count;i++){ let x=p.getX(i), y=p.getY(i), z=p.getZ(i); const ny=y/0.1;
    if(ny<0){ const f=Math.pow(-ny,1.4); x*=1-(fem?0.3:0.22)*f; z*=1-0.1*f; }
    if(ny>0.2 && z<0) z*=1.03;                       // occiput
    z*= z<0 ? 0.94 : 1.02;
    y*=1.17; if(ny<-0.7) y-=(fem?0.004:0.009)*(-ny);   // chin
    p.setXYZ(i,x*0.93,y,z); }
  g.computeVertexNormals(); return g; }
function shoeGeo(){ const s=new THREE.Shape();
  s.moveTo(-0.055,0); s.lineTo(0.13,0); s.quadraticCurveTo(0.168,0.002,0.162,0.03); s.quadraticCurveTo(0.152,0.056,0.085,0.066);
  s.lineTo(0.02,0.088); s.lineTo(-0.045,0.088); s.quadraticCurveTo(-0.068,0.06,-0.055,0);
  const g=new THREE.ExtrudeGeometry(s,{depth:0.066,bevelEnabled:true,bevelThickness:0.012,bevelSize:0.01,bevelSegments:3,curveSegments:10});
  g.translate(0,0,-0.033); g.rotateY(-Math.PI/2); return g; }
const TORSO={m:[[0.001,-0.01],[0.128,0],[0.132,0.07],[0.145,0.16],[0.165,0.26],[0.178,0.33],[0.18,0.38],[0.17,0.425],[0.14,0.462],[0.09,0.488],[0.05,0.5]],
             f:[[0.001,-0.01],[0.116,0],[0.118,0.07],[0.134,0.16],[0.152,0.25],[0.158,0.31],[0.155,0.36],[0.146,0.41],[0.118,0.452],[0.078,0.482],[0.046,0.495]]};
const PELV={m:[[0.001,-0.13],[0.08,-0.126],[0.134,-0.09],[0.15,-0.04],[0.146,0.02],[0.134,0.06],[0.128,0.078]],
            f:[[0.001,-0.13],[0.085,-0.126],[0.145,-0.09],[0.166,-0.04],[0.158,0.02],[0.13,0.06],[0.116,0.078]]};
const PG = {
  headM:headGeo(false), headF:headGeo(true),
  torsoM:lathe(TORSO.m,26), torsoF:lathe(TORSO.f,26),
  jacketM:lathe([[0.15,-0.16],[0.142,-0.05],...TORSO.m.slice(1,9).map(([r,y])=>[r*1.07+0.004,y])],26,0.17*Math.PI,1.66*Math.PI),
  jacketF:lathe([[0.16,-0.15],[0.135,-0.05],...TORSO.f.slice(1,9).map(([r,y])=>[r*1.07+0.004,y])],26,0.17*Math.PI,1.66*Math.PI),
  pelvisM:lathe(PELV.m,24), pelvisF:lathe(PELV.f,24),
  shoulder:new THREE.SphereGeometry(0.054,16,12),
  neck:capsule(0.047,0.05,0.075,14),
  upperArm:capsule(0.05,0.042,0.27), foreArm:capsule(0.041,0.031,0.23),
  thigh:capsule(0.082,0.058,0.41), shin:capsule(0.056,0.04,0.39),
  palm:slab(0.028,0.08,0.068,0.012,0.008), finger:capsule(0.0095,0.008,0.048,8), thumb:capsule(0.011,0.009,0.04,8),
  shoe:shoeGeo(), sock:new THREE.CylinderGeometry(0.041,0.043,0.05,14),
  collar:new THREE.CylinderGeometry(0.068,0.058,0.045,22,1,true,0.2*Math.PI,1.6*Math.PI),
  cuff:new THREE.CylinderGeometry(0.034,0.034,0.025,14),
  belt:new THREE.TorusGeometry(0.13,0.013,8,30),
  eyeW:new THREE.SphereGeometry(0.0155,14,10), iris:new THREE.SphereGeometry(0.0082,12,8), brow:B(0.032,0.0055,0.008),
  nose:new THREE.ConeGeometry(0.0125,0.034,10), lips:new THREE.SphereGeometry(0.02,14,8), ear:new THREE.SphereGeometry(0.022,12,8),
  hairCap:new THREE.SphereGeometry(0.106,36,18,0,Math.PI*2,0,Math.PI*0.56),
  hairTop:new THREE.SphereGeometry(0.09,24,12),
  hairLong:lathe([[0.05,-0.25],[0.084,-0.21],[0.1,-0.13],[0.108,-0.05],[0.109,0.02],[0.1,0.065]],28,0.33*Math.PI,1.34*Math.PI),
  fringe:new THREE.SphereGeometry(0.108,24,10,-0.55*Math.PI/2+Math.PI/2*0, Math.PI*0.62, Math.PI*0.18, Math.PI*0.2),
  bun:new THREE.SphereGeometry(0.046,16,12), tail:capsule(0.032,0.016,0.19,12), tie:new THREE.SphereGeometry(0.016,8,6),
  lens:new THREE.TorusGeometry(0.022,0.0032,6,20), temple:B(0.003,0.003,0.09),
  cup:new THREE.CylinderGeometry(0.035,0.03,0.09,14),
  ring:new THREE.RingGeometry(0.3,0.36,32),
};
const workers=[];
const TEAM=(CFG.team||[]).map(m=>Object.assign({},m.look||{},{id:m.id,name:m.name,role:m.role,jobId:m.jobId,model:m.model}))
  .concat([Object.assign({},(CFG.visitor&&CFG.visitor.look)||{},{id:'visitor',name:(CFG.visitor&&CFG.visitor.name)||'แขก',role:(CFG.visitor&&CFG.visitor.role)||'ผู้มาติดต่อ',model:CFG.visitor&&CFG.visitor.model})]);
const NAMES=TEAM.map(t=>t.name), ROLES=TEAM.map(t=>t.role);
const eyeWhiteM=mat(0xf3efe8,{roughness:0.25}), browCache={};
function joint(parent,x,y,z){ const j=new THREE.Group(); j.position.set(x,y,z||0); parent.add(j); return j; }
function part(geo,m,parent,x=0,y=0,z=0){ return add(geo,m,x,y,z,parent,{receive:false}); }
function makeWorker(i,seat){
  const T=TEAM[i]||{}, fem=[1,3,4].includes(T.style), sx=fem?0.165:0.188;
  const g=new THREE.Group(); scene.add(g);
  const sc=fem?0.95:0.99; g.scale.setScalar(sc);
  const skinCol=lin(T.skin??0xe8b896);
  const skin=mat(T.skin??0xe8b896,{roughness:0.52}); skin.emissive=skinCol.clone().multiplyScalar(0.05);
  const shirt=mat(T.shirt,{roughness:0.85}), pants=mat(T.pants,{roughness:0.82});
  const jacket=T.jacket?mat(T.jacket,{roughness:0.8}):null;
  const hairM=mat(T.hair,{roughness:0.48, side:THREE.DoubleSide});
  const shoeM=mat(T.shoe??0x1b1b1d,{roughness:0.38}), sockM=mat(0x22252a,{roughness:0.9});
  const sleeveUp = jacket||shirt, sleeveLo = T.sleeves==='short' ? skin : (jacket||shirt);

  const pelvis=joint(g,0,0.935,0);
  part(fem?PG.pelvisF:PG.pelvisM,pants,pelvis).scale.z=0.68;
  part(PG.belt,M.black,pelvis,0,0.068,0).rotation.x=Math.PI/2;
  pelvis.children[pelvis.children.length-1].scale.set(fem?0.9:1,1,0.66);
  const spine=joint(pelvis,0,0.075,0);
  part(fem?PG.torsoF:PG.torsoM,shirt,spine).scale.z=0.6;
  if(jacket){ const jk=part(fem?PG.jacketF:PG.jacketM,new THREE.MeshStandardMaterial({color:jacket.color,roughness:0.8,side:THREE.DoubleSide}),spine); jk.scale.z=0.62; }
  else part(B(0.014,0.36,0.004),mat(T.shirt,{roughness:0.7}),spine,0,0.26,0.104).rotation.x=-0.05; // button placket
  part(PG.collar,new THREE.MeshStandardMaterial({color:(jacket||shirt).color,roughness:0.8,side:THREE.DoubleSide}),spine,0,0.5,0.004).rotation.x=-0.12;
  // lanyard + badge
  const strap=mat(T.name==='แขก'?0xd9822b:0x2f6fde,{roughness:0.8});
  [-1,1].forEach(sd=>{ const st=part(B(0.011,0.23,0.004),strap,spine,sd*0.042,0.39,0.104+(jacket?0.006:0)); st.rotation.z=sd*0.3; st.rotation.x=-0.18; });
  part(B(0.052,0.072,0.006),M.white,spine,0,0.255,0.112+(jacket?0.006:0));
  // neck & head
  const neckJ=joint(spine,0,0.585,0); part(PG.neck,skin,neckJ);
  const head=joint(neckJ,0,0.03,0);
  const hi=joint(head,0,0.1,0.005);
  part(fem?PG.headF:PG.headM,skin,hi);
  [-1,1].forEach(sd=>{ const e=part(PG.ear,skin,hi,sd*0.093,-0.005,-0.008); e.scale.set(0.38,1,0.7); });
  const eyes=[];
  [-1,1].forEach(sd=>{ const eg=joint(hi,sd*0.032,0.012,0.08);
    const wh=part(PG.eyeW,eyeWhiteM,eg); wh.scale.set(1,0.78,0.6); wh.castShadow=false;
    const ir=part(PG.iris,mat(T.iris??0x3b2618,{roughness:0.15}),eg,0,0,0.0085); ir.scale.set(1,1,0.45); ir.castShadow=false;
    eyes.push(eg);
    const bw=part(PG.brow,mat(T.hair,{roughness:0.8}),hi,sd*0.034,0.036,0.088); bw.rotation.set(-0.25,sd*0.15,sd*-0.12); bw.castShadow=false; });
  const nose=part(PG.nose,skin,hi,0,-0.012,0.098); nose.rotation.x=Math.PI/2*0.82; nose.scale.set(1,1,0.75);
  const lip=part(PG.lips,mat(fem?0xc06b6b:0xb07a6a,{roughness:0.45}),hi,0,-0.047,0.083); lip.scale.set(1.15,0.32,0.55); lip.castShadow=false;
  // hair
  const st=T.style;
  const cap=part(PG.hairCap,hairM,hi,0,0.012,-0.01); cap.scale.set(0.98,1.16,1.05); cap.rotation.x=-0.32;
  if(st===0||st===2){ const tp=part(PG.hairTop,hairM,hi,0,0.075,0.002); tp.scale.set(1.04,st===2?0.36:0.46,1.1); tp.rotation.z=st===0?0.06:0; }
  if(st===1||st===4){ const fr=part(PG.hairTop,hairM,hi,0,0.07,0.012); fr.scale.set(1.06,0.42,1.08); }
  if(st===1){ part(PG.hairLong,hairM,hi,0,-0.005,-0.006).scale.set(0.98,1,0.98); }
  if(st===3){ part(PG.bun,hairM,hi,0,0.075,-0.098); part(PG.hairTop,hairM,hi,0,0.072,0).scale.set(1.04,0.4,1.08); }
  if(st===4){ [-1,1].forEach(sd=>{ const tj=joint(hi,sd*0.085,0.03,-0.05); part(PG.tie,mat(0x2f6fde),tj); const tl=part(PG.tail,hairM,tj); tl.rotation.z=sd*0.18; }); }
  if(T.glasses){ const fm=M.frame; [-1,1].forEach(sd=>{ part(PG.lens,fm,hi,sd*0.032,0.012,0.1).castShadow=false;
      const tm=part(PG.temple,fm,hi,sd*0.056,0.014,0.056); tm.rotation.y=sd*0.12; });
    part(B(0.018,0.003,0.003),fm,hi,0,0.016,0.104); }
  if(T.hat){ const hm=mat(0x2b2440,{roughness:0.8}); part(new THREE.CylinderGeometry(0.2,0.2,0.012,32),hm,hi,0,0.088,0);
    const cone=part(new THREE.ConeGeometry(0.105,0.3,28),hm,hi,0,0.235,-0.025); cone.rotation.x=-0.28;
    part(new THREE.CylinderGeometry(0.106,0.106,0.025,28,1,true),mat(0xb08a3a,{roughness:0.4,metalness:0.6}),hi,0,0.105,0); }
  // arms
  const arm=(sd)=>{
    const sh=joint(spine,sd*sx,0.43,0); part(PG.shoulder,sleeveUp,sh).scale.set(1,0.9,0.9);
    const ua=joint(sh,0,0,0); part(PG.upperArm,sleeveUp,ua);
    if(T.sleeves==='short') part(new THREE.CylinderGeometry(0.056,0.05,0.13,16),sleeveUp,ua,0,-0.07,0);
    const fa=joint(ua,0,-0.27,0); part(PG.foreArm,sleeveLo,fa);
    if(T.sleeves!=='short'){ part(PG.cuff,jacket?shirt:sleeveLo,fa,0,-0.215,0); }
    if(T.sleeves==='short' || !jacket){} 
    const hd=joint(fa,0,-0.235,0);
    part(PG.palm,skin,hd,0,-0.045,0);
    for(let f=0;f<4;f++){ const fj=joint(hd,-sd*0.004,-0.083,-0.025+f*0.0165); const fg=part(PG.finger,skin,fj); fg.scale.y=f===0||f===3?0.85:1; fj.rotation.z=-sd*0.35; fj.rotation.x=0.05; }
    const tj=joint(hd,-sd*0.012,-0.03,0.034); part(PG.thumb,skin,tj); tj.rotation.set(-0.55,0,-sd*0.35);
    return [ua,fa,hd];
  };
  const [uaL,faL,haL]=arm(-1), [uaR,faR,haR]=arm(1);
  const cup=part(PG.cup,M.ceramic,haR,-0.03,-0.07,0.03); cup.visible=false;
  const phone=part(B(0.009,0.085,0.042),M.black,haR,-0.022,-0.07,0.005); phone.visible=false;
  // legs
  const leg=(sd)=>{
    const th=joint(pelvis,sd*0.088,-0.06,0); part(PG.thigh,pants,th);
    const kn=joint(th,0,-0.41,0); part(PG.shin,pants,kn);
    part(PG.sock,sockM,kn,0,-0.39,0);
    const ft=joint(kn,0,-0.395,0); part(PG.shoe,shoeM,ft,0,-0.075,-0.01);
    return [th,kn,ft];
  };
  const [thL,knL,ftL]=leg(-1), [thR,knR,ftR]=leg(1);
  const ring=new THREE.Mesh(PG.ring,new THREE.MeshBasicMaterial({color:STATE_COL.work, transparent:true, opacity:0.7, depthWrite:false}));
  ring.rotation.x=-Math.PI/2; ring.position.y=0.02/sc; g.add(ring);
  blob(0,0,0.7,0.7,true,g,0.015,0.8);
  const w={g,pelvis,spine,neckJ,head,uaL,faL,haL,uaR,faR,haR,thL,knL,ftL,thR,knR,ftR,eyes,cup,phone,ring,seat,
    cups:0,meets:0,name:NAMES[i],role:ROLES[i],agentId:TEAM[i].id,jobId:TEAM[i].jobId,queue:[],pin:null,
    live:{status:'idle',task:'',progress:0,phase:'',tool:null,stats:null,attempts:0,toolCalls:0},cur:null,blinkT:1+Math.random()*3,blink:0,
    alertT:0,cheerT:0, // set by Office3D.alert()/cheer() on real failures / job completion (bridge.js)
    pos:new THREE.Vector3(seat.x,0,seat.z), heading:seat.h, face:seat.h, path:[], state:'work',
    timer:3+Math.random()*10, timerTotal:13, phase:Math.random()*6, speed:1.2+Math.random()*0.25, spot:null, after:null, id:i};
  g.position.copy(w.pos); workers.push(w);
}
seats.slice(0,TEAM.length-1).forEach((s,i)=>makeWorker(i,s));
makeWorker(TEAM.length-1,{x:13.4,z:1.35,h:-Math.PI/2});
const visitor=workers.pop(); visitor.npc=true; visitor.ring.visible=false; visitor.g.visible=false;
const pickables=[];
[...workers,visitor].forEach(w=>w.g.traverse(o=>{ if(o.isMesh && o.geometry!==PG.ring){ o.userData.w=w; pickables.push(o); } }));
workers.forEach(w=>{ const m=w.seat&&w.seat.monitor; if(m){ m.userData.w=w; m.userData.screen=true; pickables.push(m); } }); // tap a desk monitor → 'screen' event
const selRing=new THREE.Mesh(new THREE.RingGeometry(0.42,0.5,40), new THREE.MeshBasicMaterial({color:0xffffff, transparent:true, opacity:0.95, depthWrite:false}));
selRing.rotation.x=-Math.PI/2; selRing.visible=false; scene.add(selRing);
let selected=null;
const ray=new THREE.Raycaster(), ndc=new THREE.Vector2(); let downAt=null;
renderer.domElement.addEventListener('pointerdown',e=>{ downAt=[e.clientX,e.clientY]; });
renderer.domElement.addEventListener('pointerup',e=>{
  if(!downAt || Math.hypot(e.clientX-downAt[0],e.clientY-downAt[1])>6) return;
  const r=renderer.domElement.getBoundingClientRect();
  ndc.set((e.clientX-r.left)/r.width*2-1, -(e.clientY-r.top)/r.height*2+1);
  ray.setFromCamera(ndc,camera);
  const hit=ray.intersectObjects(pickables,false)[0];
  if(hit && hit.object.userData.screen){ const w=hit.object.userData.w; focusOn(w); emit('screen',{agentId:w.agentId,name:w.name}); return; } // monitor → zoom in + work-screen popup
  const w=hit? hit.object.userData.w : null; if(w) focusOn(w);
  select(w);
});
renderer.domElement.addEventListener('dblclick',e=>{ // double-tap on empty floor → back to the overview
  const r=renderer.domElement.getBoundingClientRect();
  ndc.set((e.clientX-r.left)/r.width*2-1, -(e.clientY-r.top)/r.height*2+1); ray.setFromCamera(ndc,camera);
  if(!ray.intersectObjects(pickables,false).length) resetView();
});
addEventListener('keydown',e=>{ if(e.key==='Home') resetView(); });
const infoEl=document.getElementById('info');
const tagsEl=document.getElementById('tags'); let tagsOn=true;
const TAG_ST={rest:'ว่าง',visit:'คุยงาน',work:'กำลังทำงาน',meet:'ประชุม',coffee:'พักกาแฟ',print:'พิมพ์เอกสาร',lounge:'พักผ่อน',phone:'คุยโทรศัพท์',walk:'กำลังเดิน',guest:'ติดต่องาน'};
const tagList=[...workers,visitor].map(w=>{
  const el=document.createElement('div'); el.className='tag';
  el.innerHTML=`<span class="bubble" hidden></span><b></b><span class="role"></span><span class="task" hidden></span><div class="barrow"><div class="bar"><i></i></div><span class="st"></span></div>`;
  el.querySelector('b').textContent=w.name; el.querySelector('.role').textContent=w.role;
  tagsEl.appendChild(el);
  const o={w,el,fill:el.querySelector('.bar i'),st:el.querySelector('.st'),task:el.querySelector('.task'),bubble:el.querySelector('.bubble'),nameEl:el.querySelector('b'),roleEl:el.querySelector('.role'),last:'',lastTask:null};
  w.tag=o; return o;
});
const tagV=new THREE.Vector3();
const TOOL_TH=Object.assign({web_search:'🔎 ค้นเว็บ',web_fetch:'🌐 อ่านหน้าเว็บ',code_execution:'⚙️ รันโค้ด',bash_code_execution:'⚙️ รันโค้ด',text_editor_code_execution:'📝 แก้ไฟล์',claude_code:'🛠️ Claude Code'},CFG.toolLabels||{});
function updateTags(t){
  const r=renderer.domElement.getBoundingClientRect();
  // ขนาดป้าย: ย่อตามความสูงของเวที (จอมือถือ 70%) และตามระยะกล้องเทียบกับมุมเริ่มต้น (ซูมเข้า → ใหญ่ขึ้นเล็กน้อย, ถอยออก → เล็กลง)
  const fs=Math.min(1,Math.max(0.7,r.height/640)), dist=camera.position.distanceTo(controls.target), home=HOME.pos.distanceTo(HOME.target);
  const ts=(fs*Math.min(1.15,Math.max(0.85,Math.sqrt(home/Math.max(1,dist))))).toFixed(3);
  tagList.forEach(o=>{
    const w=o.w, show=tagsOn && w.g.visible;
    if(!show){ o.el.style.display='none'; return; }
    tagV.set(w.pos.x, w.state==='walk'||w.state==='guest'||w.state==='coffee'||w.state==='print'||w.state==='phone'?1.95:1.55, w.pos.z).project(camera);
    if(tagV.z>1){ o.el.style.display='none'; return; }
    o.el.style.display='';
    const x=(tagV.x*0.5+0.5)*r.width, y=(-tagV.y*0.5+0.5)*r.height;
    o.el.style.transform=`translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%) scale(${ts})`;
    if(o.nameEl.textContent!==w.name) o.nameEl.textContent=w.name;
    if(o.roleEl.textContent!==w.role) o.roleEl.textContent=w.role;
    if(w.bubbleT>0){ w.bubbleT-=1/60; o.bubble.hidden=false; if(o.bubble.textContent!==w.bubbleText) o.bubble.textContent=w.bubbleText; } else o.bubble.hidden=true;
    if(MODE==='live' && !w.npc){
      const L=w.live, working=L.status==='working';
      const taskTxt = working && L.task ? L.task : '';
      if(taskTxt!==o.lastTask){ o.task.textContent=taskTxt; o.task.hidden=!taskTxt; o.lastTask=taskTxt; }
      let st, p, col;
      if(working){ const tool=L.tool&&TOOL_TH[L.tool]; st=(tool||L.phase||'กำลังทำงาน')+' '+Math.round((L.progress||0)*100)+'%'+(L.attempts>1?` · รอบ ${L.attempts}`:''); p=L.progress||0; col='#3fd1a8'; }
      else if(L.status==='paused'){ st='หยุดพัก'; p=1; col='#8b94a3'; }
      else { st= w.state==='walk' ? (DEST_TH[w.after&&w.after.state]||'กำลังเดิน') : (w.state==='visit'?'คุยงาน':'ว่าง'); p=1; col='#3fd1a8'; }
      o.fill.style.width=(p*100).toFixed(0)+'%'; o.fill.style.background=col;
      if(st!==o.last){ o.st.textContent=st; o.last=st; }
      return;
    }
    if(o.lastTask){ o.task.hidden=true; o.lastTask=''; }
    let p;
    if(w.state==='walk') p=1;
    else if(w.state==='meet') p=meeting.t0?Math.min(1,1-meeting.t/meeting.t0):0;
    else if(w.npc) p=1;
    else p=Math.min(1,Math.max(0,1-w.timer/(w.timerTotal||1)));
    o.fill.style.width=(p*100).toFixed(0)+'%';
    o.fill.style.background=STATE_COL[w.state]||STATE_COL.walk;
    const st=TAG_ST[w.state]||'';
    if(st!==o.last){ o.st.textContent=st; o.last=st; }
  });
}
// ---------- Mixamo models (per team member) ----------
// add a member here once their converted file is published next to the page
const MODEL_BASE=CFG.modelBase||'models/';
const MODEL_FILES={}; TEAM.forEach(t=>{ if(t.model&&t.model.file) MODEL_FILES[t.name]=Object.assign({},t.model,{file:MODEL_BASE+t.model.file}); });
// each scene state lists the clips to try, in order of preference; a variant is picked at random when there are several
const CLIP_FOR={
  work:['work'], walk:['walk'],
  // live mode: the seated work pose follows the real tool/phase (bridge.js → setAgent): typing · reading the screen · fast typing while code runs · thinking
  'work:type':['work'], 'work:read':['work'], 'work:code':['work'], 'work:think':['meet2','meet','lounge','sit','work'],
  cheer:['cheer'], sad:['sad'],   // optional Mixamo clips (Cheering / Defeated) — without them: a small hop / red ring + bubble
  meet:['meet','meet2','sit','lounge','work'],
  rest:['meet','meet2','lounge','sit','work'],
  lounge:['lounge','sitdrink','meet2','sit','meet','work'],
  coffee:['coffee','idle','talk'], phone:['phone','talk','idle'],
  print:['idle','coffee','talk'], guest:['idle','coffee','talk'], visit:['talk','idle','phone','coffee'],
};
// clips that sit down once and then hold the final pose
const ONCE=new Set(['sit','sitdrink']);
// which seated work pose fits the real activity reported by the server (tool first, then the phase text, then a slow typing/thinking cycle)
const TOOL_POSE={web_search:'read',web_fetch:'read',code_execution:'code',bash_code_execution:'code',text_editor_code_execution:'code',claude_code:'code'};
function workVariant(w,t){
  const L=w.live;
  if(L.tool && TOOL_POSE[L.tool]) return TOOL_POSE[L.tool];
  if(/กำลังคิด|กำลังอ่าน|กำลังตรวจ/.test(L.phase||'')) return 'think';
  return ((t + (w.id||0)*7) % 29) < 25 ? 'type' : 'think';   // long typing stretches with a short pause to think (deterministic, not random)
}
const CHAIR_HIPS=0.55, SOFA_HIPS=0.56; // seated hip height; 0.55 (not 0.52) so typing hands clear the 70 cm desk top
const ARM_LIFT=Object.assign({x:0,y:0.12,z:-0.18},CFG.typingArmLift||{}); // extra upper-arm rotation (rad) while typing — measured: hands 0.71 → 0.77 m, i.e. on the 0.74 m keyboard instead of under the desk
const hipsY=(clip,atEnd)=>{ const tr=clip&&clip.tracks.find(t=>/Hips\.position$/.test(t.name)); return tr?tr.values[atEnd?tr.values.length-2:1]:null; };
function attachProp(model,scale,re,mesh,pos){
  let bone=null; model.traverse(o=>{ if(!bone && o.isBone && re.test(o.name)) bone=o; }); if(!bone) return null;
  mesh.scale.setScalar(1/scale); mesh.position.set(pos[0]/scale,pos[1]/scale,pos[2]/scale); mesh.visible=false; bone.add(mesh); return mesh;
}
function useModel(w,gltf,cfg){
  const clips={}; gltf.animations.forEach(c=>clips[c.name]=c);
  const scale = 0.95*(cfg.height/1.78)/(hipsY(clips.walk)||hipsY(clips.coffee)||2);
  const model=THREE.SkeletonUtils.clone(gltf.scene);
  model.scale.setScalar(scale);
  model.traverse(o=>{ if(o.isMesh){ o.castShadow=true; o.receiveShadow=true; o.frustumCulled=false; o.userData.w=w; pickables.push(o);
    const ms=Array.isArray(o.material)?o.material:[o.material];
    ms.forEach(m=>{ if(!m) return; m.envMapIntensity=0.8;
      if(/hair|lash/i.test(m.name+o.name)){ m.transparent=false; m.alphaTest=0.45; m.side=THREE.DoubleSide; }
      else if(m.transparent || m.alphaMap){ // some Mixamo bodies (sniper/stalker) share an alpha PNG with the hair and arrive as BLEND → body shows through; make them opaque cut-outs instead
        m.transparent=false; m.opacity=1; m.alphaTest=0.5; m.depthWrite=true; m.needsUpdate=true; } }); } });
  w.g.add(model); w.pelvis.visible=false;
  w.model=model; w.mixer=new THREE.AnimationMixer(model); w.actions={};
  for(const name in clips){ const a=w.mixer.clipAction(clips[name]);
    if(ONCE.has(name)){ a.setLoop(THREE.LoopOnce,1); a.clampWhenFinished=true; } else a.setLoop(THREE.LoopRepeat);
    w.actions[name]=a; }
  w.scale=scale; w.clips=clips; w.clip=null; w.clipState=null; w.mDrop=0; w.dropTarget=0;
  w.mCup=attachProp(model,scale,/RightHand$/,new THREE.Mesh(PG.cup,M.ceramic),[0,0.09,0.04]);
  w.mPhone=attachProp(model,scale,/RightHand$/,new THREE.Mesh(B(0.04,0.085,0.009),M.black),[0.01,0.085,0.03]);
}
function poseModel(w,t,dt,sdt){
  const s=w.state;
  if(w.alertT>0) w.alertT-=sdt; if(w.cheerT>0) w.cheerT-=sdt;
  w.ring.material.color.set(w.alertT>0 ? 0xff5f6d : (STATE_COL[s]||STATE_COL.walk));
  const v = (s==='work' && MODE==='live' && w.live.status==='working') ? workVariant(w,t) : null;
  const key = (w.cheerT>0 && w.actions.cheer) ? 'cheer' : (w.alertT>0 && w.actions.sad) ? 'sad' : v ? 'work:'+v : s;
  if(key!==w.clipState){
    const list=CLIP_FOR[key]||CLIP_FOR[s]||['idle'];
    const opts=list.filter(n=>w.actions[n]);
    const pref=list.slice(0,2).filter(n=>w.actions[n]);   // vary between the two preferred clips
    const pick = pref.length ? pref[Math.floor(Math.random()*pref.length)] : (opts[0]||null);
    w.clipState=key;
    if(pick && pick!==w.clip){
      const next=w.actions[pick]; next.reset(); next.time=ONCE.has(pick)?0:Math.random()*next.getClip().duration*(pick==='walk'?1:0.6);
      const seatT = s==='lounge'?SOFA_HIPS : (s==='work'||s==='meet'||s==='rest')?CHAIR_HIPS : null;
      w.dropTarget = seatT===null ? 0 : seatT-(hipsY(w.clips[pick],ONCE.has(pick))??seatT/w.scale)*w.scale;
      next.play(); if(w.clip&&w.actions[w.clip]) w.actions[w.clip].crossFadeTo(next,0.45,false); w.clip=pick;
    }
  }
  if(w.actions.walk) w.actions.walk.timeScale=w.speed/1.25;
  if(w.clip && w.clip!=='walk' && w.actions[w.clip]) w.actions[w.clip].timeScale = w.clip==='work' ? (v==='read'?0.45 : v==='code'?1.6 : 1) : (v==='think'?0.6:1); // reading = slow, code running = fast typing
  w.mixer.update(sdt);
  // the Mixamo "Typing" clip keeps the hands at lap height; lift both upper arms a little after the mixer so the hands rest on the keyboard
  if(w.clip==='work' && (ARM_LIFT.x||ARM_LIFT.y||ARM_LIFT.z)){
    if(!w.armBones){ w.armBones=[]; w.model.traverse(o=>{ if(o.isBone && /(Left|Right)Arm$/.test(o.name)) w.armBones.push([o,o.name.includes('Left')?-1:1]); }); }
    for(const [o,sd] of w.armBones){ o.rotation.x+=ARM_LIFT.x; o.rotation.y+=ARM_LIFT.y*sd; o.rotation.z+=ARM_LIFT.z*sd; }
  }
  w.mDrop+=(w.dropTarget-w.mDrop)*(1-Math.exp(-dt*(ONCE.has(w.clip)?1.5:6))); w.model.position.y=w.mDrop;
  if(w.mCup) w.mCup.visible = s==='coffee' || (s==='lounge' && w.clip==='sitdrink');
  if(w.mPhone) w.mPhone.visible = (s==='phone' && w.clip==='phone') || (s==='lounge' && w.clip!=='sitdrink') || (s==='walk' && w.phoneWalk);
  w.g.position.copy(w.pos); if(w.cheerT>0 && !w.actions.cheer) w.g.position.y+=Math.abs(Math.sin(t*9))*0.12; w.g.rotation.y=w.heading;
  if(!w.npc) counts[s]=(counts[s]||0)+1;
}
if(THREE.GLTFLoader && THREE.SkeletonUtils){
  const loader=new THREE.GLTFLoader(), cache={};
  [...workers,visitor].forEach(w=>{ const cfg=MODEL_FILES[w.name]; if(!cfg) return;
    (cache[cfg.file] ||= new Promise((res,rej)=>loader.load(cfg.file,res,undefined,rej)))
      .then(g=>{ useModel(w,g,cfg); w.phoneWalk=!!cfg.phoneWalk; }).catch(err=>console.warn('Model failed, keeping the built-in figure:',cfg.file,err)); });
}
const tagBtn=document.getElementById('b-tags');
if(tagBtn) tagBtn.onclick=()=>{ tagsOn=!tagsOn; tagBtn.setAttribute('aria-pressed',tagsOn); };
function select(w){ selected=w; infoEl.hidden=!w; selRing.visible=!!w; if(w) updateInfo();
  emit('select', w ? {agentId:w.agentId, name:w.name} : null); }
document.getElementById('i-close').onclick=()=>select(null);
const STATE_TH={rest:'ว่าง นั่งที่โต๊ะ',visit:'คุยงานกับเพื่อนร่วมทีม',guest:'ติดต่อที่เคาน์เตอร์ต้อนรับ',work:'ทำงานที่โต๊ะ',meet:'อยู่ในห้องประชุม',coffee:'พักกาแฟ',print:'พิมพ์เอกสาร',lounge:'นั่งพักที่โซฟา',phone:'คุยโทรศัพท์ริมหน้าต่าง'};
const DEST_TH={rest:'กลับโต๊ะ',visit:'ไปคุยงาน',guest:'ไปที่เคาน์เตอร์ต้อนรับ',leave:'กลับไปที่ลิฟต์',work:'กลับโต๊ะ',meet:'ไปห้องประชุม',coffee:'ไปมุมกาแฟ',print:'ไปเครื่องพิมพ์',lounge:'ไปมุมพักผ่อน',phone:'ไปรับโทรศัพท์'};
function updateInfo(){
  const w=selected; if(!w) return;
  document.getElementById('i-name').textContent=w.name;
  document.getElementById('i-role').textContent=w.role;
  const st = w.state==='walk' ? 'กำลังเดิน'+(w.after?DEST_TH[w.after.state]:'') : STATE_TH[w.state];
  document.getElementById('i-state').textContent=st;
  document.getElementById('i-dot').style.background=STATE_COL[w.state]||STATE_COL.walk;
  const L=w.live, ti=document.getElementById('i-task');
  if(MODE==='live' && !w.npc){
    ti.textContent = L.status==='working' ? `งาน: ${L.task||'-'}${L.attempts>1?` (รอบที่ ${L.attempts})`:''} · ${L.phase||''} ${Math.round((L.progress||0)*100)}%${L.toolCalls?` · ใช้เครื่องมือ ${L.toolCalls} ครั้ง`:''}` : (L.status==='paused'?'หยุดพักโดยผู้ควบคุม':'ว่าง รองานใหม่');
    const S=L.stats||{}; document.getElementById('i-stats').textContent=[S.done!=null?`เสร็จแล้ว ${S.done} งาน`:'',S.cost!=null?`ต้นทุน $${(+S.cost).toFixed(3)}`:''].filter(Boolean).join(' · ');
    return;
  }
  ti.textContent='';
  document.getElementById('i-stats').textContent= w.npc ? 'นัดคุยงานกับทีม รอที่มุมพักผ่อน' : `วันนี้ดื่มกาแฟ ${w.cups} แก้ว · เข้าประชุม ${w.meets} ครั้ง`;
}

// ---------- Routing ----------
const AISLE_Z=0;
function nearestCrossX(x){ const xs=[-12,-8,-4,0,2]; return xs.reduce((a,b)=>Math.abs(b-x)<Math.abs(a-x)?b:a); }
const behind=(s)=>({x:s.x, z:s.z - 0.6*Math.cos(s.h)}); // step back from a seat (opposite of facing)
function route(w,to,door,prev){
  const from=w.pos, pts=[];
  let fx=from.x, fz=from.z;
  if(prev && prev.via && from.distanceTo(new THREE.Vector3(prev.x,0,prev.z))<0.05){
    [...prev.via].reverse().forEach(p=>pts.push(p)); fx=pts[pts.length-1].x; fz=pts[pts.length-1].z; }
  const inMeeting = fx>MR.x0 && fz<MR.z1, inMgr = inManagerRoom(fx,fz);
  if(inMgr && door===MGR_DOOR){ // already inside the manager's room and going to a spot in it: stay inside (walk along the door line, around the desk)
    const b=behind(to); pts.push({x:MGR_DOOR.x,z:fz},{x:MGR_DOOR.x,z:b.z},b,{x:to.x,z:to.z});
    return pts.map(p=>new THREE.Vector3(p.x,0,p.z));
  }
  const exitX = fx<2.5 ? nearestCrossX(fx) : (inMeeting? MEET_DOOR.x : fx);
  if(inMeeting){ const b={x:fx, z:fz-0.6*Math.cos(w.face)}; pts.push(b,{x:MEET_DOOR.x,z:b.z},MEET_DOOR); }
  else if(inMgr){ const b={x:fx, z:fz-0.6*Math.cos(w.face)}; pts.push(b,{x:MGR_DOOR.x,z:b.z},MGR_DOOR); } // step back from the desk/spot, walk to the door line, out
  else if(fx<2.5) pts.push({x:exitX,z:fz});
  pts.push({x:exitX,z:AISLE_Z});
  const entryX = to.via ? to.via[0].x : to.x<2.5 ? nearestCrossX(to.x) : (door?door.x:to.x);
  pts.push({x:entryX,z:AISLE_Z});
  if(door){ const b=behind(to); pts.push(door,{x:door.x,z:b.z},b); }
  else if(to.via) to.via.forEach(p=>pts.push(p));
  else if(to.x<2.5) pts.push({x:entryX,z:to.z});
  pts.push({x:to.x,z:to.z});
  return pts.map(p=>new THREE.Vector3(p.x,0,p.z));
}
const taken=new Set();
function freeSpot(list){ const f=list.filter(s=>!taken.has(s)); return f.length?f[Math.floor(Math.random()*f.length)]:null; }
function goTo(w,spot,state,door,say,pin){
  const prev=w.spot; if(prev) taken.delete(prev);
  w.spot=spot===w.seat?null:spot; if(w.spot) taken.add(w.spot);
  w.path=route(w,spot,door,prev); w.after={state,h:spot.h,say,pin}; w.state='walk'; // `say` = bubble on arrival (e.g. "มอบหมาย: …"), `pin` = paper for the other person's board
}
let meeting={active:false,t:30};
function startMeeting(){
  const free=workers.filter(w=>w.state==='work'&&!w.goLater).sort(()=>Math.random()-0.5).slice(0,2+Math.floor(Math.random()*3));
  if(free.length<2){ meeting.t=8; return; }
  meeting.active=true; meeting.t=40+Math.random()*15; meeting.t0=meeting.t;
  // people finish what they are doing and leave their desks one by one
  free.forEach((w,i)=>{ const s=freeSpot(meetSeats); if(!s) return; taken.add(s);
    w.goLater={spot:s,state:'meet',door:MEET_DOOR,t:i*2.5+Math.random()*2}; });
}
function endMeeting(){
  meeting.active=false; meeting.t=60+Math.random()*60;
  workers.forEach(w=>{ if(w.goLater&&w.goLater.state==='meet'){ taken.delete(w.goLater.spot); w.goLater=null; } });
  workers.filter(w=>w.state==='meet'||(w.after&&w.after.state==='meet'&&w.state==='walk'))
    .forEach((w,i)=>{ if(w.state==='walk') goTo(w,w.seat,'work',roomDoorFor(w.seat)); else w.goLater={spot:w.seat,state:'work',door:roomDoorFor(w.seat),t:i*1.8+Math.random()*1.5}; });
}
// ---------- Director: who goes where ----------
let MODE = CFG.mode==='live' ? 'live' : 'demo';
let JOBS_ACTIVE=false; // live: any job planning/running/synthesizing (bridge.js → Office3D.setActivity)
const PLACES={
  desk:   w=>({spot:w.seat, state: (MODE==='live' && w.live.status!=='working') ? 'rest' : 'work', door: roomDoorFor(w.seat)}),
  meeting:()=>{ const s=freeSpot(meetSeats); return s&&{spot:s,state:'meet',door:MEET_DOOR}; },
  coffee: ()=>{ const s=freeSpot(coffeeSpots); return s&&{spot:s,state:'coffee'}; },
  printer:()=>{ const s=freeSpot(printSpots); return s&&{spot:s,state:'print'}; },
  lounge: ()=>{ const s=freeSpot(loungeSpots); return s&&{spot:s,state:'lounge'}; },
  phone:  ()=>{ const s=freeSpot(phoneSpots); return s&&{spot:s,state:'phone'}; },
};
const placeOf=w=>({work:'desk',rest:'desk',meet:'meeting',coffee:'coffee',print:'printer',lounge:'lounge',phone:'phone'})[w.state];
function sendTo(w,place){
  if(place==='desk' && (w.state==='work'||w.state==='rest')){ w.state=PLACES.desk(w).state; return true; }
  const p=PLACES[place] && PLACES[place](w); if(!p) return false;
  goTo(w,p.spot,p.state,p.door); return true;
}
// a spot beside a colleague's desk, facing them — or, for someone sitting in the manager's room, a free spot in front of that desk
function visitSpotFor(w,tw){
  if(inManagerRoom(tw.seat.x,tw.seat.z) && mgrVisitSpots.length) return freeSpot(mgrVisitSpots) || mgrVisitSpots[0];
  const base=tw.seat, side=(w.id<tw.id?1:-1);
  return {x:base.x+0.8*side, z:base.z, h:Math.atan2(-side,0)};
}
const atDeskSoon=tw=>tw && (tw.state==='work'||tw.state==='rest'||(tw.state==='walk'&&tw.after&&(tw.after.state==='work'||tw.after.state==='rest')));
// returns true = walking now · 'wait' = the other person is away (meeting / handing out work / sofa): stay at your own desk and retry · false = drop
function runCommand(w,c){
  if(c.type==='visit'){
    const tw=byId(c.target); if(!tw||tw===w) return false;
    if(c.pin && c.pin.cancelled) return false;            // the task ended before the paper could be delivered
    if(!atDeskSoon(tw)) return 'wait';
    w.visitT=c.secs||4; w.visitWith=tw.agentId; w.waitFor=null; w.waitT=0; w.pendingSay=null; w.pendingPin=null;
    const vs=visitSpotFor(w,tw); goTo(w,vs,'visit',roomDoorFor(vs),c.say,c.pin); return true;
  }
  if(c.type==='go'){ return sendTo(w,c.place); }
  return false;
}
const VISIT_WAIT_MAX=90; // seconds: how long to keep retrying a visit / to wait if the other person stepped away just as you arrived
function decide(w){
  if(w.goLater){ w.timer=2; return; }
  if(w.pin){
    if(w.pin.until!==null && simTime>=w.pin.until) w.pin=null;
    else { if(placeOf(w)!==w.pin.place) sendTo(w,w.pin.place); w.timer=2; return; }
  }
  if(MODE==='live' && w.agentId==='captain'){ // people are waiting at the manager's desk to hand work in: come back and receive them before the next errand
    // guests = people already at his desk or walking over to hand in; those still waiting at their own desks come once he is back between errands
    const guests=workers.filter(o=>o!==w && o.visitWith===w.agentId && (o.state==='visit' || (o.state==='walk' && o.after && o.after.state==='visit')));
    if(guests.length){
      if(w.state==='work'||w.state==='rest'){ w.timer=1; return; }   // at the desk: stay until they have come and gone
      sendTo(w,'desk'); return;                                       // out on an errand: go back first, the next errand waits
    }
  }
  while(w.queue.length){
    const c=w.queue[0], r=runCommand(w,c);
    if(r==='wait'){ // they're away: keep the errand, check again in 1.5 s — meanwhile sit and work if a task is already running
      c.waited=(c.waited||0)+1; if(c.waited>VISIT_WAIT_MAX/1.5){ if(c.pin) pinOn(byId(c.target),c.pin); w.queue.shift(); continue; }
      w.timer=1.5; if(MODE==='live' && w.live.status==='working' && w.state!=='work') sendTo(w,'desk'); return;
    }
    w.queue.shift(); if(r) return;
  }
  if(MODE==='live'){
    const st=w.live.status;
    if(st==='working'){ if(w.state!=='work') sendTo(w,'desk'); w.timer=3; return; }
    if(st==='paused'){ if(w.state!=='lounge' && !sendTo(w,'lounge')) sendTo(w,'desk'); w.timer=6; return; }
    // idle (no task) → relax at the desk; a short break is allowed only while no job is planning/running/synthesizing
    const A=Object.assign({coffee:0.12,lounge:0.06,phone:0.05,printer:0.04},CFG.idleBreaks||{});
    const breaksOk = !(JOBS_ACTIVE && CFG.idleBreaksOnlyWhenTeamIdle!==false);
    if(w.state==='rest'||w.state==='work'){
      if(breaksOk){ let r=Math.random();
        for(const k of ['coffee','lounge','phone','printer']){ if(r<A[k]){ if(sendTo(w,k)) return; break; } r-=A[k]; } }
      w.state='rest'; w.timer=15+Math.random()*15; w.timerTotal=w.timer; return;
    }
    if(JOBS_ACTIVE && ['coffee','lounge','phone','print'].includes(w.state)){ sendTo(w,'desk'); return; } // a job started while on a break → back to the desk
    sendTo(w,'desk'); return;
  }
  const r=Math.random();
  if(w.state==='work'){
    if(r<0.25){ const s=freeSpot(coffeeSpots); if(s){goTo(w,s,'coffee'); return;} }
    else if(r<0.40){ const s=freeSpot(printSpots); if(s){goTo(w,s,'print'); return;} }
    else if(r<0.52){ const s=freeSpot(loungeSpots); if(s){goTo(w,s,'lounge'); return;} }
    else if(r<0.62){ const s=freeSpot(phoneSpots); if(s){goTo(w,s,'phone'); return;} }
    w.timer=15+Math.random()*20; w.timerTotal=w.timer;
  } else if(w.state!=='meet') goTo(w,w.seat,'work',roomDoorFor(w.seat));
}

// ---------- Simulation ----------
let speed=1, paused=false, simTime=9*3600;
const clockEl=document.getElementById('clock');
const counts={work:0,meet:0,coffee:0,print:0,walk:0,lounge:0,phone:0,rest:0,visit:0};
const tmpV=new THREE.Vector3();
function step(dt){
  simTime+=dt*60;
  if(simTime>=18*3600){ simTime=9*3600; workers.forEach(w=>{w.cups=0; w.meets=0;}); }
  if(MODE==='demo'){ meeting.t-=dt; if(meeting.t<=0){ meeting.active?endMeeting():startMeeting(); } }
  else if(meeting.active && !workers.some(w=>w.state==='meet'||(w.after&&w.after.state==='meet'))) meeting.active=false;
  workers.forEach(w=>{
    w.phase+=dt*(w.state==='walk'?w.speed*5.6:1);
    if(w.goLater && w.state!=='walk'){ w.goLater.t-=dt;
      if(w.goLater.t<=0){ const g=w.goLater; w.goLater=null; goTo(w,g.spot,g.state,g.door); } }
    if(w.state==='walk'){
      if(walkStep(w,dt)){ { w.state=w.after.state; w.face=w.after.h;
          if(w.state==='visit'){ const tw=byId(w.visitWith), here=tw&&(tw.state==='work'||tw.state==='rest');
            if(here){ if(w.after.say){ w.bubbleText=w.after.say; w.bubbleT=Math.max(3,(w.visitT||3)+0.5)*60; } if(w.after.pin) pinOn(tw,w.after.pin); }
            else { w.waitFor=w.visitWith; w.waitT=0; w.pendingSay=w.after.say||null; w.pendingPin=w.after.pin||null; } }
          else if(w.after.say){ w.bubbleText=w.after.say; w.bubbleT=3*60; }
          if(w.state==='coffee') w.cups++; if(w.state==='meet') w.meets++;
          w.timer = w.state==='work'?18+Math.random()*20 : w.state==='coffee'?12+Math.random()*12 : w.state==='print'?5+Math.random()*4
                  : w.state==='lounge'?20+Math.random()*20 : w.state==='phone'?12+Math.random()*14
                  : w.state==='rest'?15+Math.random()*15 : w.state==='visit'?(w.visitT||4) : 999; w.timerTotal=w.timer;
          if(MODE==='live' && w.state==='work') w.timer=3;
          if(w.state==='visit' && w.waitFor) w.timer=VISIT_WAIT_MAX+1; // waiting for them to come back — the talk timer starts when they do
          if(w.queue.length || w.pin) w.timer=Math.min(w.timer,0.6);
          if(MODE==='live' && w.state==='meet' && !w.pin) w.timer=Math.min(w.timer,1);
          // arrived at a break spot after a job started (or while still holding a task) → re-decide at once and head back to the desk
          if(MODE==='live' && !w.pin && ['coffee','lounge','phone','print'].includes(w.state) && (JOBS_ACTIVE || w.live.status==='working')) w.timer=Math.min(w.timer,0.6); }
      }
    } else if(w.state!=='meet' || w.pin || w.queue.length || MODE==='live'){
      if(w.state==='visit' && w.waitFor){ // standing at the other person's desk: start talking the moment they are back; leave after VISIT_WAIT_MAX s
        const tw=byId(w.waitFor);
        if(tw && (tw.state==='work'||tw.state==='rest')){ w.waitFor=null; w.timer=w.visitT||4; if(w.pendingSay){ w.bubbleText=w.pendingSay; w.bubbleT=(w.timer+0.5)*60; w.pendingSay=null; } if(w.pendingPin){ pinOn(tw,w.pendingPin); w.pendingPin=null; } }
        else { w.waitT+=dt; if(w.waitT>VISIT_WAIT_MAX){ if(w.pendingPin) pinOn(tw,w.pendingPin); w.waitFor=null; w.pendingSay=null; w.pendingPin=null; w.timer=0.3; } }
      }
      w.timer-=dt; if(w.timer<=0) decide(w); }
    let dh=w.face-w.heading; dh=Math.atan2(Math.sin(dh),Math.cos(dh)); w.heading+=dh*Math.min(1,dt*8);
  });
  updateVisitor(dt);
}
const V3=(x,z)=>new THREE.Vector3(x,0,z);
const vis={phase:'away', t:12, spot:null};
// ---------- Walking with lanes and collision avoidance ----------
// Rules: keep left on long stretches · dodge sideways (side chosen once per encounter, so nobody spins)
// · slow for someone standing in the way · if no progress for a moment, walk through (never get stuck)
const SEATED=new Set(['work','meet','lounge','rest']);
const AVOID_R=1.05;
let GAIN=2.5, GAIN_R=1.4, SLOW_R=0.9;
const crowd=()=> visitor.g.visible ? workers.concat(visitor) : workers;
function walkStep(w,dt){
  if(!w.path.length) return true;
  const tgt=w.path[0], last=w.path.length===1;
  if(w.lane===undefined){ w.lane=0.2+Math.random()*0.22; w.sideS=0; w.sides={}; w.stuckT=0; w.ghostT=0; }
  let tx=tgt.x, tz=tgt.z, dx=tx-w.pos.x, dz=tz-w.pos.z, dist=Math.hypot(dx,dz);
  if(!last && dist>1.2){ const ux=dx/dist, uz=dz/dist; tx+=uz*w.lane; tz+=-ux*w.lane; dx=tx-w.pos.x; dz=tz-w.pos.z; dist=Math.hypot(dx,dz); }
  if(dist<1e-4){ w.path.shift(); w.lastTgt=null; return !w.path.length; }
  const ux=dx/dist, uz=dz/dist, lx=uz, lz=-ux;
  // progress watchdog
  if(w.lastTgt===tgt && dist > w.lastDist - w.speed*dt*0.08) w.stuckT+=dt; else w.stuckT=Math.max(0,w.stuckT-dt*0.5);
  w.lastTgt=tgt; w.lastDist=dist;
  if(w.stuckT>2.0){ w.ghostT=1.6; w.stuckT=0; }
  const ghost=w.ghostT>0; if(ghost) w.ghostT-=dt;
  let sideT=0, slow=1;
  const nearEnd = last && dist<0.9;
  if(!ghost && !nearEnd){
    for(const o of crowd()){
      if(o===w || SEATED.has(o.state)){ if(o!==w) delete w.sides[o.id]; continue; }
      const ox=o.pos.x-w.pos.x, oz=o.pos.z-w.pos.z, r=Math.hypot(ox,oz);
      const R = o.state==='walk' ? AVOID_R : AVOID_R*GAIN_R;
      if(r>R || r<1e-4){ delete w.sides[o.id]; continue; }
      const ahead=(ox*ux+oz*uz)/r;
      if(ahead<-0.15) continue;                                       // behind me
      const sameWay = o.state==='walk' && ((o.dirx||0)*ux+(o.dirz||0)*uz)>0.6;
      if(sameWay && ahead<0.6) continue;                              // side by side, same direction
      if(w.sides[o.id]===undefined){                                  // decide once which way to step
        const lat=ox*lx+oz*lz;
        w.sides[o.id] = lat>0.08 ? -1 : lat<-0.08 ? 1 : (o.sides && o.sides[w.id]!==undefined ? o.sides[w.id] : 1);
      }
      sideT += w.sides[o.id]*(R-r)/R*(0.6+ahead)*GAIN;
      if(ahead>0.6 && r<SLOW_R) slow=Math.min(slow, Math.max(0.3,(r-0.35)/(SLOW_R-0.35)));
    }
  }
  sideT=Math.max(-1,Math.min(1,sideT));
  w.sideS += (sideT-w.sideS)*Math.min(1,dt*5);
  const mv=w.speed*dt*slow;
  w.dirx=ux; w.dirz=uz;
  if(dist<=mv){ w.pos.set(last?tgt.x:tx,0,last?tgt.z:tz); w.path.shift(); w.lastTgt=null; return !w.path.length; }
  w.pos.x+=ux*mv+lx*w.sideS*w.speed*dt*0.85; w.pos.z+=uz*mv+lz*w.sideS*w.speed*dt*0.85;
  w.face=Math.atan2(ux+lx*w.sideS*0.3, uz+lz*w.sideS*0.3);
  return false;
}
function vMove(dt){
  const w=visitor; walkStep(w,dt);
  let dh=w.face-w.heading; dh=Math.atan2(Math.sin(dh),Math.cos(dh)); w.heading+=dh*Math.min(1,dt*8);
  return !w.path.length;
}
function updateVisitor(dt){
  const w=visitor; vis.t-=dt;
  elevator.open += Math.sign(elevator.target-elevator.open)*Math.min(Math.abs(elevator.target-elevator.open),dt*1.1);
  switch(vis.phase){
    case 'away':
      if(CFG.visitor && CFG.visitor.enabled===false) break;
      if(vis.t<=0){ const s=freeSpot(loungeSpots); if(!s){ vis.t=10; break; }
        vis.spot=s; taken.add(s); w.pos.set(13.4,0,1.35); w.face=w.heading=-Math.PI/2; w.g.visible=true; w.state='guest';
        elevator.target=1; vis.phase='doorOpen'; vis.t=1.1; }
      break;
    case 'doorOpen':
      if(vis.t<=0){ w.path=[V3(12.5,1.35),V3(11.95,0.4),V3(11.95,-0.7)]; w.state='walk'; w.after={state:'guest'}; vis.phase='toDesk'; }
      break;
    case 'toDesk':
      if(w.pos.x<12.2) elevator.target=0;
      if(vMove(dt)){ w.state='guest'; w.face=-Math.PI/2; vis.phase='greet'; vis.t=6; }
      break;
    case 'greet':
      vMove(dt);
      if(vis.t<=0){ w.path=[V3(11.95,0.7),V3(6.2,0.7),...vis.spot.via.map(p=>V3(p.x,p.z)),V3(vis.spot.x,vis.spot.z)];
        w.state='walk'; w.after={state:'lounge'}; vis.phase='toLounge'; }
      break;
    case 'toLounge':
      if(vMove(dt)){ w.state='lounge'; w.face=vis.spot.h; vis.phase='wait'; vis.t=18+Math.random()*12; }
      break;
    case 'wait':
      vMove(dt);
      if(vis.t<=0){ w.path=[...[...vis.spot.via].reverse().map(p=>V3(p.x,p.z)),V3(6.2,0.7),V3(12.4,1.35)];
        taken.delete(vis.spot); w.state='walk'; w.after={state:'leave'}; vis.phase='toLift'; }
      break;
    case 'toLift':
      if(vMove(dt)){ w.state='guest'; w.face=Math.PI/2; elevator.target=1; vis.phase='liftOpen'; vis.t=1.1; }
      break;
    case 'liftOpen':
      vMove(dt);
      if(vis.t<=0){ w.path=[V3(13.4,1.35)]; w.state='walk'; w.after={state:'leave'}; vis.phase='enter'; }
      break;
    case 'enter':
      if(vMove(dt)){ w.g.visible=false; elevator.target=0; vis.phase='away'; vis.t=45+Math.random()*30;
        if(selected===w) select(null); }
      break;
  }
}
const S=Math.sin, mx=Math.max;
const NEUTRAL={py:0.935,pry:0,prz:0,spx:0.02,spy:0,spz:0,nkx:0,hdx:0,hdy:0,hdz:0,
  uaLx:0.05,uaLz:-0.07,faLx:-0.12,haLx:0,uaRx:0.05,uaRz:0.07,faRx:-0.12,haRx:0,
  thLx:0,thLz:0,thRx:0,thRz:0,knLx:0.03,knRx:0.03,ftLx:0,ftRx:0};
const JMAP=[['py','pelvis','py'],['pry','pelvis','y'],['prz','pelvis','z'],['spx','spine','x'],['spy','spine','y'],['spz','spine','z'],
  ['nkx','neckJ','x'],['hdx','head','x'],['hdy','head','y'],['hdz','head','z'],
  ['uaLx','uaL','x'],['uaLz','uaL','z'],['faLx','faL','x'],['haLx','haL','x'],['uaRx','uaR','x'],['uaRz','uaR','z'],['faRx','faR','x'],['haRx','haR','x'],
  ['thLx','thL','x'],['thLz','thL','z'],['thRx','thR','x'],['thRz','thR','z'],['knLx','knL','x'],['knRx','knR','x'],['ftLx','ftL','x'],['ftRx','ftR','x']];
function pose(w,t,dt,sdt){
  if(w.model){ poseModel(w,t,dt,sdt); return; }
  const s=w.state==='rest'?'lounge':w.state==='visit'?'guest':w.state, p=w.phase, T=Object.assign({},NEUTRAL), id=w.id;
  w.ring.material.color.set(STATE_COL[w.state]||STATE_COL.walk);
  w.cup.visible = s==='coffee'; w.phone.visible = s==='phone'||s==='lounge';
  let yawOff=0;
  if(s==='walk'){
    const a=S(p), c=Math.cos(p);
    T.py=0.915+0.022*Math.cos(2*p);
    T.pry=0.1*a; T.prz=0.035*c; T.spy=-0.17*a; T.spx=0.06; T.hdx=-0.04; T.hdy=0.07*a;
    T.thLx=0.46*a-0.04; T.thRx=-0.46*a-0.04;
    T.knLx=0.08+1.05*Math.pow(mx(0,-c),1.3); T.knRx=0.08+1.05*Math.pow(mx(0,c),1.3);
    T.ftLx=0.32*a; T.ftRx=-0.32*a;
    T.uaLx=-0.4*a+0.04; T.uaRx=0.4*a+0.04;
    T.faLx=-0.18-0.42*mx(0,a); T.faRx=-0.18-0.42*mx(0,-a);
  } else if(s==='work'||s==='meet'||s==='lounge'){
    T.py=0.6; T.thLx=T.thRx=-1.42; T.thLz=-0.07; T.thRz=0.07; T.knLx=1.27; T.knRx=1.34; T.ftLx=T.ftRx=-0.05;
    if(s==='work'){
      const cyc=(t*0.09+id*0.37)%1, ty=S(t*16+id)*0.045, ty2=S(t*13+id*2)*0.045;
      T.spx=0.22; T.hdx=0.04; T.hdy=S(t*0.7+id)*0.1+S(t*2.3+id)*0.03;
      T.uaLx=-0.9; T.uaLz=-0.04; T.faLx=-0.75+ty; T.haLx=0.45;
      T.uaRx=-0.9; T.uaRz=0.04; T.faRx=-0.75+ty2; T.haRx=0.45;
      if(cyc<0.045){ // stretch
        T.spx=-0.16; T.hdx=-0.3; T.uaLx=T.uaRx=-2.95; T.uaLz=-0.25; T.uaRz=0.25; T.faLx=T.faRx=-0.35;
      } else if(cyc<0.16){ // lean back and think, hand on chin
        T.spx=-0.1; T.hdx=-0.06; T.hdy=0.2; T.uaLx=-0.25; T.faLx=-1.45; T.uaLz=0.05;
        T.uaRx=-0.55; T.uaRz=0.15; T.faRx=-2.25; T.haRx=0.3;
      }
    } else if(s==='meet'){
      const talk=S(t*0.6+id*2.1)>0.55;
      T.spx=0.05; T.hdy=S(t*0.45+id*1.7)*0.55; T.hdx=talk?-0.04:0.06*S(t*2.8+id);
      T.uaLx=-0.62; T.faLx=-1.0; T.uaLz=-0.03; T.uaRx=-0.62; T.faRx=-1.0; T.uaRz=0.03;
      if(talk){ T.uaRx=-0.85+S(t*3.7+id)*0.2; T.faRx=-1.35+S(t*5.1)*0.3; T.haRx=S(t*4)*0.2; T.spx=0.1; }
    } else {
      T.py=0.62; T.thLx=-1.3; T.thRx=-1.18; T.knLx=1.12; T.knRx=0.95; T.ftLx=-0.2; T.ftRx=-0.25;
      T.spx=-0.24; T.hdx=0.48; T.hdy=0.05*S(t*0.3+id);
      T.uaLx=-0.3; T.faLx=-1.38; T.uaLz=0.06; T.uaRx=-0.36; T.faRx=-1.32+S(t*2+id)*0.04; T.uaRz=-0.04; T.haRx=0.45;
    }
  } else { // standing
    const ws=S(t*0.35+id);
    T.prz=0.03*ws; T.knLx=0.03+0.13*mx(0,ws); T.knRx=0.03+0.13*mx(0,-ws); T.py=0.935-0.006*Math.abs(ws);
    T.hdy=S(t*0.4+id)*0.25;
    if(s==='coffee'){
      const sip=Math.pow(mx(0,S(t*0.7+id)),3);
      T.uaLx=-0.28; T.faLx=-1.25; T.uaLz=0.06;
      T.uaRx=-0.38-sip*0.45; T.faRx=-1.45-sip*0.6; T.uaRz=0.12; T.hdx=-sip*0.18;
    } else if(s==='guest'){
      T.uaLx=-0.12; T.uaLz=0.08; T.faLx=-0.95; T.uaRx=-0.12; T.uaRz=-0.08; T.faRx=-0.95; T.hdy=0;
    } else if(s==='phone'){
      yawOff=S(t*0.45+id)*0.5;
      T.uaRx=-0.4; T.uaRz=0.55; T.faRx=-2.45; T.haRx=0.25; T.hdz=-0.14; T.hdy=0;
      T.uaLx=0.12; T.uaLz=-0.5; T.faLx=-1.45;
    } else { // printer
      T.spx=0.2; T.hdx=0.3; T.hdy=0;
      T.uaLx=-0.5; T.faLx=-0.75+S(t*3)*0.12; T.uaRx=-0.5; T.faRx=-0.75-S(t*3)*0.12;
    }
  }
  // breathing & blinking
  const br=S(t*1.7+id)*0.012; w.spine.scale.set(1+br,1,1+br*1.4);
  w.blinkT-=dt; if(w.blinkT<0){ w.blink=0.13; w.blinkT=2+Math.random()*4; }
  if(w.blink>0) w.blink-=dt;
  const ey = w.blink>0 ? 0.12 : 1; w.eyes[0].scale.y=w.eyes[1].scale.y=ey;
  // ease joints toward the target pose
  if(!w.cur){ w.cur=Object.assign({},T); }
  const k=1-Math.exp(-dt*(s==='walk'?24:6));
  for(const [key,obj,ax] of JMAP){
    w.cur[key]+=(T[key]-w.cur[key])*k;
    if(ax==='py') w[obj].position.y=w.cur[key]; else w[obj].rotation[ax]=w.cur[key];
  }
  if(w.alertT>0) w.alertT-=sdt; if(w.cheerT>0) w.cheerT-=sdt;
  if(w.alertT>0) w.ring.material.color.set(0xff5f6d);
  w.g.position.copy(w.pos); if(w.cheerT>0) w.g.position.y+=Math.abs(Math.sin(t*9))*0.12; w.g.rotation.y=w.heading+yawOff;
  if(!w.npc) counts[w.state]=(counts[w.state]||0)+1;
}

function resize(){ const r=stage.getBoundingClientRect(); renderer.setPixelRatio(fitPixelRatio(r.width,r.height)); renderer.setSize(r.width,r.height,false);
  camera.aspect=r.width/r.height; camera.fov = r.width<600?52:38; camera.updateProjectionMatrix(); }
addEventListener('resize',resize); resize();

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const rotBtn=document.getElementById('b-rotate');
if(reduce){ controls.autoRotate=false; if(rotBtn) rotBtn.setAttribute('aria-pressed','false'); }

let last=performance.now(), t=0;
function frame(now){
  const dt=Math.min(0.05,(now-last)/1000); last=now;
  if(!paused){ for(let i=0;i<speed;i++) step(dt); t+=dt*speed; }
  for(const k in counts) counts[k]=0;
  const sdt=paused?0:dt*speed;
  workers.forEach(w=>pose(w,t,dt,sdt));
  if(visitor.g.visible) pose(visitor,t,dt,sdt);
  for(const k in counts){ const el=document.getElementById('c-'+k); if(el) el.textContent=counts[k]; }
  let hour=simTime/3600;
  if(MODE==='live' && CFG.clock!=='sim'){ const d=new Date(); hour=d.getHours()+d.getMinutes()/60; }
  updateSun(Math.min(18,Math.max(9,hour)));
  clockEl.textContent=String(Math.floor(hour)).padStart(2,'0')+':'+String(Math.floor(hour*60)%60).padStart(2,'0');
  const printing=workers.some(w=>w.state==='print');
  printLight.color.setHex(printing && S(t*8)>0 ? 0x5bf0b0 : 0x2b9a76);
  tvScreen.material = (meeting.active || workers.some(w=>w.state==='meet')) ? tvOn : M.screenOff;
  screens[0].offset.y = screens[3].offset.y = -((t*0.02)%1);
  updateDetails(dt*(paused?0:speed), t, hour, printing);
  updateTags(t);
  if(selected){ selRing.position.set(selected.pos.x,0.025,selected.pos.z); updateInfo(); }
  if(camTween){ const k=Math.min(1,(now-camTween.start)/1000/camTween.dur), e=k<0.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
    camera.position.lerpVectors(camTween.p0,camTween.p1,e); controls.target.lerpVectors(camTween.g0,camTween.g1,e); if(k>=1) camTween=null; }
  controls.update(); renderer.render(scene,camera);
  requestAnimationFrame(frame);
}
document.getElementById('loading').hidden=true;
requestAnimationFrame(frame);


// ---------- Public API: window.Office3D ----------
const listeners={};
function emit(ev,data){ (listeners[ev]||[]).forEach(f=>{ try{ f(data); }catch(e){ console.error(e); } });
  if(window.parent!==window) try{ window.parent.postMessage({type:'office3d:'+ev, data}, '*'); }catch(e){} }
function byId(id){ if(id==null) return null; id=String(id);
  return workers.find(w=>w.agentId===id) || workers.find(w=>w.jobId===id) || workers.find(w=>w.name===id) || null; }
// ---------- Desk pinboards: the papers the captain pinned (one per active task) ----------
const BOARD_FONT='"IBM Plex Sans Thai","Noto Sans Thai",system-ui,sans-serif';
const noteReg=new Map(); // noteId -> note object (so an unpin can cancel a paper that is still on its way)
function drawBoard(b){
  const {ctx,canvas:c}=b, W=256, H=192; ctx.setTransform(c.width/W,0,0,c.height/H,0,0);
  ctx.fillStyle='#c9a66b'; ctx.fillRect(0,0,W,H);                       // cork
  for(let i=0;i<260;i++){ ctx.fillStyle=`rgba(90,60,30,${0.05+Math.random()*0.08})`; ctx.fillRect(Math.random()*W,Math.random()*H,2,2); }
  ctx.fillStyle='#5a4028'; ctx.fillRect(0,0,W,22); ctx.fillStyle='#f4e9d8'; ctx.font='600 14px '+BOARD_FONT; ctx.textBaseline='middle'; ctx.textAlign='left';
  ctx.fillText('งานที่ได้รับมอบหมาย', 8, 11); ctx.textAlign='right'; ctx.fillText(b.notes.length? b.notes.length+' ใบ':'', W-8, 11); ctx.textAlign='left';
  if(!b.notes.length){ ctx.fillStyle='rgba(60,40,20,.55)'; ctx.font='500 15px '+BOARD_FONT; ctx.fillText('— ว่าง —', 12, 60); }
  b.notes.slice(0,3).forEach((n,i)=>{
    const y=30+i*52, tilt=(i%2?-1:1)*0.03;
    ctx.save(); ctx.translate(12,y); ctx.rotate(tilt);
    ctx.fillStyle='rgba(0,0,0,.18)'; ctx.fillRect(3,3,232,46); ctx.fillStyle=n.attempts>1?'#ffd9a8':'#fff3a8'; ctx.fillRect(0,0,232,46);
    ctx.fillStyle='#d9332b'; ctx.beginPath(); ctx.arc(116,5,4,0,Math.PI*2); ctx.fill(); // pin
    ctx.fillStyle='#2a2118'; ctx.font='600 15px '+BOARD_FONT; ctx.fillText(String(n.title||'').slice(0,26), 8, 18);
    ctx.fillStyle='#6b5a44'; ctx.font='12px '+BOARD_FONT; ctx.fillText((n.attempts>1?`รอบที่ ${n.attempts} · `:'')+(n.from&&n.from!=='captain'?`จาก ${n.from}`:'จากกัปตัน'), 8, 36);
    ctx.restore();
  });
  b.tex.needsUpdate=true;
}
function pinOn(w,note){ const b=w&&w.seat&&w.seat.board; if(!b||!note||note.cancelled) return false;
  b.notes=b.notes.filter(n=>n.id!==note.id); b.notes.unshift(note); noteReg.set(note.id,note); drawBoard(b); return true; }
function unpinFrom(w,noteId){ const reg=noteReg.get(noteId); if(reg) reg.cancelled=true; noteReg.delete(noteId); // also cancels a paper still on its way
  const b=w&&w.seat&&w.seat.board; if(!b) return false; const n=b.notes.length; b.notes=b.notes.filter(x=>x.id!==noteId); if(b.notes.length!==n) drawBoard(b); return true; }
seats.forEach(s=>{ if(s.board) drawBoard(s.board); });
function drawPlate(seat,name,role){
  const p=seat&&seat.plate; if(!p || (p.name===name && p.role===role)) return;
  p.name=name; p.role=role; const {ctx,canvas:c}=p, W=256, H=64; ctx.setTransform(c.width/W,0,0,c.height/H,0,0);
  ctx.fillStyle='#141922'; ctx.fillRect(0,0,W,H); ctx.fillStyle='#f5b942'; ctx.fillRect(0,0,6,H);
  ctx.textBaseline='middle'; ctx.textAlign='left';
  let size=26; ctx.font=`600 ${size}px ${BOARD_FONT}`; while(size>14 && ctx.measureText(name||'').width>W-24){ size-=2; ctx.font=`600 ${size}px ${BOARD_FONT}`; }
  ctx.fillStyle='#f3f6fb'; ctx.fillText(name||'',16,role?24:32);
  if(role){ ctx.font=`500 14px ${BOARD_FONT}`; ctx.fillStyle='#9fb0c8'; ctx.fillText(String(role).slice(0,30),16,48); }
  p.tex.needsUpdate=true;
}
workers.forEach(w=>drawPlate(w.seat,w.name,w.role));
// live desk monitors: one canvas texture per team member, replacing the static screen art on their own monitor
const liveScreens={};
function screenFor(w){
  if(!w||!w.seat||!w.seat.monitor) return null;
  let e=liveScreens[w.agentId];
  if(!e){ const c=document.createElement('canvas'); c.width=1024; c.height=600; // 2× the logical 512×300 so text stays crisp when the camera zooms in on a desk
    const tex=new THREE.CanvasTexture(c); tex.encoding=THREE.sRGBEncoding; tex.anisotropy=maxAniso; tex.minFilter=THREE.LinearMipmapLinearFilter; tex.generateMipmaps=true;
    w.seat.monitor.material=new THREE.MeshBasicMaterial({map:tex}); e=liveScreens[w.agentId]={canvas:c,tex}; }
  return e;
}
function kick(w){
  if(w.state!=='walk'){ if(!w.goLater) w.timer=0; return; }
  // released from the meeting room while still walking there, with visits queued (the captain handing out the plan): turn round now
  if(MODE==='live' && !w.pin && w.queue.length && w.after && w.after.state==='meet'){ decide(w); return; }
  // got a task while heading for a break: turn round and go back to the desk
  if(MODE==='live' && w.live.status==='working' && !w.pin && !w.queue.length && w.after && !['work','visit','meet'].includes(w.after.state)) goTo(w,w.seat,'work',roomDoorFor(w.seat));
}
const modeEl=document.getElementById('mode'), modeText=document.getElementById('mode-text');
const Office3D={
  version:'1.0',
  /** 'live' = follow real agent status, 'demo' = people wander on their own */
  setMode(m){ MODE = m==='live'?'live':'demo'; modeEl.dataset.state=MODE; modeText.textContent = MODE==='live'?'เชื่อมต่อระบบแล้ว':'โหมดสาธิต';
    document.getElementById('clock-label').textContent = MODE==='live'?'เวลาจริง':'เวลาในออฟฟิศ'; workers.forEach(kick); },
  getMode(){ return MODE; },
  /** connection label shown in the panel: 'live' | 'reconnecting' | 'demo' (+ optional text) */
  setConnection(state,text){ modeEl.dataset.state=state; if(text) modeText.textContent=text; },
  /** update one agent: {status:'idle'|'working'|'paused', name, role, task, progress(0..1), phase, tool, stats:{done,cost}} */
  setAgent(id,patch={}){
    const w=byId(id); if(!w) return false;
    const before=w.live.status;
    for(const k of ['status','task','progress','phase','tool','stats','attempts','toolCalls']) if(k in patch && patch[k]!==undefined) w.live[k]=patch[k];
    if(patch.name) w.name=patch.name; if(patch.role) w.role=patch.role;
    if(MODE==='live' && w.live.status!==before) kick(w);
    return true;
  },
  /** walk from one agent to another's desk, stay `secs` (saying `say` on arrival), then carry on — e.g. the captain handing out work, or someone handing it in.
   *  `pin` = {id, title, attempts, from}: a paper pinned on the other person's desk board when the visitor arrives (the captain's assignment) */
  visit(fromId,toId,secs=4,say=null,pin=null){ const w=byId(fromId), tw=byId(toId); if(!w||!tw||w===tw) return false;
    if(pin) noteReg.set(pin.id,pin);
    w.queue.push({type:'visit',target:tw.agentId,secs,say,pin}); if(w.queue.length>8) w.queue.shift(); kick(w); return true; },
  /** put / remove a task paper on someone's desk board without walking (snapshot, task done/cancelled/handed over) */
  pin(id,note){ return pinOn(byId(id),note); },
  unpin(id,noteId){ return unpinFrom(byId(id),noteId); },
  boardNotes(id){ const w=byId(id); return w&&w.seat&&w.seat.board ? w.seat.board.notes.map(n=>Object.assign({},n)) : []; },
  /** send someone to a place: 'desk' | 'meeting' | 'coffee' | 'printer' | 'lounge' | 'phone' */
  goTo(id,place){ const w=byId(id); if(!w||!PLACES[place]) return false; w.queue.push({type:'go',place}); kick(w); return true; },
  /** keep someone at a place for `secs` (null = until release) */
  hold(id,place,secs=null){ const w=byId(id); if(!w||!PLACES[place]) return false; w.pin={place,until:secs==null?null:simTime+secs*60}; kick(w); return true; },
  release(id){ const w=byId(id); if(!w) return false; w.pin=null; kick(w); return true; },
  /** call several people into the meeting room for `secs` */
  gather(ids,secs=30){ (ids||[]).forEach((id,i)=>{ const w=byId(id); if(!w) return; w.goLater=null;
      setTimeout(()=>Office3D.hold(id,'meeting',secs),i*1500); }); return true; },
  /** short speech bubble above someone's name tag */
  say(id,text,secs=3){ const w=byId(id); if(!w) return false; w.bubbleText=String(text); w.bubbleT=secs*60; return true; },
  /** live: tell the director whether any job is planning/running/synthesizing — while true nobody takes a coffee/sofa/phone break */
  setActivity(on){ JOBS_ACTIVE=!!on; if(on) workers.forEach(w=>{ if(['coffee','lounge','phone','print'].includes(w.state) && !w.pin) kick(w); }); },
  /** something went wrong for this person (task failed / cancelled / job failed): red ring for `secs` (+ 'sad' clip if the model has one) */
  alert(id,secs=4){ const w=byId(id); if(!w) return false; w.alertT=secs; return true; },
  /** short celebration for several people (job completed): hop in place, or the 'cheer' clip if the model has one */
  cheer(ids,secs=2.5){ (ids||[]).forEach(id=>{ const w=byId(id); if(w) w.cheerT=secs; }); return true; },
  /** desk name plate: the real name/role from the server (bridge.js calls this on snapshot / agent.updated) */
  setDeskLabel(id,name,role){ const w=byId(id); if(!w) return false; drawPlate(w.seat,String(name||w.name),String(role||w.role||'')); return true; },
  /** canvas drawn by the page (bridge.js) and shown on this person's desk monitor; call screenDirty() after drawing */
  screenCanvas(id){ const e=screenFor(byId(id)); return e?e.canvas:null; },
  screenDirty(id){ const w=byId(id), e=w&&liveScreens[w.agentId]; if(e) e.tex.needsUpdate=true; },
  _debug(id){ const w=byId(id); return w&&{state:w.state,pos:w.pos.toArray(),path:w.path.map(v=>[v.x,v.z]),after:w.after,timer:w.timer,ghost:w.ghostT,stuck:w.stuckT,pin:w.pin,queue:w.queue}; },
  _armLift(x,y,z){ ARM_LIFT.x=+x||0; ARM_LIFT.y=+y||0; ARM_LIFT.z=+z||0; return Object.assign({},ARM_LIFT); },
  _bones(id){ const w=byId(id); if(!w||!w.model) return null; const v=new THREE.Vector3(), out={state:w.state,clip:w.clip,scale:+w.scale.toFixed(4),drop:+w.mDrop.toFixed(3)};
    w.model.traverse(o=>{ if(!o.isBone) return; const m=o.name.match(/(Hips|RightHand|LeftHand|Head|RightFoot|LeftUpLeg|RightForeArm)$/); if(m){ o.getWorldPosition(v); out[m[1]]=+v.y.toFixed(3); } }); return out; },
  _monitorXY(id){ const w=byId(id); if(!w||!w.seat||!w.seat.monitor) return null; const v=new THREE.Vector3(); w.seat.monitor.getWorldPosition(v); v.project(camera);
    const r=renderer.domElement.getBoundingClientRect(); return {x:r.left+(v.x*0.5+0.5)*r.width, y:r.top+(-v.y*0.5+0.5)*r.height, visible:v.z<1}; },
  agents(){ return workers.map(w=>({id:w.agentId,name:w.name,role:w.role,state:w.state,live:Object.assign({},w.live),x:+w.pos.x.toFixed(2),z:+w.pos.z.toFixed(2)})); },
  select(id){ const w=byId(id); select(w); if(w) focusOn(w); },
  /** text on the sign above the manager's room door (bridge.js sets "<captain name> · <role>") */
  setManagerLabel(text){ if(MG&&MG.drawSign){ MG.drawSign(String(text||'')); return true; } return false; },
  /** camera: zoom in on someone's desk (smooth) / back to the overview (also: double-tap the floor, Home key) */
  focus(id,dist){ return focusOn(byId(id),dist); },
  resetView(){ resetView(); return true; },
  _cam(){ return {pos:camera.position.toArray().map(v=>+v.toFixed(2)),target:controls.target.toArray().map(v=>+v.toFixed(2)),autoRotate:controls.autoRotate}; },
  setSpeed(n){ speed=Math.max(1,Math.min(4,n|0)); },
  pause(on=true){ paused=!!on; },
  /** camera auto-rotate, status rings on the floor, name tags — the dashboard toggles these instead of on-page buttons */
  setAutoRotate(on=true){ controls.autoRotate=!!on; },
  showRings(on=true){ ringsOn=!!on; workers.forEach(w=>w.ring.visible=ringsOn); },
  showTags(on=true){ tagsOn=!!on; },
  on(ev,f){ (listeners[ev] ||= []).push(f); return ()=>{ listeners[ev]=listeners[ev].filter(x=>x!==f); }; },
};
window.Office3D=Office3D;
// commands from a parent page when embedded in an <iframe>: postMessage({type:'office3d', cmd:'visit', args:['mkt-1','captain',4]}, '*')
addEventListener('message',e=>{ const d=e.data; if(!d||d.type!=='office3d'||typeof Office3D[d.cmd]!=='function') return;
  const allowed=(CFG.allowedOrigins&&CFG.allowedOrigins.length)?CFG.allowedOrigins:[location.origin]; // default: only the page's own origin (the dashboard)
  if(!allowed.includes(e.origin)) return;
  try{ Office3D[d.cmd](...(d.args||[])); }catch(err){ console.warn('Office3D command failed',d,err); } });
Office3D.setMode(MODE);

// ---------- Optional on-page controls ----------
// The page ships without buttons (the dashboard drives the scene through the API above). Add elements with these ids to get them back:
// #b-pause (pause/resume) · [data-speed="1|2|4"] · #b-rotate (camera auto-rotate) · #b-rings (status rings) · #b-tags (name tags)
const pauseBtn=document.getElementById('b-pause');
if(pauseBtn) pauseBtn.onclick=()=>{ paused=!paused; pauseBtn.textContent=paused?'เล่นต่อ':'หยุด'; pauseBtn.setAttribute('aria-pressed',paused); };
document.querySelectorAll('[data-speed]').forEach(b=>b.onclick=()=>{
  speed=+b.dataset.speed; document.querySelectorAll('[data-speed]').forEach(x=>x.setAttribute('aria-pressed',x===b)); });
if(rotBtn) rotBtn.onclick=()=>{ controls.autoRotate=!controls.autoRotate; rotBtn.setAttribute('aria-pressed',controls.autoRotate); };
const ringBtn=document.getElementById('b-rings'); let ringsOn=true;
if(ringBtn) ringBtn.onclick=()=>{ ringsOn=!ringsOn; workers.forEach(w=>w.ring.visible=ringsOn); ringBtn.setAttribute('aria-pressed',ringsOn); };
document.dispatchEvent(new CustomEvent('office3d:ready'));
emit('ready',{version:Office3D.version, mode:MODE, agents:workers.map(w=>w.agentId)}); // a parent page (iframe) can start sending commands now
})();
