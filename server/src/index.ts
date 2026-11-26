// HTTP (/health) + WebSocket server that streams Watcher output + Runner state to browsers and takes
// stage 2 commands from them. Bound to 127.0.0.1 only; a browser Origin must be loopback; every command
// payload is schema-validated, logged (no prompt text) and addressed to a session id the server knows.
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { AGENT_TOKEN_HEADER, APP_LOCK_CLOSE_CODE, CLIP_DEFAULT_EFFORT, CLIP_PERMISSION_MODE, SERVER_PORT, type ClientMsg, type ClipJob, type LinkInfo, type MachineInfo, type MachineAttachment, type RunnerState, type SavedSession, type TailscalePeer, type ServerMsg, type SessionInfo, type WorklogCard } from '../../shared/protocol';
import { AgentsApi } from './agentsApi';
import { AutoResume } from './autoresume';
import { TerminalLauncher } from './terminal';
import { ClipApi } from './api';
import { SlashCommandApi } from './slashCommands';
import { UploadApi } from './uploadApi';
import { UploadStore } from './uploads';
import { GalleryService } from './gallery';
import { ClipService } from './clips';
import { SEED_VOICES, VoiceService } from './voice';
import { effectiveExtraCwds, effectiveGalleryRoots, effectivePort, effectiveVideosDir, loadConfig } from './config';
import { createDefaultChain } from './secretChain';
import { SettingsApi } from './settingsApi';
import { DoctorApi } from './doctorApi';
import { runDoctor } from './doctor';
import { UpdateApi } from './updateApi';
import { UpdateChecker } from './updateCheck';
import { ELEVEN_SECRET, ElevenKeyHolder, agentTokenGetter, busyCounts, readRootPackage, repoRootFrom } from './wiring';
import { managedInstallProblem, realDeps, spawnUpdaterDetached } from '../../scripts/update-lib.mjs';
import { dataDir, fileLogger, type LogFn } from './cmdlog';
import { parseClientMsg, routeTarget } from './commands';
import { cachedCwds } from './cwds';
import { claudeHaiku } from './haiku';
import { WorklogDb } from './db';
import { AskError, Observer } from './observer';
import { MachineService } from './machines';
import { assertLoopbackHost, isAgentMode } from './agent';
import { RemoteHub, directFromEnv, envTokenSource } from './remote';
import { Relay } from './relay';
import { CommandError, Runner, type TurnEnd } from './runner';
import { SavedService, backfillSaved } from './saved';
import { serveStatic } from './static';
import { takeover, type TakeoverDeps } from './takeover';
import { Watcher, type WatchedTurnEnd } from './watcher';
import { Worklog } from './worklog';
import { codeOf } from './codedError';
import { UsageService } from './usage';
import type { UsageSnapshot } from '../../shared/usage';
import { projectsDir as claudeProjectsDir } from './paths';
import { AccountService } from './accounts';
import { AccountsApi } from './accountsApi';
import { TERMINAL_ACCOUNT_ID, type AccountsView, type ConnectEvent, type MainLoginEvent } from '../../shared/accounts';
import { MainAccountService } from './mainAccount';
import { MainAuthApi } from './mainAuthApi';
import { AppLock } from './appLock';
import { AuthApi } from './authApi';

