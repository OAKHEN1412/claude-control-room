import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { ClipJob, ClipOutroPhrase, ClipPreset, ClipQueueItem, LinkInfo, RunnerState, ServerMsg, SessionInfo, WorklogCard } from '../../shared/protocol';
import type { MachineAttachment, MachineInfo, SavedSession, ServerMsgNext, SnapshotNext, TailscalePeer } from './protocolNext';
import { REMOTE_ROUTABLE, SERVER_PORT } from '../../shared/protocol';
import { EMPTY_USAGE, type UsageSnapshot } from '../../shared/usage';
import { createCommander, type CommandInput, type CommandResult, type Commander } from './commands';
import { DEMO_MACHINE, demoSessions } from './demo';
import { demoLinks, demoMachines, demoSaved } from './demoNext';
import { t } from './i18n';

export interface ServerState {
  sessions: SessionInfo[];
  runners: Record<string, RunnerState>; // sessions controlled from the web, by session id
  cwds: string[]; // folders a new job may start in
  clips: ClipJob[]; // stage 5: clip jobs, newest first
  clipQueue: ClipQueueItem[]; // clips waiting for a generation slot, oldest first (empty on an older server)
  clipOutros: ClipOutroPhrase[]; // saved ending phrases, shared by every browser (empty on an older server)
  clipPresets: ClipPreset[]; // saved Clip Studio setting sets, shared by every browser (empty on an older server)
  worklog: WorklogCard[]; // stage 4: today's finished-job cards, newest first
  links: LinkInfo[]; // relay links A -> B (empty on an older server)
  saved: SavedSession[]; // remembered sessions, hidden ones included (empty on an older server)
  machines: MachineInfo[]; // other machines reachable over SSH
  attachments: MachineAttachment[];
  peers: TailscalePeer[]; // Tailscale peers offered when adding a machine
  usage: UsageSnapshot; // 5 h / weekly quota + per-session context (empty on an older server)
  machine: string | null;
  connected: boolean;
  lastMessageAt: number | null; // epoch ms when the last message arrived in this browser
}

export const INITIAL_SERVER_STATE: ServerState = {
  sessions: [],
  runners: {},
  cwds: [],
  clips: [],
  clipQueue: [],
  clipOutros: [],
  clipPresets: [],
  worklog: [],
  links: [],
  saved: [],
  machines: [],
  attachments: [],
  peers: [],
  usage: EMPTY_USAGE,
  machine: null,
  connected: false,
  lastMessageAt: null,
};

/** A message counts as "live" when the socket is open and the last one arrived this recently. */
export const LIVE_WINDOW_MS = 12_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 10_000;

/** One entry per sessionId (the last one wins), whatever the server sent. */
export function uniqueSessions(list: SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const s of list) byId.set(s.sessionId, s);
  return [...byId.values()];
}

export function isUsage(v: unknown): v is UsageSnapshot {
  return !!v && typeof v === 'object' && Array.isArray((v as UsageSnapshot).sessions);
}

