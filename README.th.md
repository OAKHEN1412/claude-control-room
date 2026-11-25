[English](README.md) | ภาษาไทย

# Claude Control Room

หน้าเว็บในเครื่องของคุณเอง ใช้ดู ควบคุม และตอบคำถามของ Claude Code ทุก session บนเครื่องนี้ในที่เดียว
มีผังความสัมพันธ์ของ session เป็นกราฟ, คิวคำถามและคำขออนุญาตรวมทุก session, สมุดงาน (worklog) ที่ Haiku ช่วยสรุป
และ Clip Studio สำหรับทำ brief ให้เป็นคลิปที่พร้อม render ระบบรองรับ Windows 10 และ 11 เป็นอันดับแรก

เซิร์ฟเวอร์ฟังเฉพาะ `127.0.0.1` ไม่เปิดให้เครือข่ายภายนอกเข้าถึง

## สิ่งที่ต้องมี

- Windows 10 หรือ 11
- Claude Code ที่ติดตั้งแล้วและ login แล้ว (มีคำสั่ง `claude` ใน PATH; รัน `claude` หนึ่งครั้งเพื่อ login)
- Node.js 22.18 ขึ้นไป ตัวติดตั้งสามารถดึง Node.js, Git และ ffmpeg ผ่าน winget ให้ได้ ถ้ายังไม่มี

## ติดตั้ง

เปิด PowerShell แล้วรัน:

```powershell
irm https://raw.githubusercontent.com/OAKHEN1412/claude-control-room/main/install.ps1 | iex
```

หรือรันตัวติดตั้งจากสำเนา repository ในเครื่อง:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Yes] [-DryRun] [-InstallDir <dir>] [-Ref <tag>] [-RepoUrl <url>] [-Port 8790] [-NoVideoToolchain]
```

- `-Yes` ตอบ yes ให้ทุกคำถาม
- `-DryRun` แสดงทุกขั้นตอนโดยไม่เปลี่ยนแปลงอะไร (การตรวจแบบอ่านอย่างเดียวยังทำงาน)
- `-InstallDir` ค่าเริ่มต้นคือ `%LOCALAPPDATA%\ClaudeControlRoom\app`
- `-Ref` ติดตั้ง release tag ที่ระบุ ถ้าไม่ระบุจะใช้ release ล่าสุด
- `-Port` ค่าเริ่มต้นคือ 8790
- `-NoVideoToolchain` ข้ามขั้นที่ 9 (HyperFrames skills, plugin Lemo-Opuscar, ไฟล์ Lemo styles)

เมื่อรันผ่าน `iex` ส่งพารามิเตอร์ไม่ได้ ให้ตั้ง environment variable แทน: `CR_INSTALL_YES=1`, `CR_INSTALL_DRYRUN=1`, `CR_INSTALL_REF` และ `CR_INSTALL_DIR`

ตัวติดตั้งไม่ต้องใช้สิทธิ์ administrator แต่ละขั้นทำซ้ำได้โดยไม่เสียหาย และจะถาม y/n ถ้าไม่ได้ใส่ `-Yes` ขั้นตอนมีดังนี้

1. **Node.js 22.18+**: ติดตั้งด้วย winget (`OpenJS.NodeJS.LTS`) ถ้ายังไม่มี
2. **Git**: ติดตั้งด้วย winget (`Git.Git`) ถ้ายังไม่มี
3. **Claude Code CLI**: ถ้าไม่พบ `claude` ใน PATH ตัวติดตั้งจะเสนอให้ใช้ตัวติดตั้งทางการ และให้รัน `claude` หนึ่งครั้งเพื่อ login
4. **ffmpeg**: ติดตั้งด้วย winget (`Gyan.FFmpeg`) ถ้ายังไม่มี
5. **App checkout**: clone repository ลงโฟลเดอร์ติดตั้งที่ release tag
6. **Dependencies and build**: รัน `npm ci` แล้ว build
7. **Config and install marker**: เขียน `config.json` ค่าเริ่มต้นไว้ใน data dir (ถ้ามีไฟล์อยู่แล้วจะคงไว้) และไฟล์ `.cr-install` ที่บอกว่าโฟลเดอร์นี้ถูกติดตั้งโดยตัวติดตั้ง (ดูหัวข้ออัปเดต)
8. **Startup shortcut and `cr` command**: สร้าง shortcut ในโฟลเดอร์ Startup และ shim ของคำสั่ง `cr` ใน `~/.local/bin` หรือ `~/bin` ไม่แก้ PATH หรือ registry
9. **Video toolchain**: ติดตั้ง HyperFrames skills (`npx skills add heygen-com/hyperframes`), plugin Lemo-Opuscar (`lemo-opuscar@lemolab`) และสร้างไฟล์ Lemo styles ถ้าขั้นนี้ล้มเหลวจะเป็นเพียงคำเตือน ไม่ทำให้การติดตั้งล้มทั้งหมด
10. **Start server**: เปิดเซิร์ฟเวอร์แบบซ่อนหน้าต่างที่พอร์ตที่เลือก รอจนตอบสนอง แล้วเปิดในเบราว์เซอร์

ตารางสรุปท้ายการติดตั้งแสดงว่าแต่ละขั้น done, skipped หรือ failed

## การเปิดใช้ครั้งแรก

เบราว์เซอร์จะเปิดที่ `http://127.0.0.1:8790` ในการเปิดครั้งแรก แผง **Setup / ตรวจเครื่อง** จะตรวจเครื่องและแสดงคำสั่งแก้ไขในแถวที่ไม่ผ่าน:

