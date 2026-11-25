// Clip jobs: a clip is a normal Runner session started with a generated brief in a new folder ~/videos/<slug>.
// This service owns what is clip-specific: the folder, the brief, the stage progress and the "render ได้" message.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLIP_OUTRO_MAX, CLIP_OUTRO_NAME_MAX, CLIP_OUTRO_SAVED_MAX, CLIP_PERMISSION_MODE, CLIP_PRESET_MAX, cleanOutroText, type ClipOutroPhrase, CLIP_STAGES, type ClipJob, type ClipPreset, type ClipQueueItem, type ClipSettings, type ClipStartInput, type SessionInfo } from '../../shared/protocol';
import { buildClipPrompt, slugify, type ResolvedStyle } from './clipPrompt';
import { inferStage, listNewFiles } from './clipProgress';
import type { WorklogDb } from './db';
import { ourStyleById } from './ourStyles';
import { CommandError, type Runner } from './runner';
import type { LemoList } from './styles';

export const RENDER_MESSAGE = 'render ได้';

export function defaultVideosDir(): string {
  const o = process.env.CR_VIDEOS_DIR;
  return o && o.trim() !== '' ? o : path.join(os.homedir(), 'videos');
}

/** Picks a folder name that does not exist yet: slug, slug-2, slug-3 ... */
export function freeFolderName(videosDir: string, slug: string, exists: (p: string) => boolean = fs.existsSync): string {
  let name = slug;
  for (let n = 2; exists(path.join(videosDir, name)); n++) name = `${slug}-${n}`;
  return name;
}

/** How many clips may generate at the same time (CR_CLIP_CONCURRENCY, default 2, at least 1). */
export function clipConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CR_CLIP_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : 2;
}

const RATIO_WORD: Record<ClipSettings['ratio'], string> = { '16:9': 'แนวนอน 16:9', '9:16': 'แนวตั้ง 9:16', '1:1': 'จัตุรัส 1:1' };
const LENGTH_WORD: Record<ClipSettings['length'], string> = { '30s': '30 วิ', '60s': '60 วิ', '90s': '90 วิ', '3min': '3 นาที' };

/** Name given to a preset seeded from past clips, e.g. "Whiteboard · แนวตั้ง 9:16 · 60 วิ". */
export function suggestPresetName(s: ClipSettings, styleName: string): string {
  return `${styleName} · ${RATIO_WORD[s.ratio]} · ${LENGTH_WORD[s.length]}`;
}

export interface ClipView {
  jobs: ClipJob[];
  queue: ClipQueueItem[];
  presets: ClipPreset[];
  outros: ClipOutroPhrase[];
}

export interface ClipDeps {
  db: WorklogDb;
  runner: Pick<Runner, 'start' | 'send' | 'isAlive'>;
  sessions: () => SessionInfo[];
  lemo: () => LemoList;
  videosDir?: string;
  now?: () => number;
  scanThrottleMs?: number;
  concurrency?: number; // generation jobs at once; default CR_CLIP_CONCURRENCY or 2
  newId?: () => string;
  /** Env for the clip's child process only (the ElevenLabs key). Synchronous; never put into the brief, a log or the DB. */
  clipEnv?: () => Record<string, string>;
}

export class ClipService extends EventEmitter {
  private readonly deps: ClipDeps;
  private readonly videosDir: string;
  private readonly now: () => number;
  private readonly lastScan = new Map<string, number>();

  constructor(deps: ClipDeps) {
    super();
    this.deps = deps;
    this.videosDir = path.resolve(deps.videosDir ?? defaultVideosDir());
    this.now = deps.now ?? Date.now;
    this.deps.db.seedPresetsOnce(this.now(), suggestPresetName, this.newId);
  }

  private readonly newId = (): string => (this.deps.newId ?? randomUUID)();
  private pumping = false;

  jobs(): ClipJob[] {
    return this.deps.db.listClips();
  }

  queue(): ClipQueueItem[] {
    return this.deps.db.listQueued().map((q) => q.item);
  }

  presets(): ClipPreset[] {
    return this.deps.db.listPresets();
  }

