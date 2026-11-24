// Pure transcript parser: turns one Claude Code transcript (.jsonl, one JSON object
// per line) into a session/subagent status, thought, title, model and timeline.
// No I/O here. The watcher feeds complete lines via ingestLine() and calls derive().
import { LIMIT_TEXT_RE, type LimitInfo, type Status, type TimelineEvent, type WaitItem } from '../../shared/protocol';
import { showAttachments } from '../../shared/uploads';
import { parseQuestions } from './questions';
import { stripSecrets } from './secrets';
import { toolLabel } from './toolLabels';

export const TIMELINE_CAP = 30;
/** Timeline cap for subagent readers (the agent timeline view); the session payload keeps TIMELINE_CAP. */
export const SUBAGENT_TIMELINE_CAP = 60;
/** Max length of a user prompt / assistant answer kept in the timeline (whole text, newlines kept). */
export const EVENT_TEXT_MAX = 4000;
const RECENT_TOOL_MS = 10 * 60 * 1000; // a pending tool_use younger than this = still working
const RECENT_ACTIVITY_MS = 10 * 1000; // transcript written this recently = still working
const WAITING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const NOISE_TYPES = new Set([
  'attachment', 'system', 'file-history-snapshot', 'file-history-delta', 'queue-operation',
  'permission-mode', 'mode', 'last-prompt', 'bridge-session', 'frame-link', 'tools-used',
  'session-owner', 'atis-latch', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
]);

interface PendingTool {
  name: string;
  input: unknown;
  ts: number;
}

/** One failed action (worklog layer 1). `id` is the tool_use id (or the entry uuid for an API error). */
export interface FailureRec {
  id: string;
  ts: number;
  tool: string; // Thai tool label (toolLabels.ts), clipped to 100
  text: string; // first line of the error text, secrets stripped, <= 200 chars
}

const FAILURE_CAP = 300;
const PROMPT_KEEP = 4;
const FAILURE_TEXT_MAX = 200;
// A user declining a tool or interrupting is not a failure of the work.
const USER_DECLINE_RE = /^(the user doesn't want to proceed|\[request interrupted|user rejected|the user (?:rejected|denied|declined))/i;

export interface TranscriptState {
  title?: string; // last non-empty ai-title (collapsed)
  firstPrompt?: string; // first human prompt (collapsed), used when there is no ai-title
  model: string | null; // last assistant model that is not '<synthetic>'
  effort: string | null; // effort of the latest entry that has one
  lastActivityTs: number; // max parsed timestamp over recognised entries (0 = none)
  lastEntryTs: number; // most recent parsed timestamp; fallback for entries without one
  pending: Map<string, PendingTool>; // tool_use ids without a tool_result yet
  timeline: TimelineEvent[]; // ring, oldest first, max timelineCap
  timelineCap: number; // TIMELINE_CAP unless the reader asked for more (subagents)
  lastThinking: string; // thinking of the latest assistant entry that has thinking blocks ('' if empty)
  lastText: string; // first non-empty line of the latest assistant text ('' = none)
  lastAssistantEndTurn: boolean;
  failures: FailureRec[]; // failed actions, oldest first, capped
  tools: Map<string, { name: string; label: string }>; // every tool_use seen (name + Thai label), to label its result
  prompts: string[]; // last human prompts (collapsed, <= 300 chars)
  lastTextFull: string; // latest assistant text (collapsed, <= 800 chars)
  endTurnSeq: number; // counts assistant entries that end a turn (stop_reason end_turn) with real text; never goes down
  lastEndTurn: { text: string; ts: number } | null; // text of that entry, full (not clipped), raw
  limit: LimitInfo | null; // latest limit api error with no normal assistant turn after it
  assistantTurns: number; // assistant entries that carry a real model answer
  badLines: number; // lines that are not a JSON object
  totalLines: number; // non-blank lines fed in
  recognisedLines: number; // lines with a known entry type (incl. noise types)
}

export function createState(timelineCap: number = TIMELINE_CAP): TranscriptState {
  return {
    model: null,
    effort: null,
    lastActivityTs: 0,
    lastEntryTs: 0,
    pending: new Map(),
    timeline: [],
    timelineCap,
    lastThinking: '',
    lastText: '',
    lastAssistantEndTurn: false,
    failures: [],
    tools: new Map(),
    prompts: [],
    lastTextFull: '',
    endTurnSeq: 0,
    lastEndTurn: null,
    limit: null,
    assistantTurns: 0,
    badLines: 0,
    totalLines: 0,
    recognisedLines: 0,
  };
}

export interface DeriveCtx {
  now: number; // epoch ms
  processAlive: boolean | null; // null = not applicable (subagent)
  finished?: boolean; // subagent meta.finished
  liveWaiting?: boolean; // Claude's own session json says status=waiting (a permission prompt)
}

export interface Derived {
  title: string;
  model: string | null;
  effort: string | null;
  status: Status;
  thought: string;
  timeline: TimelineEvent[];
  lastActivity: number;
  waitItems: WaitItem[];
  limit?: LimitInfo;
  unreadable?: string;
}

// ---------- small helpers ----------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function firstLine(s: string): string {
  for (const l of s.split(/\r?\n/)) {
    const t = l.trim();
    if (t) return t;
  }
  return '';
}