- เวอร์ชัน Node.js; `claude` อยู่ใน PATH และ login แล้ว
- เข้าถึง Claude in Chrome ได้ (ตรวจแบบ best effort)
- ffmpeg และ ffprobe
- HyperFrames skills, plugin Lemo และไฟล์ Lemo styles
- ตั้งค่า ElevenLabs key แล้ว
- data dir เขียนได้

การตรวจชุดเดียวกันรันจาก terminal ได้ด้วย `npm run doctor` และผ่าน HTTP ที่ `GET /api/doctor`

หน้า **Settings** แก้ไฟล์ `config.json` ตัวเดียวกับที่อธิบายในหัวข้อ การตั้งค่าและ environment variables ด้านล่าง

## การตั้งค่า Clip Studio

Clip Studio เปลี่ยน brief ให้เป็นโปรเจกต์วิดีโอ การพากย์เสียงต้องใช้ ElevenLabs API key

- ตั้งคีย์ในหน้า **Settings** หรือตั้ง environment variable `ELEVENLABS_API_KEY` ก่อนเปิดเซิร์ฟเวอร์
- คีย์ที่ตั้งจากหน้า Settings จะถูกเข้ารหัสด้วย Windows DPAPI สำหรับผู้ใช้ Windows ของคุณ และเก็บไว้ที่ `<dataDir>/secrets.dpapi.json` ไม่เคยเก็บเป็นข้อความธรรมดาและไม่เขียนลง log หน้าเว็บแสดงแค่ "ตั้งแล้ว" หรือ "ยังไม่ได้ตั้ง"
- งานคลิปรับคีย์ผ่าน environment ของ child process ของงานนั้นเท่านั้น (`ELEVENLABS_API_KEY`) จะไม่ถูกเขียนลง brief หรือไฟล์ใด ๆ
- **ไม่ render โดยไม่มีคำสั่ง** งานคลิปจะหยุดที่สถานะ "พร้อม render" และจะ render ก็ต่อเมื่อคุณสั่งเริ่ม render เอง

## อัปเดต

