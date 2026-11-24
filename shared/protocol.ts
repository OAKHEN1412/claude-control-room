// Wire protocol (WebSocket, JSON text frames). Server -> browser: watcher view + Runner state.
// Browser -> server: stage 2 commands (validated in server/src/commands.ts).
import type { UsageSnapshot } from './usage';

export type Status = 'running' | 'waiting' | 'idle' | 'done' | 'unreadable';

export interface TimelineEvent {
  ts: number; // epoch ms
  kind: 'user' | 'tool' | 'error' | 'text';
  text: string; // tool/error: one line <= 160 chars; user/text: whole message <= 4000 chars, newlines kept
  tone?: 'limit'; // usage / rate limit message (shown red); additive
}

/** A session that hit a usage / rate limit and has not produced a normal answer since. */
export interface LimitInfo {
  text: string; // the message, one line <= 160 chars, e.g. "You've hit your 5-hour limit · resets 1:30pm (Asia/Bangkok)"
  at: number; // epoch ms
}

/** Matches the usage / rate limit messages Claude Code writes as an API error. */
export const LIMIT_TEXT_RE = /(hit your .{0,40}limit|usage limit|weekly limit|5-hour limit|rate limit|limit (?:reached|will reset)|limit resets?)/i;
/** "ติดลิมิต · resets 1:30pm (Asia/Bangkok)" from the message; just "ติดลิมิต" when it has no reset part. */
export function limitLabel(text: string): string {
  const m = /resets?.*$/i.exec(text.replace(/\s+/g, ' '));
  return m ? `ติดลิมิต · ${m[0].trim()}` : 'ติดลิมิต';
}

export interface AgentInfo {
  id: string; // agent id from file name agent-<id>.jsonl
  description: string; // from .meta.json
  model: string | null;
  effort: string | null;
  status: Status; // running | idle | done (finished) | unreadable
  thought: string;
  finished: boolean;
  lastActivity: number;
}

/** A question or permission prompt a terminal session is waiting on, seen through the transcript. Read-only. */
export interface WaitItem {
  id: string; // tool_use id
  kind: 'ask' | 'permission';
  toolName: string;
  label: string; // Thai tool label with key detail
  detail: string; // command / file name, '' when none
  questions?: AskQuestion[]; // kind === 'ask'
  at: number; // epoch ms the tool_use was written
}

export interface SessionInfo {
  sessionId: string;
  pid: number;
  name: string; // from sessions/<pid>.json
  cwd: string;
  kind: string;
  title: string; // ai-title, else first user prompt (<=80 chars)
  model: string | null;
  effort: string | null;
  status: Status;
  thought: string; // <=120 chars
  startedAt: number;
  lastActivity: number; // epoch ms of last transcript entry
  timeline: TimelineEvent[]; // last ~30, oldest first
  subagents: AgentInfo[];
  limit?: LimitInfo; // latest usage/rate-limit message with no normal assistant turn after it
  waitItems?: WaitItem[]; // stage 3: questions / permissions the transcript shows as unanswered (read-only)
  unreadable?: string; // reason when status === 'unreadable'
  machineId?: string; // set by the main server on a session that lives on another machine (remote agent); absent = this PC
}

// ---- Stage 2: Runner (sessions started / resumed by the web) ----

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const DEFAULT_EFFORT: EffortLevel = 'high';

export interface ModelOption {
  id: string; // value used in commands
  label: string; // shown in the UI
  cli: string | null; // value for claude --model; null = not launchable
  disabled?: string; // reason shown as tooltip; present = cannot be chosen
}

export const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: 'opus', label: 'Opus 5.5', cli: 'opus' },
  { id: 'fable', label: 'Fable 5.2', cli: 'fable' },
  { id: 'sonnet', label: 'Sonnet 5.5', cli: 'sonnet' },
  { id: 'haiku', label: 'Haiku 5.5', cli: 'haiku' },
  { id: 'qwen', label: 'qwen (claude-9arm)', cli: null, disabled: 'ช้า และยังเป็นแบบทดลอง' },
  { id: 'tokenme-deepseek', label: 'TokenMe · DeepSeek V4 Flash', cli: null, disabled: 'TokenMe ปฏิเสธ: ยังไม่ได้สมัครแพ็กเกจ (2026-11-23)' },
  { id: 'tokenme-qwen', label: 'TokenMe · Qwen 3.8 27B', cli: null, disabled: 'TokenMe ปฏิเสธ: ยังไม่ได้สมัครแพ็กเกจ (2026-11-23)' },
  { id: 'tokenme-gemma', label: 'TokenMe · Gemma 4 31B', cli: null, disabled: 'TokenMe ปฏิเสธ: ยังไม่ได้สมัครแพ็กเกจ (2026-11-23)' },
  { id: 'aipass', label: 'AIpass', cli: null, disabled: 'ยังไม่ตั้งค่า' },
];
export const DEFAULT_MODEL = 'opus';