// Clip to at most n characters, ending with an ellipsis when cut.
function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (isObj(b) && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text;
    }
  }
  return '';
}

// A prompt is a real human prompt when origin is absent or kind 'human'.
// Prompts starting with '<' are system-reminder / command wrappers, not user text.
function isHumanOrigin(obj: Record<string, unknown>): boolean {
  const origin = obj.origin;
  if (!isObj(origin)) return true;
  return origin.kind === undefined || origin.kind === 'human';
}

/** Error text for the worklog: first meaningful line ("Exit code N" joined with the next one), secrets stripped. */
export function failureText(raw: string): string {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let line = lines[0] ?? '';
  if (/^exit code \d+$/i.test(line) && lines[1]) line = `${line}: ${lines[1]}`;
  return clip(collapse(stripSecrets(line)) || '(error)', FAILURE_TEXT_MAX);
}

function addFailure(state: TranscriptState, f: FailureRec): void {
  if (state.failures.some((x) => x.id === f.id)) return;
  state.failures.push(f);
  if (state.failures.length > FAILURE_CAP) state.failures.splice(0, state.failures.length - FAILURE_CAP);
}

function pushEvent(state: TranscriptState, kind: TimelineEvent['kind'], text: string, ts: number, tone?: TimelineEvent['tone']): void {
  if (!text) return;
  state.timeline.push(tone ? { ts, kind, text, tone } : { ts, kind, text });
  if (state.timeline.length > state.timelineCap) {
    state.timeline.splice(0, state.timeline.length - state.timelineCap);
  }
}

// ---------- one-line tool summary ----------

/**
 * Short one-line summary of a tool call, e.g. "Bash: Run sample tests".
 * Format: "<name>: <detail>" (or just "<name>" when there is no detail), collapsed
 * to one line and at most 100 characters. Never throws; odd input gives the name only.
 */
export function summarizeTool(name: string, input: unknown): string {
  try {
    return clip(collapse(toolLabel(name, input)), 100);
  } catch {
    return typeof name === 'string' && name ? clip(collapse(name), 100) : 'tool';
  }
}

// ---------- ingest ----------

// Common bookkeeping for a recognised entry: effort, timestamps. Returns the entry ts
// (falls back to the previous entry's ts when the line has none).
function recognise(state: TranscriptState, obj: Record<string, unknown>): number {
  state.recognisedLines++;
  if (typeof obj.effort === 'string' && obj.effort) state.effort = obj.effort;
  const parsed = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (Number.isFinite(parsed)) {
    state.lastEntryTs = parsed;
    state.lastActivityTs = Math.max(state.lastActivityTs, parsed);
  }
  return Number.isFinite(parsed) ? parsed : state.lastEntryTs;
}

