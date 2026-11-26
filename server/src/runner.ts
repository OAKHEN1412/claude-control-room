// Runner: starts and drives `claude -p --input-format stream-json` children for the web UI.
//
// Two layers:
//  - RunnerSession: the protocol layer around ONE child (stdin/stdout streams). It knows nothing
//    about processes except pid/kill, so tests feed it a fake child.
//  - Runner: the manager (cwd whitelist, spawning, ownership of sessions by id).
//
// Safety rules kept here:
//  - every can_use_tool request is HELD until a user answers it (never auto-allowed);
//  - children are always started with an explicit --permission-mode (default unless the command says otherwise),
//    never the user's own settings default (which may be bypassPermissions);
//  - a child is only ever killed by the exact PID the Runner spawned (ChildLike.kill).
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';
import {
  DEFAULT_PERMISSION_MODE,
  MODEL_OPTIONS,
  PERMISSION_MODES,
  type AskQuestion,
  type EffortLevel,
  type PendingRequest,
  type PermissionMode,
  type RunnerState,
  type LimitInfo,
  type SlashCommand,
  LIMIT_TEXT_RE,
  DEFAULT_EFFORT,
} from '../../shared/protocol';

import { TERMINAL_ACCOUNT_ID } from '../../shared/accounts';
import { buildUserContent, type UserContent } from './attachments';
import type { AccountPort } from './accountPort';
import { CodedError } from './codedError';
import { parseQuestions } from './questions';
import { stripSecrets } from './secrets';
import { trimCommands } from './slashCommands';
import { toolLabel } from './toolLabels';
import type { StoredUpload } from './uploads';

/** The part of a tool label after "<label>: " (the key detail), '' when none. */
export function labelDetail(label: string): string {
  const k = label.indexOf(': ');
  return k >= 0 ? label.slice(k + 2) : '';
}

export class CommandError extends CodedError {}

/** A finished turn of a Runner job (its stream `result` event). */
export interface TurnEnd {
  sessionId: string;
  text: string; // final assistant text ('' when none)
  isError: boolean;
  interrupted: boolean;
}

export interface ChildLike extends EventEmitter {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ChildLike;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One account switch of a job: when, and the profile NAMES before and after. */
export interface AccountSwitchEntry {
  at: number;
  from: string;
  to: string;
}

export interface SessionOptions {
  sessionId: string;
  cwd: string;
  child: ChildLike;
  model: string | null;
  effort: string | null;
  permissionMode?: PermissionMode;
  remoteControl?: boolean; // turn Remote Control on once the child has initialised
  accountId?: string; // profile the child runs as (reported in state(); absent when accounts are not used)
  now?: () => number;
  controlTimeoutMs?: number; // wait for a control_response
  stopGraceMs?: number; // after interrupt, kill the child if the turn has not ended
  settleMs?: number; // a result with unconsumed messages: wait this long for the replay before going idle
}

interface Waiter {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Held {
  pending: PendingRequest;
  input: Record<string, unknown>;
}

const INPUT_PREVIEW_MAX = 2000;
const STDERR_KEEP = 2000;

const limitLine = (t: string): string => {
  const l = (t.split(/\r?\n/).find((x) => x.trim() !== '') ?? t).replace(/\s+/g, ' ').trim();
  return l.length > 160 ? `${l.slice(0, 159)}…` : l;
};

const QUEUED_TEXT_MAX = 300;

interface QueuedMsg {
  text: string; // clipped, secrets stripped (shown in the UI)
  full: string; // the original text, kept for send_now
  at: number;
  names: string[]; // attachment file names
  ids: string[]; // upload ids, to re-attach on send_now
}

/** What Runner.send knows about a message besides its content. */
export interface SendMeta {
  text: string;
  names?: string[];
  ids?: string[];
}

function contentText(c: UserContent): string {
  if (typeof c === 'string') return c;
  return c
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter((t) => t !== '')
    .join('\n');
}

/** The one message send_now delivers: texts joined by blank lines, attachment ids in order without repeats. */
export function combineQueued(items: readonly { text: string; ids: readonly string[] }[]): { text: string; ids: string[] } {
  const texts = items.map((i) => i.text.trim()).filter((t) => t !== '');
  const ids: string[] = [];
  for (const i of items) for (const id of i.ids) if (!ids.includes(id)) ids.push(id);
  return { text: texts.join('\n\n'), ids };
}

/** Protocol layer around one stream-json child. Emits 'change' (RunnerState) and 'exit'. */
export class RunnerSession extends EventEmitter {
  readonly sessionId: string;
  readonly cwd: string;
  private readonly child: ChildLike;
  private readonly now: () => number;
  private readonly controlTimeoutMs: number;
  private readonly stopGraceMs: number;
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';
  private stderrTail = '';
  private readonly waiters = new Map<string, Waiter>();
  private readonly held = new Map<string, Held>();
  private stopTimer: NodeJS.Timeout | null = null;
  private killed = false;
  private readonly startedAt: number;
  // Turn accounting. Messages sent while a turn runs are merged into it by Claude (one `result` for
  // several messages), so results cannot be counted. With --replay-user-messages the child echoes each
  // user message (isReplay) when it consumes it: the queue = sent - consumed.
  private busy = false;
  // One entry per message sent and not yet consumed (oldest first); unconsumed === queue.length by construction.
  private queue: QueuedMsg[] = [];
  private turnStarts = 0; // child-side turn starts seen: a replay echo of one of our messages, or a new `system init`
  private stopping = false;
  private settleTimer: NodeJS.Timeout | null = null;
  private readonly settleMs: number;
  private model: string | null;
  private effort: string | null;
  private permissionMode: PermissionMode;
  private remoteControl = false;
  private remoteUrl: string | undefined;
  private wantRemote: boolean;
  private readonly accountId: string | undefined;
  private accountPending: string | undefined; // profile of a switch waiting for the turn to end
  private accountLog: AccountSwitchEntry[] | undefined; // last switches of this job (names, not ids)
  private confirmed = false;
  private alive = true;
  private error: string | undefined;
  private lastJson = '';
  private limit: LimitInfo | undefined; // usage/rate limit seen on the stream, cleared by the next normal answer
  private turnText = ''; // text of the latest main-thread assistant message in the running turn