// ---- Permission mode (per job) ----
// `default` = ask for every risky tool; acceptEdits = file edits go through, commands still ask;
// plan = Claude only plans; bypassPermissions = never asks (needs an explicit `confirm: true`).
// The CLI also lists auto (a model classifier decides), dontAsk (anything not pre-approved is denied
// without a prompt) and manual (alias of default). They are deliberately not offered: see docs/permission-mode-check.md.
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';
export const CLIP_PERMISSION_MODE: PermissionMode = 'acceptEdits';
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'ถามทุกครั้ง',
  acceptEdits: 'แก้ไฟล์ได้เลย · คำสั่งยังถาม',
  plan: 'วางแผนอย่างเดียว',
  bypassPermissions: 'ไม่ถามเลย (เสี่ยง)',
};
export const BYPASS_CONFIRM_TEXT = 'งานนี้จะแก้ไฟล์และรันคำสั่งได้โดยไม่ถาม — ยืนยัน?';

/** Quick-command chips (text sent as a normal user message). */
export const QUICK_CHIPS: readonly string[] = ['ทำงานต่อ', 'ลุยเลย', 'เสร็จยัง', 'handoff', 'commit push'];

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: { label: string; description: string }[];
}

/** A can_use_tool request held until the user answers. Never auto-answered. */
export interface PendingRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  kind: 'permission' | 'ask';
  description: string; // short, for the button row
  label?: string; // Thai tool label with key detail (server/src/toolLabels.ts)
  detail?: string; // key detail only: command / file name
  inputPreview: string; // JSON of the tool input, <= 2000 chars
  questions?: AskQuestion[]; // kind === 'ask'
  at: number;
}

/** A user message Claude has accepted but not started on yet (it waits behind the running tool / turn). */
export interface QueuedText {
  text: string; // <= 300 chars, secrets stripped
  at: number; // epoch ms when it was sent
  files?: string[]; // attachment file names
}

/** Live state of a session the Runner owns (a child process is, or was, attached). */
export interface RunnerState {
  sessionId: string;
  cwd: string;
  alive: boolean; // child process still running
  pid: number | null;
  busy: boolean; // a turn is running
  queued: number; // user messages sent while busy, not yet answered
  queuedTexts?: QueuedText[]; // those messages, oldest first (additive; absent when queued is 0)
  model: string | null; // as confirmed by get_settings (applied), else requested
  effort: string | null;
  confirmed: boolean; // model/effort came from get_settings
  permissionMode: PermissionMode; // as the child reports it (init / set_permission_mode answer)
  remoteControl: boolean; // Remote Control (claude.ai / phone) is on for this session
  remoteUrl?: string; // claude.ai/code/... link while remoteControl is on
  limit?: LimitInfo; // the child reported a usage/rate limit and has not answered normally since
  pending: PendingRequest[];
  error?: string;
  startedAt: number;
  machineId?: string; // remote agent: the machine this job runs on; absent = this PC
}

// ---- Stage 4: worklog + summary assistant ----

/** One finished job in the worklog ("บันทึกงาน"). Built from the server's own failure records; Haiku only words it. */
export interface WorklogCard {
  sessionId: string;
  title: string;
  cwd: string;
  finishedAt: number; // epoch ms of the session's last activity when the card was made
  result: string | null; // one line ("เสร็จ: ..."); null until Haiku wrote it
  bullets: string[]; // what did not work, short
  failureCount: number; // failed actions recorded for this session (layer 1)
  state: 'queued' | 'haiku' | 'rule'; // queued = waiting for the summary call; rule = Haiku failed, bullets are deterministic
  updatedAt: number;
}

// ---- Stage 5: Clip Studio ----

export const CLIP_STAGES = ['บท', 'storyboard', 'สร้าง scene', 'preview', 'พร้อม render'] as const;
export const CLIP_LENGTHS = ['30s', '60s', '90s', '3min'] as const;
export const CLIP_RATIOS = ['16:9', '9:16', '1:1'] as const;
export const CLIP_LANGS = ['th', 'en'] as const;
export const CLIP_CAST = ['เทค', 'บอท', 'ภู', 'ฟ้า'] as const;
export const CLIP_VOICE_MODEL = 'eleven_v3';
export const CLIP_SCRIPT_MODELS = ['opus', 'fable', 'sonnet', 'haiku'] as const; // models a clip job can use (Claude only)
export const CLIP_BUILDER_MODELS = ['opus', 'fable', 'sonnet'] as const;