  view(): ClipView {
    return { jobs: this.jobs(), queue: this.queue(), presets: this.presets(), outros: this.deps.db.listOutros() };
  }

  /** Jobs that hold a generation slot: started, not yet at "พร้อม render", and their session is still running. */
  activeCount(): number {
    return this.jobs().filter((j) => !j.ready && this.deps.runner.isAlive(j.sessionId)).length;
  }

  private get limit(): number {
    return Math.max(1, this.deps.concurrency ?? clipConcurrency());
  }

  /**
   * The only entry for "queue a clip": checks the request now (so a bad style or missing voice is refused at once),
   * stores it, then starts as many waiting clips as free slots allow. Returns the session id when it started
   * right away, otherwise null (it waits as "รอคิว") together with the queue id.
   */
  enqueue(req: ClipStartInput): { queueId: string; sessionId: string | null } {
    const { name } = this.resolveStyle(req.styleId);
    if (req.settings.voice && !req.voiceId) throw new CommandError('เลือกเสียงพากย์ก่อน (หรือปิดเสียงพากย์)', 'srv.clip.voiceRequired');
    const queueId = this.newId();
    this.deps.db.enqueueClip(queueId, req, name, this.now());
    const started = this.pump();
    if (started.size === 0) this.emit('change', this.jobs()); // pump stays quiet when nothing started: the new waiting entry still has to reach the browsers
    return { queueId, sessionId: started.get(queueId) ?? null };
  }

  /** Removes a waiting clip. A clip that already started is a job, not a queue entry: close it from its session instead. */
  dequeue(id: string): void {
    if (!this.deps.db.removeQueued(id)) throw new CommandError('คลิปนี้ไม่ได้อยู่ในคิวแล้ว (เริ่มทำไปแล้ว?)', 'srv.clip.notQueued');
    this.emit('change', this.jobs());
  }

  /** Starts waiting clips (oldest first) while there are free slots. Safe to call at any time. */
  pump(): Map<string, string> {
    const started = new Map<string, string>(); // queue id -> session id
    if (this.pumping) return started;
    this.pumping = true;
    let changed = false;
    try {
      for (const q of this.deps.db.listQueued()) {
        if (q.item.error) continue; // failed to start: stays listed until the user removes it, never retried
        if (this.activeCount() >= this.limit) break;
        try {
          const sessionId = this.launch(q.input);
          started.set(q.item.id, sessionId);
          this.deps.db.removeQueued(q.item.id);
        } catch (e) {
          this.deps.db.setQueuedError(q.item.id, e instanceof Error ? e.message : String(e));
        }
        changed = true;
      }
    } finally {
      this.pumping = false;
    }
    if (changed) this.emit('change', this.jobs());
    return started;
  }

  // ---- presets ----

  /** New preset (no id) or rename / update of an existing one. Returns the preset id. */
  savePreset(input: { id?: string; name: string; settings: ClipSettings; styleId: string }): string {
    const name = input.name.trim();
    if (name === '') throw new CommandError('ตั้งชื่อชุดก่อน', 'srv.clip.presetNameRequired');
    this.resolveStyle(input.styleId); // refuses an unknown style
    const db = this.deps.db;
    const list = db.listPresets();
    const old = input.id ? db.getPreset(input.id) : null;
    if (input.id && !old) throw new CommandError('ไม่พบชุดนี้ (ถูกลบไปแล้ว?)', 'srv.clip.presetMissing');
    if (!old && list.length >= CLIP_PRESET_MAX) {
      throw new CommandError(`เก็บชุดได้ไม่เกิน ${CLIP_PRESET_MAX} ชุด ลบชุดเก่าก่อน`, 'srv.clip.presetFull', { max: CLIP_PRESET_MAX });
    }
    if (list.some((p) => p.id !== old?.id && p.name === name)) throw new CommandError('มีชุดชื่อนี้อยู่แล้ว', 'srv.clip.presetNameTaken');
    const id = old?.id ?? this.newId();
    db.savePreset({ id, name, settings: input.settings, styleId: input.styleId, createdAt: old?.createdAt ?? this.now(), suggested: false });
    this.emit('change', this.jobs());
    return id;
  }

