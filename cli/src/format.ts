// Timeline -> terminal lines, the `cr ls` table and colours. Pure (colour is a flag), unit-tested.
// Same look as the web pane (web/src/terminalLines.ts): `> user`, `⏺ assistant text`, `⏺ Tool(args)`, `  ⎿ error`.
import type { AccountInfo } from '../../shared/accounts.ts';
import { TERMINAL_ACCOUNT_ID } from '../../shared/accounts.ts';
import type { RunnerState, SessionInfo, TimelineEvent } from '../../shared/protocol.ts';

export const MAX_ARGS = 72;
export const MAX_RESULT = 110;

export interface Paint {
  dim(s: string): string;
  red(s: string): string;
  cyan(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  bold(s: string): string;
}

export function makePaint(on: boolean): Paint {
  const w = (code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { dim: w('2'), red: w('31'), cyan: w('36'), yellow: w('33'), green: w('32'), bold: w('1') };
}

export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const keepLines = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** "Read: src/App.tsx" -> `Read(src/App.tsx)`; a bare name stays bare. */
export function toolCall(text: string): string {
  const t = oneLine(text);
  const i = t.indexOf(': ');
  if (i <= 0) return t;
  return `${t.slice(0, i).trim()}(${clip(t.slice(i + 2).trim(), MAX_ARGS)})`;
}

/** First line carries the mark, the others are indented under it. */
function block(mark: string, text: string, paint: (s: string) => string): string[] {
  return keepLines(text)
    .split('\n')
    .map((l, i) => (i === 0 ? `${paint(mark)} ${l}` : `  ${l}`));
}

/** Terminal lines of one timeline event. `afterTool`: the previous event was a tool call (an error then nests under it). */
export function eventLines(e: TimelineEvent, afterTool: boolean, p: Paint): string[] {
  switch (e.kind) {
    case 'user':
      return keepLines(e.text)
        .split('\n')
        .map((l, i) => p.dim(i === 0 ? `> ${l}` : `  ${l}`));
    case 'text':
      return block('⏺', e.text, (s) => s);
    case 'tool':
      return [`${p.cyan('⏺')} ${p.cyan(toolCall(e.text))}`];
    case 'error': {
      const t = clip(oneLine(e.text), MAX_RESULT);
      return [afterTool ? p.red(`  ⎿ ${t}`) : p.red(`⏺ ${t}`)];
    }
  }
}

const keyOf = (e: TimelineEvent): string => `${e.ts}|${e.kind}|${e.text}`;

/**
 * The events of `events` (a sliding window, oldest first) that come after the last one already printed.
 * `lastKey` is the key of that last printed event (null = nothing printed yet, everything is new).
 */
export function newEvents(events: readonly TimelineEvent[], lastKey: string | null, lastTs: number): TimelineEvent[] {
  if (lastKey === null) return [...events];
  for (let i = events.length - 1; i >= 0; i--) if (keyOf(events[i]) === lastKey) return events.slice(i + 1);
  // the window slid past the last printed event: keep what is newer
  return events.filter((e) => e.ts > lastTs);
}

export { keyOf as eventKey };

/** Tracks what was already printed for one session and which typed lines the terminal already shows. */
export class TimelinePrinter {
  private lastKey: string | null = null;
  private lastTs = 0;
  private afterTool = false;
  private sent: string[] = [];
  private first = true;
  private readonly paint: Paint;
  private readonly history: number;
  constructor(paint: Paint, history = 20) {
    this.paint = paint;
    this.history = history;
  }

  /** The user typed this here: the echo in the timeline is not printed a second time. */
  noteSent(text: string): void {
    this.sent.push(oneLine(text));
  }

  /** Lines for the events that are new since the last call (the first call prints at most `history` events). */
  update(events: readonly TimelineEvent[]): string[] {
    let fresh = newEvents(events, this.lastKey, this.lastTs);
    const out: string[] = [];
    if (this.first) {
      this.first = false;
      if (fresh.length > this.history) {
        out.push(this.paint.dim(`… (ข้ามประวัติเก่า ${fresh.length - this.history} รายการ)`));
        fresh = fresh.slice(-this.history);
      }
    }
    for (const e of fresh) {
      this.lastKey = keyOf(e);
      this.lastTs = e.ts;
      if (e.kind === 'user') {
        const i = this.sent.indexOf(oneLine(e.text));
        if (i >= 0) {
          this.sent.splice(i, 1);
          this.afterTool = false;
          continue;
        }
      }
      out.push(...eventLines(e, this.afterTool, this.paint));
      this.afterTool = e.kind === 'tool' || (e.kind === 'error' && this.afterTool);
    }
    return out;
  }
}

// ---- `cr ls` ----

export interface JobRow {
  id: string;
  kind: 'web' | 'terminal';
  state: string;
  title: string;
  cwd: string;
  /** Profile name the web job runs as (only when its RunnerState has an accountId). */
  account?: string;
}

const STATUS_TH: Record<string, string> = { running: 'ทำงาน', waiting: 'รอคุณ', idle: 'ว่าง', done: 'จบ', unreadable: 'อ่านไม่ได้' };

export function runnerStateText(r: RunnerState): string {
  if (!r.alive) return 'หยุดแล้ว';
  if (r.pending.length > 0) return `รอคุณ ${r.pending.length}`;
  return r.busy ? (r.queued > 0 ? `ทำงาน (+${r.queued})` : 'ทำงาน') : 'ว่าง';
}

/** Runner jobs first (they can be attached), then terminal sessions (read-only; `all` includes finished ones). */
/** Display name of a profile id: the terminal login shows `terminal`; an id the list does not know is shown as is. */
export function profileLabel(id: string, accounts: readonly AccountInfo[] = []): string {
  if (id === TERMINAL_ACCOUNT_ID) return TERMINAL_ACCOUNT_ID;
  return accounts.find((a) => a.id === id)?.name ?? id;
}

export function listRows(sessions: readonly SessionInfo[], runners: readonly RunnerState[], all: boolean, accounts: readonly AccountInfo[] = []): JobRow[] {
  const rows: JobRow[] = [];
  const titleOf = (id: string): string => {
    const s = sessions.find((x) => x.sessionId === id);
    return s ? s.title || s.name : '';
  };
  for (const r of runners) {
    const row: JobRow = { id: r.sessionId, kind: 'web', state: runnerStateText(r), title: titleOf(r.sessionId), cwd: r.cwd };
    if (r.accountId) row.account = profileLabel(r.accountId, accounts);
    rows.push(row);
  }
  for (const s of sessions) {
    if (runners.some((r) => r.sessionId === s.sessionId)) continue;
    if (!all && s.status === 'done') continue;
    rows.push({ id: s.sessionId, kind: 'terminal', state: STATUS_TH[s.status] ?? s.status, title: s.title || s.name, cwd: s.cwd });
  }
  return rows;
}

export function formatList(rows: readonly JobRow[], p: Paint, width = 100): string[] {
  if (rows.length === 0) return [p.dim('ไม่มีงาน (cr new "…" เพื่อเริ่ม)')];
  const out: string[] = [];
  const stateW = Math.max(...rows.map((r) => [...r.state].length), 4);
  // the profile column exists only when some row runs as a profile; without it the layout is unchanged
  const acctW = Math.max(0, ...rows.map((r) => [...(r.account ?? '')].length));
  const titleW = Math.max(12, Math.min(40, width - 8 - 6 - 2 - stateW - 8 - 20 - (acctW > 0 ? acctW + 2 : 0)));
  for (const r of rows) {
    const kind = r.kind === 'web' ? p.green('web ') : p.dim('term');
    const state = r.state + ' '.repeat(Math.max(0, stateW - [...r.state].length));
    const title = clip(r.title || '(ไม่มีชื่อ)', titleW);
    const pad = ' '.repeat(Math.max(0, titleW - [...title].length));
    const acct = acctW > 0 ? `  ${p.dim(r.account ?? '')}${' '.repeat(Math.max(0, acctW - [...(r.account ?? '')].length))}` : '';
    out.push(`${p.bold(r.id.slice(0, 8))}  ${kind}  ${state}  ${title}${pad}${acct}  ${p.dim(r.cwd)}`);
  }
  return out;
}
