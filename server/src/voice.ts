// Voice previews: ElevenLabs eleven_v3 text-to-speech, cached on disk.
//
//  - The API key comes from the secrets vault (`secrets get tools/elevenlabs.enc`) once at server start. It lives
//    only in this process's memory: never logged, never written to disk, never sent to the browser.
//  - Cache: ~/.claude-control-room/voice-cache/<sha256(voice + model + text)>.mp3. A repeat of the same
//    voice + model + text is served from disk and costs no credits.
//  - Calls are serialised (ElevenLabs answers 429 to parallel requests) and identical in-flight requests share one call.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLIP_VOICE_MODEL } from '../../shared/protocol';
import { dataDir, type LogFn } from './cmdlog';

export const MAX_SAMPLE_CHARS = 120;
export const VAULT_ENTRY = 'tools/elevenlabs.enc';
const VOICE_ID_RE = /^[A-Za-z0-9]{8,40}$/;
const KEY_RE = /sk_[A-Za-z0-9]{16,}/;
const TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';

export interface VoiceEntry {
  id: string;
  name: string;
  builtin: boolean; // seeded entries cannot be removed
}

export const SEED_VOICES: readonly { id: string; name: string }[] = [
  { id: 'KhBRXgEQjvfdIyXOu7G3', name: 'เสียงหลักที่คุณเลือก' },
  { id: '2rg92Q2u0RWu8LiUcLQA', name: 'เสียงของ ai-glossary / FRL unit' },
  { id: 'bIHbv24MWmeRgasZH58o', name: 'Will · เสียงของ Freshy Guide' },
];

export const DEFAULT_SAMPLE = 'สวัสดีครับ วันนี้เรามาทำความรู้จักกับ FRL unit กัน';

export function voiceCacheDir(): string {
  return path.join(dataDir(), 'voice-cache');
}

export function isVoiceId(v: unknown): v is string {
  return typeof v === 'string' && VOICE_ID_RE.test(v);
}

/** Sample sentence after trimming; null when empty or longer than MAX_SAMPLE_CHARS characters. */
export function cleanSample(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  const n = [...t].length;
  return n >= 1 && n <= MAX_SAMPLE_CHARS ? t : null;
}

/** Cache key: sha256 of voice + model + text (separated so no two triples collide). */
export function voiceCacheKey(voiceId: string, model: string, text: string): string {
  return createHash('sha256').update(`${voiceId}\n${model}\n${text}`, 'utf8').digest('hex');
}

export function cacheFile(dir: string, key: string): string {
  return path.join(dir, `${key}.mp3`);
}

/** Pulls the sk_ token out of `secrets get` output. Returns null when none is there. */
export function parseKey(output: string): string | null {
  const m = KEY_RE.exec(output);
  return m ? m[0] : null;
}

/** Reads the key through the `secrets` script (a bash script: run it with bash on Windows). Never throws; null = unavailable. */
export function readKeyFromVault(entry: string = VAULT_ENTRY, parse: (out: string) => string | null = parseKey): Promise<string | null> {
  const script = process.env.CR_SECRETS_BIN || path.join(process.env.USERPROFILE || process.env.HOME || '', 'secrets', 'bin', 'secrets');
  const bashes = [process.env.CR_BASH, 'C:\\Program Files\\Git\\bin\\bash.exe', 'bash'].filter((b): b is string => !!b);
  const attempt = (i: number): Promise<string | null> =>
    new Promise((resolve) => {
      if (i >= bashes.length) return resolve(null);
      execFile(bashes[i], [script.replace(/\\/g, '/'), 'get', entry], { windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
        const key = err ? null : parse(String(stdout));
        if (key) resolve(key);
        else void attempt(i + 1).then(resolve);
      });
    });
  return attempt(0);
}

export class VoiceError extends Error {}

export interface PreviewResult {
  hash: string;
  cached: boolean;
  bytes: number;
}

export interface VoiceStore {
  listVoices(): VoiceEntry[];
  addVoice(id: string, name: string): void;
  removeVoice(id: string): boolean;
}

export interface VoiceServiceOptions {
  store: VoiceStore;
  getKey: () => string | null | Promise<string | null>;
  cacheDir?: string;
  fetchFn?: typeof fetch;
  log?: LogFn;
  model?: string;
}

/** Short reason for a failed ElevenLabs call (never includes the request headers or the key). */
function httpReason(status: number): string {
  if (status === 401 || status === 403) return 'ElevenLabs ปฏิเสธ key (สิทธิ์ไม่พอหรือหมดอายุ)';
  if (status === 429) return 'ElevenLabs ตอบ 429 (เรียกถี่เกินหรือเครดิตหมด) รอสักครู่แล้วลองใหม่';
  if (status === 400 || status === 404 || status === 422) return `ElevenLabs ปฏิเสธคำขอ (${status}): ตรวจ voice ID / ประโยค`;
  return `ElevenLabs ผิดพลาด (${status})`;
}