const IMAGE_NOTE_RE = /^\[Image: source: [^\]]*\]$/;

function addPrompt(state: TranscriptState, rawText: string, ts: number): void {
  // "[ไฟล์แนบ] <path>" lines (chat attachments) show as "📎 name"; image blocks are never read at all.
  const t = showAttachments(rawText).trim();
  // Skip empty prompts and system-reminder-like wrappers that start with '<'.
  if (!t || t.startsWith('<')) return;
  if (IMAGE_NOTE_RE.test(t)) return; // Claude's own "[Image: source: <temp path>]" note after a pasted image
  if (state.firstPrompt === undefined) state.firstPrompt = collapse(t);
  state.prompts.push(clip(collapse(stripSecrets(t)), 300));
  if (state.prompts.length > PROMPT_KEEP) state.prompts.shift();
  pushEvent(state, 'user', clip(stripSecrets(t), EVENT_TEXT_MAX), ts);
}

function ingestUser(state: TranscriptState, obj: Record<string, unknown>, ts: number): void {
  const message = isObj(obj.message) ? obj.message : {};
  const content = message.content;
  const human = isHumanOrigin(obj);
  if (typeof content === 'string') {
    if (human) addPrompt(state, content, ts);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === 'tool_result') {
      // A tool_result answers the pending tool_use with the same id.
      const useId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      if (useId) state.pending.delete(useId);
      const text = resultText(block.content);
      if (block.is_error === true) {
        pushEvent(state, 'error', clip(firstLine(text) || '(error)', 160), ts);
      }
      const tool = useId ? state.tools.get(useId) : undefined;
      const bashExit = tool?.name === 'Bash' && block.is_error !== true && /^exit code [1-9]\d*\b/i.test(text.trim());
      if (useId && (block.is_error === true || bashExit) && !USER_DECLINE_RE.test(text.trim())) {
        const label = tool ? tool.label : 'เครื่องมือ';
        addFailure(state, { id: useId, ts, tool: clip(collapse(label), 100), text: failureText(text) });
      }
    } else if (block.type === 'text' && human && typeof block.text === 'string') {
      addPrompt(state, block.text, ts);
    }
  }
}

function ingestAssistant(state: TranscriptState, obj: Record<string, unknown>, ts: number): void {
  const message = isObj(obj.message) ? obj.message : {};
  // Model: last assistant message with a real model id. '<synthetic>' is ignored.
  if (typeof message.model === 'string' && message.model && message.model !== '<synthetic>') {
    state.model = message.model;
  }
  state.lastAssistantEndTurn = message.stop_reason === 'end_turn';
  const apiErr = typeof obj.apiError === 'string' || obj.isApiErrorMessage === true;
  if (!apiErr && message.model !== '<synthetic>') state.assistantTurns++;
  const content = Array.isArray(message.content) ? message.content : [];
  let hasThinking = false;
  let thinking = '';
  let text = '';
  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === 'thinking') {
      hasThinking = true;
      if (typeof block.thinking === 'string' && block.thinking.trim()) thinking = block.thinking.trim();
    } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      text = block.text.trim();
      if (apiErr && typeof obj.uuid === 'string') {
        addFailure(state, { id: obj.uuid, ts, tool: 'เรียก API', text: failureText(text) });
      }
      // full answer (newlines kept) so the pane shows what Claude actually said, not just its first line
      if (!apiErr) pushEvent(state, 'text', clip(stripSecrets(text), EVENT_TEXT_MAX), ts);
      else if (LIMIT_TEXT_RE.test(text)) {
        const line = clip(firstLine(text), 160);
        state.limit = { text: line, at: ts };
        pushEvent(state, 'text', line, ts, 'limit');
      } else pushEvent(state, 'text', clip(firstLine(text), 160), ts);
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      state.pending.set(block.id, { name: block.name, input: block.input, ts });
      state.tools.set(block.id, { name: block.name, label: summarizeTool(block.name, block.input) });
      pushEvent(state, 'tool', summarizeTool(block.name, block.input), ts);
    }
  }
  // A normal (non-error) assistant turn means the limit is over.
  if (!apiErr && message.model !== '<synthetic>' && content.some((b) => isObj(b) && (b.type === 'text' || b.type === 'tool_use'))) {
    state.limit = null;
  }
  // Thought priority 1 uses the latest assistant entry that has thinking blocks.
  if (hasThinking) state.lastThinking = thinking;
  if (text && !apiErr && message.stop_reason === 'end_turn' && message.model !== '<synthetic>') {
    state.endTurnSeq++;
    state.lastEndTurn = { text, ts };
  }
  if (text) {
    state.lastText = firstLine(text);
    if (!apiErr) state.lastTextFull = clip(collapse(stripSecrets(text)), 800);
  }
}

