// Maps the session timeline to Claude Code terminal lines. Pure; no React.
//
//   > user prompt                 (muted grey)
//   ⏺ assistant text
//   ⏺ ToolName(short args)
//     ⎿ error text               (only the error line is red)
//
// The timeline holds no tool output, only calls and errors, so an error that follows a tool call is
// shown as that call's result line; the data itself is not changed.
// User prompts and assistant text keep every line (the mark sits on the first line, the rest is indented
// under it by the layout); tool and error lines are always one line.
import type { TimelineEvent } from '../../shared/protocol';

export type TermKind = 'user' | 'assistant' | 'tool' | 'error' | 'thought' | 'switch';

export interface TermLine {
  key: string;
  kind: TermKind;
  /** Left marker: '>' user, '⏺' assistant/tool, '⎿' nested result, '✻' thought. */
  mark: string;
  /** Text as shown while collapsed. For a tool call this is `Name(args)`. */
  text: string;
  /** Complete text (same as `text` unless it was shortened). */
  full: string;
  /** Rendered indented under the previous tool call. */
  nested: boolean;
  /** `text` is shorter than `full`: click to expand. */
  collapsible: boolean;
  ts: number | null;
  /** Number of text lines: user prompts and assistant text can span many, the other kinds are one. */
  rows: number;
  /** Usage / rate limit message: drawn red. */
  tone?: 'limit';
}

export const MAX_ARGS = 72;
export const MAX_RESULT = 110;

export const MARK = { user: '>', dot: '⏺', result: '⎿', thought: '✻' } as const;

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const countRows = (s: string): number => s.split('\n').length;

/** Full text of a prompt or answer: line breaks kept (CRLF normalised), trailing blank space dropped. */
export const keepLines = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');

/** "Read: src/App.tsx" -> { name: "Read", args: "src/App.tsx" }. Text without ": " is a bare name. */
export function splitTool(text: string): { name: string; args: string } {
  const t = text.trim();
  const i = t.indexOf(': ');
  if (i <= 0) return { name: t, args: '' };
  return { name: t.slice(0, i).trim(), args: t.slice(i + 2).trim() };
}

/** `Name(args)` with long args shortened; a call without args is just `Name`. */
export function toolCall(text: string): { text: string; full: string } {
  const { name, args } = splitTool(text);
  if (!args) return { text: name, full: name };
  return { text: `${name}(${clip(args, MAX_ARGS)})`, full: `${name}(${args})` };
}

export function formatTimeline(events: ReadonlyArray<TimelineEvent>): TermLine[] {
  const out: TermLine[] = [];
  let inTool = false; // the previous line is a tool call or one of its result lines
  events.forEach((e, i) => {
    const key = `${e.ts}:${i}`;
    const base = { key, ts: e.ts, nested: false, collapsible: false, rows: 1 };
    switch (e.kind) {
      case 'user': {
        const text = keepLines(e.text);
        out.push({ ...base, kind: 'user', mark: MARK.user, text, full: text, rows: countRows(text) });
        inTool = false;
        break;
      }
      case 'text': {
        const text = keepLines(e.text);
        out.push({ ...base, kind: 'assistant', mark: MARK.dot, text, full: text, rows: countRows(text), ...(e.tone === 'limit' ? { tone: 'limit' as const } : {}) });
        inTool = false;
        break;
      }
      case 'tool': {
        const c = toolCall(oneLine(e.text));
        out.push({ ...base, kind: 'tool', mark: MARK.dot, text: c.text, full: c.full, collapsible: c.text !== c.full });
        inTool = true;
        break;
      }
      case 'error': {
        const full = oneLine(e.text);
        const text = clip(full, MAX_RESULT);
        out.push({
          ...base,
          kind: 'error',
          mark: inTool ? MARK.result : MARK.dot,
          text,
          full,
          nested: inTool,
          collapsible: text !== full,
        });
        break;
      }
    }
  });
  return out;
}

/** One account switch of a session (RunnerState.accountLog entry; from/to are profile names). */
export interface AccountSwitch {
  at: number;
  from: string;
  to: string;
}

/** Names the server stores for the built-in profile, before translation (English). */
const BUILTIN_SWITCH_NAMES = ['Main account', 'Terminal login'];

/**
 * A switch's profile name for the divider. The server stores the built-in profile by its English display name;
 * that name is replaced by `terminalName` (the translated built-in label). Other names pass through unchanged.
 */
export function switchName(name: string, terminalName: string): string {
  return BUILTIN_SWITCH_NAMES.includes(name) ? terminalName : name;
}

/** Local time as HH:MM, 24 h. */
export function hhmm(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Merges one divider line per account switch into the timeline, in time order by `at`. A switch goes before
 * the first line stamped later than it. Repeats (same at, from, to) are shown once. No log: lines unchanged.
 * `label` builds the divider text from the switch and its HH:MM time.
 */
export function mergeAccountSwitches(
  lines: TermLine[],
  log: ReadonlyArray<AccountSwitch> | undefined,
  label: (sw: AccountSwitch, time: string) => string,
): TermLine[] {
  if (!log || log.length === 0) return lines;
  const seen = new Set<string>();
  const switches = [...log]
    .sort((a, b) => a.at - b.at)
    .filter((sw) => {
      const k = `${sw.at}|${sw.from}|${sw.to}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  const divider = (sw: AccountSwitch, i: number): TermLine => {
    const text = label(sw, hhmm(sw.at));
    return { key: `sw:${sw.at}:${i}`, kind: 'switch', mark: '', text, full: text, nested: false, collapsible: false, ts: sw.at, rows: 1 };
  };
  const out: TermLine[] = [];
  let next = 0;
  for (const l of lines) {
    while (next < switches.length && l.ts !== null && switches[next].at < l.ts) {
      out.push(divider(switches[next], next));
      next++;
    }
    out.push(l);
  }
  while (next < switches.length) {
    out.push(divider(switches[next], next));
    next++;
  }
  return out;
}

/** The "latest thought" shown as a dim line at the end of the log. */
export function thoughtLine(thought: string): TermLine | null {
  const t = thought.trim();
  if (!t) return null;
  return { key: 'thought', kind: 'thought', mark: MARK.thought, text: t, full: t, nested: false, collapsible: false, ts: null, rows: 1 };
}