  constructor(opts: SessionOptions) {
    super();
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.child = opts.child;
    this.model = opts.model;
    this.effort = opts.effort;
    this.permissionMode = opts.permissionMode ?? DEFAULT_PERMISSION_MODE;
    this.wantRemote = opts.remoteControl === true;
    this.accountId = opts.accountId;
    this.now = opts.now ?? Date.now;
    this.controlTimeoutMs = opts.controlTimeoutMs ?? 10_000;
    this.stopGraceMs = opts.stopGraceMs ?? 5_000;
    this.settleMs = opts.settleMs ?? 3_000;
    this.startedAt = this.now();

    opts.child.stdout.on('data', (chunk: Buffer | string) => this.onData(chunk));
    opts.child.stdout.on('end', () => this.flushLine());
    opts.child.stderr?.on('data', (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_KEEP);
    });
    opts.child.stdin.on('error', () => {
      // EPIPE after the child died: handled through 'exit'
    });
    opts.child.on('error', (e: Error) => this.onExit(`spawn error: ${e.message}`));
    opts.child.on('exit', (code: number | null, signal: string | null) => {
      const why = this.killed || code === 0 ? undefined : `exited code=${code ?? ''} ${signal ?? ''}`.trim();
      this.onExit(why);
    });
  }

  // ---- state ----

  state(): RunnerState {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      alive: this.alive,
      pid: this.child.pid ?? null,
      busy: this.alive && this.busy,
      queued: this.alive ? this.queue.length : 0,
      ...(this.alive && this.queue.length > 0 ? { queuedTexts: this.queue.map((q) => ({ text: q.text, at: q.at, ...(q.names.length > 0 ? { files: q.names } : {}) })) } : {}),
      model: this.model,
      effort: this.effort,
      confirmed: this.confirmed,
      permissionMode: this.permissionMode,
      remoteControl: this.alive && this.remoteControl,
      ...(this.alive && this.remoteControl && this.remoteUrl ? { remoteUrl: this.remoteUrl } : {}),
      ...(this.alive && this.limit ? { limit: this.limit } : {}),
      pending: [...this.held.values()].map((h) => h.pending),
      ...(this.error !== undefined ? { error: this.error } : {}),
      startedAt: this.startedAt,
      ...(this.accountId !== undefined ? { accountId: this.accountId } : {}),
      ...(this.accountPending !== undefined ? { accountPending: this.accountPending } : {}),
      ...(this.accountLog && this.accountLog.length > 0 ? { accountLog: this.accountLog.map((e) => ({ ...e })) } : {}),
    };
  }

  /** Account-switch bookkeeping kept on the job: `pending` = switch waiting for the turn to end (undefined clears it). */
  setAccountMeta(meta: { pending?: string; log?: AccountSwitchEntry[] }): void {
    if ('pending' in meta) this.accountPending = meta.pending;
    if (meta.log !== undefined) this.accountLog = meta.log;
    this.changed();
  }

  private changed(): void {
    const s = this.state();
    const j = JSON.stringify(s);
    if (j === this.lastJson) return;
    this.lastJson = j;
    this.emit('change', s);
  }

  // ---- input ----