const HOST = '127.0.0.1';
const PING_MS = 5000;
const MAX_PAYLOAD = 256 * 1024;
const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** No Origin (non-browser client) or a loopback Origin is accepted; anything else is refused. */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return ALLOWED_ORIGIN_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export interface ServerOptions {
  watcher: Watcher;
  port: number; // 0 picks a free port (tests)
  host?: string; // must be loopback (default 127.0.0.1); anything else throws
  /** Agent mode: when set, every websocket must present the token in the x-cr-agent-token header (checked here). */
  verifyToken?: (header: string | string[] | undefined) => boolean;
  /** Other PCs' sessions (SSH tunnel + agent). Their sessions / runners / saved are merged into snapshots and broadcasts. */
  remote?: RemoteHub;
  machine?: string;
  pingMs?: number;
  now?: () => number;
  runner?: Runner; // without one, every command is refused
  allowedCwds?: () => string[]; // for the folder dropdown; the Runner enforces its own whitelist
  worklog?: Worklog; // stage 4: failure records + job cards, pushed to browsers on change
  observer?: Observer; // stage 4: the summary assistant (Haiku, no tools)
  clips?: ClipService; // stage 5: clip jobs
  saved?: SavedService; // remembered sessions (saved_* commands, `saved` broadcasts)
  machines?: MachineService; // SSH machines (machine_* commands, `machines` broadcasts)
  usage?: UsageService; // 5 h / weekly quota + context meters (`usage` broadcasts)
  relay?: Relay; // links between sessions (final answer of A -> user message to B)
  terminal?: Pick<TerminalLauncher, 'open'>; // open_terminal: a new window running `cr attach <id>`
  api?: ClipApi; // stage 5: HTTP routes for Clip Studio
  gallery?: GalleryService; // video gallery routes (/api/gallery/*)
  agents?: AgentsApi; // subagent timeline route (/api/agents/<session>/<agent>/timeline)
  slash?: SlashCommandApi; // GET /api/slash-commands
  uploads?: UploadApi; // chat attachments (POST /api/upload)
  settings?: SettingsApi; // /api/settings (config.json + ElevenLabs key)
  doctor?: DoctorApi; // /api/doctor
  update?: UpdateApi; // /api/update (status, check, apply)
  accounts?: AccountService; // account profiles (accounts / account_connect broadcasts, usage per profile)
  accountsApi?: AccountsApi; // /api/accounts routes (before ClipApi, which answers every other /api/ path)
  main?: MainAccountService; // the main account's claude.ai login (main_login broadcasts)
  mainAuthApi?: MainAuthApi; // /api/accounts/main routes (before accountsApi)
  authApi?: AuthApi; // /api/auth routes (app lock)
  appLock?: AppLock; // optional app password: guards every HTTP request and the websocket upgrade
  staticDir?: string; // stage 6 production mode: serve the built web from here (SPA fallback)
  log?: LogFn;
  isPidAlive?: (pid: number) => boolean;
  isClip?: (sessionId: string) => boolean; // takeover: a Clip Studio session is never taken over as a terminal one
  takeoverEnv?: Partial<TakeoverDeps>; // tests: fake sessions dir, image lookup, kill, timings
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { watcher } = opts;
  const machine = opts.machine ?? os.hostname();
  const now = opts.now ?? Date.now;
  const runner = opts.runner;
  const log: LogFn = opts.log ?? (() => {});
  const pidAlive = opts.isPidAlive ?? defaultPidAlive;
  const cwdList = opts.allowedCwds ?? (() => []);
  const host = opts.host ?? HOST;
  assertLoopbackHost(host);
  const remote = opts.remote;
  const allSessions = (): SessionInfo[] => (remote ? [...watcher.snapshot(), ...remote.sessions()] : watcher.snapshot());
  const allRunners = (): RunnerState[] => [...(runner?.states() ?? []), ...(remote ? remote.runners() : [])];
  const allSaved = (): SavedSession[] | undefined => (opts.saved ? (remote ? [...opts.saved.list(), ...remote.savedAll()] : opts.saved.list()) : undefined);

  const httpServer = http.createServer((req, res) => {
    if (opts.appLock?.guard(req, res)) return; // first: nothing else answers while the app is locked
    if (opts.authApi?.handle(req, res)) return;
    if (opts.gallery?.handle(req, res)) return;
    if (opts.agents?.handle(req, res)) return;
    if (opts.slash?.handle(req, res)) return;
    if (opts.uploads?.handle(req, res)) return; // before ClipApi, which answers every other /api/ path
    if (opts.mainAuthApi?.handle(req, res)) return; // before accountsApi: /api/accounts/main is not a profile id
    if (opts.accountsApi?.handle(req, res)) return;
    if (opts.settings?.handle(req, res)) return;
    if (opts.doctor?.handle(req, res)) return;
    if (opts.update?.handle(req, res)) return;
    if (opts.api?.handle(req, res)) return;
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (opts.staticDir && serveStatic(opts.staticDir, req, res)) return;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_PAYLOAD,
    verifyClient: (info: { origin: string; req: http.IncomingMessage }) => originAllowed(info.origin) && (!opts.verifyToken || opts.verifyToken(info.req.headers[AGENT_TOKEN_HEADER])),
  });

  const send = (ws: WebSocket, msg: ServerMsg): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const broadcast = (msg: ServerMsg): void => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  };

  /** The summary assistant: read-only, never reaches a session. */
  const ask = async (ws: WebSocket, origin: string | undefined, msg: Extract<ClientMsg, { type: 'ask' }>): Promise<void> => {
    const base = { origin: origin ?? null, cmd: 'ask', reqId: msg.reqId, questionChars: msg.question.length };
    try {
      if (!opts.observer) throw new AskError('ผู้ช่วยสรุปยังไม่เปิดใช้', 'srv.observer.disabled');
      const answer = await opts.observer.ask(msg.question);
      log({ ...base, ok: true });
      send(ws, { type: 'ack', serverTime: now(), reqId: msg.reqId, ok: true, answer });
    } catch (e) {
      log({ ...base, ok: false, error: errText(e) });
      send(ws, { type: 'ack', serverTime: now(), reqId: msg.reqId, ok: false, error: errText(e), ...codeOf(e) });
    }
  };

  /** Link commands (relay). Returns the link id for link_create. */
  const executeLink = (msg: Extract<ClientMsg, { type: 'link_create' | 'link_delete' | 'link_pause' | 'link_resume' }>): string | undefined => {
    const relay = opts.relay;
    if (!relay) throw new CommandError('relay is not enabled');
    switch (msg.type) {
      case 'link_create':
        return relay.create(msg.from, msg.to, msg.maxForwards);
      case 'link_delete':
        relay.delete(msg.linkId);
        return msg.linkId;
      case 'link_pause':
        relay.pause(msg.linkId, msg.paused);
        return msg.linkId;
      case 'link_resume':
        relay.resume(msg.linkId);
        return msg.linkId;
    }
  };

  type ExtraMsg = Extract<ClientMsg, { type: 'saved_hide' | 'saved_unhide' | 'saved_resume' | 'machine_add' | 'machine_update' | 'machine_delete' | 'machine_test' | 'machine_attach' | 'machine_detach' }>;
  const isExtra = (m: ClientMsg): m is ExtraMsg => m.type.startsWith('saved_') || m.type.startsWith('machine_');

  /** Saved-session and machine commands. They do not all need the Runner (machine_add/test, saved_hide...). */
  const executeExtra = async (msg: ExtraMsg): Promise<{ sessionId?: string; machineId?: string }> => {
    const saved = opts.saved;
    const machines = opts.machines;
    switch (msg.type) {
      case 'saved_hide':
      case 'saved_unhide':
        if (!saved) throw new CommandError('saved sessions are not enabled');
        saved.setHidden(msg.sessionId, msg.type === 'saved_hide');
        return { sessionId: msg.sessionId };
      case 'saved_resume':
        if (!saved) throw new CommandError('saved sessions are not enabled');
        saved.resume({ sessionId: msg.sessionId, model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode });
        return { sessionId: msg.sessionId };
    }
    if (!machines) throw new CommandError('machines are not enabled');
    switch (msg.type) {
      case 'machine_add': {
        const { type: _t, reqId: _r, ...fields } = msg;
        return { machineId: machines.add(fields) };
      }
      case 'machine_update': {
        const { type: _t, reqId: _r, machineId, ...fields } = msg;
        return { machineId: machines.update(machineId, fields) };
      }
      case 'machine_delete':
        return { machineId: machines.remove(msg.machineId) };
      case 'machine_test':
        await machines.test(msg.machineId);
        return { machineId: msg.machineId };
      case 'machine_attach':
        machines.attachJob(msg.sessionId, msg.machineId);
        return { sessionId: msg.sessionId, machineId: msg.machineId };
      case 'machine_detach':
        machines.detachJob(msg.sessionId, msg.machineId);
        return { sessionId: msg.sessionId, machineId: msg.machineId };
    }
  };

  /** Runs one validated command. Throws CommandError (or Error) with a user-facing message. */
  const execute = async (msg: ClientMsg): Promise<string | undefined> => {
    if (!runner) throw new CommandError('runner is not enabled');
    switch (msg.type) {
      case 'clip_start': {
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        const { type: _t, reqId: _r, ...input } = msg;
        const r = opts.clips.enqueue(input); // starts at once while a slot is free, else waits as "รอคิว"
        return r.sessionId ?? r.queueId;
      }
      case 'clip_preset_save': {
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        return opts.clips.savePreset({ id: msg.id, name: msg.name, settings: msg.settings, styleId: msg.styleId });
      }
      case 'clip_preset_delete':
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        opts.clips.deletePreset(msg.id);
        return msg.id;
      case 'clip_outro_save':
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        return opts.clips.saveOutro({ id: msg.id, name: msg.name, text: msg.text });
      case 'clip_outro_delete':
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        opts.clips.deleteOutro(msg.id);
        return msg.id;
      case 'clip_dequeue':
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        opts.clips.dequeue(msg.id);
        return msg.id;
      case 'clip_render':
        if (!opts.clips) throw new CommandError('Clip Studio is not enabled');
        opts.clips.render(msg.sessionId);
        return msg.sessionId;
      case 'start':
        return runner.start({
          cwd: msg.cwd,
          model: msg.model,
          effort: msg.effort,
          prompt: msg.prompt,
          permissionMode: msg.permissionMode,
          remoteControl: msg.remoteControl,
          attachments: msg.attachments,
          accountId: msg.accountId,
        });
      case 'set_account':
        await runner.setAccount(msg.sessionId, msg.accountId);
        return msg.sessionId;
      case 'send':
        runner.send(msg.sessionId, msg.text, msg.attachments);
        opts.relay?.onUserSend(msg.sessionId); // a message from the user (not a relay one) restarts the loop counters
        return msg.sessionId;
      case 'send_now':
        await runner.sendNow(msg.sessionId); // the websocket path below also puts the note in the ack
        opts.relay?.onUserSend(msg.sessionId);
        return msg.sessionId;
      case 'stop':
        runner.stop(msg.sessionId);
        return msg.sessionId;
      case 'close':
        runner.close(msg.sessionId);
        return msg.sessionId;
      case 'open_terminal': {
        if (!opts.terminal) throw new CommandError('terminal launcher is not enabled');
        // Runner jobs only: a terminal session already has its own window and stays read-only here.
        const st = runner.states().find((r) => r.sessionId === msg.sessionId);
        if (!st || !st.alive) throw new CommandError('เปิดใน terminal ได้เฉพาะงานที่คุมจากเว็บและยังทำงานอยู่', 'srv.term.webOnly');
        const info = watcher.snapshot().find((s) => s.sessionId === msg.sessionId);
        await opts.terminal.open({ sessionId: msg.sessionId, title: info?.title || info?.name || 'Claude job', cwd: st.cwd });
        return msg.sessionId;
      }
      case 'set_model':
        await runner.setModel(msg.sessionId, msg.model);
        return msg.sessionId;
      case 'set_effort':
        await runner.setEffort(msg.sessionId, msg.effort);
        return msg.sessionId;
      case 'set_permission_mode':
        await runner.setPermissionMode(msg.sessionId, msg.mode);
        return msg.sessionId;
      case 'set_remote_control':
        await runner.setRemoteControl(msg.sessionId, msg.on);
        return msg.sessionId;
      case 'answer':
        runner.answer(msg.sessionId, msg.requestId, msg.behavior, msg.answers, msg.message);
        return msg.sessionId;
      case 'takeover': {
        await takeover(msg.sessionId, {
          snapshot: () => watcher.snapshot(),
          isRunnerJob: (id) => runner.has(id),
          isClip: (id) => (opts.isClip ? opts.isClip(id) : (opts.clips?.find(id) ?? null) !== null),
          pidAlive,
          adopt: (req) => void runner.adopt({ sessionId: req.sessionId, cwd: req.cwd, rawModel: req.rawModel, permissionMode: req.permissionMode }, { trustedCwd: true }),
          now,
          log,
          ...opts.takeoverEnv,
        });
        return msg.sessionId;
      }
      case 'adopt': {
        const info = watcher.snapshot().find((s) => s.sessionId === msg.sessionId);
        if (!info) {
          // A clip job whose Runner child is gone (e.g. server restart): resume it in its own server-made folder.
          // Progress keeps flowing because clips.refresh() matches the resumed session by the same session id.
          const job = opts.clips?.find(msg.sessionId);
          if (!job) throw new CommandError('unknown session id');
          runner.adopt(
            {
              sessionId: msg.sessionId,
              cwd: job.cwd,
              model: msg.model ?? job.builderModel,
              effort: msg.effort ?? CLIP_DEFAULT_EFFORT,
              permissionMode: msg.permissionMode ?? CLIP_PERMISSION_MODE, // clip jobs default to acceptEdits
              remoteControl: msg.remoteControl,
            },
            { trustedCwd: true }, // refuses while the session is already live under the Runner
          );
          return msg.sessionId;
        }
        // A terminal session stays read-only while its process lives.
        if (pidAlive(info.pid)) throw new CommandError('the terminal process is still running; close it first');
        runner.adopt({
          sessionId: msg.sessionId,
          cwd: info.cwd,
          model: msg.model,
          effort: msg.effort,
          rawModel: info.model,
          permissionMode: msg.permissionMode,
          remoteControl: msg.remoteControl,
        });
        return msg.sessionId;
      }
    }
  };

  /** A validated command for another PC: forwarded to its agent under a fresh reqId; the ack comes back under the browser's. */
  const forwardRemote = async (ws: WebSocket, origin: string | undefined, target: string, m: ClientMsg): Promise<void> => {
    const base: Record<string, unknown> = { origin: origin ?? null, cmd: m.type, reqId: m.reqId, machineId: target };
    if ('sessionId' in m) base.sessionId = m.sessionId;
    if (m.type === 'start') Object.assign(base, { cwd: m.cwd, model: m.model, effort: m.effort, promptChars: m.prompt.length });
    if (m.type === 'send') base.textChars = m.text.length;
    try {
      if (target === '') throw new CommandError('machineId invalid');
      if (!remote) throw new CommandError('remote machines are not enabled');
      const ack = await remote.forward(target, m);
      log({ ...base, ok: ack.ok, ...(ack.ok ? {} : { error: ack.error }) });
      send(ws, { ...ack, serverTime: now(), reqId: m.reqId });
    } catch (e) {
      log({ ...base, ok: false, error: errText(e) });
      send(ws, { type: 'ack', serverTime: now(), reqId: m.reqId, ok: false, error: errText(e), ...codeOf(e) });
    }
  };

  const handleCommand = async (ws: WebSocket, origin: string | undefined, data: string): Promise<void> => {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      send(ws, { type: 'ack', serverTime: now(), reqId: '', ok: false, error: 'invalid JSON' });
      return;
    }
    const target = routeTarget(raw); // machineId of a command for another PC's agent ('' = invalid)
    const parsed = parseClientMsg(raw);
    if (!parsed.ok) {
      log({ origin: origin ?? null, ok: false, error: parsed.error });
      send(ws, {
        type: 'ack',
        serverTime: now(),
        reqId: parsed.reqId ?? '',
        ok: false,
        error: parsed.error,
        ...(parsed.code !== undefined ? { code: parsed.code } : {}),
        ...(parsed.vars ? { vars: parsed.vars } : {}),
      });
      return;
    }
    const m = parsed.msg;
    if (target !== null) {
      await forwardRemote(ws, origin, target, m);
      return;
    }
    if (m.type === 'ask') {
      await ask(ws, origin, m);
      return;
    }
    const base: Record<string, unknown> = { origin: origin ?? null, cmd: m.type, reqId: m.reqId };
    if ('sessionId' in m) base.sessionId = m.sessionId;
    if (m.type === 'start') Object.assign(base, { cwd: m.cwd, model: m.model, effort: m.effort, promptChars: m.prompt.length });
    if (m.type === 'clip_start') Object.assign(base, { topicChars: m.topic.length, styleId: m.styleId, voiceId: m.voiceId, scriptModel: m.scriptModel, builderModel: m.builderModel, effort: m.effort });
    if (m.type === 'send') base.textChars = m.text.length;
    if (m.type === 'link_create') Object.assign(base, { from: m.from, to: m.to, maxForwards: m.maxForwards ?? null });
    if (m.type === 'link_delete' || m.type === 'link_pause' || m.type === 'link_resume') base.linkId = m.linkId;
    if (m.type === 'link_pause') base.paused = m.paused;
    if (m.type === 'set_model') base.model = m.model;
    if (m.type === 'set_effort') base.effort = m.effort;
    if (m.type === 'set_permission_mode') Object.assign(base, { permissionMode: m.mode, confirm: m.confirm === true });
    if (m.type === 'set_remote_control') base.remoteControl = m.on;
    if (m.type === 'set_account') base.accountId = m.accountId;
    if (m.type === 'start' && m.accountId !== undefined) base.accountId = m.accountId;
    if ('machineId' in m) base.machineId = m.machineId;
    if (m.type === 'machine_add' || m.type === 'machine_update') Object.assign(base, { nameChars: m.name.length, hostChars: m.host.length, userChars: m.user.length, hasKey: m.keyPath !== '', shell: m.shell });
    if (m.type === 'saved_resume' && m.permissionMode) Object.assign(base, { permissionMode: m.permissionMode, confirm: m.confirm === true });
    if (m.type === 'start' || m.type === 'clip_start' || m.type === 'adopt') {
      if (m.permissionMode) Object.assign(base, { permissionMode: m.permissionMode, confirm: m.confirm === true });
      if (m.remoteControl !== undefined) base.remoteControl = m.remoteControl;
    }
    if (m.type === 'answer') Object.assign(base, { requestId: m.requestId, behavior: m.behavior });
    try {
      if (m.type === 'link_create' || m.type === 'link_delete' || m.type === 'link_pause' || m.type === 'link_resume') {
        const linkId = executeLink(m);
        log({ ...base, ok: true, linkId });
        send(ws, { type: 'ack', serverTime: now(), reqId: m.reqId, ok: true, linkId });
        return;
      }
      if (isExtra(m)) {
        const r = await executeExtra(m);
        log({ ...base, ok: true, ...(r.sessionId ? { resultSession: r.sessionId } : {}), ...(r.machineId ? { resultMachine: r.machineId } : {}) });
        send(ws, { type: 'ack', serverTime: now(), reqId: m.reqId, ok: true, ...r });
        return;
      }
      if (m.type === 'send_now' && runner) {
        const note = await runner.sendNow(m.sessionId);
        opts.relay?.onUserSend(m.sessionId);
        log({ ...base, ok: true, resultSession: m.sessionId });
        send(ws, { type: 'ack', serverTime: now(), reqId: m.reqId, ok: true, sessionId: m.sessionId, answer: note });
        return;
      }
      const sessionId = await execute(m);
      log({ ...base, ok: true, resultSession: sessionId });
      send(ws, { type: 'ack', serverTime: now(), reqId: m.reqId, ok: true, sessionId });
    } catch (e) {
      log({ ...base, ok: false, error: errText(e) });
      send(ws, { type: 'ack', serverTime: now(), reqId: m.reqId, ok: false, error: errText(e), ...codeOf(e) });
    }
  };

  /** The account fields of a snapshot (empty when accounts are not enabled). */
  const accountsSnapshot = (): { accounts?: AccountsView['accounts']; defaultAccountId?: string; ptyAvailable?: boolean } => {
    if (!opts.accounts) return {};
    const v = opts.accounts.view();
    return { accounts: v.accounts, defaultAccountId: v.defaultId, ptyAvailable: v.ptyAvailable };
  };

  wss.on('connection', (ws, req) => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    ws.on('error', () => {
      // a broken client must not take the server down
    });
    // App lock: a refused client gets no snapshot and no message handler. Closed before any send, so it is never
    // in the broadcast set (broadcast only sends to OPEN sockets, and this one is CLOSING from here on).
    if (opts.appLock && !opts.appLock.wsAllowed(req)) {
      ws.close(APP_LOCK_CLOSE_CODE, 'LOCKED');
      return;
    }
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      void handleCommand(ws, origin, data.toString('utf8'));
    });
    send(ws, {
      type: 'snapshot',
      machine,
      serverTime: now(),
      sessions: allSessions(),
      runners: allRunners(),
      cwds: cwdList(),
      ...(opts.relay ? { links: opts.relay.list() } : {}),
      ...(opts.usage ? { usage: opts.usage.snapshot() } : {}),
      ...(opts.saved ? { saved: allSaved() } : {}),
      ...(opts.machines ? { ...opts.machines.view() } : {}),
      ...accountsSnapshot(),
    });
    if (opts.clips) send(ws, { type: 'clips', serverTime: now(), ...opts.clips.view() });
    if (opts.worklog) send(ws, { type: 'worklog', serverTime: now(), cards: opts.worklog.cards() });
  });

  const pingTimer = setInterval(() => broadcast({ type: 'ping', serverTime: now() }), opts.pingMs ?? PING_MS);

  const onSessionEvent = (session: SessionInfo) => broadcast({ type: 'session', serverTime: now(), session });
  const onRemoved = (sessionId: string) => broadcast({ type: 'removed', serverTime: now(), sessionId });
  const onRunnerChange = (state: RunnerState) => {
    broadcast({ type: 'runner', serverTime: now(), runner: state });
    opts.clips?.pump(); // a clip job that ended or went quiet may have freed a generation slot
  };
  const onRunnerRemoved = (sessionId: string, info?: { closed?: boolean }) => {
    broadcast({ type: 'runner_removed', serverTime: now(), sessionId });
    opts.clips?.pump();
    // closed on purpose: the graph box goes now, not after the watcher's grace period
    if (info?.closed) watcher.forget(sessionId);
  };
  const onWorklog = (cards: WorklogCard[]) => broadcast({ type: 'worklog', serverTime: now(), cards });
  const onClips = () => {
    if (opts.clips) broadcast({ type: 'clips', serverTime: now(), ...opts.clips.view() });
  };
  const onSaved = (sessions: SavedSession[]) => broadcast({ type: 'saved', serverTime: now(), sessions: remote ? [...sessions, ...remote.savedAll()] : sessions });
  const onRemoteSaved = () => {
    if (opts.saved) broadcast({ type: 'saved', serverTime: now(), sessions: allSaved() ?? [] });
  };
  const onRemoteSession = (session: SessionInfo) => broadcast({ type: 'session', serverTime: now(), session });
  const onRemoteRemoved = (machineId: string, sessionId: string) => broadcast({ type: 'removed', serverTime: now(), sessionId, machineId });
  const onRemoteRunner = (state: RunnerState) => broadcast({ type: 'runner', serverTime: now(), runner: state });
  const onRemoteRunnerRemoved = (machineId: string, sessionId: string) => broadcast({ type: 'runner_removed', serverTime: now(), sessionId, machineId });
  const onRemoteStatus = (machineId: string, st: { state: 'connecting' | 'online' | 'error'; error?: string; cwds?: string[] } | null) => opts.machines?.setAgentStatus(machineId, st);
  const onMachines = (v: { machines: MachineInfo[]; attachments: MachineAttachment[]; peers: TailscalePeer[] }) => broadcast({ type: 'machines', serverTime: now(), ...v });
  const onSavedSession = (s: SessionInfo) => opts.saved?.onSession(s);
  const onSavedTouch = () => opts.saved?.touch();
  const onGoneForMachines = (sessionId: string) => opts.machines?.onSessionGone(sessionId);
  const onUsage = (usage: UsageSnapshot) => broadcast({ type: 'usage', serverTime: now(), usage });
  opts.usage?.on('change', onUsage);
  const onStreamEvent = (id: string, ev: unknown) => {
    const acct = runner?.accountOf(id) ?? TERMINAL_ACCOUNT_ID;
    // Only rate_limit_event lines are checked for the type first, so the hot path stays cheap.
    const isRate = typeof ev === 'object' && ev !== null && (ev as { type?: unknown }).type === 'rate_limit_event';
    // The global header quota belongs to the stored login (Terminal) only: a token job's rate_limit_event is that profile's.
    if (!(isRate && acct !== TERMINAL_ACCOUNT_ID)) opts.usage?.ingest(id, ev);
    // Usage per profile.
    if (opts.accounts && isRate) opts.accounts.recordUsage(acct, ev);
  };
  if (opts.usage || opts.accounts) runner?.on('stream_event', onStreamEvent);
  const onAccounts = (v: AccountsView) => broadcast({ type: 'accounts', serverTime: now(), accounts: v.accounts, defaultId: v.defaultId, ptyAvailable: v.ptyAvailable });
  const onAccountConnect = (event: ConnectEvent) => broadcast({ type: 'account_connect', serverTime: now(), event });
  if (opts.accounts) {
    opts.accounts.on('change', onAccounts);
    opts.accounts.on('connect', onAccountConnect);
  }
  const onMainLogin = (event: MainLoginEvent) => broadcast({ type: 'main_login', serverTime: now(), event });
  opts.main?.on('login', onMainLogin);
  const onLinks = (links: LinkInfo[]) => broadcast({ type: 'links', serverTime: now(), links });
  const onRunnerTurnEnd = (e: TurnEnd) => opts.relay?.onSourceTurnEnd(e.sessionId, e.text, { isError: e.isError, interrupted: e.interrupted });
  // A Runner job is reported by its own stream; the watcher's transcript event for the same session is a duplicate.
  const onWatchedTurnEnd = (e: WatchedTurnEnd) => {
    if (runner?.has(e.sessionId)) return;
    opts.relay?.onSourceTurnEnd(e.sessionId, e.text, { isError: e.isError, interrupted: e.interrupted, ts: e.ts });
  };
  const onGoneForRelay = (sessionId: string) => opts.relay?.onSessionGone(sessionId);
  const onWatcherGoneForRelay = (sessionId: string) => {
    if (!runner?.has(sessionId)) opts.relay?.onSessionGone(sessionId);
  };
  if (opts.relay) {
    opts.relay.on('change', onLinks);
    runner?.on('turn_end', onRunnerTurnEnd);
    runner?.on('removed', onGoneForRelay);
    watcher.on('turn_end', onWatchedTurnEnd);
    watcher.on('removed', onWatcherGoneForRelay);
  }
  opts.clips?.on('change', onClips);
  if (opts.saved) {
    opts.saved.on('change', onSaved);
    watcher.on('session', onSavedSession);
    watcher.on('removed', onSavedTouch);
    runner?.on('change', onSavedTouch);
    runner?.on('removed', onSavedTouch);
  }
  if (opts.machines) {
    opts.machines.on('change', onMachines);
    runner?.on('removed', onGoneForMachines);
  }
  const onClipSession = (s: SessionInfo) => opts.clips?.refresh(s.sessionId);
  if (opts.clips) watcher.on('session', onClipSession);
  opts.worklog?.on('change', onWorklog);
  watcher.on('session', onSessionEvent);
  watcher.on('removed', onRemoved);
  runner?.on('change', onRunnerChange);
  runner?.on('removed', onRunnerRemoved);
  if (remote) {
    remote.on('session', onRemoteSession);
    remote.on('removed', onRemoteRemoved);
    remote.on('runner', onRemoteRunner);
    remote.on('runner_removed', onRemoteRunnerRemoved);
    remote.on('saved', onRemoteSaved);
    remote.on('status', onRemoteStatus);
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(opts.port, host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port,
    close: async () => {
      clearInterval(pingTimer);
      opts.usage?.off('change', onUsage);
      runner?.off('stream_event', onStreamEvent);
      if (opts.accounts) {
        opts.accounts.off('change', onAccounts);
        opts.accounts.off('connect', onAccountConnect);
      }
      opts.main?.off('login', onMainLogin);
      watcher.off('session', onSessionEvent);
      watcher.off('removed', onRemoved);
      runner?.off('change', onRunnerChange);
      runner?.off('removed', onRunnerRemoved);
      if (remote) {
        remote.off('session', onRemoteSession);
        remote.off('removed', onRemoteRemoved);
        remote.off('runner', onRemoteRunner);
        remote.off('runner_removed', onRemoteRunnerRemoved);
        remote.off('saved', onRemoteSaved);
        remote.off('status', onRemoteStatus);
      }
      opts.worklog?.off('change', onWorklog);
      opts.clips?.off('change', onClips);
      if (opts.saved) {
        opts.saved.off('change', onSaved);
        watcher.off('session', onSavedSession);
        watcher.off('removed', onSavedTouch);
        runner?.off('change', onSavedTouch);
        runner?.off('removed', onSavedTouch);
      }
      if (opts.machines) {
        opts.machines.off('change', onMachines);
        runner?.off('removed', onGoneForMachines);
      }
      watcher.off('session', onClipSession);
      if (opts.relay) {
        opts.relay.off('change', onLinks);
        runner?.off('turn_end', onRunnerTurnEnd);
        runner?.off('removed', onGoneForRelay);
        watcher.off('turn_end', onWatchedTurnEnd);
        watcher.off('removed', onWatcherGoneForRelay);
      }
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
    },
  };
}