/**
 * Feed one complete transcript line. Never throws.
 * - blank lines are ignored (not counted);
 * - a line that is not a JSON object counts as a bad line and is otherwise ignored;
 * - known entry types are recognised; unknown types are ignored (not recognised).
 * The watcher should feed complete lines only; a truncated trailing line that is
 * still being written will count as one bad line until its newline arrives.
 */
export function ingestLine(state: TranscriptState, line: string): void {
  try {
    if (typeof line !== 'string') return;
    const trimmed = line.trim();
    if (!trimmed) return;
    state.totalLines++;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      state.badLines++;
      return;
    }
    if (!isObj(obj) || typeof obj.type !== 'string') {
      state.badLines++;
      return;
    }
    const type = obj.type;
    if (type === 'ai-title') {
      recognise(state, obj);
      if (typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) state.title = collapse(obj.aiTitle);
    } else if (type === 'user') {
      ingestUser(state, obj, recognise(state, obj));
    } else if (type === 'assistant') {
      ingestAssistant(state, obj, recognise(state, obj));
    } else if (type === 'system' && obj.subtype === 'api_error') {
      const ts = recognise(state, obj);
      // Retries are transient noise; only the final failed attempt is a failure of the work.
      const err = isObj(obj.error) ? obj.error : {};
      const last = typeof obj.retryAttempt === 'number' && typeof obj.maxRetries === 'number' && obj.retryAttempt >= obj.maxRetries;
      const msg = typeof err.formatted === 'string' ? err.formatted : typeof err.message === 'string' ? err.message : '';
      if (last && msg && typeof obj.uuid === 'string') addFailure(state, { id: obj.uuid, ts, tool: 'เรียก API', text: failureText(msg) });
    } else if (NOISE_TYPES.has(type) || type.startsWith('api-request')) {
      // Known noise: recognised (so the file is not "unreadable") but carries no state.
      recognise(state, obj);
    }
    // Any other type: ignored on purpose.
  } catch {
    state.badLines++;
  }
}

// ---------- derive ----------

function oldestPending(state: TranscriptState): PendingTool | undefined {
  let best: PendingTool | undefined;
  for (const p of state.pending.values()) {
    if (!best || p.ts < best.ts) best = p;
  }
  return best;
}

/**
 * Unanswered prompts of a live terminal session, oldest first:
 *  - every pending AskUserQuestion (with its questions) and ExitPlanMode (plan approval);
 *  - a permission prompt: the transcript never records it, so it is only reported when Claude's own
 *    session json says status=waiting, and then it is the OLDEST other pending tool_use.
 */
