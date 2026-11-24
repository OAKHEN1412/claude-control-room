// Relay: links between AI sessions. A link A -> B sends A's final answer of every finished turn to B as a
// user message, so two sessions (or two links, A->B and B->A) can talk or hand each other work.
//
// Rules kept here:
//  - the target must be a live Runner job; a terminal session can only be a source (never written to);
//  - each link has a forward counter with a ceiling (loop guard), and all links share a global rate cap;
//  - the user messaging a session through the web resets the counters of links that touch it;
//  - message text is never logged or stored beyond the in-flight call; state lives in memory only.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { LINK_MAX_FORWARDS_DEFAULT, LINK_MAX_FORWARDS_LIMIT, type LinkInfo } from '../../shared/protocol';
import { stripSecrets } from './secrets';
import { CommandError } from './runner';

export const RELAY_TEXT_MAX = 8000;
export const RELAY_GLOBAL_MAX = 30; // forwards ...
export const RELAY_GLOBAL_WINDOW_MS = 10 * 60 * 1000; // ... per 10 minutes, across all links

export interface RelayDeps {
  /** Sends `text` as a user message to a live Runner job (Runner.send: queue / busy logic applies). May throw. */
  send: (to: string, text: string) => void;
  /** True when `id` is a Runner job whose process is alive. */
  isLiveRunner: (id: string) => boolean;
  /** True when `id` is a session the server knows (Runner job or watched terminal session). */
  exists: (id: string) => boolean;
  /** Display title of a session for the message header; '' / undefined falls back to the id. */
  titleOf?: (id: string) => string | undefined;
  now?: () => number;
  newId?: () => string;
  /** Log of ids and lengths only; never text. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface TurnMeta {
  isError?: boolean;
  interrupted?: boolean;
  /** Epoch ms of the answer (terminal sources): answers not newer than the link's creation are ignored. */
  ts?: number;
}

interface Link extends LinkInfo {
  createdAt: number;
}

export function wrapForward(fromTitle: string, fromId: string, body: string): string {
  return `[ข้อความจาก ${fromTitle} · ${fromId.slice(0, 8)}]\n${body}`;
}

/** Emits 'change' (LinkInfo[]) whenever any link is created, removed or changes. */
export class Relay extends EventEmitter {
  private readonly links = new Map<string, Link>();
  private readonly stamps: number[] = []; // times of recent forwards (global cap)
  private readonly deps: RelayDeps;
  private readonly now: () => number;

  constructor(deps: RelayDeps) {
    super();
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  list(): LinkInfo[] {
    return [...this.links.values()].map(({ createdAt: _c, ...info }) => ({ ...info }));
  }

  private changed(): void {
    this.emit('change', this.list());
  }

  private get(linkId: string): Link {
    const l = this.links.get(linkId);
    if (!l) throw new CommandError('ไม่พบลิงก์นี้');
    return l;
  }

  create(from: string, to: string, maxForwards: number = LINK_MAX_FORWARDS_DEFAULT): string {
    if (from === to) throw new CommandError('ต้นทางกับปลายทางต้องเป็นคนละงาน');
    if (!Number.isInteger(maxForwards) || maxForwards < 1 || maxForwards > LINK_MAX_FORWARDS_LIMIT) {
      throw new CommandError(`จำนวนครั้งส่งต่อสูงสุดต้อง 1-${LINK_MAX_FORWARDS_LIMIT}`);
    }
    if (!this.deps.isLiveRunner(to)) throw new CommandError('ปลายทางต้องเป็นงานที่คุมจากเว็บ');
    if (!this.deps.exists(from)) throw new CommandError('ไม่พบงานต้นทาง');
    for (const l of this.links.values()) if (l.from === from && l.to === to) throw new CommandError('มีลิงก์นี้อยู่แล้ว');
    const id = (this.deps.newId ?? (() => `l${randomUUID().replace(/-/g, '').slice(0, 10)}`))();
    this.links.set(id, {
      id, from, to, paused: false, state: 'ok', forwards: 0, maxForwards, lastForwardAt: null, createdAt: this.now(),
    });
    this.changed();
    return id;
  }

  delete(linkId: string): void {
    this.get(linkId);
    this.links.delete(linkId);
    this.changed();
  }

  pause(linkId: string, paused: boolean): void {
    const l = this.get(linkId);
    if (l.paused === paused) return;
    l.paused = paused;
    this.changed();
  }

  /** Resets the counter and clears limit / rate / error. */
  resume(linkId: string): void {
    const l = this.get(linkId);
    l.forwards = 0;
    l.state = 'ok';
    delete l.error;
    this.changed();
  }

  /** The user sent a message to `sessionId` through the web: loop counters of links touching it restart. */
  onUserSend(sessionId: string): void {
    let any = false;
    for (const l of this.links.values()) {
      if (l.from !== sessionId && l.to !== sessionId) continue;
      if (l.forwards === 0 && l.state !== 'limit') continue;
      l.forwards = 0;
      if (l.state === 'limit') l.state = 'ok'; // the limit was only the counter
      any = true;
    }
    if (any) this.changed();
  }

  /** A session disappeared (job closed / removed, watched session gone): its links go with it. */
  onSessionGone(sessionId: string): void {
    let any = false;
    for (const [id, l] of [...this.links]) {
      if (l.from === sessionId || l.to === sessionId) {
        this.links.delete(id);
        any = true;
      }
    }
    if (any) this.changed();
  }

  /** Source `sessionId` finished a turn with `text` as its final answer. */
  onSourceTurnEnd(sessionId: string, text: string, meta: TurnMeta = {}): void {
    if (meta.isError || meta.interrupted) return;
    const outgoing = [...this.links.values()].filter((l) => l.from === sessionId);
    if (outgoing.length === 0) return;
    const clean = stripSecrets(text ?? '').trim();
    if (clean === '') return;
    const body = clean.length > RELAY_TEXT_MAX ? clean.slice(0, RELAY_TEXT_MAX) : clean;
    const title = this.deps.titleOf?.(sessionId)?.trim() || sessionId;
    const message = wrapForward(title, sessionId, body);
    let touched = false;
    for (const l of outgoing) {
      if (l.paused || l.state !== 'ok') continue;
      if (meta.ts !== undefined && meta.ts <= l.createdAt) continue; // older than the link
      const t = this.now();
      while (this.stamps.length > 0 && t - this.stamps[0] >= RELAY_GLOBAL_WINDOW_MS) this.stamps.shift();
      if (this.stamps.length >= RELAY_GLOBAL_MAX) {
        for (const x of this.links.values()) if (x.state === 'ok') x.state = 'rate';
        touched = true;
        break;
      }
      try {
        if (!this.deps.isLiveRunner(l.to)) throw new CommandError('ปลายทางไม่ได้ทำงานอยู่');
        this.deps.send(l.to, message);
      } catch (e) {
        l.state = 'error';
        l.error = e instanceof Error ? e.message : String(e);
        this.deps.log?.({ cmd: 'link_forward', ok: false, linkId: l.id, from: l.from, to: l.to, error: l.error });
        touched = true;
        continue;
      }
      this.stamps.push(t);
      l.forwards += 1;
      l.lastForwardAt = t;
      if (l.forwards >= l.maxForwards) l.state = 'limit';
      this.deps.log?.({ cmd: 'link_forward', ok: true, linkId: l.id, from: l.from, to: l.to, chars: message.length, forwards: l.forwards });
      touched = true;
    }
    if (touched) this.changed();
  }
}
