# ไฟล์ประกอบสำหรับ Hermes Agent

ใช้คู่กับ [docs/11-hermes.md](../../docs/11-hermes.md) — ไม่มีอะไรในโฟลเดอร์นี้ถูกติดตั้งอัตโนมัติ ผู้ใช้เป็นคนเพิ่มลง Hermes เอง (เพื่อไม่ทับ Hermes ที่ใช้งานกับงานอื่นอยู่)

- `skills/grock-workforce/SKILL.md` — ทักษะบอก Hermes ว่า "เมื่อไร" ควร/ไม่ควรใช้เครื่องมือ `mcp_grock_*` และขั้นตอนสั่งงาน/รายงาน
  ให้ Hermes เห็นโดยเพิ่มใน `config.yaml` ของโปรไฟล์ที่ต้องการ (ไม่ต้องคัดลอกไฟล์):
  ```yaml
  skills:
    external_dirs:
      - "C:/Projects/AI Agent/Grock Agent/tools/hermes/skills"
  ```
  ทักษะนี้ตั้ง `metadata.hermes.requires_tools: [mcp_grock_create_job]` จึงโผล่ในรายการเฉพาะเมื่อ MCP server `grock` ต่อสำเร็จ
- `mcp_servers.example.yaml` — บล็อก `mcp_servers.grock` สำหรับวางต่อท้ายบล็อก `mcp_servers:` เดิม (แก้พาธ/โทเคนก่อน)
- `webhook-route.example.yaml` — route รับผลโจทย์ (ตั้งใน `platforms.webhook` ของโปรไฟล์ที่รัน gateway; ภายใต้ multiplexing ต้องอยู่ใน default พร้อม `profile:`)
- `setup-profile.ps1` — ทาง ข แบบกดรันครั้งเดียว (ผู้ใช้รันเอง): หลัง `hermes profile create grock --no-alias` สคริปต์จะสร้างโทเคน API + webhook secret แล้วเขียนลง `.env` ของศูนย์ควบคุม, `.env` + `config.yaml` + `SOUL.md` ของโปรไฟล์ (ไม่แสดงค่าลับ ไม่แตะโปรไฟล์ default) เหลือให้ผู้ใช้วาง `TELEGRAM_BOT_TOKEN` (และ `OPENAI_API_KEY` ถ้าไม่ใส่ `-CopyOpenAIKey`) เอง
  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Projects\AI Agent\Grock Agent\tools\hermes\setup-profile.ps1" -Profile grock -CopyOpenAIKey
  ```
- `SOUL.grock.md` — บุคลิก "ผู้จัดการใหญ่" ที่สคริปต์คัดลอกไปเป็น `SOUL.md` ของโปรไฟล์ใหม่ (ไม่แตะ SOUL.md ของโปรไฟล์เดิม)
