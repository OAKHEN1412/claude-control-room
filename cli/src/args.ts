// Command line parsing for `cr`. Pure: no I/O, so it is unit-tested. Errors are Thai, ready to print.
import { DEFAULT_EFFORT, DEFAULT_MODEL, EFFORT_LEVELS, MODEL_OPTIONS, SERVER_PORT } from '../../shared/protocol.ts';
import type { EffortLevel } from '../../shared/protocol.ts';

export type Command =
  | { kind: 'ls'; all: boolean }
  | { kind: 'new'; cwd: string; model: string; effort: EffortLevel; prompt: string; attach: boolean }
  | { kind: 'attach'; id: string }
  | { kind: 'resume'; id: string; model?: string; effort?: EffortLevel }
  | { kind: 'takeover'; id: string; yes: boolean }
  | { kind: 'update'; tag?: string; latest: boolean; skills: boolean; dryRun: boolean }
  | { kind: 'help' };

export interface Parsed {
  ok: true;
  port: number;
  machine?: string; // passthrough hook for remote machines: added to start / saved_resume as `machineId`
  command: Command;
}
export type ParseResult = Parsed | { ok: false; error: string };

export const USAGE = `cr — คุมงาน Claude Control Room จาก terminal

  cr [ls] [--all]                       รายการงาน (งานจากเว็บ + session ใน terminal)
  cr new [--cwd DIR] [--model M] [--effort E] ["prompt"]
                                        เริ่มงานใหม่ แล้วต่อเข้าไปดู (--no-attach = ไม่ต่อ)
  cr attach <id>                        ต่อเข้างานที่เปิดอยู่ (พิมพ์ข้อความ = ส่งเข้างาน)
  cr resume <sessionId>                 เอา session เก่ามาเป็นงานที่คุมได้ทั้งเว็บและ terminal แล้วต่อ
  cr takeover <id> [-y]                 ยึด session ที่เปิดอยู่ใน terminal: ปิด claude ตัวนั้น (ต้องว่าง) แล้วย้ายมาคุม (ถามยืนยัน, -y = ไม่ถาม) แล้วต่อ
  cr update [--latest | --tag vX.Y.Z] [--skills] [--dry-run]
                                        อัปเดตเซิร์ฟเวอร์เป็น release tag (ใช้ได้เฉพาะการติดตั้งที่มี .cr-install; ไม่ต้องเปิดเซิร์ฟเวอร์)

  id ใช้แค่ตัวหน้า ๆ ได้ (อย่างน้อย 4 ตัว)   --port N หรือ CR_PORT = พอร์ตของเซิร์ฟเวอร์ (ค่าตั้งต้น ${SERVER_PORT})
  ในโหมด attach: เลข = ตอบคำถาม · /stop หยุดงาน · /close ปิดงาน · /detach หรือ Ctrl+C ออกโดยงานยังรันต่อ · /help`;

const MODEL_IDS = MODEL_OPTIONS.filter((m) => m.cli && !m.disabled).map((m) => m.id);

export function parsePort(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

interface Flags {
  values: Map<string, string>;
  bools: Set<string>;
  rest: string[];
}

const VALUE_FLAGS = new Set(['--cwd', '--model', '--effort', '--port', '--machine', '--tag']);
const BOOL_FLAGS = new Set(['--all', '-a', '--no-attach', '--help', '-h', '--yes', '-y', '--latest', '--skills', '--dry-run']);

function splitFlags(args: string[]): Flags | string {
  const f: Flags = { values: new Map(), bools: new Set(), rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      f.rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (VALUE_FLAGS.has(name)) {
        const v = eq > 0 ? a.slice(eq + 1) : args[++i];
        if (v === undefined || v === '') return `ตัวเลือก ${name} ต้องมีค่า`;
        f.values.set(name, v);
      } else if (BOOL_FLAGS.has(name) && eq < 0) {
        f.bools.add(name);
      } else {
        return `ไม่รู้จักตัวเลือก ${a} (cr --help)`;
      }
      continue;
    }
    f.rest.push(a);
  }
  return f;
}

