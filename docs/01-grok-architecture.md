# Grok (xAI) ทำงานอย่างไร — สรุปจากข้อมูลสาธารณะ (ณ ต.ค. 2026)

> หมายเหตุสำคัญ: xAI ไม่ได้เผยแพร่สเปกทางเทคนิคอย่างเป็นทางการของระบบ multi-agent
> ข้อมูลส่วนใหญ่มาจากประกาศของ xAI/Elon Musk, เอกสาร API ที่ docs.x.ai และบทวิเคราะห์จากสื่อ/นักพัฒนา
> ตัวเลข benchmark และต้นทุนเป็นตัวเลขที่ผู้ขายหรือสื่อรายงาน ยังไม่ได้ตรวจสอบอิสระทั้งหมด

## 1. ภาพรวม: Grok ไม่ใช่โมเดลเดียว แต่เป็น "ระบบ"

| ชั้น | สิ่งที่อยู่ในชั้นนี้ | ตัวอย่างใน Grok |
|---|---|---|
| โมเดลพื้นฐาน | LLM ขนาดใหญ่ ฝึกด้วย RL จำนวนมหาศาลบนคลัสเตอร์ Colossus | Grok 4 → 4.1 → 4.20 → 4.3 → 4.5 (ก.ค. 2026) |
| ชั้น multi-agent (inference-time) | หลาย agent ที่มีบทบาทต่างกัน ทำงานคู่ขนานแล้วถกเถียง/สังเคราะห์ | Grok 4 Heavy, Grok 4.20 (4 agents), Heavy tier (รายงานว่า 16 agents) |
| เครื่องมือฝั่งเซิร์ฟเวอร์ | ค้นเว็บ, ค้น X, รันโค้ด, ค้นไฟล์, สร้างภาพ, MCP | Agent Tools API ผ่าน `/v1/responses` |
| ผลิตภัณฑ์/ส่วนติดต่อผู้ใช้ | เว็บ grok.com, แอป, CLI | grok.com (โหมด Auto/Fast/Expert/Heavy), Grok Build (coding agent) |
| วิสัยทัศน์ระดับองค์กร | บริษัทซอฟต์แวร์ที่ทำงานด้วย AI ทั้งหมด | Macrohard (ประกาศ ส.ค. 2025, ผูกกับ Colossus 2) |

## 2. Grok 4 Heavy (ก.ค. 2025) — จุดเริ่มของ multi-agent

- รัน **หลาย agent คู่ขนาน** กับโจทย์เดียวกัน แต่ละตัวทำงานอิสระ แล้ว "เทียบคำตอบ" เพื่อหาข้อสรุปที่ดีที่สุด
- ได้คะแนน Humanity's Last Exam ประมาณ 44% (พร้อม tool use) แต่ช้ากว่าและแพงกว่าโมเดลเดี่ยวราว 10 เท่า — ขายผ่านแพ็กเกจ SuperGrok Heavy ราว $300/เดือน
- บทเรียน: การใช้ "ปริมาณ compute ตอนตอบ" (test-time compute) แลกคุณภาพ ใช้ได้จริงแต่ต้องมีวิธีควบคุมต้นทุน

## 3. Grok 4.20 (เบต้า ก.พ. 2026) — 4 agents ที่มีชื่อและบทบาท

นี่คือส่วนที่ใกล้เคียง "ทีมงาน AI" ที่สุด และเป็นต้นแบบของระบบที่เราสร้างในโปรเจกต์นี้

| Agent | บทบาท (ตามที่สื่อรายงาน) | เทียบกับทีมของเรา |
|---|---|---|
| **Grok (Captain)** | แตกโจทย์เป็นงานย่อย กำหนดกลยุทธ์ ไกล่เกลี่ยความขัดแย้ง สังเคราะห์คำตอบสุดท้าย | กัปตัน (orchestrator) |
| **Harper** | ค้นข้อมูลเรียลไทม์ (รวม X firehose) ตรวจสอบข้อเท็จจริง | นักวิจัย |
| **Benjamin** | ตรรกะ คณิตศาสตร์ โค้ด ตรวจทีละขั้น | นักวิเคราะห์ / นักพัฒนา |
| **Lucas** | มุมมองทางเลือก หา blind spot ความสมดุล อ่านง่าย | นักเขียน + ส่วนหนึ่งของ QA |

