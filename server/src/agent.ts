// Agent mode (CR_MODE=agent or --agent): the same server cut down to what another Control Room needs to see and command
// this PC's Claude sessions: watcher + runner + saved sessions + the websocket command handling. No static web, summary
// helper, gallery, clips, voice, worklog, machines registry or relay. It binds 127.0.0.1 only and is reached through an
// SSH local port forward; on top of the SSH key every websocket must carry the shared token (header x-cr-agent-token).
// Only the sha256 of the token is stored here (CR_AGENT_TOKEN_SHA256 or <data dir>/agent-token.sha256).
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_PORT } from '../../shared/protocol';
import { dataDir, fileLogger } from './cmdlog';
import { cachedCwds } from './cwds';
import { WorklogDb } from './db';
import { projectsDir as claudeProjectsDir } from './paths';
import { Runner } from './runner';
import { SavedService, backfillSaved } from './saved';
import { Watcher } from './watcher';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The server only ever listens on loopback. Throws for anything else (0.0.0.0, a LAN or Tailscale address, ''). */
export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK.has(host.trim().toLowerCase())) throw new Error(`refusing to bind ${JSON.stringify(host)}: only loopback (127.0.0.1) is allowed`);
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Expected token hash: CR_AGENT_TOKEN_SHA256, else sha256 of CR_AGENT_TOKEN (dev / tests), else the first line of
 * <data dir>/agent-token.sha256. Returns null when none is set (the agent then refuses to start: fail closed).
 */
export function loadTokenHash(env: NodeJS.ProcessEnv = process.env, file: string = path.join(dataDir(), 'agent-token.sha256')): string | null {
  const h = (env.CR_AGENT_TOKEN_SHA256 ?? '').trim().toLowerCase();
  if (HEX64.test(h)) return h;
  const plain = env.CR_AGENT_TOKEN;
  if (plain && plain.trim() !== '') return sha256Hex(plain.trim());
  try {
    const line = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]?.trim().toLowerCase() ?? '';
    return HEX64.test(line) ? line : null;
  } catch {
    return null;
  }
}

/** Constant-time check of a presented token against the stored hash. */
export function tokenMatches(hash: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(sha256Hex(presented), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True when the header value (a string or a repeated header) holds the right token. */
export function headerTokenOk(hash: string, header: string | string[] | undefined): boolean {
  return typeof header === 'string' && tokenMatches(hash, header.trim());
}

export function agentPortFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CR_AGENT_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : AGENT_PORT;
}

export function isAgentMode(env: NodeJS.ProcessEnv, argv: string[]): boolean {
  return env.CR_MODE === 'agent' || argv.includes('--agent');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Entry of agent mode. Never returns while running; exits the process on a fatal start problem. */
export async function runAgent(): Promise<void> {
  // imported here so index.ts (which imports this file lazily) is fully evaluated first
  const { startServer, portInUse } = await import('./index');
  const HOST = '127.0.0.1';
  const port = agentPortFromEnv();
  const hash = loadTokenHash();
  if (!hash) {
    console.error('agent: no token hash (set up with scripts/install-remote.mjs, or CR_AGENT_TOKEN_SHA256) - not starting');
    process.exit(1);
  }
  if (await portInUse(port, HOST)) {
    console.log(`agent: port ${HOST}:${port} is already in use (second copy?) - not starting`);
    process.exit(0);
  }
  let runnerRef: Runner | null = null;
  const watcher = new Watcher({ keepAlive: (id) => runnerRef?.isAlive(id) === true });
  watcher.start();
  const extra = (process.env.CR_EXTRA_CWDS ?? '').split(path.delimiter).filter((x) => x.trim() !== '');
  const allowedCwds = cachedCwds({ sessionCwds: () => watcher.snapshot().map((s) => s.cwd), extra });
  const extraArgs = process.env.CR_RUNNER_ARGS ? (JSON.parse(process.env.CR_RUNNER_ARGS) as string[]) : [];
  const runner = new Runner({ allowedCwds, extraArgs, claudeBin: process.env.CR_CLAUDE_BIN });
  runnerRef = runner;
  const db = new WorklogDb(process.env.CR_DB_FILE || undefined);
  const saved = new SavedService({
    db,
    runner,
    snapshot: () => watcher.snapshot(),
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
    projectsDir: claudeProjectsDir(),
    isClip: () => false,
  });
  const cmdLog = fileLogger();
  const server = await startServer({
    watcher,
    port,
    host: HOST,
    runner,
    allowedCwds,
    saved,
    verifyToken: (header) => headerTokenOk(hash, header),
    log: cmdLog,
  });
  setImmediate(() => {
    try {
      console.log(`agent: saved sessions backfilled ${backfillSaved({ db, projectsDir: claudeProjectsDir(), isClip: () => false })}`);
      saved.notifyNow();
    } catch (e) {
      console.error(`agent: saved backfill failed: ${errText(e)}`);
    }
  });
  console.log(`agent: listening on ${HOST}:${server.port} (token required)`);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`agent ${signal}: shutting down`);
    runner.shutdown();
    saved.stop();
    watcher.stop();
    db.close();
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