export class VoiceService {
  readonly cacheDir: string;
  private readonly opts: VoiceServiceOptions;
  private readonly model: string;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly inflight = new Map<string, Promise<PreviewResult>>();
  apiCalls = 0; // real ElevenLabs requests made by this process

  constructor(opts: VoiceServiceOptions) {
    this.opts = opts;
    this.cacheDir = opts.cacheDir ?? voiceCacheDir();
    this.model = opts.model ?? CLIP_VOICE_MODEL;
  }

  list(): VoiceEntry[] {
    return this.opts.store.listVoices();
  }

  add(id: string, name: string): void {
    if (!isVoiceId(id)) throw new VoiceError('voice ID ไม่ถูกต้อง (ตัวอักษร/ตัวเลข 8-40 ตัว)');
    const n = name.trim().slice(0, 60) || 'เสียงที่เพิ่มเอง';
    this.opts.store.addVoice(id, n);
  }

  remove(id: string): boolean {
    return this.opts.store.removeVoice(id);
  }

  /** Path of a cached mp3 by its hash, only for well-formed hashes. */
  audioFile(hash: string): string | null {
    if (!/^[0-9a-f]{64}$/.test(hash)) return null;
    const f = cacheFile(this.cacheDir, hash);
    try {
      return fs.statSync(f).size > 0 ? f : null;
    } catch {
      return null;
    }
  }

  preview(voiceId: string, rawText: string): Promise<PreviewResult> {
    if (!isVoiceId(voiceId)) return Promise.reject(new VoiceError('voice ID ไม่ถูกต้อง'));
    const text = cleanSample(rawText);
    if (text === null) return Promise.reject(new VoiceError(`ประโยคทดลองต้องมี 1-${MAX_SAMPLE_CHARS} ตัวอักษร`));
    const hash = voiceCacheKey(voiceId, this.model, text);
    const file = cacheFile(this.cacheDir, hash);
    try {
      const size = fs.statSync(file).size;
      if (size > 0) {
        this.opts.log?.({ cmd: 'voice_preview', voiceId, cached: true, chars: [...text].length });
        return Promise.resolve({ hash, cached: true, bytes: size });
      }
    } catch {
      // not cached
    }
    const running = this.inflight.get(hash);
    if (running) return running;
    const job = this.chain.then(() => this.generate(voiceId, text, hash, file));
    this.chain = job.catch(() => undefined);
    this.inflight.set(hash, job);
    const done = () => this.inflight.delete(hash);
    job.then(done, done);
    return job;
  }

  private async generate(voiceId: string, text: string, hash: string, file: string): Promise<PreviewResult> {
    // The queue may have produced this file while we waited.
    try {
      const size = fs.statSync(file).size;
      if (size > 0) return { hash, cached: true, bytes: size };
    } catch {
      // still missing
    }
    const key = await this.opts.getKey();
    if (!key) throw new VoiceError('ยังไม่มี key ElevenLabs (secrets get tools/elevenlabs.enc อ่านไม่ได้ตอนเริ่ม server)');
    const body: Record<string, unknown> = { text, model_id: this.model };
    if (/[฀-๿]/.test(text)) body.language_code = 'th';
    const f = this.opts.fetchFn ?? fetch;
    this.apiCalls++;
    let res: Response;
    try {
      res = await f(`${TTS_URL}/${voiceId}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json; charset=utf-8', Accept: 'audio/mpeg' },
        body: Buffer.from(JSON.stringify(body), 'utf8'), // UTF-8 bytes, never a shell string
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      this.opts.log?.({ cmd: 'voice_preview', voiceId, cached: false, ok: false, error: 'network' });
      throw new VoiceError(`เรียก ElevenLabs ไม่ได้: ${e instanceof Error ? e.name : 'network error'}`);
    }
    if (!res.ok) {
      this.opts.log?.({ cmd: 'voice_preview', voiceId, cached: false, ok: false, status: res.status });
      throw new VoiceError(httpReason(res.status));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new VoiceError('ElevenLabs ส่งเสียงกลับมาสั้นผิดปกติ');
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const tmp = `${file}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    this.opts.log?.({ cmd: 'voice_preview', voiceId, cached: false, ok: true, bytes: buf.length, chars: [...text].length });
    return { hash, cached: false, bytes: buf.length };
  }
}
