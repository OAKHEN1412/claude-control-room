// Pure helpers for stage 2 controls (no React): who may be controlled, labels, answer building.
import {
  MODEL_OPTIONS,
  PERMISSION_MODES,
  type AskQuestion,
  type ModelOption,
  type PermissionMode,
  type PendingRequest,
  type RunnerState,
  type SessionInfo,
} from '../../shared/protocol';

/** runner: controlled from the web now. adoptable: terminal process is gone, can be resumed under the Runner.
 *  readonly: a live terminal session (never written to). */
export type ControlMode = 'runner' | 'adoptable' | 'readonly';

export function controlMode(session: SessionInfo, runner: RunnerState | undefined): ControlMode {
  if (runner?.alive) return 'runner';
  if (session.status === 'done') return 'adoptable';
  return 'readonly';
}

export const READONLY_REASON = 'เปิดจาก terminal — ดูได้อย่างเดียว';
export const ADOPT_DISABLED = 'ใช้ได้เมื่อ session นี้ปิดแล้ว';
export const ADOPT_HINT = 'terminal ปิดแล้ว — กด "ย้ายมาคุมจากเว็บ" เพื่อทำต่อ';

/** Reason shown on disabled model/effort/send controls; null when controllable. */
export function disabledReason(mode: ControlMode): string | null {
  if (mode === 'runner') return null;
  return mode === 'adoptable' ? ADOPT_HINT : READONLY_REASON;
}

/** Last two path segments. */
export function cwdTail(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return cwd;
  return parts.length > 2 ? `…\\${parts.slice(-2).join('\\')}` : parts.join('\\');
}

/** "name — folder": shown beside every send button so the target is never ambiguous. */
export function targetLabel(session: Pick<SessionInfo, 'name' | 'cwd'>): string {
  return `${session.name || 'session'} — ${cwdTail(session.cwd)}`;
}

/** Maps a model string from the CLI ("claude-haiku-5-5", "haiku") to a select option id. */
export function modelOptionId(model: string | null | undefined): string | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const o of MODEL_OPTIONS) {
    if (o.cli && (m === o.cli || m.includes(o.cli))) return o.id;
  }
  return null;
}

export function modelTitle(o: ModelOption): string | undefined {
  return o.disabled;
}

/** Effort to show in a select: the confirmed value of the Runner, else the session's. */
export function effortValue(runner: RunnerState | undefined, session: SessionInfo): string {
  return runner?.effort ?? session.effort ?? 'high';
}

export function modelValue(runner: RunnerState | undefined, session: SessionInfo): string {
  return modelOptionId(runner?.model) ?? modelOptionId(session.model) ?? '';
}

/** Short busy/queue line for the pane head. */
export function runnerLine(r: RunnerState | undefined): string {
  if (!r) return '';
  if (!r.alive) return r.error ? `งานหยุดแล้ว: ${r.error}` : 'งานหยุดแล้ว';
  const parts = [r.busy ? 'กำลังทำ' : 'ว่าง'];
  if (r.queued > 0) parts.push(`รอคิว ${r.queued} งาน`);
  if (r.pending.length > 0) parts.push(`รอคุณ ${r.pending.length}`);
  if (!r.confirmed) parts.push('รอยืนยันโมเดลจากตัวงาน');
  return parts.join(' · ');
}

/** Answers object for AskUserQuestion from per-question choices (multi-select: labels joined by ", "). */
export function buildAnswers(questions: readonly AskQuestion[], choices: Record<string, string[] | string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of questions) {
    const c = choices[q.question];
    if (c === undefined) continue;
    const v = Array.isArray(c) ? c.join(', ') : c;
    if (v.trim() !== '') out[q.question] = v;
  }
  return out;
}

export function allAnswered(questions: readonly AskQuestion[], choices: Record<string, string[] | string>): boolean {
  return questions.every((q) => {
    const c = choices[q.question];
    return c !== undefined && (Array.isArray(c) ? c.length > 0 : c.trim() !== '');
  });
}

/** Toggle one option of a question in the local choice map (immutable). */
export function toggleChoice(
  choices: Record<string, string[] | string>,
  q: AskQuestion,
  label: string,
): Record<string, string[] | string> {
  if (!q.multiSelect) return { ...choices, [q.question]: label };
  const cur = Array.isArray(choices[q.question]) ? (choices[q.question] as string[]) : [];
  const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  return { ...choices, [q.question]: next };
}