/** True when something already listens on host:port (probe only; nothing is sent). */
export function portInUse(port: number, host: string = HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE'));
    probe.listen(port, host, () => probe.close(() => resolve(false)));
  });
}

async function main(): Promise<void> {
  // Agent mode: watcher + runner + saved sessions only, loopback, token-protected (see agent.ts).
  if (isAgentMode(process.env, process.argv)) {
    const { runAgent } = await import('./agent');
    await runAgent();
    return;
  }
  const cfgLoad = loadConfig();
  for (const w of cfgLoad.warnings) console.warn(`config: ${w}`);
  const cfg = cfgLoad.config;
  const port = effectivePort(process.env, cfg, SERVER_PORT); // env beats config.json
  // Production mode (npm run start): also serve web/dist. Checked before anything is opened, so a logon start
  // while the dev server holds the port logs one line and exits instead of fighting it for the DB.
  const serveWeb = process.argv.includes('--serve-web');
  if (await portInUse(port)) {
    console.log(`port ${HOST}:${port} is already in use (dev server or a second copy?) - not starting`);
    process.exit(serveWeb ? 0 : 1);
  }
  const staticDir = serveWeb ? process.env.CR_STATIC_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist') : undefined;
  // The Runner is created below; the watcher only asks it when a poll runs.
  let runnerRef: Runner | null = null;
  let clipsRef: ClipService | null = null; // late-bound like runnerRef: clips is created after the Runner
  const watcher = new Watcher({ keepAlive: (id) => runnerRef?.isAlive(id) === true });
  watcher.start();
  const extra = effectiveExtraCwds(process.env, cfg);
  const allowedCwds = cachedCwds({ sessionCwds: () => watcher.snapshot().map((s) => s.cwd), extra });
  // CR_RUNNER_ARGS: JSON array appended to the claude command line (light mode for tests).
  const extraArgs = process.env.CR_RUNNER_ARGS ? (JSON.parse(process.env.CR_RUNNER_ARGS) as string[]) : [];
  // Chat attachments: uploads older than 14 days are removed at startup.
  const uploadStore = new UploadStore(path.join(dataDir(), 'uploads'));
  const oldUploads = uploadStore.cleanup();
  if (oldUploads.length > 0) console.log(`uploads: removed ${oldUploads.length} old day folder(s)`);
  // The ElevenLabs key comes from the secret chain (env, DPAPI store, vault CLI) and is kept in memory for clip children.
  const chain = createDefaultChain();
  const keys = new ElevenKeyHolder(chain);
  // SQLite first: the account profiles and the worklog share it.
  const db = new WorklogDb(process.env.CR_DB_FILE || undefined);
  // Account profiles (tokens come from the secret chain; loaded before anything resumes a job).
  // The main account (the login a plain `claude` run uses). Created before AccountService: its status shows on the Terminal row.
  // Its runner check is lazy, so `runner` (declared below) is only read once the server is running.
  const main: MainAccountService = new MainAccountService({
    claudeBin: process.env.CR_CLAUDE_BIN,
    busyTerminalJobs: (): boolean => runner.states().some((s) => s.alive && s.busy && (runner.accountOf(s.sessionId) ?? 'terminal') === 'terminal'),
    log: (m) => console.log(m),
  });
  const accounts: AccountService = new AccountService({ db, secrets: chain, claudeBin: process.env.CR_CLAUDE_BIN, log: (m) => console.log(m), main: { info: () => main.info() } });
  await accounts.init();
  main.on('status', () => accounts.notifyChanged());
  const accountsApi = new AccountsApi({ originAllowed, accounts });
  const mainAuthApi = new MainAuthApi({ originAllowed, main });
  // App lock: the config dir's appLock record (no record = no lock). Sessions live in this process only.
  const appLock = new AppLock({ dir: dataDir() });
  const authApi = new AuthApi({ originAllowed, lock: appLock });
  const runner: Runner = new Runner({
    allowedCwds,
    extraArgs,
    claudeBin: process.env.CR_CLAUDE_BIN,
    uploads: uploadStore,
    accounts,
    // A clip job resumed after a server restart gets its key again (the per-process jobEnv map is empty then).
    envForSession: (id) => (clipsRef?.find(id) != null ? keys.clipEnv() : {}),
  });
  runnerRef = runner;
  // A profile unlocked from the app: its jobs that waited for the password start now.
  accounts.on('unlocked', (id: string) => {
    const n = runner.resumeWaiting(id);
    if (n > 0) console.log(`resumed ${n} waiting job(s) for account ${id}`);
  });
  runner.on('waiting_failed', (e: { sessionId: string }) => console.log(`waiting job ${e.sessionId} could not be resumed`));
  // Stage 4: SQLite worklog + the Haiku helper (no tools). CR_NO_SUMMARY=1 turns the model off (cards stay deterministic).
  const haiku = process.env.CR_NO_SUMMARY === '1' ? undefined : claudeHaiku({ claudeBin: process.env.CR_CLAUDE_BIN });
  const idleRaw = Number(process.env.CR_IDLE_MS);
  const worklog = new Worklog({
    db,
    sources: () => watcher.worklogSources(),
    haiku,
    idleMs: Number.isFinite(idleRaw) && idleRaw > 0 ? idleRaw : undefined,
    log: (m) => console.error(m),
  });
  const observer = haiku
    ? new Observer({ haiku, db, sessions: () => watcher.snapshot(), runners: () => runner.states(), cards: () => worklog.cards() })
    : undefined;
  worklog.start();
  // Stage 5: voices (key read once from the vault, kept in memory only), style list, clip jobs.
  db.seedVoices([...SEED_VOICES, ...cfg.voices], Date.now());
  await keys.refresh(); // logs "elevenlabs key: available|not available" only
  const log = fileLogger();
  const voice = new VoiceService({ store: db, getKey: () => chain.get(ELEVEN_SECRET), log });
  const api = new ClipApi({ voice, originAllowed });
  const clips = new ClipService({
    db,
    runner,
    sessions: () => watcher.snapshot(),
    lemo: () => api.lemoList(),
    videosDir: effectiveVideosDir(process.env, cfg),
    clipEnv: () => keys.clipEnv(),
  });
  clipsRef = clips;
  clips.pump(); // clips queued before a restart start as soon as a slot is free
  const galleryRoots = effectiveGalleryRoots(process.env, cfg);
  const gallery = new GalleryService({ jobs: () => clips.jobs(), originAllowed, roots: () => galleryRoots });
  const agents = new AgentsApi({ watcher, originAllowed });
  const cmdLog = fileLogger();
  const relay = new Relay({
    send: (to, text) => runner.send(to, text),
    isLiveRunner: (id) => runner.isAlive(id),
    exists: (id) => runner.has(id) || watcher.snapshot().some((s) => s.sessionId === id),
    titleOf: (id) => {
      const s = watcher.snapshot().find((x) => x.sessionId === id);
      return s ? s.title || s.name : undefined;
    },
    log: cmdLog,
  });
  const saved = new SavedService({
    db,
    runner,
    snapshot: () => watcher.snapshot(),
    pidAlive: defaultPidAlive,
    projectsDir: claudeProjectsDir(),
    isClip: (id) => clips.find(id) !== null,
  });
  const machines = new MachineService({ db, runner, log: cmdLog });
  const usage = new UsageService();
  usage.start();
  // Other PCs' Claude sessions (machines with agent: true). Token source: env CR_AGENT_TOKEN_<MACHINEID> first (and
  // CR_AGENT_TOKEN with CR_REMOTE_DIRECT=1), then the secret chain (agent:<machineId>). CR_REMOTE_DIRECT=1 is a dev switch.
  const direct = directFromEnv(process.env);
  const envToken = envTokenSource(process.env, direct !== null);
  const remote = new RemoteHub({
    machines: () => db.listMachines().map((m) => ({ id: m.id, name: m.name, host: m.host, user: m.user, keyPath: m.keyPath, agent: m.agent === true })),
    getToken: agentTokenGetter(envToken, chain),
    direct,
    log: cmdLog,
  });
  machines.on('change', () => remote.sync());
  let listenPort = port;
  const terminal = new TerminalLauncher({ port: () => listenPort });
  const uploads = new UploadApi({ store: uploadStore, originAllowed });
  const slash = new SlashCommandApi({ runner, claudeBin: process.env.CR_CLAUDE_BIN, originAllowed });
  const settings = new SettingsApi({ originAllowed, secrets: keys.secretsAdmin(), onChange: () => console.log('settings saved') });
  const doctor = new DoctorApi({ originAllowed, run: () => runDoctor({ hasElevenKey: () => chain.has(ELEVEN_SECRET) }) });
  // Update check: GitHub releases of the repo in the root package.json (CR_UPDATE_URL overrides). Started in production only.
  const repoRoot = repoRootFrom(path.dirname(fileURLToPath(import.meta.url)));
  const rootPkg = readRootPackage(path.join(repoRoot, 'package.json'));
  const updateChecker = new UpdateChecker({
    currentVersion: rootPkg.version,
    repo: rootPkg.repo,
    url: process.env.CR_UPDATE_URL,
    enabled: () => loadConfig().config.update.check,
  });
  const updates = new UpdateApi({
    originAllowed,
    checker: updateChecker,
    canUpdate: async () => {
      const problem = await managedInstallProblem(repoRoot, realDeps());
      return problem ? { ok: false, reason: problem } : { ok: true };
    },
    busy: () => busyCounts(runner.states(), clips.jobs(), (id) => runner.isAlive(id)),
    startUpdater: async (tag) => spawnUpdaterDetached({ appDir: repoRoot, tag, pid: process.pid, port: listenPort, dataDir: dataDir(), skills: false }),
  });
  const server = await startServer({ watcher, port, runner, allowedCwds, worklog, observer, clips, api, gallery, agents, uploads, slash, settings, doctor, update: updates, relay, saved, machines, usage, terminal, remote, staticDir, log: cmdLog, accounts, accountsApi, main, mainAuthApi, authApi, appLock });
  void main.status(true); // the main account's login state, for the Terminal row (not awaited)
  listenPort = server.port;
  if (serveWeb) updateChecker.start();
  // Live Runner jobs survive a server restart: remembered in SQLite, resumed idle here. CR_NO_AUTORESUME=1 turns it off.
  const autoResume =
    process.env.CR_NO_AUTORESUME === '1'
      ? undefined
      : new AutoResume({
          db,
          runner,
          titleOf: (id) => {
            const s = watcher.snapshot().find((x) => x.sessionId === id);
            return s ? s.title || s.name : '';
          },
          log: (m) => console.log(m),
        });
  if (autoResume) {
    autoResume.start();
    autoResume.restore();
  }
  remote.sync();
  // One-time backfill of the saved list from the last 30 days of transcripts (idempotent), then the machine probes.
  setImmediate(() => {
    try {
      const n = backfillSaved({ db, projectsDir: claudeProjectsDir(), isClip: (id) => clips.find(id) !== null });
      console.log(`saved sessions: backfilled ${n}`);
      saved.notifyNow();
    } catch (e) {
      console.error(`saved backfill failed: ${errText(e)}`);
    }
  });
  machines.start();
  console.log(`listening on ${HOST}:${server.port}${staticDir ? ` (serving ${staticDir})` : ''}`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: shutting down`);
    autoResume?.suspend(); // the children dying now are not "closed" jobs
    runner.shutdown();
    worklog.stop();
    saved.stop();
    usage.stop();
    machines.stop();
    remote.stop();
    updateChecker.stop();
    updates.stop();
    accounts.dispose(); // a running setup-token capture or check must not outlive the server; late timers become no-ops
    main.dispose(); // cancels a running `claude auth login` pty
    watcher.stop();
    db.close();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

// Start only when this file is the entry point (tsx src/index.ts), never on import.
const entry = process.argv[1];
if (entry && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`server failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