  private write(obj: unknown): void {
    if (!this.alive) throw new Error('process has ended');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  /** Sends a user message at any time; if Claude is mid-turn it queues inside the child. */
  sendUser(content: UserContent, meta?: SendMeta): void {
    this.write({ type: 'user', message: { role: 'user', content } });
    this.queue.push({
      text: stripSecrets(meta?.text ?? contentText(content)).slice(0, QUEUED_TEXT_MAX),
      full: meta?.text ?? contentText(content),
      at: this.now(),
      names: meta?.names ?? [],
      ids: meta?.ids ?? [],
    });
    this.busy = true;
    this.changed();
  }

  /** Control request with a response. Resolves with response.response (the payload). */
  control(subtype: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`control request ${subtype} timed out`));
      }, this.controlTimeoutMs);
      this.waiters.set(requestId, { resolve, reject, timer });
      try {
        this.write({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } });
      } catch (e) {
        clearTimeout(timer);
        this.waiters.delete(requestId);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private commands: SlashCommand[] | null = null; // slash menu list (kept out of RunnerState: ~60 KB)

  /** Asks the child for its slash commands (initialize control request; no user message, no tokens). */
  async loadCommands(): Promise<SlashCommand[]> {
    const res = await this.control('initialize');
    this.commands = trimCommands(res.commands);
    if (this.commands.length > 0) this.emit('commands', this.commands);
    return this.commands;
  }

  commandList(): SlashCommand[] | null {
    return this.commands;
  }

  /** Reads back what the child really applies and updates the badge from it. */
  async refreshSettings(): Promise<{ model: string | null; effort: string | null }> {
    const res = await this.control('get_settings');
    const applied = isRecord(res.applied) ? res.applied : {};
    if (typeof applied.model === 'string') this.model = applied.model;
    if (typeof applied.effort === 'string') this.effort = applied.effort;
    this.confirmed = true;
    this.changed();
    return { model: this.model, effort: this.effort };
  }

  /** Live model switch: set_model only (never mixed with a /model message), confirmed by get_settings. */
  async setModel(cliModel: string): Promise<{ model: string | null; effort: string | null }> {
    await this.control('set_model', { model: cliModel });
    this.model = cliModel;
    this.confirmed = false;
    this.changed();
    return this.refreshSettings();
  }

  /** Live effort switch: apply_flag_settings {effortLevel}, confirmed by get_settings. */
  async setEffort(level: EffortLevel): Promise<{ model: string | null; effort: string | null }> {
    await this.control('apply_flag_settings', { settings: { effortLevel: level } });
    this.effort = level;
    this.confirmed = false;
    this.changed();
    return this.refreshSettings();
  }

  /**
   * Live permission-mode switch: control_request set_permission_mode, applied by the child at once
   * (also mid-turn). The child answers with the mode it really applies; bypassPermissions is only
   * accepted because every child is launched with --allow-dangerously-skip-permissions.
   */
  async setPermissionMode(mode: PermissionMode): Promise<PermissionMode> {
    const res = await this.control('set_permission_mode', { mode });
    const applied = typeof res.mode === 'string' ? (PERMISSION_MODES as readonly string[]).includes(res.mode) : false;
    this.permissionMode = applied ? (res.mode as PermissionMode) : mode;
    this.changed();
    return this.permissionMode;
  }

  /**
   * Remote Control (claude.ai / phone) on or off: control_request remote_control {enabled}. The answer to
   * "on" carries session_url; system bridge_state events follow (ready, connected, ...).
   */
  async setRemoteControl(on: boolean): Promise<void> {
    const res = await this.control('remote_control', on ? { enabled: true } : { enabled: false });
    this.wantRemote = on;
    this.remoteControl = on;
    this.remoteUrl = on && typeof res.session_url === 'string' ? res.session_url : undefined;
    this.changed();
  }

  /** Answer a held can_use_tool request. */
  answer(requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string>, message?: string): void {
    const h = this.held.get(requestId);
    if (!h) throw new Error('no such pending request');
    let response: Record<string, unknown>;
    if (behavior === 'allow') {
      const updatedInput: Record<string, unknown> = { ...h.input };
      if (h.pending.kind === 'ask') updatedInput.answers = answers ?? {};
      response = { behavior: 'allow', updatedInput };
    } else {
      response = { behavior: 'deny', message: message && message !== '' ? message : 'User denied this from the control room' };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.held.delete(requestId);
    this.changed();
  }

  /** Interrupt the running turn; if the turn has not ended after the grace time, kill this exact child. */
  stop(): void {
    if (!this.alive) return;
    try {
      this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
    } catch {
      this.killChild();
      return;
    }
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.alive && this.busy) this.killChild();
    }, this.stopGraceMs);
    if (this.busy) this.stopping = true;
  }

  /** The queued-but-unconsumed messages as they were sent (full text, upload ids). */
  queuedMessages(): { text: string; ids: string[] }[] {
    return this.queue.map((q) => ({ text: q.full, ids: q.ids }));
  }

  /** Monotonic count of turn starts reported by the child (replay echo or `system init`). */
  get turnStartCount(): number {
    return this.turnStarts;
  }

  /** Resolves true when the interrupted turn has ended (a result arrived), false when the child died instead. */
  interruptAndWait(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const fin = (v: boolean): void => {
        if (done) return;
        done = true;
        clearTimeout(t);
        this.off('turn_end', onEnd);
        this.off('exit', onExit);
        resolve(v);
      };
      const onEnd = (): void => fin(true);
      const onExit = (): void => fin(false);
      const t = setTimeout(() => fin(false), timeoutMs);
      this.on('turn_end', onEnd);
      this.on('exit', onExit);
      if (!this.busy) fin(true);
      else this.stop();
    });
  }

  /** Kill the exact child PID this session spawned. */
  killChild(): void {
    if (!this.alive) return;
    this.killed = true;
    try {
      this.child.kill();
    } catch {
      // already gone
    }
  }

  /** End the session politely: close stdin so claude exits on its own, kill after a grace period. */
  close(graceMs = 2000): void {
    if (!this.alive) return;
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const t = setTimeout(() => this.killChild(), graceMs);
    t.unref();
  }

  // ---- output ----

  private onData(chunk: Buffer | string): void {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, '');
      this.buf = this.buf.slice(nl + 1);
      this.onLine(line);
    }
  }

  private flushLine(): void {
    const rest = this.buf.replace(/\r$/, '');
    this.buf = '';
    if (rest.trim() !== '') this.onLine(rest);
  }

  private onLine(line: string): void {
    if (line.trim() === '') return;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      return; // not JSON (banner/noise)
    }
    if (!isRecord(ev)) return;
    try {
      this.onEvent(ev);
    } catch (e) {
      this.error = `protocol error: ${e instanceof Error ? e.message : String(e)}`;
      this.changed();
    }
  }

  private onEvent(ev: Record<string, unknown>): void {
    if (ev.type === 'rate_limit_event' || ev.type === 'assistant' || ev.type === 'result') this.emit('stream_event', this.sessionId, ev); // usage meters
    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'bridge_state' && typeof ev.state === 'string') {
          // ready / connected = on; anything that ends the bridge turns the badge off
          if (ev.state === 'connected' || ev.state === 'ready') this.remoteControl = true;
          else if (ev.state === 'failed' || ev.state === 'disconnected' || ev.state === 'closed') {
            this.remoteControl = false;
            this.remoteUrl = undefined;
          }
          this.changed();
          return;
        }
        if (ev.subtype === 'init') {
          this.turnStarts += 1;
          if (typeof ev.model === 'string' && !this.confirmed) this.model = ev.model;
          if (typeof ev.permissionMode === 'string' && (PERMISSION_MODES as readonly string[]).includes(ev.permissionMode)) {
            this.permissionMode = ev.permissionMode as PermissionMode;
          }
          this.changed();
          if (this.wantRemote && !this.remoteControl) {
            this.setRemoteControl(true).catch((e: unknown) => {
              this.wantRemote = false;
              this.error = `Remote Control: ${e instanceof Error ? e.message : String(e)}`;
              this.changed();
            });
          }
          // Confirm model/effort from the child itself, not from what we asked for.
          this.refreshSettings().catch(() => {
            // the badge keeps the requested values
          });
        }
        return;
      case 'user':
        // The child consumed a message of ours (replay). Tool results are not replays.
        if (ev.isReplay === true) {
          this.turnStarts += 1;
          this.queue.shift();
          this.busy = true;
          this.clearSettle();
          this.changed();
        }
        return;
      case 'assistant': {
        if (ev.parent_tool_use_id != null) return; // a subagent's message, not this session's answer
        const msg = isRecord(ev.message) ? ev.message : {};
        const content = Array.isArray(msg.content) ? msg.content : [];
        const text = content
          .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
          .map((b) => (b.text as string).trim())
          .filter((t) => t !== '')
          .join('\n\n');
        if (text !== '') this.turnText = text;
        const synthetic = ev.isApiErrorMessage === true || typeof ev.error === 'string' || msg.model === '<synthetic>';
        if (synthetic && LIMIT_TEXT_RE.test(text)) {
          this.limit = { text: limitLine(text), at: Date.now() };
          this.changed();
        } else if (!synthetic && text !== '' && this.limit) {
          this.limit = undefined;
          this.changed();
        }
        return;
      }
      case 'stream_event':
        if (this.settleTimer) this.clearSettle(); // a queued message started its own turn
        return;
      case 'result': {
        const interrupted = this.stopping;
        const isError = ev.is_error === true || (typeof ev.subtype === 'string' && ev.subtype.startsWith('error'));
        const text = typeof ev.result === 'string' && ev.result.trim() !== '' ? ev.result.trim() : this.turnText;
        this.turnText = '';
        if (isError && LIMIT_TEXT_RE.test(text) && !this.limit) this.limit = { text: limitLine(text), at: Date.now() };
        this.onResult();
        this.emit('turn_end', { sessionId: this.sessionId, text, isError, interrupted } satisfies TurnEnd);
        return;
      }
      case 'control_response':
        this.onControlResponse(ev);
        return;
      case 'control_request':
        this.onControlRequest(ev);
        return;
      case 'control_cancel_request': {
        const id = typeof ev.request_id === 'string' ? ev.request_id : '';
        if (this.held.delete(id)) this.changed();
        return;
      }
      default:
        return;
    }
  }

  private clearSettle(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private onResult(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.held.clear(); // a finished turn cannot still wait on a tool
    if (this.stopping) {
      // after an interrupt the child may or may not still hold what was queued; we stop tracking it (send_now checks the replays)
      this.stopping = false;
      this.queue = [];
    }
    if (this.queue.length === 0) {
      this.busy = false;
      this.clearSettle();
    } else if (!this.settleTimer) {
      // Messages are still waiting: normally their replay arrives at once. If it never does, stop claiming busy.
      this.settleTimer = setTimeout(() => {
        this.settleTimer = null;
        this.queue = [];
        this.busy = false;
        this.changed();
      }, this.settleMs);
    }
    this.changed();
  }

  private onControlResponse(ev: Record<string, unknown>): void {
    const r = ev.response;
    if (!isRecord(r) || typeof r.request_id !== 'string') return;
    const w = this.waiters.get(r.request_id);
    if (!w) return;
    this.waiters.delete(r.request_id);
    clearTimeout(w.timer);
    if (r.subtype === 'error') w.reject(new Error(typeof r.error === 'string' ? r.error : 'control request failed'));
    else w.resolve(isRecord(r.response) ? r.response : {});
  }

  private onControlRequest(ev: Record<string, unknown>): void {
    const requestId = typeof ev.request_id === 'string' ? ev.request_id : '';
    const req = ev.request;
    if (!requestId || !isRecord(req)) return;
    if (req.subtype !== 'can_use_tool') {
      // Unknown host request: answer with an error so the child never hangs on us. (Never an allow.)
      try {
        this.write({
          type: 'control_response',
          response: { subtype: 'error', request_id: requestId, error: `unsupported request ${String(req.subtype)}` },
        });
      } catch {
        // ended
      }
      return;
    }
    const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'unknown';
    const input = isRecord(req.input) ? req.input : {};
    const questions = toolName === 'AskUserQuestion' ? parseQuestions(input) : undefined;
    let preview = '';
    try {
      preview = JSON.stringify(input).slice(0, INPUT_PREVIEW_MAX);
    } catch {
      preview = '';
    }
    const pending: PendingRequest = {
      requestId,
      toolUseId: typeof req.tool_use_id === 'string' ? req.tool_use_id : '',
      toolName,
      kind: questions ? 'ask' : 'permission',
      label: toolLabel(toolName, input),
      detail: labelDetail(toolLabel(toolName, input)),
      description: typeof req.description === 'string' && req.description !== '' ? req.description : toolName,
      inputPreview: preview,
      ...(questions ? { questions } : {}),
      at: this.now(),
    };
    this.held.set(requestId, { pending, input });
    this.changed();
  }

  private onExit(why?: string): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('process ended'));
      this.waiters.delete(id);
    }
    this.held.clear();
    this.clearSettle();
    this.busy = false;
    this.queue = [];
    if (why) this.error = this.stderrTail ? `${why}: ${this.stderrTail.trim().slice(-300)}` : why;
    this.changed();
    this.emit('exit', this.state());
  }
}