  // ---- saved endings ----

  /** New saved ending (no id) or rename / new text of an existing one. Returns its id. */
  saveOutro(input: { id?: string; name?: string; text: string }): string {
    const text = cleanOutroText(input.text);
    if (text === '') throw new CommandError('พิมพ์คำท้ายก่อนบันทึก', 'srv.clip.outroRequired');
    if ([...text].length > CLIP_OUTRO_MAX) throw new CommandError(`คำท้ายยาวเกิน ${CLIP_OUTRO_MAX} ตัวอักษร`, 'srv.clip.outroTooLong', { max: CLIP_OUTRO_MAX });
    const db = this.deps.db;
    const old = input.id ? db.listOutros().find((o) => o.id === input.id) : undefined;
    if (input.id && !old) throw new CommandError('ไม่พบคำท้ายนี้ (ถูกลบไปแล้ว?)', 'srv.clip.outroMissing');
    if (!old && db.listOutros().length >= CLIP_OUTRO_SAVED_MAX) {
      throw new CommandError(`เก็บคำท้ายได้ไม่เกิน ${CLIP_OUTRO_SAVED_MAX} อัน ลบอันเก่าก่อน`, 'srv.clip.outroFull', { max: CLIP_OUTRO_SAVED_MAX });
    }
    const rawName = (input.name ?? '').replace(/\s+/g, ' ').trim();
    const name = (rawName !== '' ? rawName : text.replace(/\s+/g, ' ')).slice(0, rawName !== '' ? CLIP_OUTRO_NAME_MAX : 20);
    const id = old?.id ?? this.newId();
    db.saveOutro({ id, name, text, createdAt: old?.createdAt ?? this.now() });
    this.emit('change', this.jobs());
    return id;
  }

  deleteOutro(id: string): void {
    if (!this.deps.db.deleteOutro(id)) throw new CommandError('ไม่พบคำท้ายนี้', 'srv.clip.outroNotFound');
    this.emit('change', this.jobs());
  }

  deletePreset(id: string): void {
    if (!this.deps.db.deletePreset(id)) throw new CommandError('ไม่พบชุดนี้', 'srv.clip.presetNotFound');
    this.emit('change', this.jobs());
  }

  /** One clip job by its session id, whether or not the session is live right now. */
  find(sessionId: string): ClipJob | null {
    return this.deps.db.getClip(sessionId);
  }

  private resolveStyle(styleId: string): { style: ResolvedStyle; name: string } {
    const [kind, id] = [styleId.slice(0, styleId.indexOf(':')), styleId.slice(styleId.indexOf(':') + 1)];
    if (kind === 'ours') {
      const s = ourStyleById(id);
      if (!s) throw new CommandError('ไม่รู้จักสไตล์นี้', 'srv.clip.styleUnknown');
      return { style: { kind: 'ours', style: s }, name: s.name };
    }
    if (kind === 'lemo') {
      const list = this.deps.lemo();
      if (!list.installed) throw new CommandError('ยังไม่ได้ติดตั้ง Lemo-Opuscar', 'srv.clip.lemoNotInstalled');
      const s = list.styles.find((x) => x.id === id);
      if (!s) throw new CommandError('ไม่พบสไตล์ Lemo นี้ (กด "โหลดรายการสไตล์ใหม่")', 'srv.clip.lemoStyleMissing');
      return { style: { kind: 'lemo', style: s }, name: s.name };
    }
    throw new CommandError('สไตล์ไม่ถูกต้อง', 'srv.clip.styleInvalid');
  }

  /** Starts one clip right now, whatever the queue holds (the queue calls launch(); tests and callers that want it now call this). */
  start(req: ClipStartInput): string {
    const id = this.launch(req);
    this.emit('change', this.jobs());
    return id;
  }