เซิร์ฟเวอร์จะตรวจ release ล่าสุดบน GitHub (`releases/latest` ของ repository) ตอนเริ่มทำงาน และทุก 6 ชั่วโมง ถ้า `update.check` เปิดอยู่ (ค่าเริ่มต้นคือเปิด) การตรวจที่ล้มเหลวจะไม่แจ้ง และจะเก็บผลล่าสุดที่สำเร็จไว้

อัปเดตการติดตั้งที่ตัวติดตั้งดูแลจาก terminal:

```powershell
cr update --latest                 # release tag ล่าสุด
cr update --tag v0.2.0             # tag ที่ระบุ
cr update --latest --skills        # อัปเดต HyperFrames skills และ plugin Lemo ด้วย
cr update --latest --dry-run       # แสดงแผนอย่างเดียว ไม่เปลี่ยนแปลงอะไร
```

`cr update` ไม่ต้องให้เซิร์ฟเวอร์รันอยู่ ตัวอัปเดต (`scripts/update.mjs`) ทำดังนี้

1. ปฏิเสธการทำงานถ้าโฟลเดอร์ไม่มีไฟล์ `.cr-install` หรือไม่ใช่ git checkout ที่สะอาด git checkout ที่คุณ clone เองจะไม่ถูกแตะต้องเลย
2. fetch tags, checkout release tag, รัน `npm ci` และ build แล้วสร้างไฟล์ Lemo styles ใหม่
3. หยุดเซิร์ฟเวอร์ด้วย process ID ที่ตรงกับตัวเซิร์ฟเวอร์เท่านั้น เปิดใหม่แบบซ่อนหน้าต่าง แล้วตรวจว่า `/` ตอบสนอง
4. ถ้า health check ของเวอร์ชันใหม่ไม่ผ่าน จะย้อนกลับไปยัง commit เดิม (dependencies, build, restart) และรายงานผล

รหัสออกจากโปรแกรม: `0` อัปเดตสำเร็จ, `2` ถูกปฏิเสธหรือ argument ผิด, `3` ล้มเหลว (ย้อนกลับแล้วหรือยังไม่มีอะไรเปลี่ยน), `4` ย้อนกลับไม่สำเร็จ (ต้องกู้คืนด้วยมือตาม log) ความคืบหน้าเขียนไว้ที่ `<dataDir>/update.log` งานที่กำลังรันจะกลับมาเองหลังรีสตาร์ตผ่าน auto-resume

แบนเนอร์ในหน้าเว็บ ("มีเวอร์ชันใหม่" พร้อมปุ่ม Update now หรือ Update when idle) เป็นส่วนหนึ่งของฟีเจอร์อัปเดตเดียวกัน การอัปเดตจะรอจนกว่างานที่กำลังทำงาน, งานที่รอคำตอบ หรือคลิปที่กำลังสร้างจะเสร็จก่อน

## การตั้งค่าและ environment variables

การตั้งค่าอยู่ที่ `<dataDir>/config.json` ถ้าไม่มีไฟล์จะใช้ค่าเริ่มต้น ถ้าไฟล์อ่านหรือ parse ไม่ได้ จะใช้ค่าเริ่มต้นพร้อมคำเตือนใน log เซิร์ฟเวอร์ไม่ล้มเพราะ config ผิด

```json
{
  "language": "auto",
  "port": null,
  "galleryRoots": [],
  "videosDir": null,
  "extraCwds": [],
  "voices": [],
  "update": { "check": true, "channel": "stable" }
}
```

| ฟิลด์ใน config | ความหมาย | ค่าเริ่มต้น |
|---|---|---|
| `language` | `th`, `en` หรือ `auto` (ตามเบราว์เซอร์) | `auto` |
| `port` | พอร์ตของเซิร์ฟเวอร์ 1-65535 | `8790` |
| `galleryRoots` | โฟลเดอร์ที่แกลเลอรีสแกน | `~/videos` |
| `videosDir` | โฟลเดอร์โปรเจกต์คลิป | `~/videos` |
| `extraCwds` | โฟลเดอร์เพิ่มเติมที่ session เริ่มทำงานได้ | ไม่มี |
| `voices` | เสียง ElevenLabs เพิ่มเติม `{id, name}` ที่แสดงใน Clip Studio | เสียง premade ของ ElevenLabs บางตัว |
| `update.check` | ตรวจ release ใหม่บน GitHub | `true` |
| `update.channel` | ช่องทาง release | `stable` |