กระบวนการทำงาน (4 ขั้น):
1. **Decomposition** — Captain วิเคราะห์โจทย์ครั้งเดียวและกระจายงานย่อยให้ผู้เชี่ยวชาญ
2. **Parallel analysis** — ทั้ง 4 ตัวได้บริบทเต็ม แล้ววิเคราะห์พร้อมกัน
3. **Internal debate** — รอบทบทวนสั้น ๆ ที่ตั้งคำถาม/แก้กันเอง จนได้ฉันทามติหรือ "ติดธงความไม่แน่ใจ"
4. **Synthesis** — Captain รวมส่วนที่ดีที่สุดเป็นคำตอบเดียว

จุดเทคนิคที่น่าสนใจ:
- agents **ใช้ weights เดียวกัน แชร์ prefix/KV cache และ input context** → ต้นทุนส่วนเพิ่มราว 1.5–2.5 เท่าของการตอบครั้งเดียว ไม่ใช่ 4 เท่า
- คำถามง่ายอาจ **ข้ามสภา (council) ไปเลย** เพื่อประหยัด
- ข้อความถกเถียงถูกฝึกด้วย RL ให้กระชับ ไม่ใช่แชตยาว ๆ
- ผู้ใช้เห็นเพียง **trace แบบย่อ (optional/compressed)** ไม่ได้เห็นงานของแต่ละ agent สด ๆ แบบเต็ม → นี่คือช่องว่างที่ระบบของเราเติม (dashboard เรียลไทม์ต่อคน)
- xAI อ้างลด hallucination อย่างมีนัย (ตัวเลขภายใน ~83% non-hallucination เทียบอิสระ ~78%) — ควรมองเป็นแนวโน้ม ไม่ใช่ตัวเลขยืนยัน

## 4. Agent Tools API — เครื่องมือที่รันบนเซิร์ฟเวอร์ xAI

- เครื่องมือ 2 ประเภท: **built-in ที่ xAI รันให้** (web search, X search, code interpreter, collections/file search, image generation, MCP server, view image/video) และ **function calling** ของเราเอง
- ใช้ผ่าน Responses API (`/v1/responses`) โมเดลจะวนเรียกเครื่องมือเองจนได้คำตอบ และฝัง citation ในข้อความได้
- บทเรียน: "พนักงาน AI" ต้องมีเครื่องมือจริง ไม่ใช่แค่ความรู้ในโมเดล — ใน Claude มี server tools เทียบเท่า (web search, web fetch, code execution) ที่เราเพิ่มให้แต่ละตำแหน่งได้ในเฟสถัดไป

## 5. Grok Build (เบต้า 14 พ.ค. 2026) — coding agent ที่ทำงานคู่ขนาน

- เป็น agent ในเทอร์มินัล รันได้ **สูงสุด 8 sub-agents คู่ขนาน**
- ขั้นตอน **วางแผน → ผู้ใช้ตรวจ/แก้แผน → อนุมัติ → ลงมือ** (ไม่รันโค้ดก่อนอนุมัติ)
- sub-agent แต่ละตัวทำงานใน **Git worktree แยกกัน** (สาขา/โฟลเดอร์ของตัวเอง) แล้วค่อย merge → ลดการเหยียบกัน
- รองรับ ACP, MCP, hooks, skills, `AGENTS.md`, โหมด headless (`-p`) สำหรับ CI
- โมเดลใต้ล่าง `grok-build-0.1` (ต่อยอดจาก grok-code-fast-1, context 256K) SWE-Bench Verified ~70.8% (ผู้ขายรายงาน)
- บทเรียน: การ "แยกพื้นที่ทำงาน" ต่อ agent + ด่านอนุมัติแผนโดยมนุษย์ คือแบบแผนที่องค์กรนำไปใช้ได้ทันที

## 6. Macrohard — "บริษัทซอฟต์แวร์ที่เป็น AI ล้วน"

- วิสัยทัศน์ของ Musk: ให้ Grok **สร้าง agent เฉพาะทางจำนวนมาก** (เขียนโปรแกรม สร้าง/เข้าใจภาพและวิดีโอ) และมี agent ที่ **เลียนแบบมนุษย์ใช้ซอฟต์แวร์ใน VM** ทดสอบจนกว่าผลงานจะดีเยี่ยม
- ผูกกับซูเปอร์คอมพิวเตอร์ Colossus 2 ที่เมมฟิส (แผน 1 ล้าน GPU) — ส่วนใหญ่ยังเป็นประกาศ รายละเอียดจริงมีน้อย
- นี่คือโจทย์เดียวกับ "องค์กรที่มี AI ทำงาน 100%" ของคุณ: ต้องมี (1) ทะเบียนตำแหน่ง/บทบาท (2) ตัวประสานงานกลาง (3) การวัดผลและตรวจคุณภาพ (4) ความสามารถเห็นว่าแต่ละตัวทำอะไรอยู่