/** Pure reducer for one server message. `at` is the receive time (epoch ms). */
export function applyMsg(state: ServerState, msg: ServerMsg | ServerMsgNext, at: number = Date.now()): ServerState {
  switch (msg.type) {
    case 'snapshot': {
      const x = msg as typeof msg & SnapshotNext;
      return {
        ...state,
        links: Array.isArray(msg.links) ? msg.links : state.links,
        saved: Array.isArray(x.saved) ? x.saved : state.saved,
        machines: Array.isArray(x.machines) ? x.machines : state.machines,
        attachments: Array.isArray(x.attachments) ? x.attachments : state.attachments,
        peers: Array.isArray(x.peers) ? x.peers : state.peers,
        usage: isUsage(msg.usage) ? msg.usage : state.usage,
        machine: msg.machine,
        sessions: uniqueSessions(msg.sessions),
        runners: Object.fromEntries((msg.runners ?? []).map((r) => [r.sessionId, r])),
        cwds: msg.cwds ?? state.cwds,
        lastMessageAt: at,
      };
    }
    case 'links':
      return { ...state, links: Array.isArray(msg.links) ? msg.links : state.links, lastMessageAt: at };
    case 'saved':
      return { ...state, saved: Array.isArray(msg.sessions) ? msg.sessions : state.saved, lastMessageAt: at };
    case 'machines':
      return {
        ...state,
        machines: Array.isArray(msg.machines) ? msg.machines : state.machines,
        attachments: Array.isArray(msg.attachments) ? msg.attachments : state.attachments,
        peers: Array.isArray(msg.peers) ? msg.peers : state.peers,
        lastMessageAt: at,
      };
    case 'runner':
      return { ...state, runners: { ...state.runners, [msg.runner.sessionId]: msg.runner }, lastMessageAt: at };
    case 'runner_removed': {
      // a remote machine's removal only touches that machine's runner (ids are UUIDs, but never trust that)
      const cur = state.runners[msg.sessionId];
      if (msg.machineId !== undefined && cur && cur.machineId !== msg.machineId) return { ...state, lastMessageAt: at };
      const { [msg.sessionId]: _gone, ...rest } = state.runners;
      return { ...state, runners: rest, lastMessageAt: at };
    }
    case 'cwds':
      return { ...state, cwds: msg.cwds, lastMessageAt: at };
    case 'worklog':
      return { ...state, worklog: msg.cards, lastMessageAt: at };
    case 'clips':
      return {
        ...state,
        clips: msg.jobs,
        clipQueue: Array.isArray(msg.queue) ? msg.queue : [],
        clipPresets: Array.isArray(msg.presets) ? msg.presets : state.clipPresets,
        clipOutros: Array.isArray(msg.outros) ? msg.outros : state.clipOutros,
        lastMessageAt: at,
      };
    case 'usage':
      return { ...state, usage: isUsage(msg.usage) ? msg.usage : state.usage, lastMessageAt: at };
    case 'ack':
      return state; // handled by the commander, not by state
    case 'session': {
      const id = msg.session.sessionId;
      const exists = state.sessions.some((s) => s.sessionId === id);
      const sessions = exists
        ? state.sessions.map((s) => (s.sessionId === id ? msg.session : s))
        : [...state.sessions, msg.session];
      return { ...state, sessions, lastMessageAt: at };
    }
    case 'removed':
      return { ...state, sessions: state.sessions.filter((s) => s.sessionId !== msg.sessionId || (msg.machineId !== undefined && s.machineId !== msg.machineId)), lastMessageAt: at };
    case 'ping':
      return { ...state, lastMessageAt: at };
    default:
      return state;
  }
}

export type ServerAction = { kind: 'msg'; msg: ServerMsg | ServerMsgNext; at: number } | { kind: 'connected'; connected: boolean };

export function serverReducer(state: ServerState, action: ServerAction): ServerState {
  if (action.kind === 'connected') return { ...state, connected: action.connected };
  return applyMsg(state, action.msg, action.at);
}

/** Parses one text frame. Returns null for anything that is not a known server message. */
export function parseMsg(raw: string): ServerMsg | ServerMsgNext | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case 'snapshot':
      return typeof o.machine === 'string' && Array.isArray(o.sessions) ? (v as ServerMsg) : null;
    case 'session': {
      const s = o.session as Record<string, unknown> | undefined;
      return s && typeof s.sessionId === 'string' ? (v as ServerMsg) : null;
    }
    case 'removed':
      return typeof o.sessionId === 'string' ? (v as ServerMsg) : null;
    case 'ping':
      return v as ServerMsg;
    case 'runner': {
      const r = o.runner as Record<string, unknown> | undefined;
      return r && typeof r.sessionId === 'string' && Array.isArray(r.pending) ? (v as ServerMsg) : null;
    }
    case 'runner_removed':
      return typeof o.sessionId === 'string' ? (v as ServerMsg) : null;
    case 'cwds':
      return Array.isArray(o.cwds) ? (v as ServerMsg) : null;
    case 'worklog':
      return Array.isArray(o.cards) ? (v as ServerMsg) : null;
    case 'clips':
      return Array.isArray(o.jobs) ? (v as ServerMsg) : null;
    case 'usage':
      return isUsage(o.usage) ? (v as ServerMsg) : null;
    case 'links':
      return Array.isArray(o.links) ? (v as ServerMsg) : null;
    case 'saved':
      return Array.isArray(o.sessions) ? (v as ServerMsgNext) : null;
    case 'machines':
      return Array.isArray(o.machines) ? (v as ServerMsgNext) : null;
    case 'ack':
      return typeof o.reqId === 'string' && typeof o.ok === 'boolean' ? (v as ServerMsg) : null;
    default:
      return null;
  }
}

export function resolveWsUrl(hostname: string, override?: string, servedPort?: string): string {
  if (override) return override;
  // Production: the page is served by the Node server itself, so the socket is on the same port.
  if (servedPort) return `ws://${hostname || '127.0.0.1'}:${servedPort}`;
  return `ws://${hostname || '127.0.0.1'}:${SERVER_PORT}`;
}

