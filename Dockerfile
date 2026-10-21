# AI Workforce Control Center — ภาพ Docker สำหรับรันบน VPS/Railway (ดู docs/10-online.md §2)
# สถานะ/ผลงานอยู่ใน volume: /app/data (ทะเบียนโปรเจกต์, team.json, state.db) และ /app/logs — โปรเจกต์ที่ให้ทีมทำงานต้อง mount เข้ามาเองและลงทะเบียนด้วย tools/grock.mjs
FROM node:24-alpine

# git ใช้สำหรับ push ผลงานเป็น branch (gitpush.js) และ git apply --check ของ Phase 2 · tini ส่งสัญญาณปิดให้ node ถูกต้อง
RUN apk add --no-cache git tini

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public
COPY tools ./tools
COPY docs ./docs
COPY README.md ./

# ในคอนเทนเนอร์ต้องฟังทุก interface — จึงบังคับให้มีการล็อกอิน (DASHBOARD_TOKEN) ก่อนสตาร์ต (server/auth.js)
ENV HOST=0.0.0.0 PORT=3789 MODE=auto AUTH=auto GROCK_DATA_DIR=/app/data
VOLUME ["/app/data", "/app/logs"]
EXPOSE 3789

# รันเป็น user ธรรมดา (ไฟล์โมเดล 3 มิติ/portraits ที่ผู้ใช้วางเองให้ mount ทับ public/office3d/models และ public/office3d/portraits)
RUN mkdir -p /app/data /app/logs && chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3789)+'/api/health',{headers:process.env.DASHBOARD_TOKEN?{authorization:'Bearer '+process.env.DASHBOARD_TOKEN}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/index.js"]