environment variable มีผลเหนือไฟล์เสมอ ดังนั้น launcher จึงตรึงค่าได้โดยไม่ต้องแก้ไฟล์

| Environment variable | แทนค่าใน | ใช้ทำอะไร |
|---|---|---|
| `CR_PORT` (หรือ `PORT`) | `port` | พอร์ตของเซิร์ฟเวอร์ |
| `CR_DATA_DIR` | | โฟลเดอร์ข้อมูล (ค่าเริ่มต้น `~/.claude-control-room`) |
| `CR_GALLERY_ROOTS` | `galleryRoots` | โฟลเดอร์แกลเลอรี คั่นด้วยตัวคั่น path ของระบบปฏิบัติการ |
| `CR_VIDEOS_DIR` | `videosDir` | โฟลเดอร์โปรเจกต์คลิป |
| `CR_EXTRA_CWDS` | `extraCwds` | โฟลเดอร์เริ่มงานเพิ่มเติมที่อนุญาต |
| `ELEVENLABS_API_KEY` | คีย์ที่ตั้งใน Settings | ElevenLabs key (ลำดับแรกของการค้นหา secret) |
| `CR_NO_AUTORESUME` | | `1` = ไม่เปิดงาน Runner กลับมาตอนเริ่มเซิร์ฟเวอร์ |
| `CR_NO_SUMMARY` | | `1` = ปิดตัวสรุปสมุดงานด้วย Haiku |
| `CR_CLAUDE_BIN` | | path ของโปรแกรม `claude` |
| `CR_NO_CHROME` | | `1` = ไม่ส่ง `--chrome` ให้ session |
| `CR_LEMO_DIR` | | โฟลเดอร์ไลบรารี Lemo-Opuscar สำหรับตัวสร้าง styles (ค่าเริ่มต้น `~/lemo-opuscar`) |
| `CR_LEMO_FILE` | | อ่าน Lemo styles จากไฟล์นี้ |
| `CR_UPDATE_URL` | | เปลี่ยน URL ที่ใช้ตรวจ release (สำหรับทดสอบ) |

secret ถูกค้นหาตามลำดับนี้: environment variable, แล้วค่อยเป็นที่เก็บ DPAPI (`secrets.dpapi.json`), แล้วเป็นคำสั่ง `secrets` ถ้ามีใน PATH ค่าของ secret จะไม่ถูกเขียนลง log, prompt, URL หรือไฟล์ใดนอกจากที่เก็บ DPAPI

สไตล์ Clip Studio ของคุณเองเก็บไว้ที่ `<dataDir>/our-styles.json` เป็น JSON array ที่แต่ละรายการมี `id`, `name`, `note`, `sourceDir`, `workflowFiles`, `extraRules`, `renders` และ `alt` รายการที่รูปแบบผิดจะถูกข้าม

## การใช้หน้าเว็บและคำสั่ง `cr`

- งานที่เริ่มจากหน้าเว็บจะถามสิทธิ์ทุกครั้งที่จะทำการกระทำ ในหน้าเว็บไม่มีโหมดข้ามการถามสิทธิ์
- session ที่ Control Room เป็นผู้รัน ตอบได้ทั้งจากหน้าเว็บและจาก terminal ใครตอบก่อนชนะ
- session ที่คุณเปิดเองใน terminal จะแสดงแบบดูอย่างเดียว ถ้าจะยึดมาคุม ใช้ `cr takeover <id>` หรือปุ่มยึดมาคุม ระบบจะปิด process `claude` ตัวนั้นเฉพาะเมื่อ session ว่างอยู่ แล้วเปิด session ต่อใต้ Control Room