/** A single single-select question can be answered with one click. */
export function isQuickAsk(p: PendingRequest): boolean {
  return p.kind === 'ask' && !!p.questions && p.questions.length === 1 && !p.questions[0].multiSelect;
}

/** Folders offered in the new-job select: the server's list only. */
export function cwdChoices(cwds: readonly string[]): string[] {
  return [...cwds];
}

export const MODEL_CHOICES: readonly ModelOption[] = MODEL_OPTIONS;

// ---- permission mode / Remote Control ----

/** Mode shown for a session: the Runner's own report; '' when the web does not control it (read-only terminal session). */
export function modeValue(runner: RunnerState | undefined): PermissionMode | '' {
  return runner?.alive ? runner.permissionMode : '';
}

export function needsBypassConfirm(mode: PermissionMode): boolean {
  return mode === 'bypassPermissions';
}

/**
 * What a mode select does when the user picks `chosen` while `current` is set.
 * apply = send it now; confirm = show the inline confirmation first (bypassPermissions); none = no change.
 */
export function modeChoice(current: PermissionMode | '', chosen: PermissionMode): 'apply' | 'confirm' | 'none' {
  if (chosen === current) return 'none';
  return needsBypassConfirm(chosen) ? 'confirm' : 'apply';
}

/** Command fields for start / clip_start / adopt. `confirmed` is only true after the explicit confirm step. */
export function jobFlags(mode: PermissionMode, confirmed: boolean, remoteControl: boolean): {
  permissionMode: PermissionMode;
  confirm?: true;
  remoteControl?: true;
} {
  return {
    permissionMode: mode,
    ...(needsBypassConfirm(mode) && confirmed ? { confirm: true as const } : {}),
    ...(remoteControl ? { remoteControl: true as const } : {}),
  };
}

/** Small badges for a graph node: the mode when it is not default, and RC when Remote Control is on. */
export function modeBadges(runner: RunnerState | undefined): string[] {
  if (!runner?.alive) return [];
  const out: string[] = [];
  if (runner.permissionMode !== 'default') out.push(runner.permissionMode);
  if (runner.remoteControl) out.push('RC');
  return out;
}

export const isPermissionMode = (v: string): v is PermissionMode => (PERMISSION_MODES as readonly string[]).includes(v);

// ---- close job ("ปิดงาน") ----

/** How long the first click of "ปิดงาน" stays armed before it reverts. */
export const CLOSE_CONFIRM_MS = 4000;
export const CLOSE_TERMINAL_REASON = 'งานที่เปิดจาก terminal ต้องปิดจาก terminal';

/** Only a live Runner job can be closed from the web (the same condition the stop button uses). */
export function canCloseJob(mode: ControlMode): boolean {
  return mode === 'runner';
}

/** Tooltip of the close button; undefined when it is enabled. */
export function closeJobTitle(mode: ControlMode): string | undefined {
  if (mode === 'runner') return 'ปิดงานนี้ — หยุดตัวงานและเอาออกจากผัง';
  return mode === 'readonly' ? CLOSE_TERMINAL_REASON : (disabledReason(mode) ?? undefined);
}

/**
 * Two-step close. The first click arms the button ("ยืนยันปิดงาน?"); a second click while armed sends the close.
 * Nothing happens when the job cannot be closed from the web.
 */
export function closeClick(armed: boolean, canClose: boolean): 'arm' | 'send' | 'none' {
  if (!canClose) return 'none';
  return armed ? 'send' : 'arm';
}

// ---- the terminal as a second client of a Runner job (the `cr` command) ----

export const OPEN_TERMINAL_LABEL = 'เปิดใน terminal';
export const OPEN_TERMINAL_TITLE = 'เปิดหน้าต่าง terminal ที่ต่อกับงานนี้ — พิมพ์สั่งได้พร้อมกับหน้าเว็บ';

/** Open-in-terminal needs a live Runner job (a terminal session already has its own window). */
export function canOpenTerminal(mode: ControlMode): boolean {
  return mode === 'runner';
}

/** First 8 characters of a session id: what `cr` accepts as a prefix. */
export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Hint for a session that runs in a real terminal (read-only here): how to command it from the web as well.
 * null when the session is not a read-only terminal one.
 */