export function waitItems(state: TranscriptState, liveWaiting: boolean): WaitItem[] {
  const out: WaitItem[] = [];
  let oldestOther: [string, PendingTool] | undefined;
  for (const [id, p] of state.pending) {
    if (p.name === 'AskUserQuestion') {
      const questions = parseQuestions(p.input);
      out.push({
        id,
        kind: 'ask',
        toolName: p.name,
        label: toolLabel(p.name, p.input),
        detail: questions?.[0]?.question ?? '',
        ...(questions ? { questions } : {}),
        at: p.ts,
      });
    } else if (p.name === 'ExitPlanMode') {
      const plan = isObj(p.input) && typeof p.input.plan === 'string' ? firstLine(p.input.plan) : '';
      out.push({ id, kind: 'permission', toolName: p.name, label: 'ขออนุมัติแผน', detail: clip(plan, 160), at: p.ts });
    } else if (!oldestOther || p.ts < oldestOther[1].ts) {
      oldestOther = [id, p];
    }
  }
  if (liveWaiting && oldestOther) {
    const [id, p] = oldestOther;
    const label = toolLabel(p.name, p.input);
    const k = label.indexOf(': ');
    out.push({
      id,
      kind: 'permission',
      toolName: p.name,
      label: `ขออนุญาต${label}`,
      detail: clip(k >= 0 ? label.slice(k + 2) : '', 160),
      at: p.ts,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Derive the public view of a transcript.
 *
 * Title: last ai-title; else first human prompt; each capped at 80 chars; else '(ไม่มีชื่อ)'.
 * Model / effort: last real model id; latest effort value seen.
 * Status (first match wins):
 *   1. done: processAlive === false, or finished === true (subagent meta).
 *   2. unreadable: nothing recognised in >= 1 line, or >50% bad lines with >= 10 lines.
 *      Never guessed: the reason is returned in `unreadable`.
 *   3. waiting: a pending AskUserQuestion / ExitPlanMode (no tool_result yet).
 *   4. running: a pending other tool started within 10 min, or the transcript
 *      was written within the last 10 s.
 *   5. idle: otherwise.
 * Thought (<=120 chars, one line), priority:
 *   1. thinking text of the latest assistant entry that has thinking blocks;
 *   2. summary of the oldest still-pending tool_use ("Bash: <description>");
 *   3. first non-empty line of the latest assistant text.
 * Timeline: last 30 events, oldest first.
 */
export function derive(state: TranscriptState, ctx: DeriveCtx): Derived {
  const now = ctx.now;
  const title = clip(state.title || state.firstPrompt || '', 80) || '(ไม่มีชื่อ)';

  let unreadableReason: string | undefined;
  if (state.totalLines > 0 && state.recognisedLines === 0) {
    unreadableReason = `no recognised transcript entries in ${state.totalLines} lines`;
  } else if (state.totalLines >= 10 && state.badLines / state.totalLines > 0.5) {
    unreadableReason = `${state.badLines} of ${state.totalLines} lines are not valid JSON`;
  }

  const pendingAll = [...state.pending.values()];
  const waiting = pendingAll.some((p) => WAITING_TOOLS.has(p.name));
  const pendingOther = pendingAll.filter((p) => !WAITING_TOOLS.has(p.name));
  const lastActivity = state.lastActivityTs;

  let status: Status;
  if (ctx.processAlive === false || ctx.finished === true) {
    status = 'done';
  } else if (unreadableReason) {
    status = 'unreadable';
  } else if (waiting) {
    status = 'waiting';
  } else if (
    pendingOther.some((p) => now - p.ts <= RECENT_TOOL_MS) ||
    (lastActivity > 0 && now - lastActivity <= RECENT_ACTIVITY_MS)
  ) {
    status = 'running';
  } else {
    status = 'idle';
  }

  let thought = '';
  if (state.lastThinking) {
    thought = clip(collapse(state.lastThinking), 120);
  } else {
    const oldest = oldestPending(state);
    if (oldest) thought = clip(summarizeTool(oldest.name, oldest.input), 120);
    else if (state.lastText) thought = clip(collapse(state.lastText), 120);
  }

  const derived: Derived = {
    title,
    model: state.model,
    effort: state.effort,
    status,
    thought,
    timeline: state.timeline.map((e) => ({ ...e })),
    lastActivity,
    waitItems: status === 'done' || status === 'unreadable' ? [] : waitItems(state, ctx.liveWaiting === true),
  };
  if (state.limit && status !== 'done') derived.limit = { ...state.limit };
  if (status === 'unreadable' && unreadableReason) derived.unreadable = unreadableReason;
  return derived;
}