// ---------------------------------------------------------------------------------------------

/** A dead job stays listed this long (so its last state can be read), then leaves the Runner. */
export const RUNNER_GONE_KEEP_MS = 60_000;

export interface RunnerOptions {
  /** How long an ended job stays in states() before it is removed (default RUNNER_GONE_KEEP_MS). */
  goneKeepMs?: number;
  /** Directories a job may start in (exact match, case-insensitive on Windows). */
  allowedCwds: () => string[];
  spawn?: SpawnFn;
  claudeBin?: string;
  extraArgs?: string[]; // appended to the claude command line (tests / light mode)
  now?: () => number;
  controlTimeoutMs?: number;
  stopGraceMs?: number;
  sendNowSettleMs?: number; // after the interrupt: how long to wait for the child to take the queued messages by itself
  sendNowWaitMs?: number; // how long send_now waits for the interrupted turn to end
  /** Lookup of uploaded chat attachments (id -> saved file). Without it every attachment id is refused. */
  uploads?: { resolve(id: string): StoredUpload | null };
  /** Extra env for a child by session id (the server gives clip jobs their key after a restart). Merged under extraEnv. */
  envForSession?: (sessionId: string) => Record<string, string>;
  /** Profiles a job can run as (token injected in the child env). Without it no account logic runs at all. */
  accounts?: AccountPort;
}

