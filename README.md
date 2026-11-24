# Claude Control Room

หน้าเว็บในเครื่อง (127.0.0.1) สำหรับดู คุม และตอบคำถามของ Claude Code ทุก session บนเครื่องนี้ในที่เดียว
มีโครงข่ายงาน, ตัวละคร Claude ที่ขยับตามสถานะจริง, คิวคำถาม/ขออนุญาตรวมทุก session, สมุดงาน (worklog) ที่สรุปด้วย Haiku
และ Clip Studio สำหรับสั่งทำคลิปจนถึงขั้น "พร้อม render"

โครงสร้าง: `server/` (Node + ws + SQLite) · `web/` (React + Vite) · `shared/` (protocol ที่ใช้ร่วมกัน)

## รัน

```
npm install
npm run dev      # พัฒนา: server 8790 + Vite 5173 (HMR) เปิด http://127.0.0.1:5173
npm run build    # build server (tsc) + web (web/dist)
npm run start    # ใช้งานจริง: Node server ตัวเดียว เสิร์ฟ web/dist ที่ http://127.0.0.1:8790 (ไม่มี Vite)
npm test         # test ทั้ง server และ web
```

- `npm run start` ต้อง `npm run build` ก่อนอย่างน้อยหนึ่งครั้ง (ถ้ายังไม่ build หน้าเว็บจะขึ้นข้อความบอก)
- เปลี่ยนพอร์ตด้วย `PORT=8894` (หรือ `CR_PORT`) ก่อนสั่ง start
- ถ้าพอร์ตถูกใช้อยู่แล้ว (เช่นเปิด `npm run dev` ค้างไว้) โหมด start จะเขียนบรรทัดเดียวลง log แล้วจบเอง ไม่แย่งพอร์ต ไม่เปิดฐานข้อมูล
- ระวัง: `npm run dev` ใช้ `tsx watch` แก้ไฟล์ใน `server/src` เมื่อไรเซิร์ฟเวอร์ restart เมื่อนั้น (งานที่ Claude ตัวลูกกำลังทำอยู่จะถูกตัด)

## เปิดเองตอนเปิดเครื่อง (Windows)

ใช้ shortcut ในโฟลเดอร์ Startup ของผู้ใช้ (`shell:startup`) ไม่ต้องสิทธิ์ admin ไม่ใช้ Task Scheduler ไม่แตะ registry

```
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1     # ติดตั้ง
powershell -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1   # ถอน (ไม่หยุด server ที่รันอยู่)
```

shortcut ชื่อ `Claude Control Room.lnk` ชี้ไป `wscript.exe scripts\start-hidden.vbs` ซึ่งรัน `npm run start` แบบไม่มีหน้าต่าง
และเขียน log ที่ `~/.claude-control-room/server.log` (เกิน 5 MB เริ่มไฟล์ใหม่)
ย้ายโฟลเดอร์ repo แล้วให้รัน install อีกครั้งเพื่ออัปเดต path ใน shortcut

หยุด server ที่รันแบบซ่อน: หา PID ของพอร์ตด้วย `netstat -ano | findstr :8790` แล้ว `taskkill /PID <pid> /T /F`

## สั่งงานจาก terminal ด้วย `cr`

งานที่ Runner เปิด (เริ่มจากหน้าเว็บหรือจาก `cr new`) สั่งได้พร้อมกันทั้งจาก terminal และหน้าเว็บ — terminal เป็นอีก client หนึ่งของงานเดียวกัน
ข้อความที่ส่งจากฝั่งหนึ่งโผล่อีกฝั่ง คำถาม/ขออนุญาตตอบได้จากฝั่งไหนก็ได้ (ใครตอบก่อนชนะ) ไม่ได้ยัดข้อความเข้า session `claude` ที่เปิดใน terminal (ยังดูได้อย่างเดียวเหมือนเดิม)

ติดตั้ง (ครั้งเดียว, ไม่ต้อง admin, ไม่แก้ PATH/registry, ต้องมี Node 22.18 ขึ้นไป):

```
powershell -ExecutionPolicy Bypass -File scripts\install-cr.ps1       # สร้าง cr.cmd + cr (Git Bash) ในโฟลเดอร์ที่อยู่ใน PATH อยู่แล้ว (~/.local/bin หรือ ~/bin)
powershell -ExecutionPolicy Bypass -File scripts\uninstall-cr.ps1      # ถอน
```

ถ้าไม่มีโฟลเดอร์ที่อยู่ใน PATH สคริปต์จะบอกบรรทัดที่ต้องเพิ่ม PATH เอง (ไม่เพิ่มให้) · ย้าย repo แล้วให้รันติดตั้งอีกครั้ง

