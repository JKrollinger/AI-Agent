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
- `webhook-route.example.yaml` — route รับผลโจทย์ (ตั้งใน `platforms.webhook` ของโปรไฟล์ default; ถ้าใช้โปรไฟล์แยกต้องมี `profile:`)