const ACCOUNT_LOG_MAX = 20;

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9._-]+$/;

export function normPath(p: string): string {
  let r = path.resolve(p);
  while (r.length > 3 && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** Env for the child: parent env without any CLAUDE* variable (they redirect transcripts/sessions). */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.toUpperCase().startsWith('CLAUDE')) out[k] = v;
  return out;
}

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike;

/** Arguments of Runner.adopt(): kept as they were when a job waits for a locked profile. */
export interface AdoptRequest {
  sessionId: string;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  rawModel?: string | null;
  permissionMode?: PermissionMode;
  remoteControl?: boolean;
  accountId?: string;
}

interface WaitingJob {
  req: AdoptRequest;
  opts: { trustedCwd?: boolean };
  accountId: string; // the resolved profile the job waits for
  since: number;
}

export class Runner extends EventEmitter {
  private readonly sessions = new Map<string, RunnerSession>();
  // resumes that wait for a locked profile (adopt() with such a profile): no child yet, the request is kept until resumeWaiting()
  private readonly waiting = new Map<string, WaitingJob>();
  // jobs the user closed on purpose (see close()): removed as soon as their child exits
  private readonly closing = new Set<string>();
  // extra env given at start (clip jobs: the ElevenLabs key), kept per session id for re-launches in THIS process only.
  // Never written anywhere: not the command log, the DB, events or snapshots. A server restart loses it.
  private readonly jobEnv = new Map<string, Record<string, string>>();
  private readonly opts: RunnerOptions;
  private readonly spawnFn: SpawnFn;
  private lastCmds: SlashCommand[] | null = null;
  // account switches: the latest requested profile per job waiting for its turn to end, the job listeners that wait for
  // it, and the jobs whose switch is running right now (one at a time per job)
  private readonly pendingSwitch = new Map<string, string>();
  private readonly pendingListeners = new Map<string, { onChange: () => void; onExit: () => void }>();
  private readonly switching = new Set<string>();

  /** Slash commands of one job (null until its child answered). */
  commandsFor(sessionId: string): SlashCommand[] | null {
    return this.sessions.get(sessionId)?.commandList() ?? null;
  }

  /** The list from the most recent job that answered. */
  lastCommands(): SlashCommand[] | null {
    return this.lastCmds;
  }

  constructor(opts: RunnerOptions) {
    super();
    this.opts = opts;
    this.spawnFn = opts.spawn ?? defaultSpawn;
  }

  states(): RunnerState[] {
    return [...this.sessions.values()].map((s) => s.state()).concat([...this.waiting.keys()].map((sid) => this.waitingState(sid)));
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.waiting.has(sessionId);
  }

  /** True when the profile is a token profile with a password that is not unlocked in this server run. */
  private isLocked(accountId: string): boolean {
    return this.opts.accounts?.isLocked(accountId) === true;
  }

  /** Synthetic state of a job that waits for its locked profile: not alive, no child. */
  private waitingState(sessionId: string): RunnerState {
    const w = this.waiting.get(sessionId);
    if (!w) throw new Error('not waiting'); // only called for keys of `waiting`
    return {
      sessionId,
      cwd: w.req.cwd,
      alive: false,
      pid: null,
      busy: false,
      queued: 0,
      model: w.req.model ?? w.req.rawModel ?? null,
      effort: w.req.effort ?? null,
      confirmed: false,
      permissionMode: w.req.permissionMode ?? DEFAULT_PERMISSION_MODE,
      remoteControl: false,
      pending: [],
      startedAt: w.since,
      accountId: w.accountId,
      waitingUnlock: w.accountId,
    };
  }

  /**
   * Launches every job that waits for this profile (it was unlocked). Each goes through adopt() again; the entry is
   * removed first, so the real session's own 'change' replaces the synthetic state. A job whose relaunch fails is
   * reported as 'waiting_failed' and dropped ('removed'). Never throws. Returns how many jobs were started.
   */
  resumeWaiting(accountId: string): number {
    if (this.isLocked(accountId)) return 0;
    let n = 0;
    for (const [sid, w] of [...this.waiting]) {
      if (w.accountId !== accountId) continue;
      this.waiting.delete(sid);
      try {
        this.adopt(w.req, w.opts);
        n++;
      } catch (e) {
        this.emit('waiting_failed', { sessionId: sid, error: e instanceof Error ? e.message : String(e) });
        this.emit('removed', sid);
      }
    }
    return n;
  }

  isAlive(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.state().alive === true;
  }

  /** Resolves a requested cwd against the whitelist; returns the whitelisted spelling. */
  resolveCwd(cwd: string): string {
    const want = normPath(cwd);
    const hit = this.opts.allowedCwds().find((c) => normPath(c) === want);
    if (!hit) throw new CommandError('cwd not allowed (only folders already used by a session or project root)');
    let ok = false;
    try {
      ok = fs.statSync(hit).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new CommandError('cwd does not exist');
    return hit;
  }

  /** A folder the server created itself (clip jobs): skips the whitelist, still must be an existing directory. */
  trustCwd(cwd: string): string {
    let ok = false;
    try {
      ok = fs.statSync(cwd).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) throw new CommandError('cwd does not exist');
    return cwd;
  }

  buildArgs(
    cliModel: string,
    effort: string,
    sessionFlag: ['--session-id' | '--resume', string],
    permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
  ): string[] {
    return [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--replay-user-messages',
      '--permission-prompt-tool', 'stdio',
      // Explicit, so a user-level defaultMode of bypassPermissions can never make a web job skip prompts.
      '--permission-mode', permissionMode,
      // Only makes bypassPermissions *available* (a live switch needs it); it does not turn it on.
      '--allow-dangerously-skip-permissions',
      '--model', cliModel,
      '--effort', effort,
      // -p does not load Claude in Chrome on its own; web jobs should be able to drive the browser like a terminal session.
      ...(process.env.CR_NO_CHROME === '1' ? [] : ['--chrome']),
      sessionFlag[0], sessionFlag[1],
      ...(this.opts.extraArgs ?? []),
    ];
  }

  /**
   * Profile a job runs as: requested ?? remembered ?? default; an unknown id falls back to the default.
   * undefined without opts.accounts (accounts not in use).
   */
  private resolveAccount(sessionId: string, requested?: string): string | undefined {
    const port = this.opts.accounts;
    if (!port) return undefined;
    const id = requested ?? port.sessionAccount(sessionId) ?? port.defaultId();
    return port.exists(id) ? id : port.defaultId();
  }

  /** Profile id of a job: from its state, else the remembered one, else null. */
  accountOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.state().accountId ?? this.opts.accounts?.sessionAccount(sessionId) ?? null;
  }