```
cr                          รายการ session (--all รวมที่จบแล้ว)
cr new "prompt"             เริ่ม session ในโฟลเดอร์ปัจจุบันแล้วต่อเข้าไปดู  [--cwd DIR] [--model M] [--effort E] [--no-attach]
cr attach <id>              ต่อเข้า session; ข้อความที่พิมพ์จะถูกส่งเข้า session
cr resume <sessionId>       เอา session เก่ามาอยู่ใต้ Control Room แล้วต่อเข้าไป
cr takeover <id> [-y]       ยึด session ที่ว่างอยู่จาก terminal (-y = ไม่ถามยืนยัน)
cr update ...               ดูหัวข้ออัปเดต
```

ในโหมด `cr attach`: พิมพ์เลขเพื่อตอบคำถามหรือคำขออนุญาต (เลขตัวสุดท้ายคือ "อื่น ๆ" ให้พิมพ์เอง) · `/stop` หยุดงาน · `/close` ปิดงาน · `/detach` หรือ Ctrl+C ออกโดยงานยังรันต่อ · `/skip` ข้ามคำถาม · `/help` ดูคำสั่งทั้งหมด รหัส session ต้องใช้อย่างน้อย 4 ตัวอักษร

งานที่ Runner เปิดจะถูกจำไว้ใน SQLite ตอนเริ่มเซิร์ฟเวอร์จะเปิดงานกลับมาได้สูงสุด 8 งาน เรียงจากใหม่สุด ยกเว้นตั้ง `CR_NO_AUTORESUME=1`

## การพัฒนา

```
npm ci
npm run dev        # เซิร์ฟเวอร์ 8790 และ Vite 5173 แบบ hot reload เปิด http://127.0.0.1:5173
npm run build      # build เซิร์ฟเวอร์ (tsc), เว็บ และ cli
npm run start      # โหมดใช้งานจริง: เซิร์ฟเวอร์ตัวเดียวเสิร์ฟ web/dist ที่ http://127.0.0.1:8790
npm test           # test ของเซิร์ฟเวอร์, เว็บ และ cli
npm run doctor     # ตรวจสภาพแวดล้อม แสดงผลใน terminal
```

`npm run start` ต้อง `npm run build` ก่อนอย่างน้อยหนึ่งครั้ง `npm run dev` รันเซิร์ฟเวอร์ด้วย `tsx watch`: เมื่อไฟล์ใน `server/src` เปลี่ยน เซิร์ฟเวอร์จะรีสตาร์ต และงานของ session ที่กำลังทำอยู่ในขณะนั้นจะถูกตัด

repository ที่ clone มาแล้วรันจาก source เป็นการติดตั้งสำหรับพัฒนา `cr update` จะไม่แตะต้องมัน

## Remote agent (ไม่บังคับ)

เครื่องอีกเครื่องสามารถรัน Control Room ในโหมด agent (`npm run start:agent` หรือ `CR_MODE=agent`) โหมดนี้มีเฉพาะ watcher, runner และ saved sessions ฟังที่ `127.0.0.1:8791` (`CR_AGENT_PORT`) และต้องมี token header ตอนเชื่อม WebSocket agent เก็บเพียง SHA-256 hash ของ token เครื่องหลักเชื่อมต่อผ่าน SSH tunnel และอ่าน token จาก environment variable `CR_AGENT_TOKEN_<MACHINEID>` session ของเครื่องระยะไกลจะแสดงใต้ node ของเครื่องนั้นในผัง `scripts/install-remote.mjs` ใช้ติดตั้ง agent (`--dry-run` แสดงแผนก่อน) ตอนนี้ยังไม่รองรับประวัติ sub-agent, การเชื่อมโยงข้ามเครื่อง และ Clip Studio บนเครื่องระยะไกล