export interface ClipSettings {
  length: (typeof CLIP_LENGTHS)[number];
  ratio: (typeof CLIP_RATIOS)[number];
  lang: (typeof CLIP_LANGS)[number];
  voice: boolean;
  music: boolean;
  cast: string[]; // subset of CLIP_CAST
  outro?: ClipOutro; // ending of the clip; absent = no ending (old presets and jobs)
}

/** The ending (outro) of a clip: a last scene of ~3-5 s that shows this text. */
export interface ClipOutro {
  on: boolean;
  text: string; // <= CLIP_OUTRO_MAX chars, may have several lines
}

export const CLIP_OUTRO_MAX = 300;
export const CLIP_OUTRO_SAVED_MAX = 50;
export const CLIP_OUTRO_NAME_MAX = 40;

/** Ending text as stored: CRLF to LF, control characters removed (newline kept), trimmed. */
export function cleanOutroText(v: string): string {
  // eslint-disable-next-line no-control-regex
  return v.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '').trim();
}

/** A saved ending phrase, shared by every browser. */
export interface ClipOutroPhrase {
  id: string;
  name: string;
  text: string;
  createdAt: number;
}

/** One clip job (a Runner session started from Clip Studio). `stage` is an index into CLIP_STAGES. */
export interface ClipJob {
  sessionId: string;
  topic: string;
  slug: string;
  cwd: string;
  styleId: string; // 'ours:<id>' or 'lemo:<id>'
  styleName: string;
  settings: ClipSettings;
  voiceId: string | null;
  scriptModel: string;
  builderModel: string;
  createdAt: number;
  stage: number; // 0..4, highest stage reached (never goes back)
  ready: boolean; // stage === 4: ready to render, waiting for the user
  renderRequested: boolean; // the user pressed "สั่ง render"
}

/** A saved set of every clip setting plus the style, picked in one click on the Clip Studio page. */
export interface ClipPreset {
  id: string;
  name: string;
  settings: ClipSettings;
  styleId: string; // 'ours:<id>' or 'lemo:<id>'
  suggested: boolean; // seeded from past clips on first run, not yet edited by the user
  createdAt: number;
}

/** A clip that was queued but has not started generating yet (no session exists for it). */
export interface ClipQueueItem {
  id: string; // queue id, not a session id
  topic: string;
  settings: ClipSettings;
  styleId: string;
  styleName: string;
  createdAt: number;
  error?: string; // starting it failed; it stays in the list until removed
}

export const CLIP_PRESET_MAX = 40;

export interface ClipStartInput {
  topic: string;
  points: string;
  settings: ClipSettings;
  styleId: string;
  voiceId: string | null;
  scriptModel: string;
  builderModel: string;
  effort: EffortLevel;
  permissionMode?: PermissionMode; // missing = acceptEdits for clip jobs
  remoteControl?: boolean;
  confirm?: boolean; // required when permissionMode is bypassPermissions
}

// ---- Links between AI sessions (relay): the final answer of A is sent as a user message to B ----

export const LINK_MAX_FORWARDS_DEFAULT = 6;
export const LINK_MAX_FORWARDS_LIMIT = 50;

/** A -> B: every finished turn of `from` (final answer) is forwarded to `to` (a live Runner job). In-memory only. */
export interface LinkInfo {
  id: string;
  from: string; // source session id (Runner job or terminal session)
  to: string; // target session id (must be a live Runner job)
  paused: boolean;
  state: 'ok' | 'limit' | 'rate' | 'error'; // limit = maxForwards reached, rate = global cap, error = last forward failed
  forwards: number;
  maxForwards: number;
  lastForwardAt: number | null; // epoch ms
  error?: string;
}


// ---- Saved sessions (remembered work that can be reopened another day) ----

/** One remembered session. Hiding only flips `hidden`; a transcript file is never deleted or moved. */
export interface SavedSession {
  sessionId: string;
  cwd: string;
  title: string;
  model: string | null;
  effort: string | null;
  source: 'terminal' | 'web' | 'clip';
  firstSeen: number; // epoch ms
  lastActivity: number; // epoch ms
  hidden: boolean;
  live: boolean; // in the watcher snapshot with its process alive, or a live Runner job
  machineId?: string; // remote agent: the machine that remembered it; absent = this PC
}

// ---- Machines (other PCs on Tailscale that an AI can work on over SSH) ----