  private launch(
    cwd: string,
    cliModel: string,
    effort: string,
    flag: ['--session-id' | '--resume', string],
    sessionId: string,
    permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE,
    remoteControl = false,
    extraEnv: Record<string, string> = {},
    accountId?: string,
  ): RunnerSession {
    const port = this.opts.accounts;
    // checked on the resolved profile, before any child exists; adopt() diverts locked profiles to `waiting` instead
    if (accountId !== undefined && this.isLocked(accountId)) throw new CommandError('account is locked: enter its password first', 'srv.account.locked');
    // tokenFor throws before any child exists when the profile needs a token that is not loaded
    const token = port && accountId !== undefined ? port.tokenFor(accountId) : null;
    const env: NodeJS.ProcessEnv = { ...childEnv(), ...(this.opts.envForSession?.(sessionId) ?? {}), ...extraEnv }; // extra envs are merged over the parent env for this child only
    if (typeof token === 'string') {
      // the profile's token replaces every other login the child could pick up (set last: nothing above may override it)
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    const child = this.spawnFn(this.opts.claudeBin ?? 'claude', this.buildArgs(cliModel, effort, flag, permissionMode), { cwd, env });
    if (port && accountId !== undefined) port.rememberSession(sessionId, accountId);
    const session = new RunnerSession({
      sessionId,
      cwd,
      child,
      model: cliModel,
      effort,
      permissionMode,
      remoteControl,
      accountId,
      now: this.opts.now,
      controlTimeoutMs: this.opts.controlTimeoutMs,
      stopGraceMs: this.opts.stopGraceMs,
    });
    this.sessions.set(sessionId, session);
    session.on('commands', (c: SlashCommand[]) => {
      this.lastCmds = c;
    });
    session.loadCommands().catch(() => {
      // no list for this job: the API falls back to the last known one
    });
    session.on('change', (state: RunnerState) => this.emit('change', state));
    session.on('turn_end', (e: TurnEnd) => this.emit('turn_end', e));
    session.on('stream_event', (id: string, ev: unknown) => this.emit('stream_event', id, ev));
    session.on('exit', () => {
      if (this.closing.delete(sessionId) && this.sessions.get(sessionId) === session) {
        // closed on purpose: gone at once, no grace period
        this.sessions.delete(sessionId);
        this.emit('removed', sessionId, { closed: true });
        return;
      }
      const timer = setTimeout(() => {
        // a resumed job replaced this entry under the same id: keep the new one
        if (this.sessions.get(sessionId) !== session) return;
        this.sessions.delete(sessionId);
        this.emit('removed', sessionId);
      }, this.opts.goneKeepMs ?? RUNNER_GONE_KEEP_MS);
      timer.unref?.();
    });
    this.emit('change', session.state());
    return session;
  }

  /**
   * New job in a whitelisted folder. Returns the new session id.
   * extraEnv: merged over the child's env for this job only (clip jobs pass the ElevenLabs key here, never in the prompt).
   */
  start(
    req: { cwd: string; model: string; effort: EffortLevel; prompt: string; permissionMode?: PermissionMode; remoteControl?: boolean; attachments?: string[]; accountId?: string },
    opts: { trustedCwd?: boolean; extraEnv?: Record<string, string> } = {},
  ): string {
    // trustedCwd is only passed by server code that made the folder itself (Clip Studio); the browser cannot set it.
    const cwd = opts.trustedCwd ? this.trustCwd(req.cwd) : this.resolveCwd(req.cwd);
    const cli = MODEL_OPTIONS.find((o) => o.id === req.model)?.cli;
    if (!cli) throw new CommandError('model not available');
    const content = this.userContent(req.prompt, req.attachments); // before the child exists: an unknown id starts nothing
    const sessionId = randomUUID();
    const extra = { ...(opts.extraEnv ?? {}) };
    const accountId = this.resolveAccount(sessionId, req.accountId);
    const s = this.launch(cwd, cli, req.effort, ['--session-id', sessionId], sessionId, req.permissionMode ?? DEFAULT_PERMISSION_MODE, req.remoteControl === true, extra, accountId);
    if (Object.keys(extra).length > 0) this.jobEnv.set(sessionId, extra); // only once the child exists (a refused token starts nothing)
    s.sendUser(content);
    return sessionId;
  }

  /**
   * Resume an existing session under the Runner (`claude --resume <id>`). The caller checks the old process is gone.
   * trustedCwd: the folder was made by server code (clip job), so it skips the whitelist, as in start().
   */
  adopt(req: AdoptRequest, opts: { trustedCwd?: boolean } = {}): string {
    if (!SAFE_ID_RE.test(req.sessionId)) throw new CommandError('bad session id');
    if (this.isAlive(req.sessionId)) throw new CommandError('session already controlled from the web');
    const cwd = opts.trustedCwd ? this.trustCwd(req.cwd) : this.resolveCwd(req.cwd);
    const cli = (req.model ? MODEL_OPTIONS.find((o) => o.id === req.model)?.cli : null) ?? req.rawModel ?? 'opus';
    if (!SAFE_MODEL_RE.test(cli)) throw new CommandError('model not available');
    const accountId = this.resolveAccount(req.sessionId, req.accountId);
    if (accountId !== undefined && this.isLocked(accountId)) {
      // a locked profile: keep the request until the password is entered (resumeWaiting); no child now
      this.waiting.set(req.sessionId, { req, opts, accountId, since: this.opts.now ? this.opts.now() : Date.now() });
      this.emit('change', this.waitingState(req.sessionId));
      return req.sessionId;
    }
    this.launch(
      cwd,
      cli,
      req.effort ?? DEFAULT_EFFORT,
      ['--resume', req.sessionId],
      req.sessionId,
      req.permissionMode ?? DEFAULT_PERMISSION_MODE,
      req.remoteControl === true,
      this.jobEnv.get(req.sessionId) ?? {}, // a clip job keeps its env when it is re-launched in this process
      accountId,
    );
    return req.sessionId;
  }

  private get(sessionId: string): RunnerSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new CommandError('unknown session (not controlled from the web)');
    return s;
  }