## ข้อมูลและความเป็นส่วนตัว

ข้อมูลทั้งหมดเก็บอยู่ใน data dir คือ `~/.claude-control-room` เว้นแต่ตั้ง `CR_DATA_DIR`

| ไฟล์หรือโฟลเดอร์ | เนื้อหา |
|---|---|
| `control-room.db` | สมุดงาน, การตั้งค่าเสียง, งานคลิป, saved sessions และงาน Runner (SQLite) |
| `config.json` | การตั้งค่าที่ไม่ใช่ความลับ |
| `secrets.dpapi.json` | ความลับที่เข้ารหัสด้วย DPAPI สำหรับผู้ใช้ Windows ของคุณ (มีเฉพาะเมื่อตั้งค่าจากหน้า Settings) |
| `commands.log` | ใครส่งคำสั่งอะไรและเมื่อไร ไม่บันทึกข้อความ prompt |
| `server.log` | ข้อความตอนเริ่มเซิร์ฟเวอร์ เกิน 5 MB จะเริ่มไฟล์ใหม่ |
| `update.log` | ความคืบหน้าของตัวอัปเดต |
| `stills/`, `voice-cache/`, `summarizer/` | ภาพนิ่งของคลิป, ไฟล์เสียงตัวอย่างที่แคชไว้ และโฟลเดอร์ชั่วคราวของตัวสรุป Haiku |
| `our-styles.json`, `lemo-styles.json` | นิยามสไตล์คลิป |
| `agent-token.sha256` | เฉพาะ remote agent: hash ของ token |

การเชื่อมต่อออกนอกเครื่องจากแอปนี้มีเพียงรายการต่อไปนี้

- **Claude Code เอง**: session คุยกับ Anthropic เหมือนตอนที่คุณรัน Claude Code ด้วยมือ
- **ตรวจ release**: ส่งคำขอไป `api.github.com` เพื่อดู release ล่าสุด ไม่ส่งบัญชีหรือข้อมูลส่วนตัว ปิดได้ด้วย `update.check: false`
- **ElevenLabs**: เฉพาะตอนที่คุณฟังตัวอย่างเสียงหรือสร้างเสียงพากย์ใน Clip Studio โดยใช้คีย์ของคุณ
- **ติดตั้งและอัปเดต**: winget, GitHub และ npm รวมถึงการติดตั้ง HyperFrames และ plugin Lemo

ไม่มี telemetry และไม่มีการเก็บสถิติการใช้งาน

## ถอนการติดตั้ง

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1 [-InstallDir <dir>] [-Purge] [-Yes] [-DryRun]
```

สคริปต์จะหยุดเซิร์ฟเวอร์ (process ที่ถือพอร์ตอยู่), ลบ shortcut ใน Startup และ shim ของ `cr`, แล้วลบโฟลเดอร์แอป ถ้าโฟลเดอร์ไม่มีไฟล์ `.cr-install` สคริปต์จะปฏิเสธการทำงานทั้งหมด จึงไม่มีทางลบ development checkout โดยไม่ตั้งใจ data dir จะถูกเก็บไว้ เว้นแต่ใส่ `-Purge` ซึ่งจะลบด้วย

## ลิขสิทธิ์

MIT ดู [LICENSE](LICENSE)

## การมีส่วนร่วมและผู้ดูแล

ยินดีรับ issue และ pull request

สำหรับผู้ดูแล: `scripts/release.mjs <X.Y.Z>` สร้าง snapshot สาธารณะที่ตัดข้อมูลส่วนตัวออกแล้ว ค่าเริ่มต้นเป็น dry run ถ้าใส่ `--apply` จะปรับเลขเวอร์ชัน เพิ่มรายการใน changelog และ commit กับ tag ใน repository สาธารณะ สคริปต์ไม่ push และไม่สร้าง GitHub release เอง จะพิมพ์คำสั่งเหล่านั้นให้คุณรันเอง