export type MachineShell = 'cmd' | 'powershell' | 'bash';
export const MACHINE_SHELLS: readonly MachineShell[] = ['cmd', 'powershell', 'bash'];

export type AgentState = 'connecting' | 'online' | 'error';

export interface MachineInfo {
  id: string;
  name: string;
  host: string;
  user: string;
  keyPath: string;
  shell: MachineShell;
  notes: string;
  reach: 'online' | 'offline' | 'unknown'; // TCP connect to host:22
  ssh: 'ok' | 'fail' | 'untested' | 'not_configured';
  sshError?: string;
  lastCheck: number | null; // epoch ms of the last reachability probe
  agent?: boolean; // 'ดู Claude บนเครื่องนี้': the main server keeps an SSH tunnel to the agent on this machine
  agentState?: AgentState; // connection of that tunnel + websocket (only when agent)
  agentError?: string; // Thai text when agentState === 'error'
  agentCwds?: string[]; // folders the agent allows a new job in
}

export interface TailscalePeer {
  name: string; // HostName, lowercased
  ip: string; // first IPv4
  os: string;
  online: boolean;
}

/** A live Runner job that was told about a machine (in memory only). */
export interface MachineAttachment {
  sessionId: string;
  machineId: string;
  at: number; // epoch ms
}

export interface MachineFields {
  name: string;
  host: string;
  user: string;
  keyPath: string;
  shell: MachineShell;
  notes?: string;
  agent?: boolean; // missing on machine_update = keep the current value
}

export type ClientMsg =
  | ({ type: 'clip_start'; reqId: string } & ClipStartInput)
  | { type: 'clip_render'; reqId: string; sessionId: string }
  | { type: 'clip_preset_save'; reqId: string; id?: string; name: string; settings: ClipSettings; styleId: string } // no id = new preset, id = rename / update
  | { type: 'clip_preset_delete'; reqId: string; id: string }
  | { type: 'clip_outro_save'; reqId: string; id?: string; name?: string; text: string } // no id = new saved ending, id = rename / replace text
  | { type: 'clip_outro_delete'; reqId: string; id: string }
  | { type: 'clip_dequeue'; reqId: string; id: string } // remove a queued clip that has not started
  | {
      type: 'start';
      reqId: string;
      cwd: string;
      model: string;
      effort: EffortLevel;
      prompt: string; // may be '' when `attachments` is given
      permissionMode?: PermissionMode; // missing = default
      remoteControl?: boolean;
      confirm?: boolean; // required when permissionMode is bypassPermissions
      attachments?: string[]; // upload ids from POST /api/upload (<= 10), see shared/uploads.ts
    }
  | { type: 'send'; reqId: string; sessionId: string; text: string; attachments?: string[] } // text may be '' when attachments is given
  | { type: 'stop'; reqId: string; sessionId: string }
  | { type: 'send_now'; reqId: string; sessionId: string } // interrupt the running turn, then deliver the queued messages as ONE message
  | { type: 'close'; reqId: string; sessionId: string } // end a Runner job now (stdin closed, then killed)
  | { type: 'open_terminal'; reqId: string; sessionId: string } // open a Windows Terminal window running `cr attach <id>` (live Runner job only)
  | { type: 'set_model'; reqId: string; sessionId: string; model: string }
  | { type: 'set_effort'; reqId: string; sessionId: string; effort: EffortLevel }
  | { type: 'set_permission_mode'; reqId: string; sessionId: string; mode: PermissionMode; confirm?: boolean }
  | { type: 'set_remote_control'; reqId: string; sessionId: string; on: boolean }
  | {
      type: 'answer';
      reqId: string;
      sessionId: string;
      requestId: string;
      behavior: 'allow' | 'deny';
      answers?: Record<string, string>; // AskUserQuestion: question text -> chosen label / free text
      message?: string; // deny reason
    }
  | {
      type: 'adopt';
      reqId: string;
      sessionId: string;
      model?: string;
      effort?: EffortLevel;
      permissionMode?: PermissionMode; // missing = default (acceptEdits for a clip job)
      remoteControl?: boolean;
      confirm?: boolean;
    }
  | { type: 'takeover'; reqId: string; sessionId: string } // 'ยึดมาคุม': close that terminal session's claude (exact pid, idle only) and adopt it under the Runner in bypassPermissions; carries machineId on a remote machine
  | { type: 'link_create'; reqId: string; from: string; to: string; maxForwards?: number } // 1..50, default 6; ack carries linkId
  | { type: 'link_delete'; reqId: string; linkId: string }
  | { type: 'link_pause'; reqId: string; linkId: string; paused: boolean }
  | { type: 'link_resume'; reqId: string; linkId: string } // resets the counter, clears limit / rate / error
  | { type: 'ask'; reqId: string; question: string } // summary assistant (Haiku, no tools). Never reaches a session.
  | { type: 'saved_hide'; reqId: string; sessionId: string } // only flips `hidden`; never touches a transcript file
  | { type: 'saved_unhide'; reqId: string; sessionId: string }
  | {
      type: 'saved_resume';
      reqId: string;
      sessionId: string;
      model?: string;
      effort?: EffortLevel;
      permissionMode?: PermissionMode;
      confirm?: boolean; // required when permissionMode is bypassPermissions
    }
  | ({ type: 'machine_add'; reqId: string } & MachineFields) // ack carries machineId
  | ({ type: 'machine_update'; reqId: string; machineId: string } & MachineFields)
  | { type: 'machine_delete'; reqId: string; machineId: string } // also removes its attachments
  | { type: 'machine_test'; reqId: string; machineId: string } // ssh ... "echo cr-ok"
  | { type: 'machine_attach'; reqId: string; sessionId: string; machineId: string } // live Runner job only
  | { type: 'machine_detach'; reqId: string; sessionId: string; machineId: string };