  /** Creates the folder, starts the session and records the job. Returns the new session id. Does not emit. */
  private launch(req: ClipStartInput): string {
    const { style, name } = this.resolveStyle(req.styleId);
    if (req.settings.voice && !req.voiceId) throw new CommandError('เลือกเสียงพากย์ก่อน (หรือปิดเสียงพากย์)', 'srv.clip.voiceRequired');
    const stamp = new Date(this.now()).toISOString().slice(0, 10);
    const slug = freeFolderName(this.videosDir, slugify(req.topic, `clip-${stamp}`));
    const cwd = path.join(this.videosDir, slug);
    if (path.dirname(path.resolve(cwd)) !== this.videosDir) throw new CommandError('ชื่อโฟลเดอร์ไม่ถูกต้อง', 'srv.clip.folderInvalid');
    fs.mkdirSync(this.videosDir, { recursive: true });
    fs.mkdirSync(cwd); // not recursive: fails if somebody created it meanwhile
    const prompt = buildClipPrompt({ req, style, cwd });
    let sessionId: string;
    try {
      sessionId = this.deps.runner.start(
        {
          cwd,
          model: req.builderModel,
          effort: req.effort,
          prompt,
          permissionMode: req.permissionMode ?? CLIP_PERMISSION_MODE,
          remoteControl: req.remoteControl === true,
        },
        { trustedCwd: true, extraEnv: this.deps.clipEnv?.() ?? {} },
      );
    } catch (e) {
      try {
        fs.rmdirSync(cwd); // only succeeds while empty
      } catch {
        // leave it
      }
      throw e;
    }
    this.deps.db.insertClip({
      sessionId,
      topic: req.topic.trim(),
      slug,
      cwd,
      styleId: req.styleId,
      styleName: name,
      settings: req.settings,
      voiceId: req.settings.voice ? req.voiceId : null,
      scriptModel: req.scriptModel,
      builderModel: req.builderModel,
      createdAt: this.now(),
      stage: 0,
      ready: false,
      renderRequested: false,
    });
    return sessionId;
  }

  /** The "สั่ง render" button: only at พร้อม render, sends the fixed message to that job and nothing else. */
  render(sessionId: string): void {
    const job = this.deps.db.getClip(sessionId);
    if (!job) throw new CommandError('ไม่ใช่งานคลิป', 'srv.clip.notClipJob');
    if (job.stage < CLIP_STAGES.length - 1) throw new CommandError('งานยังไม่ถึงขั้น พร้อม render', 'srv.clip.notReady');
    if (job.renderRequested) throw new CommandError('สั่ง render ไปแล้ว', 'srv.clip.renderAlready');
    if (!this.deps.runner.isAlive(sessionId)) {
      throw new CommandError('งานนี้ไม่ได้ทำงานอยู่ใต้ Runner (เปิดแชทเต็มจอแล้วรับช่วงก่อน)', 'srv.clip.notRunner');
    }
    this.deps.runner.send(sessionId, RENDER_MESSAGE);
    this.deps.db.setClipRenderRequested(sessionId);
    this.emit('change', this.jobs());
  }

  /** Recomputes the stage of one clip job from its session (or all jobs). Emits 'change' when something moved. */
  refresh(sessionId?: string): void {
    const sessions = this.deps.sessions();
    let changed = false;
    for (const job of this.jobs()) {
      if (sessionId && job.sessionId !== sessionId) continue;
      if (job.stage >= CLIP_STAGES.length - 1) continue; // top stage: nothing further to infer
      const s = sessions.find((x) => x.sessionId === job.sessionId);
      if (!s) continue;
      const t = this.now();
      let files: string[] | undefined;
      if (t - (this.lastScan.get(job.sessionId) ?? 0) >= (this.deps.scanThrottleMs ?? 3000)) {
        this.lastScan.set(job.sessionId, t);
        files = listNewFiles(job.cwd, job.createdAt, fs);
      }
      const stage = Math.max(job.stage, inferStage({ events: s.timeline, thought: s.thought, files }));
      if (stage > job.stage) {
        this.deps.db.setClipStage(job.sessionId, stage);
        changed = true;
      }
    }
    if (changed) {
      this.emit('change', this.jobs());
      this.pump(); // a clip that reached "พร้อม render" frees its slot
    }
  }
}