```
cr                          # = cr ls  รายการงาน (web = คุมได้, term = ดูอย่างเดียว) --all รวมที่จบแล้ว
cr new "ตอบคำว่า OK"        # เริ่มงานใหม่ในโฟลเดอร์ปัจจุบัน แล้วต่อเข้าไปดู  [--cwd DIR] [--model haiku] [--effort low] [--no-attach]
cr attach 1a2b              # ต่อเข้างาน (id ใช้ตัวหน้า ๆ อย่างน้อย 4 ตัว) พิมพ์ข้อความ = ส่งเข้างาน
cr resume 1a2b              # เอา session เก่า (ที่ปิด terminal แล้ว) มาเป็นงานที่คุมได้ทั้งสองฝั่ง แล้วต่อ
```

ใน `cr attach`: พิมพ์เลข = ตอบคำถาม/ขออนุญาต (เลขตัวสุดท้าย = "อื่น ๆ" พิมพ์เอง) · `/stop` หยุดงาน · `/close` ปิดงาน (ถามยืนยัน) ·
`/detach` หรือ Ctrl+C ออกโดยงานยังรันต่อ · `/skip` ข้ามคำถาม · `/help`
`cr new --cwd` ต้องเป็นโฟลเดอร์ที่ whitelist ของเซิร์ฟเวอร์ยอมรับ (เหมือนปุ่ม + AI) · พอร์ตตาม `CR_PORT` หรือ `--port` (ค่าตั้งต้น 8790)
ถ้าเซิร์ฟเวอร์ restart `cr attach` จะรอแล้วต่อใหม่เอง (งานกลับมาเพราะ auto-resume ด้านล่าง)

ปุ่ม "เปิดใน terminal" (ที่งานของ Runner ทั้งหน้า v1 และแถบข้างของ pane v2) เปิดหน้าต่าง Windows Terminal ที่รัน `cr attach` ของงานนั้นให้ (ไม่มี `wt.exe` จะใช้ `cmd /c start`)
session ที่เปิดใน terminal จริง ๆ ยังดูอย่างเดียว — แต่มีปุ่ม "ยึดมาคุม" (กดสองครั้ง) และ `cr takeover <id>` (ถาม y/n, `-y` ข้าม): เซิร์ฟเวอร์ปิด `claude.exe` ของ session นั้นตัวเดียว
(`taskkill /PID <pid> /T /F`, pid อ่านจาก `~/.claude/sessions/<pid>.json` ตอนสั่ง และเช็คชื่อ process ก่อน) แล้วเปิดต่อด้วย `--resume` ใต้ Runner แบบ "ไม่ถามเลย" ทำได้เมื่อ session ว่างเท่านั้น
(ไม่ทำงาน/ไม่รอคำตอบ, ไม่มี subagent วิ่ง, transcript ไม่ถูกเขียนใน 15 วินาที) · ใช้กับเครื่องอื่นผ่าน agent ได้ (ปุ่มเดียวกัน) · ทุกครั้งลง `commands.log` พร้อม pid
ถ้าไม่อยากให้ปิด: ออกจาก session เองแล้วรัน `cr resume <id>`

## งานของ Runner กลับมาเองหลัง restart

เซิร์ฟเวอร์จำงานของ Runner ที่ยังเปิดอยู่ (session id, โฟลเดอร์, โมเดล, effort, ชื่อ, โหมดสิทธิ์) ไว้ใน SQLite (ตาราง `runner_jobs`)
ตอนเริ่มจะเปิดงานเหล่านั้นด้วย `--resume` แบบว่าง (ไม่ส่ง prompt) สูงสุด 8 งาน (ใหม่สุดก่อน) งานที่เปิดไม่ขึ้นจะถูกลบออกจากรายการ
งานที่ปิดเองไม่กลับมา · โหมดเดิมของงานถูกกู้คืน รวม "ไม่ถามเลย" · ปิดฟีเจอร์ด้วย `CR_NO_AUTORESUME=1` (ใช้กับ instance ทดสอบ)

## ข้อมูล

ทุกอย่างอยู่ที่ `~/.claude-control-room/`: `control-room.db` (สมุดงาน, เสียง, งานคลิป), `commands.log` (คำสั่งที่ส่ง ไม่มีเนื้อหา prompt),
`server.log` (โหมด start), `stills/`, `voice-cache/`, `summarizer/` ไม่มี secret ในโฟลเดอร์นี้ คีย์ ElevenLabs อ่านจาก vault ด้วย `secrets get` ตอนเริ่ม และอยู่ใน memory เท่านั้น

## สไตล์คลิปของเราเอง (our-styles.json)

