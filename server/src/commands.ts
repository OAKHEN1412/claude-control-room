// Schema validation for browser -> server commands. Hand-written (no dependencies); every field is
// checked and unknown message types / fields of the wrong type are rejected.
import {
  CLIP_BUILDER_MODELS,
  CLIP_CAST,
  CLIP_LANGS,
  CLIP_LENGTHS,
  CLIP_OUTRO_MAX,
  CLIP_OUTRO_NAME_MAX,
  CLIP_RATIOS,
  CLIP_SCRIPT_MODELS,
  EFFORT_LEVELS,
  cleanOutroText,
  LINK_MAX_FORWARDS_LIMIT,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  REMOTE_ROUTABLE,
  type ClientMsg,
  type ClipOutro,
  type ClipSettings,
  type EffortLevel,
  type MachineShell,
  type PermissionMode,
} from '../../shared/protocol';
import type { VarMap } from '../../shared/protocol';
import { UPLOAD_MAX_FILES } from '../../shared/uploads';
import { checkMachineShapeCoded } from './machines';

export const MAX_TEXT = 20_000;
export const MAX_CWD = 1_000;
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQ_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Optional `attachments`: upload ids (uuid), at most 10, no duplicates. Returns the list ([] when absent) or an error. */
export function parseAttachments(v: unknown): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > UPLOAD_MAX_FILES) return `attachments must be a list of at most ${UPLOAD_MAX_FILES} ids`;
  const out: string[] = [];
  for (const id of v) {
    if (typeof id !== 'string' || !UPLOAD_ID_RE.test(id)) return 'attachment id invalid';
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export type Parsed = { ok: true; msg: ClientMsg } | { ok: false; error: string; reqId?: string; code?: string; vars?: VarMap };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v);
}

/** A model id the Runner can launch (known id, has a CLI value, not disabled). */
export function launchableModel(id: unknown): string | null {
  if (typeof id !== 'string') return null;
  const m = MODEL_OPTIONS.find((o) => o.id === id);
  return m && m.cli && !m.disabled ? m.cli : null;
}

/**
 * Optional permissionMode (+ confirm for bypassPermissions) and remoteControl of a start / adopt / clip_start.
 * Returns an error string, or the parsed values (mode undefined = the caller's default).
 */
function parseJobFlags(raw: Record<string, unknown>): { mode?: PermissionMode; remoteControl?: boolean; confirm?: boolean } | string {
  const out: { mode?: PermissionMode; remoteControl?: boolean; confirm?: boolean } = {};
  if (raw.permissionMode !== undefined) {
    const m = oneOf(PERMISSION_MODES, raw.permissionMode);
    if (!m) return 'permission mode invalid';
    if (m === 'bypassPermissions' && raw.confirm !== true) return 'bypassPermissions needs confirm: true';
    out.mode = m;
    if (m === 'bypassPermissions') out.confirm = true;
  }
  if (raw.remoteControl !== undefined) {
    if (typeof raw.remoteControl !== 'boolean') return 'remoteControl must be true or false';
    out.remoteControl = raw.remoteControl;
  }
  return out;
}

function flagFields(f: { mode?: PermissionMode; remoteControl?: boolean; confirm?: boolean }): Record<string, unknown> {
  return {
    ...(f.mode ? { permissionMode: f.mode, ...(f.confirm ? { confirm: true } : {}) } : {}),
    ...(f.remoteControl !== undefined ? { remoteControl: f.remoteControl } : {}),
  };
}

const CLIP_STYLE_RE = /^(?:ours|lemo):[A-Za-z0-9._-]{1,80}$/;
const VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
export const MAX_TOPIC = 200;
export const MAX_POINTS = 1000;
export const MAX_PRESET_NAME = 60;

function oneOf<T extends string>(list: readonly T[], v: unknown): T | null {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;
}

function parseClipSettings(v: unknown): ClipSettings | string {
  if (!isRecord(v)) return 'settings must be an object';
  const length = oneOf(CLIP_LENGTHS, v.length);
  const ratio = oneOf(CLIP_RATIOS, v.ratio);
  const lang = oneOf(CLIP_LANGS, v.lang);
  if (!length) return 'length invalid';
  if (!ratio) return 'ratio invalid';
  if (!lang) return 'language invalid';
  if (typeof v.voice !== 'boolean' || typeof v.music !== 'boolean') return 'voice/music must be true or false';
  if (!Array.isArray(v.cast) || v.cast.length > CLIP_CAST.length) return 'cast invalid';
  const cast: string[] = [];
  for (const c of v.cast) {
    if (oneOf(CLIP_CAST, c) === null) return 'cast invalid';
    if (!cast.includes(c as string)) cast.push(c as string);
  }
  let outro: ClipOutro | undefined;
  if (v.outro !== undefined && v.outro !== null) {
    if (!isRecord(v.outro) || typeof v.outro.on !== 'boolean' || typeof v.outro.text !== 'string') return 'outro invalid';
    const text = cleanOutroText(v.outro.text);
    if ([...text].length > CLIP_OUTRO_MAX) return `outro too long (max ${CLIP_OUTRO_MAX})`;
    if (v.outro.on && text === '') return 'outro is on but empty';
    outro = { on: v.outro.on, text };
  }
  return { length, ratio, lang, voice: v.voice, music: v.music, cast, ...(outro ? { outro } : {}) };
}