export function parseArgs(argv: string[], cwd: string, env: Record<string, string | undefined> = {}): ParseResult {
  const f = splitFlags(argv);
  if (typeof f === 'string') return { ok: false, error: f };
  const portFlag = f.values.get('--port');
  let port = parsePort(env.CR_PORT) ?? SERVER_PORT;
  if (portFlag !== undefined) {
    const p = parsePort(portFlag);
    if (p === null) return { ok: false, error: `พอร์ตไม่ถูกต้อง: ${portFlag}` };
    port = p;
  }
  const machine = f.values.get('--machine') ?? (env.CR_MACHINE || undefined);
  if (machine !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(machine)) return { ok: false, error: `machine id ไม่ถูกต้อง: ${machine}` };
  const wrap = (command: Command): Parsed => ({ ok: true, port, ...(machine ? { machine } : {}), command });

  if (f.bools.has('--help') || f.bools.has('-h')) return wrap({ kind: 'help' });
  const [verb, ...args] = f.rest;
  switch (verb ?? 'ls') {
    case 'help':
      return wrap({ kind: 'help' });
    case 'ls':
    case 'list':
      return wrap({ kind: 'ls', all: f.bools.has('--all') || f.bools.has('-a') });
    case 'attach': {
      if (args.length !== 1) return { ok: false, error: 'ใช้: cr attach <id>' };
      return wrap({ kind: 'attach', id: args[0] });
    }
    case 'resume': {
      if (args.length !== 1) return { ok: false, error: 'ใช้: cr resume <sessionId>' };
      const model = f.values.get('--model');
      const effort = f.values.get('--effort');
      const r = checkModelEffort(model, effort);
      if (r) return { ok: false, error: r };
      return wrap({ kind: 'resume', id: args[0], ...(model ? { model } : {}), ...(effort ? { effort: effort as EffortLevel } : {}) });
    }
    case 'takeover': {
      if (args.length !== 1) return { ok: false, error: 'ใช้: cr takeover <id>' };
      return wrap({ kind: 'takeover', id: args[0], yes: f.bools.has('--yes') || f.bools.has('-y') });
    }
    case 'update': {
      const usage = 'ใช้: cr update [--latest | --tag vX.Y.Z] [--skills] [--dry-run]';
      if (args.length !== 0) return { ok: false, error: usage };
      const tag = f.values.get('--tag');
      const latest = f.bools.has('--latest');
      if (tag !== undefined && latest) return { ok: false, error: 'ใส่ --tag หรือ --latest อย่างใดอย่างหนึ่ง' };
      if (tag === undefined && !latest) return { ok: false, error: `ต้องระบุ --latest หรือ --tag vX.Y.Z (${usage})` };
      if (tag !== undefined && !/^v\d+\.\d+\.\d+$/.test(tag)) return { ok: false, error: `tag ไม่ถูกต้อง: ${tag} (ต้องเป็นรูปแบบ vX.Y.Z)` };
      return wrap({
        kind: 'update',
        ...(tag !== undefined ? { tag } : {}),
        latest,
        skills: f.bools.has('--skills'),
        dryRun: f.bools.has('--dry-run'),
      });
    }
    case 'new': {
      const model = f.values.get('--model') ?? DEFAULT_MODEL;
      const effort = f.values.get('--effort') ?? DEFAULT_EFFORT;
      const r = checkModelEffort(model, effort);
      if (r) return { ok: false, error: r };
      return wrap({
        kind: 'new',
        cwd: f.values.get('--cwd') ?? cwd,
        model,
        effort: effort as EffortLevel,
        prompt: args.join(' ').trim(),
        attach: !f.bools.has('--no-attach'),
      });
    }
    default:
      return { ok: false, error: `ไม่รู้จักคำสั่ง "${verb}" (cr --help)` };
  }
}

function checkModelEffort(model: string | undefined, effort: string | undefined): string | null {
  if (model !== undefined && !MODEL_IDS.includes(model)) return `model ไม่ถูกต้อง: ${model} (ใช้ได้: ${MODEL_IDS.join(', ')})`;
  if (effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(effort)) return `effort ไม่ถูกต้อง: ${effort} (ใช้ได้: ${EFFORT_LEVELS.join(', ')})`;
  return null;
}

const MIN_PREFIX = 4;

export type Resolved = { ok: true; id: string } | { ok: false; error: string };

/** Finds one id by a prefix (case-insensitive, at least 4 characters). `ids` are full session ids. */
export function resolvePrefix(prefix: string, ids: readonly string[]): Resolved {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f-]+$/.test(p)) return { ok: false, error: `id ไม่ถูกต้อง: ${prefix}` };
  if (p.length < MIN_PREFIX) return { ok: false, error: `id สั้นเกินไป (ใช้อย่างน้อย ${MIN_PREFIX} ตัว)` };
  const hits = [...new Set(ids)].filter((id) => id.toLowerCase().startsWith(p));
  if (hits.length === 0) return { ok: false, error: `ไม่พบ id ที่ขึ้นต้นด้วย ${prefix}` };
  if (hits.length > 1) return { ok: false, error: `id ${prefix} ตรงกับหลายงาน: ${hits.map((h) => h.slice(0, 8)).join(', ')} — พิมพ์ให้ยาวขึ้น` };
  return { ok: true, id: hits[0] };
}