หน้าสร้างคลิปแสดง "สไตล์เดิมของเรา" จากไฟล์ `~/.claude-control-room/our-styles.json` (หรือ `$CR_DATA_DIR/our-styles.json`) ซึ่งอ่านตอน server เริ่ม
ไม่มีไฟล์ = ไม่มีรายการ รายการที่ผิดรูปจะถูกข้าม ตัวอย่าง:

```json
[
  {
    "id": "my-style",
    "name": "My explainer style",
    "note": "short description shown in the picker",
    "sourceDir": "C:/projects/my-video-project",
    "workflowFiles": ["AGENTS.md", "STORYBOARD.md", "assets/"],
    "extraRules": ["Rules added to the brief for this style"],
    "renders": ["C:/projects/my-video-project/renders/final.mp4"],
    "alt": "sample still from my-video-project"
  }
]
```

`sourceDir` คือโปรเจกต์ที่คัดลอก workflow ไปใช้, `renders` คือไฟล์วิดีโอที่ใช้ตัดภาพตัวอย่าง (ไฟล์แรกที่มีอยู่จริง)

## ความปลอดภัย

- ฟังเฉพาะ `127.0.0.1` และ browser ที่ต่อเข้ามาต้องมี Origin เป็น loopback
- งานที่เริ่มจากหน้าเว็บ ถามสิทธิ์ทุกครั้ง (อนุญาต / ไม่อนุญาต) ไม่มีโหมดข้ามสิทธิ์
- ไม่ส่งข้อความเข้า session ที่เปิดอยู่ใน terminal; session ใน terminal ดูได้อย่างเดียว ต้องปิด terminal ก่อนถึงรับมาคุมได้ (`cr resume` หรือปุ่ม "ย้ายมาคุมจากเว็บ")
- `cr` ต่อ WebSocket เดียวกับหน้าเว็บ (ไม่มี Origin = client ที่ไม่ใช่ browser ซึ่งเซิร์ฟเวอร์ยอมรับ) ใช้คำสั่งชุดเดียวกัน จึงผ่านการตรวจ cwd whitelist/schema เหมือนกัน; `open_terminal` รับเฉพาะ session id แบบ uuid และงานของ Runner ที่ยังทำงานอยู่
- ผู้ช่วยสรุป (Haiku) ไม่มี tool ใด ๆ อ่านอย่างเดียว
- งานคลิปหยุดที่ "พร้อม render" และ render เมื่อกดสั่งเองเท่านั้น

## ดู/สั่ง Claude บนเครื่องอื่น (remote agent)

เครื่องที่ติ๊ก "ดู Claude บนเครื่องนี้" ในหน้า Control Room จะมี session ขึ้นใต้ node ของเครื่องนั้น และสั่งงานได้เหมือน session ในเครื่องนี้

- **Agent** = server ตัวเดิมในโหมดตัดทอน (`npm run start:agent` หรือ `CR_MODE=agent`): มีแค่ watcher + runner + saved sessions
  ฟังเฉพาะ `127.0.0.1:8791` (`CR_AGENT_PORT`) ปฏิเสธ host อื่นทุกแบบ และ websocket ต้องมี header `x-cr-agent-token`
  เครื่องนั้นเก็บแค่ sha256 ของ token (`~/.claude-control-room/agent-token.sha256`) ไม่เก็บ token จริง
- **เครื่องหลัก** เปิด `ssh -N -L 127.0.0.1:<พอร์ตว่าง>:127.0.0.1:8791` (key ต้องอยู่ใน `~/.ssh`) แล้วต่อ websocket เข้าพอร์ตนั้น หลุดแล้วต่อใหม่เอง
  token อ่านจาก env `CR_AGENT_TOKEN_<MACHINEID>` (เช่น `CR_AGENT_TOKEN_DESKTOP_SERVER`) ไม่เขียนลงไฟล์หรือ log
- ติดตั้งจากเครื่องหลัก (ต้อง commit ก่อน เพราะใช้ `git archive HEAD`): `node scripts/install-remote.mjs <machineId> --dry-run` ดูแผน
  แล้วรันจริงโดยตั้ง env token (หรือ `--token-stdin`)
- ทดสอบในเครื่องเดียว: `CR_REMOTE_DIRECT=1 CR_REMOTE_DIRECT_PORT=<พอร์ต agent>` ข้ามขั้น SSH (ใช้ `CR_AGENT_TOKEN` เป็น token ได้) ปิดไว้เป็นค่าเริ่มต้น
- ยังไม่รองรับกับเครื่องอื่น: ประวัติงานย่อย (`/api/agents`), link ระหว่างเครื่อง, Clip Studio, ผู้ช่วยสรุป