  private live(sessionId: string): RunnerSession {
    const s = this.get(sessionId);
    if (!s.state().alive) throw new CommandError('process has ended; resume it first');
    return s;
  }

  /** Message content with the uploaded attachments (ids from POST /api/upload) resolved; unknown id = CommandError. */
  userContent(text: string, attachments?: readonly string[]): UserContent {
    if (!attachments || attachments.length === 0) return text;
    const found: StoredUpload[] = [];
    for (const id of attachments) {
      const a = this.opts.uploads?.resolve(id) ?? null;
      if (!a) throw new CommandError('ไม่พบไฟล์แนบ (อาจถูกลบแล้ว) — แนบใหม่อีกครั้ง', 'srv.runner.attachMissing');
      found.push(a);
    }
    return buildUserContent(text, found);
  }

  send(sessionId: string, text: string, attachments?: readonly string[]): void {
    const s = this.live(sessionId);
    const names = (attachments ?? []).map((id) => this.opts.uploads?.resolve(id)?.name ?? '').filter((n) => n !== '');
    s.sendUser(this.userContent(text, attachments), { text, names, ids: [...(attachments ?? [])] });
  }

  /**
   * "หยุดแล้วส่งเลย": interrupt the running turn. If Claude then starts on its queue by itself (what it does after an
   * interrupted tool) nothing more is sent; if the queue was dropped, the queued messages are delivered again as ONE
   * message (attachments re-attached when their uploads still exist). Returns a Thai note for the ack.
   */
  async sendNow(sessionId: string): Promise<string> {
    const s = this.live(sessionId);
    const items = s.queuedMessages();
    if (items.length === 0) throw new CommandError('ไม่มีข้อความรอส่ง', 'srv.runner.noQueued');
    const base = s.turnStartCount;
    const ended = await s.interruptAndWait(this.opts.sendNowWaitMs ?? 15_000);
    if (!ended || !s.state().alive) {
      throw new CommandError('หยุดงานไม่สำเร็จ — ตัวงานปิดไป ข้อความที่รอส่งหายไปด้วย', 'srv.runner.stopFailed');
    }
    // Claude Code keeps what was queued behind an interrupted tool and starts on all of it by itself, as ONE merged
    // turn: ~150 ms after the interrupted turn's `result` it emits `system init`, and about a second later the replay
    // echo of the merged message (measured live). Those messages are delivered already: sending them again would
    // answer them twice. So any turn start after the interrupt means "taken".
    const settleMs = this.opts.sendNowSettleMs ?? 1200;
    const t0 = Date.now();
    while (s.turnStartCount === base && Date.now() - t0 < settleMs && s.state().alive) await new Promise((r) => setTimeout(r, 50));
    if (s.turnStartCount > base) return `หยุดคำสั่งแล้ว Claude รับข้อความที่รออยู่ ${items.length} ข้อความไปทำต่อเอง (ไม่ต้องส่งซ้ำ)`;
    const { text, ids } = combineQueued(items);
    let note = `หยุดคำสั่งแล้ว ส่งข้อความที่รอส่ง ${items.length} ข้อความรวมเป็นข้อความเดียว`;
    let content: UserContent;
    try {
      content = this.userContent(text, ids);
    } catch {
      content = text; // an upload was deleted meanwhile: text only
      note += ' (ไฟล์แนบหายไป ส่งเฉพาะข้อความ)';
    }
    const names = ids.map((id) => this.opts.uploads?.resolve(id)?.name ?? '').filter((n) => n !== '');
    s.sendUser(content, { text, names, ids });
    return note;
  }

  stop(sessionId: string): void {
    this.live(sessionId).stop();
  }

  /**
   * End a live job on purpose (user closed it). Its stdin closes so claude exits; the job leaves states() as soon
   * as the child has exited, instead of after the usual goneKeepMs.
   */
  close(sessionId: string): void {
    if (this.waiting.delete(sessionId)) {
      // a job that only waits for its profile has no child: it is gone at once
      this.emit('closing', sessionId);
      this.emit('removed', sessionId, { closed: true });
      return;
    }
    this.live(sessionId).close();
    this.closing.add(sessionId);
    this.emit('closing', sessionId); // auto-resume forgets the job at once (a server stop before the child exits must not bring it back)
  }