/** HTTP base for /api routes: same port as the page in production, the dev server port otherwise. */
export function resolveApiBase(hostname: string, servedPort?: string): string {
  return `http://${hostname || '127.0.0.1'}:${servedPort || SERVER_PORT}`;
}

/** API base for this page (production build is served by the Node server on its own port). */
export function apiBase(): string {
  return resolveApiBase(window.location.hostname, import.meta.env.PROD ? window.location.port : undefined);
}

/**
 * A command about a session (or a saved session) that lives on another machine gets that machine's id, so the main server
 * forwards it to the agent there. Commands that already carry a machineId, and every non-routable type, pass unchanged.
 */
export function withMachine(cmd: CommandInput, st: Pick<ServerState, 'sessions' | 'runners' | 'saved'>): CommandInput {
  if (cmd.machineId !== undefined || !REMOTE_ROUTABLE.includes(cmd.type) || !('sessionId' in cmd)) return cmd;
  const sid = (cmd as { sessionId: string }).sessionId;
  const mid = cmd.type === 'saved_resume' ? st.saved.find((s) => s.sessionId === sid)?.machineId : (st.sessions.find((s) => s.sessionId === sid)?.machineId ?? st.runners[sid]?.machineId);
  return mid ? { ...cmd, machineId: mid } : cmd;
}

export function nextDelay(delayMs: number): number {
  return Math.min(delayMs * 2, BACKOFF_MAX_MS);
}

export function isLive(connected: boolean, lastMessageAt: number | null, now: number): boolean {
  return connected && lastMessageAt !== null && now - lastMessageAt < LIVE_WINDOW_MS;
}

export function isDemoSearch(search: string): boolean {
  return new URLSearchParams(search).get('demo') === '1';
}

function demoState(): ServerState {
  const now = Date.now();
  const sessions = demoSessions(now);
  const m = demoMachines(now, sessions);
  return { ...INITIAL_SERVER_STATE, sessions, machine: DEMO_MACHINE, links: demoLinks(now, sessions), saved: demoSaved(now, sessions), ...m };
}

export type ServerApi = ServerState & {
  demo: boolean;
  command: (cmd: CommandInput) => Promise<CommandResult>;
  ask: (question: string) => Promise<CommandResult>; // summary assistant: waits up to 100 s for Haiku
};

export function useServer(): ServerApi {
  const demo = useMemo(() => isDemoSearch(window.location.search), []);
  const [state, dispatch] = useReducer(serverReducer, demo, (d) => (d ? demoState() : INITIAL_SERVER_STATE));

  const wsRef = useRef<WebSocket | null>(null);
  const commander = useRef<Commander | null>(null);
  if (!commander.current) {
    commander.current = createCommander((text) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(text);
      return true;
    });
  }
  const stateRef = useRef(state);
  stateRef.current = state;
  const command = useCallback(
    (cmd: CommandInput): Promise<CommandResult> =>
      demo ? Promise.resolve({ ok: false, error: t('shell.conn.demoNoCommand') }) : commander.current!.send(withMachine(cmd, stateRef.current)),
    [demo],
  );

  const ask = useCallback(
    (question: string): Promise<CommandResult> =>
      demo ? Promise.resolve({ ok: false, error: t('shell.conn.demoNoAsk') }) : commander.current!.send({ type: 'ask', question }, 100_000),
    [demo],
  );

  useEffect(() => {
    if (demo) return;
    const url = resolveWsUrl(window.location.hostname, import.meta.env.VITE_CR_WS as string | undefined, import.meta.env.PROD ? window.location.port : undefined);
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = BACKOFF_MIN_MS;
    let closing = false;

    const open = () => {
      ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        delay = BACKOFF_MIN_MS;
        dispatch({ kind: 'connected', connected: true });
      };
      ws.onmessage = (ev) => {
        const msg = parseMsg(typeof ev.data === 'string' ? ev.data : '');
        if (!msg) return;
        commander.current?.onMessage(msg);
        dispatch({ kind: 'msg', msg, at: Date.now() });
      };
      ws.onclose = () => {
        dispatch({ kind: 'connected', connected: false });
        commander.current?.failAll(t('shell.conn.lost'));
        if (closing) return;
        timer = setTimeout(open, delay);
        delay = nextDelay(delay);
      };
    };

    open();
    return () => {
      closing = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [demo]);

  return { ...state, demo, command, ask };
}
