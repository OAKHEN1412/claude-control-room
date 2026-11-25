// The brief a clip job starts with. Pure: same input, same text. The no-render rule is always in it.
import type { ClipSettings, ClipStartInput } from '../../shared/protocol';
import { CLIP_VOICE_MODEL } from '../../shared/protocol';
import type { OurStyle } from './ourStyles';
import type { LemoStyle } from './styles';
import { buildClipPromptEn } from './clipPromptEn';

export type ResolvedStyle = { kind: 'ours'; style: OurStyle } | { kind: 'lemo'; style: LemoStyle };

export const NO_RENDER_RULE =
  'กฎเหล็ก: ห้าม render (ห้ามรัน `hyperframes render` ทุกคุณภาพ) จนกว่าผู้ใช้จะสั่ง. เมื่อ composition ผ่านการตรวจและพร้อมแล้ว ให้หยุดและพิมพ์ว่า "พร้อม render" แล้วรอ. ผู้ใช้จะส่งข้อความ "render ได้" เมื่อพร้อมให้ render.';

const LENGTH_TEXT: Record<ClipSettings['length'], string> = { '30s': '30 วินาที', '60s': '60 วินาที', '90s': '90 วินาที', '3min': '3 นาที' };
const RATIO_TEXT: Record<ClipSettings['ratio'], string> = { '16:9': '16:9 (1920x1080)', '9:16': '9:16 แนวตั้ง (1080x1920)', '1:1': '1:1 (1080x1080)' };

/** Folder-name slug of a topic: letters/digits of any script, hyphen-joined, lower case, max 40 chars. Never empty or reserved. */
export function slugify(topic: string, fallback: string): string {
  const s = topic
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  if (s === '' || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) return fallback;
  return s;
}

export function settingsLine(s: ClipSettings): string {
  const cast = s.cast.length > 0 ? s.cast.join(', ') : 'ไม่มีตัวละคร';
  return [
    `ความยาว ${LENGTH_TEXT[s.length]}`,
    `สัดส่วน ${RATIO_TEXT[s.ratio]}`,
    `ภาษา ${s.lang === 'th' ? 'ไทย' : 'English'}`,
    s.voice ? 'มีเสียงพากย์' : 'ไม่มีเสียงพากย์',
    s.music ? 'มีเพลง' : 'ไม่มีเพลง',
    `ตัวละคร ${cast}`,
    ...(activeOutro(s) ? ['มีฉากท้ายคลิป'] : []),
  ].join(' · ');
}

/** The ending text of a request when its outro is on and not empty, else null. */
export function activeOutro(s: ClipSettings): string | null {
  const t = s.outro && s.outro.on ? s.outro.text.trim() : '';
  return t === '' ? null : t;
}

export interface BuildPromptInput {
  req: ClipStartInput;
  style: ResolvedStyle;
  cwd: string;
}