  /**
   * Run a live job as another profile. Idle: the child is closed and resumed (`--resume`) as that profile now.
   * Busy (a turn runs or messages are queued): the switch waits, and runs once the job is idle.
   * Returns 'done' (switched, or already that profile) or 'queued'.
   */
  async setAccount(sessionId: string, accountId: string): Promise<'done' | 'queued'> {
    const port = this.opts.accounts;
    if (!port) throw new CommandError('accounts are not enabled');
    if (!port.exists(accountId)) throw new CommandError('ไม่พบโปรไฟล์บัญชีนี้', 'srv.account.unknown');
    if (this.isLocked(accountId)) throw new CommandError('account is locked: enter its password first', 'srv.account.locked');
    port.tokenFor(accountId); // throws srv.account.noToken when the token is not loaded; the value is not kept here
    const s = this.live(sessionId);
    if (this.switching.has(sessionId)) throw new CommandError('an account switch is already running for this job');
    if (this.accountOf(sessionId) === accountId) {
      this.dropPending(sessionId);
      return 'done';
    }
    const st = s.state();
    if (st.busy || st.queued > 0) {
      this.pendingSwitch.set(sessionId, accountId); // latest request wins
      if (!this.pendingListeners.has(sessionId)) this.listenForIdle(s);
      s.setAccountMeta({ pending: accountId });
      return 'queued';
    }
    this.dropPending(sessionId);
    this.switching.add(sessionId);
    try {
      await this.performSwitch(sessionId, accountId);
      return 'done';
    } finally {
      this.switching.delete(sessionId);
    }
  }

  /** Waits (once per job) for the job to become idle, then runs its pending switch. */
  private listenForIdle(s: RunnerSession): void {
    const sid = s.sessionId;
    const onChange = (): void => {
      if (this.switching.has(sid)) return;
      const st = s.state();
      if (!st.alive || st.busy || st.queued > 0) return;
      const target = this.pendingSwitch.get(sid);
      if (target === undefined) return;
      this.dropPending(sid); // removes these listeners and clears the pending mark
      this.switching.add(sid);
      this.performSwitch(sid, target)
        .catch((e: unknown) => {
          this.emit('account_switch_failed', { sessionId: sid, error: e instanceof Error ? e.message : String(e) });
        })
        .finally(() => this.switching.delete(sid));
    };
    const onExit = (): void => this.dropPending(sid); // the job ended before its turn did: the switch is dropped
    s.on('change', onChange);
    s.once('exit', onExit);
    this.pendingListeners.set(sid, { onChange, onExit });
  }

  /** Forget a queued switch of a job (no-op when there is none). */
  private dropPending(sessionId: string): void {
    if (!this.pendingSwitch.has(sessionId)) return;
    this.pendingSwitch.delete(sessionId);
    const l = this.pendingListeners.get(sessionId);
    this.pendingListeners.delete(sessionId);
    const s = this.sessions.get(sessionId);
    if (s && l) {
      s.off('change', l.onChange);
      s.off('exit', l.onExit);
    }
    s?.setAccountMeta({ pending: undefined });
  }

  /** Resolves true when the session has exited, false when `ms` pass first. */
  private waitExit(s: RunnerSession, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!s.state().alive) {
        resolve(true);
        return;
      }
      const onExit = (): void => {
        clearTimeout(t);
        resolve(true);
      };
      const t = setTimeout(() => {
        s.off('exit', onExit);
        resolve(false);
      }, ms);
      s.once('exit', onExit);
    });
  }

  /**
   * Close the live child (NOT Runner.close: that marks the job closed on purpose and auto-resume would forget it),
   * then resume the same session under the new profile with the same folder, model, effort and permission mode.
   */
  private async performSwitch(sessionId: string, accountId: string): Promise<void> {
    const port = this.opts.accounts;
    if (!port) throw new CommandError('accounts are not enabled');
    if (this.isLocked(accountId)) throw new CommandError('account is locked: enter its password first', 'srv.account.locked'); // before the old child is closed
    const old = this.live(sessionId);
    const st = old.state();
    const from = port.nameOf(this.accountOf(sessionId) ?? TERMINAL_ACCOUNT_ID);
    const to = port.nameOf(accountId);
    const model = st.model !== null && SAFE_MODEL_RE.test(st.model) ? st.model : 'opus';
    const effort = st.effort ?? DEFAULT_EFFORT;
    const exited = this.waitExit(old, 4_000);
    old.close(); // stdin ends; the child exits on its own, close() kills it after its own grace time
    if (!(await exited)) {
      old.killChild();
      if (!(await this.waitExit(old, 2_000))) throw new CommandError('ปิดงานเดิมไม่สำเร็จ — ยังไม่ได้สลับบัญชี', 'srv.account.switchFailed');
    }
    const at = this.opts.now ? this.opts.now() : Date.now();
    const log: AccountSwitchEntry[] = [...(st.accountLog ?? []), { at, from, to }].slice(-ACCOUNT_LOG_MAX);
    const fresh = this.launch(
      st.cwd,
      model,
      effort,
      ['--resume', sessionId],
      sessionId,
      st.permissionMode,
      st.remoteControl,
      this.jobEnv.get(sessionId) ?? {},
      accountId,
    );
    fresh.setAccountMeta({ log });
    this.emit('account_switch', { sessionId, from, to, at });
  }

  async setModel(sessionId: string, model: string): Promise<RunnerState> {
    const cli = MODEL_OPTIONS.find((o) => o.id === model)?.cli;
    if (!cli) throw new CommandError('model not available');
    const s = this.live(sessionId);
    await s.setModel(cli);
    return s.state();
  }

  async setEffort(sessionId: string, effort: EffortLevel): Promise<RunnerState> {
    const s = this.live(sessionId);
    await s.setEffort(effort);
    return s.state();
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<RunnerState> {
    if (!(PERMISSION_MODES as readonly string[]).includes(mode)) throw new CommandError('permission mode invalid');
    const s = this.live(sessionId);
    await s.setPermissionMode(mode);
    return s.state();
  }

  async setRemoteControl(sessionId: string, on: boolean): Promise<RunnerState> {
    const s = this.live(sessionId);
    await s.setRemoteControl(on);
    return s.state();
  }

  answer(sessionId: string, requestId: string, behavior: 'allow' | 'deny', answers?: Record<string, string>, message?: string): void {
    const s = this.live(sessionId);
    try {
      s.answer(requestId, behavior, answers, message);
    } catch (e) {
      throw new CommandError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Server shutdown: end every live child (exact PIDs only). */
  shutdown(): void {
    for (const s of this.sessions.values()) s.killChild();
  }
}