/** machineId of a command aimed at a remote agent: null = a local command, '' = present but invalid (refuse), else the target. */
export function routeTarget(raw: unknown): string | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !REMOTE_ROUTABLE.includes(raw.type)) return null;
  if (raw.machineId === undefined || raw.machineId === null) return null;
  return typeof raw.machineId === 'string' && SAFE_ID_RE.test(raw.machineId) ? raw.machineId : '';
}

export function parseClientMsg(raw: unknown): Parsed {
  if (!isRecord(raw)) return { ok: false, error: 'message must be an object' };
  const reqId = typeof raw.reqId === 'string' && REQ_ID_RE.test(raw.reqId) ? raw.reqId : undefined;
  const bad = (error: string): Parsed => ({ ok: false, error, reqId });
  if (reqId === undefined) return bad('reqId missing or invalid');
  const type = raw.type;
  const sid = (): string | null =>
    typeof raw.sessionId === 'string' && SAFE_ID_RE.test(raw.sessionId) ? raw.sessionId : null;
  const mid = (): string | null =>
    typeof raw.machineId === 'string' && SAFE_ID_RE.test(raw.machineId) ? raw.machineId : null;
  const text = (v: unknown): string | null =>
    typeof v === 'string' && v.trim() !== '' && v.length <= MAX_TEXT ? v : null;

  switch (type) {
    case 'start': {
      if (typeof raw.cwd !== 'string' || raw.cwd === '' || raw.cwd.length > MAX_CWD) return bad('cwd invalid');
      if (launchableModel(raw.model) === null) return bad('model not available');
      if (!isEffort(raw.effort)) return bad('effort invalid');
      const atts = parseAttachments(raw.attachments);
      if (typeof atts === 'string') return bad(atts);
      const prompt = atts.length > 0 && raw.prompt === '' ? '' : text(raw.prompt);
      if (prompt === null) return bad('prompt empty or too long');
      const flags = parseJobFlags(raw);
      if (typeof flags === 'string') return bad(flags);
      return { ok: true, msg: { type, reqId, cwd: raw.cwd, model: raw.model as string, effort: raw.effort, prompt, ...(atts.length > 0 ? { attachments: atts } : {}), ...flagFields(flags) } };
    }
    case 'send': {
      const s = sid();
      const atts = parseAttachments(raw.attachments);
      if (typeof atts === 'string') return bad(atts);
      const t = atts.length > 0 && raw.text === '' ? '' : text(raw.text);
      if (!s) return bad('sessionId invalid');
      if (t === null) return bad('text empty or too long');
      return { ok: true, msg: { type, reqId, sessionId: s, text: t, ...(atts.length > 0 ? { attachments: atts } : {}) } };
    }
    case 'send_now':
    case 'stop': {
      const s = sid();
      return s ? { ok: true, msg: { type, reqId, sessionId: s } } : bad('sessionId invalid');
    }
    case 'close': {
      const s = sid();
      return s ? { ok: true, msg: { type, reqId, sessionId: s } } : bad('sessionId invalid');
    }
    case 'open_terminal': {
      // strict uuid: the id ends up on a command line (see terminal.ts)
      return typeof raw.sessionId === 'string' && UUID_RE.test(raw.sessionId)
        ? { ok: true, msg: { type, reqId, sessionId: raw.sessionId } }
        : bad('sessionId invalid');
    }
    case 'set_model': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      if (launchableModel(raw.model) === null) return bad('model not available');
      return { ok: true, msg: { type, reqId, sessionId: s, model: raw.model as string } };
    }
    case 'set_effort': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      if (!isEffort(raw.effort)) return bad('effort invalid');
      return { ok: true, msg: { type, reqId, sessionId: s, effort: raw.effort } };
    }
    case 'set_permission_mode': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      const mode = oneOf(PERMISSION_MODES, raw.mode);
      if (!mode) return bad('permission mode invalid');
      if (mode === 'bypassPermissions' && raw.confirm !== true) return bad('bypassPermissions needs confirm: true');
      return { ok: true, msg: { type, reqId, sessionId: s, mode, ...(mode === 'bypassPermissions' ? { confirm: true } : {}) } };
    }
    case 'set_remote_control': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      if (typeof raw.on !== 'boolean') return bad('on must be true or false');
      return { ok: true, msg: { type, reqId, sessionId: s, on: raw.on } };
    }
    case 'answer': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      if (typeof raw.requestId !== 'string' || !REQ_ID_RE.test(raw.requestId)) return bad('requestId invalid');
      if (raw.behavior !== 'allow' && raw.behavior !== 'deny') return bad('behavior must be allow or deny');
      let answers: Record<string, string> | undefined;
      if (raw.answers !== undefined) {
        if (!isRecord(raw.answers)) return bad('answers must be an object');
        answers = {};
        for (const [k, v] of Object.entries(raw.answers)) {
          if (typeof v !== 'string' || v.length > MAX_TEXT || k.length > MAX_TEXT) return bad('answers must map text to text');
          answers[k] = v;
        }
      }
      let message: string | undefined;
      if (raw.message !== undefined) {
        if (typeof raw.message !== 'string' || raw.message.length > 2000) return bad('message invalid');
        message = raw.message;
      }
      return { ok: true, msg: { type, reqId, sessionId: s, requestId: raw.requestId, behavior: raw.behavior, answers, message } };
    }
    case 'adopt': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      let model: string | undefined;
      if (raw.model !== undefined) {
        if (launchableModel(raw.model) === null) return bad('model not available');
        model = raw.model as string;
      }
      let effort: EffortLevel | undefined;
      if (raw.effort !== undefined) {
        if (!isEffort(raw.effort)) return bad('effort invalid');
        effort = raw.effort;
      }
      const flags = parseJobFlags(raw);
      if (typeof flags === 'string') return bad(flags);
      return { ok: true, msg: { type, reqId, sessionId: s, model, effort, ...flagFields(flags) } };
    }
    case 'takeover': {
      // strict uuid: the id picks which process gets killed (the server still re-reads the pid from its own sessions file)
      return typeof raw.sessionId === 'string' && UUID_RE.test(raw.sessionId)
        ? { ok: true, msg: { type, reqId, sessionId: raw.sessionId } }
        : bad('sessionId invalid');
    }
    case 'clip_start': {
      const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
      if (topic === '' || topic.length > MAX_TOPIC) return bad('topic empty or too long');
      const points = raw.points === undefined ? '' : raw.points;
      if (typeof points !== 'string' || points.length > MAX_POINTS) return bad('points too long');
      const settings = parseClipSettings(raw.settings);
      if (typeof settings === 'string') return bad(settings);
      if (typeof raw.styleId !== 'string' || !CLIP_STYLE_RE.test(raw.styleId)) return bad('style invalid');
      let voiceId: string | null = null;
      if (raw.voiceId !== null && raw.voiceId !== undefined) {
        if (typeof raw.voiceId !== 'string' || !VOICE_ID_RE.test(raw.voiceId)) return bad('voice id invalid');
        voiceId = raw.voiceId;
      }
      const scriptModel = oneOf(CLIP_SCRIPT_MODELS, raw.scriptModel);
      const builderModel = oneOf(CLIP_BUILDER_MODELS, raw.builderModel);
      if (!scriptModel || launchableModel(scriptModel) === null) return bad('script model not available');
      if (!builderModel || launchableModel(builderModel) === null) return bad('builder model not available');
      if (!isEffort(raw.effort)) return bad('effort invalid');
      const flags = parseJobFlags(raw);
      if (typeof flags === 'string') return bad(flags);
      return {
        ok: true,
        msg: { type, reqId, topic, points: points.trim(), settings, styleId: raw.styleId, voiceId, scriptModel, builderModel, effort: raw.effort, ...flagFields(flags) },
      };
    }
    case 'clip_preset_save': {
      const name = typeof raw.name === 'string' ? raw.name.trim() : '';
      if (name === '' || name.length > MAX_PRESET_NAME) return bad('preset name empty or too long');
      const settings = parseClipSettings(raw.settings);
      if (typeof settings === 'string') return bad(settings);
      if (typeof raw.styleId !== 'string' || !CLIP_STYLE_RE.test(raw.styleId)) return bad('style invalid');
      if (raw.id !== undefined && (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id))) return bad('preset id invalid');
      return { ok: true, msg: { type, reqId, ...(raw.id !== undefined ? { id: raw.id as string } : {}), name, settings, styleId: raw.styleId } };
    }
    case 'clip_outro_save': {
      if (typeof raw.text !== 'string') return bad('outro text invalid');
      const text = cleanOutroText(raw.text);
      if (text === '') return bad('outro text empty');
      if ([...text].length > CLIP_OUTRO_MAX) return bad(`outro too long (max ${CLIP_OUTRO_MAX})`);
      if (raw.name !== undefined && (typeof raw.name !== 'string' || [...raw.name].length > CLIP_OUTRO_NAME_MAX)) return bad('outro name too long');
      if (raw.id !== undefined && (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id))) return bad('outro id invalid');
      return { ok: true, msg: { type, reqId, ...(raw.id !== undefined ? { id: raw.id as string } : {}), ...(raw.name !== undefined ? { name: (raw.name as string).trim() } : {}), text } };
    }
    case 'clip_outro_delete':
    case 'clip_preset_delete':
    case 'clip_dequeue': {
      return typeof raw.id === 'string' && SAFE_ID_RE.test(raw.id) ? { ok: true, msg: { type, reqId, id: raw.id } } : bad('id invalid');
    }
    case 'clip_render': {
      const s = sid();
      return s ? { ok: true, msg: { type, reqId, sessionId: s } } : bad('sessionId invalid');
    }
    case 'link_create': {
      const from = typeof raw.from === 'string' && SAFE_ID_RE.test(raw.from) ? raw.from : null;
      const to = typeof raw.to === 'string' && SAFE_ID_RE.test(raw.to) ? raw.to : null;
      if (!from) return bad('from invalid');
      if (!to) return bad('to invalid');
      let maxForwards: number | undefined;
      if (raw.maxForwards !== undefined) {
        const n = raw.maxForwards;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > LINK_MAX_FORWARDS_LIMIT) return bad('maxForwards must be 1..50');
        maxForwards = n;
      }
      return { ok: true, msg: { type, reqId, from, to, ...(maxForwards !== undefined ? { maxForwards } : {}) } };
    }
    case 'link_delete':
    case 'link_resume': {
      const id = typeof raw.linkId === 'string' && SAFE_ID_RE.test(raw.linkId) ? raw.linkId : null;
      return id ? { ok: true, msg: { type, reqId, linkId: id } } : bad('linkId invalid');
    }
    case 'link_pause': {
      const id = typeof raw.linkId === 'string' && SAFE_ID_RE.test(raw.linkId) ? raw.linkId : null;
      if (!id) return bad('linkId invalid');
      if (typeof raw.paused !== 'boolean') return bad('paused must be true or false');
      return { ok: true, msg: { type, reqId, linkId: id, paused: raw.paused } };
    }
    case 'ask': {
      const q = typeof raw.question === 'string' ? raw.question.trim() : '';
      if (q === '' || q.length > 500) return bad('question empty or too long');
      return { ok: true, msg: { type, reqId, question: q } };
    }
    case 'saved_hide':
    case 'saved_unhide': {
      const s = sid();
      return s ? { ok: true, msg: { type, reqId, sessionId: s } } : bad('sessionId invalid');
    }
    case 'saved_resume': {
      const s = sid();
      if (!s) return bad('sessionId invalid');
      let model: string | undefined;
      if (raw.model !== undefined) {
        if (launchableModel(raw.model) === null) return bad('model not available');
        model = raw.model as string;
      }
      let effort: EffortLevel | undefined;
      if (raw.effort !== undefined) {
        if (!isEffort(raw.effort)) return bad('effort invalid');
        effort = raw.effort;
      }
      const flags = parseJobFlags({ permissionMode: raw.permissionMode, confirm: raw.confirm });
      if (typeof flags === 'string') return bad(flags);
      return { ok: true, msg: { type, reqId, sessionId: s, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...flagFields(flags) } };
    }
    case 'machine_add':
    case 'machine_update': {
      let machineId = '';
      if (type === 'machine_update') {
        const id = mid();
        if (!id) return bad('machineId invalid');
        machineId = id;
      }
      const err = checkMachineShapeCoded(raw);
      if (err) return { ok: false, error: err.text, reqId, code: err.code, ...(err.vars ? { vars: err.vars } : {}) };
      const fields = {
        name: (raw.name as string).trim(),
        host: raw.host as string,
        user: raw.user as string,
        keyPath: (raw.keyPath as string).trim(),
        shell: raw.shell as MachineShell,
        ...(raw.notes !== undefined ? { notes: raw.notes as string } : {}),
        ...(raw.agent !== undefined ? { agent: raw.agent as boolean } : {}),
      };
      return type === 'machine_add'
        ? { ok: true, msg: { type, reqId, ...fields } }
        : { ok: true, msg: { type, reqId, machineId, ...fields } };
    }
    case 'machine_delete':
    case 'machine_test': {
      const id = mid();
      return id ? { ok: true, msg: { type, reqId, machineId: id } } : bad('machineId invalid');
    }
    case 'machine_attach':
    case 'machine_detach': {
      const s = sid();
      const id = mid();
      if (!s) return bad('sessionId invalid');
      if (!id) return bad('machineId invalid');
      return { ok: true, msg: { type, reqId, sessionId: s, machineId: id } };
    }
    default:
      return bad('unknown command type');
  }
}