export function terminalHint(mode: ControlMode, sessionId: string): string | null {
  if (mode !== 'readonly') return null;
  return `อยากสั่งจากเว็บด้วย: กด "ยึดมาคุม" (ปิด claude ใน terminal ให้ แล้วย้ายมาคุมจากเว็บ ใช้ได้เมื่อ session ว่าง) — หรือออกเองใน terminal (/exit) แล้วรัน  cr resume ${shortId(sessionId)}  แล้วกด "ย้ายมาคุมจากเว็บ"`;
}

// ---- take over a live terminal session ("ยึดมาคุม") ----

export const TAKEOVER_LABEL = 'ยึดมาคุม';
export const TAKEOVER_ARMED_LABEL = 'กดอีกครั้งเพื่อปิด claude ใน terminal แล้วย้ายมาคุม';
export const TAKEOVER_TITLE = 'ปิด claude ที่เปิดอยู่ใน terminal ของ session นี้ แล้วเปิดต่อที่เว็บ (ใช้ได้เมื่อว่างเท่านั้น)';
export const TAKEOVER_BUSY_TITLE = 'งานนี้กำลังทำงานอยู่ รอให้ว่างก่อน';
export const TAKEOVER_NOT_LIVE_TITLE = 'ใช้ได้กับ session ที่เปิดใน terminal และยังเปิดอยู่';

/**
 * Whether the take-over button can be pressed, and the tooltip to show. The server re-checks everything (pid, image
 * name, idle, subagents, transcript age); this only keeps the button from inviting an obvious refusal.
 */
export function takeoverGate(session: Pick<SessionInfo, 'status' | 'waitItems' | 'subagents'>, mode: ControlMode): { enabled: boolean; title: string } {
  if (mode !== 'readonly') return { enabled: false, title: TAKEOVER_NOT_LIVE_TITLE };
  const asking = (session.waitItems?.length ?? 0) > 0;
  const subRunning = session.subagents.some((a) => a.status === 'running' && !a.finished);
  if (session.status === 'running' || session.status === 'waiting' || session.status === 'unreadable' || asking || subRunning) {
    return { enabled: false, title: TAKEOVER_BUSY_TITLE };
  }
  return { enabled: true, title: TAKEOVER_TITLE };
}

// ---- queued messages strip ("ข้อความรอส่ง") ----

export interface QueueStrip {
  count: number;
  headline: string; // "ข้อความรอส่ง 3 · จะถึง Claude หลังคำสั่งที่กำลังรันเสร็จ"
  texts: { text: string; at: number; files?: string[] }[]; // oldest first; may be shorter than count (an older server sends only the count)
  running: string | null; // "Bash: cargo build --release · 6 นาที", null when unknown
}

/** "ไม่ถึงนาที" / "6 นาที" / "1 ชม. 5 นาที". */
export function sinceLabel(from: number, now: number): string {
  const min = Math.max(0, Math.floor((now - from) / 60_000));
  if (min < 1) return 'ไม่ถึงนาที';
  return min < 60 ? `${min} นาที` : `${Math.floor(min / 60)} ชม. ${min % 60} นาที`;
}

/** The tool the job is inside right now: the newest timeline event when it is a tool line and the job is busy. */
export function runningNow(session: SessionInfo | undefined, runner: RunnerState | undefined, now: number): string | null {
  if (!runner?.busy || !session) return null;
  const last = session.timeline[session.timeline.length - 1];
  if (!last || last.kind !== 'tool') return null;
  return `${last.text} · ${sinceLabel(last.ts, now)}`;
}

/** null when nothing waits. Only a live job has a queue. */
export function queueStrip(session: SessionInfo | undefined, runner: RunnerState | undefined, now: number): QueueStrip | null {
  if (!runner?.alive || runner.queued <= 0) return null;
  return {
    count: runner.queued,
    headline: `ข้อความรอส่ง ${runner.queued} · จะถึง Claude หลังคำสั่งที่กำลังรันเสร็จ`,
    texts: runner.queuedTexts ?? [],
    running: runningNow(session, runner, now),
  };
}

export const SEND_NOW_LABEL = 'หยุดแล้วส่งเลย';
export const SEND_NOW_CONFIRM_LABEL = 'ยืนยัน: หยุดคำสั่งที่รันอยู่';
export const SEND_NOW_TITLE = 'หยุดคำสั่งที่กำลังรันอยู่ (งานที่ทำค้างจะถูกตัด) แล้วส่งข้อความที่รออยู่ทั้งหมดรวมเป็นข้อความเดียว';