## 7. ไทม์ไลน์โมเดล (อย่างย่อ)

| ช่วงเวลา | เหตุการณ์ |
|---|---|
| ก.ค. 2025 | Grok 4 + Grok 4 Heavy (multi-agent คู่ขนาน) |
| ก.ย.–พ.ย. 2025 | Grok 4 Fast, Grok 4.1 (+ Agent Tools API) |
| ก.พ. 2026 | Grok 4.20 เบต้า — 4 agents มีชื่อและบทบาท |
| พ.ค. 2026 | Grok Build เบต้า (coding agent 8 sub-agents) |
| ก.ค. 2026 | Grok 4.5 (เน้น coding/agentic, context 500K, $2/$6 ต่อล้านโทเคน ตามรายงาน) |
| ปลายปี 2026 | Grok 5 ยังไม่ออก (ตลาดคาดการณ์ ~82% ภายในสิ้นปี) |

## 8. สิ่งที่เรานำมาใช้ในโปรเจกต์นี้ (และสิ่งที่เราทำ "เกิน" Grok)

| หลักการจาก Grok/xAI | การนำมาใช้ใน AI Workforce Control Center |
|---|---|
| Captain + ผู้เชี่ยวชาญ | กัปตันแตกงาน/มอบหมาย/สังเคราะห์ + ทีม 6 ตำแหน่ง |
| แชร์บริบทร่วม | ทุกงานได้ "โจทย์หลัก + ผลงานต้นน้ำ" เป็น input |
| Debate / ตรวจกันเอง | QA ให้คะแนน 0–100 ไม่ผ่านส่งกลับแก้ (สูงสุด 3 รอบ) = handoff อัตโนมัติ |
| คู่ขนานเมื่อไม่พึ่งพากัน | กราฟ dependency: งานที่ไม่รอกันทำพร้อมกัน |
| แยกพื้นที่ทำงานต่อ agent | 1 พนักงาน = 1 งาน ณ เวลาหนึ่ง; ขยายเป็น worktree/sandbox ได้ |
| คุมต้นทุนด้วยการเลือกโมเดลตามความยาก | กัปตัน/QA ใช้ Opus, ทีมงานใช้ Sonnet; ปรับ effort ต่อตำแหน่ง |
| trace แบบย่อ (จุดอ่อนของ Grok) | **เราเปิดทุกอย่าง**: เหตุการณ์สด, ข้อความที่กำลังพิมพ์, เฟสงาน, ตัวชี้วัดต่อคน |
| เครื่องมือฝั่งเซิร์ฟเวอร์ | เฟสถัดไป: เพิ่ม web search / code execution ให้แต่ละตำแหน่ง |

## แหล่งอ้างอิง

- Grok 4 / Heavy: https://www.datacamp.com/blog/grok-4
- Grok 4.20 agents: https://www.nextbigfuture.com/2026/02/how-the-xai-grok-4-20-agents-work.html , https://www.verdent.ai/guides/grok-4-20-multi-agent-system , https://engineeratheart.medium.com/inside-grok-4-20-how-four-agents-on-one-backbone-beat-separate-models-acefa425cb52 , https://natural20.com/coverage/grok-420-xai-four-agents-system-benchmarks-jailbreak
- Agent Tools API: https://docs.x.ai/developers/tools/overview , https://ai-sdk.dev/providers/ai-sdk-providers/xai
- Grok Build: https://www.eweek.com/news/xai-grok-build-coding-agent/ , https://devops.com/xai-enters-the-coding-agent-race-with-grok-build , https://www.digitalapplied.com/blog/xai-grok-build-cli-parallel-coding-agents , https://en.wikipedia.org/wiki/Grok_Build
- Macrohard: https://nationalcioreview.com/articles-insights/extra-bytes/elon-musk-to-rival-microsoft-with-new-macrohard-ai-project/ , https://petri.com/podcast/can-ai-clone-microsoft-inside-musks-macrohard/ , https://www.yahoo.com/news/articles/macrohard-why-does-elon-musk-185555294.html
- Grok 4.5 / Grok 5: https://www.basenor.com/blogs/news/grok-4-5-4-6-and-tavily-4-updates-that-matter , https://aireiter.com/blog/grok-5-what-we-know-so-far , https://en.wikipedia.org/wiki/Grok_(chatbot)