export type ServerMsg =
  | { type: 'snapshot'; machine: string; serverTime: number; sessions: SessionInfo[]; runners?: RunnerState[]; cwds?: string[]; links?: LinkInfo[]; saved?: SavedSession[]; machines?: MachineInfo[]; attachments?: MachineAttachment[]; peers?: TailscalePeer[]; usage?: UsageSnapshot }
  | { type: 'usage'; serverTime: number; usage: UsageSnapshot } // 5 h / weekly quota + per-session context; broadcast on change
  | { type: 'runner'; serverTime: number; runner: RunnerState }
  | { type: 'runner_removed'; serverTime: number; sessionId: string; machineId?: string }
  | { type: 'cwds'; serverTime: number; cwds: string[] }
  | { type: 'ack'; serverTime: number; reqId: string; ok: boolean; error?: string; sessionId?: string; linkId?: string; machineId?: string; answer?: string }
  | { type: 'links'; serverTime: number; links: LinkInfo[] } // broadcast on every change
  | { type: 'worklog'; serverTime: number; cards: WorklogCard[] }
  | { type: 'saved'; serverTime: number; sessions: SavedSession[] } // newest lastActivity first, <= 300, hidden included; debounced 1 s
  | { type: 'machines'; serverTime: number; machines: MachineInfo[]; attachments: MachineAttachment[]; peers: TailscalePeer[] }
  | { type: 'clips'; serverTime: number; jobs: ClipJob[]; queue?: ClipQueueItem[]; presets?: ClipPreset[]; outros?: ClipOutroPhrase[] }
  | { type: 'session'; serverTime: number; session: SessionInfo } // add or replace
  | { type: 'removed'; serverTime: number; sessionId: string; machineId?: string }
  | { type: 'ping'; serverTime: number };

export const SERVER_PORT = 8790;

// ---- Remote agent (another PC's Claude sessions, seen through an SSH tunnel) ----

export const AGENT_PORT = 8791; // the agent listens here on 127.0.0.1 of the remote PC; the main server forwards a local port to it
export const AGENT_TOKEN_HEADER = 'x-cr-agent-token';

/**
 * A browser command aimed at another machine's agent carries `machineId` (any command that targets a session or starts a
 * job: start, send, stop, close, set_*, answer, adopt, takeover, saved_resume). The main server validates it like a local one,
 * forwards it with its own reqId and relays the ack under the browser's reqId. machine_* messages keep their own meaning
 * of machineId.
 */
export const REMOTE_ROUTABLE: readonly string[] = ['start', 'send', 'send_now', 'stop', 'close', 'set_model', 'set_effort', 'set_permission_mode', 'set_remote_control', 'answer', 'adopt', 'takeover', 'saved_resume'];

/** One card of the video gallery (GET /api/gallery). The browser only ever sees `id`, never a file path. */
export interface GalleryItem {
  id: string;
  project: string; // folder that owns the renders/ directory
  name: string; // file name without extension
  title: string; // "project / name", readable
  mtimeMs: number;
  size: number;
  durationSec: number | null; // null when ffprobe failed
  style: string; // clip job style, else our style, else ''
  topic: string; // clip job topic, else ''
  thumbUrl: string; // may 404 when ffmpeg fails: the UI shows a placeholder
  videoUrl: string;
}