export function buildClipPrompt({ req, style, cwd }: BuildPromptInput): string {
  if (req.settings.lang === 'en') return buildClipPromptEn({ req, style, cwd });
  const { settings } = req;
  const points = req.points
    .split(/[,\n،]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const noSubagent = style.kind === 'ours' && style.style.noSubagents === true;
  const L: string[] = [];

  L.push('คุณกำลังทำคลิปวิดีโอด้วย HyperFrames (HTML เป็นวิดีโอ) ตาม workflow คลิปเดิมของเรา. ทำงานในโฟลเดอร์นี้:');
  L.push(cwd);
  L.push('');
  L.push(`หัวข้อ: ${req.topic.trim()}`);
  L.push(points.length > 0 ? `ประเด็นที่ต้องมี: ${points.join(' / ')}` : 'ประเด็นที่ต้องมี: ไม่ระบุ (เลือกเองให้ครบความหมาย + ตัวอย่าง)');
  L.push(`ค่าปรับ: ${settingsLine(settings)}`);
  L.push('');

  L.push('## สไตล์');
  if (style.kind === 'ours') {
    const s = style.style;
    L.push(`สไตล์ของเรา: ${s.name} (${s.note}).`);
    L.push(`โปรเจกต์ต้นแบบ: ${s.sourceDir}`);
    L.push(`อ่านและคัดลอก workflow / ไฟล์สไตล์จากต้นแบบมาไว้ในโฟลเดอร์งาน (อย่าแก้ต้นฉบับ): ${s.workflowFiles.join(', ')}`);
    L.push('เริ่มจากอ่าน AGENTS.md / CLAUDE.md ของต้นแบบ แล้วทำตามกฎในนั้น. ใช้ตัวละครและ asset ชุดเดียวกับต้นแบบ.');
    for (const r of s.extraRules) L.push(`- ${r}`);
  } else {
    const s = style.style;
    L.push(`สไตล์ Lemo-Opuscar: ${s.name}${s.nameZh ? ` (${s.nameZh})` : ''} · หมวด ${s.category} · style id: ${s.id}`);
    L.push('ใช้ skill lemo-opuscar กับ style id นี้ (เรียก skill lemo-opuscar แล้วเลือกสไตล์ตาม id).');
    if (s.stylePath) L.push(`โฟลเดอร์สไตล์: ${s.stylePath} (อ่าน DIRECTOR.md / ไฟล์สไตล์ในนั้นก่อนสร้าง)`);
    L.push('สไตล์นี้ออกแบบมาให้ Claude สร้าง.');
  }
  L.push('');

  L.push('## เสียง / เพลง');
  if (settings.voice && req.voiceId) {
    L.push(`เสียงพากย์: ElevenLabs model ${CLIP_VOICE_MODEL}, voice ID ${req.voiceId}${settings.lang === 'th' ? ', language_code th' : ''}.`);
    L.push('- เขียนบทพากย์ให้ไหลเป็นเทคเดียว; ตัด scene ตาม timestamp ของคำ (endpoint /v1/text-to-speech/<voice>/with-timestamps).');
    L.push('- key: อยู่ในตัวแปรสภาพแวดล้อม `ELEVENLABS_API_KEY` ของโปรเซสนี้อยู่แล้ว (อ่านจาก os.environ / process.env, ส่งเป็น header `xi-api-key`). ห้ามอ่าน key จากไฟล์ .env ห้ามพิมพ์หรือเขียน key ลงไฟล์.');
    L.push('- ส่ง JSON เป็น UTF-8 ผ่านไฟล์ (Python ensure_ascii=False) ไม่ใช้ curl -d กับข้อความไทย. เรียก API ทีละครั้ง (ขนานแล้วได้ 429).');
  } else {
    L.push('ไม่มีเสียงพากย์ ใช้ข้อความบนจอ/เพลง/เสียงประกอบแทน (ห้ามเรียก ElevenLabs).');
  }
  L.push(settings.music ? '- เพลง: ใช้เพลงฟรีเท่านั้น (media-use / HeyGen catalog), ลดเสียงเพลงใต้เสียงพากย์.' : '- ไม่ใส่เพลง ใช้ SFX เบาๆ ตามจังหวะได้.');
  L.push('');

  const outro = activeOutro(settings);
  if (outro) {
    L.push('## ท้ายคลิป (outro)');
    L.push(`ฉากสุดท้ายของคลิป (ยาวประมาณ 3-5 วินาที นับรวมอยู่ในความยาวที่เลือกแล้ว ไม่ต่อเพิ่ม) ต้องแสดงข้อความท้ายคลิปนี้บนจอให้เห็นชัด อ่านง่ายที่สัดส่วน ${RATIO_TEXT[settings.ratio]} จัดตัวอักษรและสีให้เข้ากับสไตล์ที่เลือก. ใส่ข้อความตรงตามนี้ทุกตัวอักษร ห้ามแก้หรือตัดคำ:`);
    for (const line of outro.split('\n')) L.push(`> ${line}`);
    L.push(settings.voice && req.voiceId ? `ผู้พากย์อ่านข้อความท้ายคลิปนี้ด้วย (${settings.lang === 'th' ? 'ภาษาไทย' : 'English'}) ในฉากสุดท้าย.` : 'ไม่มีเสียงพากย์: แสดงเป็นข้อความบนจอเท่านั้น.');
    L.push('ใส่ฉากท้ายคลิปนี้ใน storyboard เป็นฉากสุดท้ายอย่างชัดเจน.');
    L.push('');
  }

  L.push('## ใครทำขั้นไหน');
  if (noSubagent) {
    L.push('งานสไตล์นี้ห้ามใช้ subagent: เขียนบท storyboard และสร้าง scene เองทั้งหมดใน session นี้.');
  } else if (req.scriptModel === req.builderModel) {
    L.push(`เขียนบทและ storyboard เอง (model ${req.builderModel}) แล้วสร้าง scene ต่อ.`);
  } else {
    L.push(`บทและ storyboard: ส่งให้ subagent ที่ใช้ model ${req.scriptModel} เขียน (Agent tool, model: "${req.scriptModel}") แล้วอ่านผลและแก้ก่อนใช้.`);
    L.push(`สร้าง scene (เขียนโค้ด composition): คุณทำเอง (model ${req.builderModel}).`);
  }
  L.push('');

  L.push('## ขั้นของงาน และการรายงาน');
  L.push('ทำตามลำดับ: 1 บท → 2 storyboard → 3 สร้าง scene → 4 preview + ตรวจ (hyperframes check/lint, snapshot ดูภาพจริง) → 5 พร้อม render.');
  L.push('ตอนเริ่มแต่ละขั้น ให้พิมพ์ข้อความบรรทัดเดียวในรูปแบบนี้ (เว็บอ่านเพื่อแสดงความคืบหน้า): `ขั้น N/5 <ชื่อขั้น>` เช่น `ขั้น 2/5 storyboard`.');
  L.push('');
  L.push(NO_RENDER_RULE);
  L.push('ขั้น 5/5: พิมพ์ `ขั้น 5/5 พร้อม render` พร้อมสรุปสั้นๆ ว่ามีอะไรในคลิป แล้วหยุดทันที.');
  return L.join('\n');
}
