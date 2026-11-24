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

export type TermKind = 'user' | 'assistant' | 'tool' | 'error' | 'thought';

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

/** The "latest thought" shown as a dim line at the end of the log. */
export function thoughtLine(thought: string): TermLine | null {
  const t = thought.trim();
  if (!t) return null;
  return { key: 'thought', kind: 'thought', mark: MARK.thought, text: t, full: t, nested: false, collapsible: false, ts: null, rows: 1 };
}
