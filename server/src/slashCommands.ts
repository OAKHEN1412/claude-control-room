// Slash command list for the composer menu: GET /api/slash-commands?sessionId=<id>.
// Source: control_request {subtype:'initialize'} on a claude stream-json child; the answer carries
// `commands` ({name, description, argumentHint, builtin?}). No user message is ever sent, so no tokens.
// Order of answers: that session's own list, else the last list any session answered, else a one-off probe child.
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type http from 'node:http';
import type { SlashCommand } from '../../shared/protocol';
import { childEnv, type ChildLike, type SpawnFn } from './runner';

export const DESCRIPTION_MAX = 160;

/** Keeps name/description/argumentHint/builtin of each valid entry; description single-line and clipped. */
export function trimCommands(raw: unknown): SlashCommand[] {
  if (!Array.isArray(raw)) return [];
  const out: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const r = c as Record<string, unknown>;
    if (typeof r.name !== 'string' || r.name === '' || /\s/.test(r.name) || seen.has(r.name)) continue;
    seen.add(r.name);
    const d = (typeof r.description === 'string' ? r.description : '').replace(/\s+/g, ' ').trim();
    out.push({
      name: r.name,
      description: d.length > DESCRIPTION_MAX ? `${d.slice(0, DESCRIPTION_MAX - 1)}…` : d,
      argumentHint: typeof r.argumentHint === 'string' ? r.argumentHint.slice(0, 80) : '',
      builtin: r.builtin === true,
    });
  }
  return out;
}

export interface CommandSource {
  commandsFor(sessionId: string): SlashCommand[] | null;
  lastCommands(): SlashCommand[] | null;
}

export interface SlashDeps {
  runner?: CommandSource;
  claudeBin?: string;
  spawn?: SpawnFn;
  probeTimeoutMs?: number;
  cwd?: string;
  originAllowed: (origin: string | undefined) => boolean;
}

const PROBE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku'];

const defaultSpawn: SpawnFn = (cmd, args, opts) =>
  nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) as unknown as ChildLike;

export class SlashCommandApi {
  private cache: SlashCommand[] | null = null;
  private probing: Promise<SlashCommand[]> | null = null;

  constructor(private readonly deps: SlashDeps) {}

  /** One-off probe: initialize only, then kill exactly that child. Shared by concurrent callers, cached. */
  probe(): Promise<SlashCommand[]> {
    if (this.cache) return Promise.resolve(this.cache);
    if (this.probing) return this.probing;
    const p = this.runProbe()
      .then((list) => {
        if (list.length > 0) this.cache = list;
        return list;
      })
      .catch(() => [] as SlashCommand[])
      .finally(() => {
        this.probing = null;
      });
    this.probing = p;
    return p;
  }

  private runProbe(): Promise<SlashCommand[]> {
    const spawn = this.deps.spawn ?? defaultSpawn;
    const timeoutMs = this.deps.probeTimeoutMs ?? 20_000;
    return new Promise((resolve) => {
      let child: ChildLike;
      try {
        child = spawn(this.deps.claudeBin ?? process.env.CR_CLAUDE_BIN ?? 'claude', PROBE_ARGS, { cwd: this.deps.cwd ?? os.homedir(), env: childEnv() });
      } catch {
        resolve([]);
        return;
      }
      const id = randomUUID();
      let buf = '';
      let settled = false;
      const finish = (list: SlashCommand[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          child.kill(); // only the child we started
        } catch {
          // already gone
        }
        resolve(list);
      };
      const timer = setTimeout(() => finish([]), timeoutMs);
      timer.unref?.();
      child.stdout.on('data', (d: Buffer | string) => {
        buf += d.toString();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          try {
            const ev = JSON.parse(line) as { type?: string; response?: { request_id?: string; subtype?: string; response?: { commands?: unknown } } };
            if (ev.type === 'control_response' && ev.response?.request_id === id) {
              finish(ev.response.subtype === 'error' ? [] : trimCommands(ev.response.response?.commands));
              return;
            }
          } catch {
            // noise
          }
        }
      });
      child.on('error', () => finish([]));
      child.on('exit', () => finish([]));
      child.stdin.on('error', () => {});
      try {
        child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'initialize' } })}\n`);
      } catch {
        finish([]);
      }
    });
  }

  async list(sessionId: string | null): Promise<SlashCommand[]> {
    const r = this.deps.runner;
    const own = sessionId ? r?.commandsFor(sessionId) : null;
    if (own && own.length > 0) return own;
    const last = r?.lastCommands();
    if (last && last.length > 0) return last;
    return this.probe();
  }

  /** Returns true when the request was a /api/slash-commands route (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/api/slash-commands') return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { ...cors, Allow: 'GET' });
      res.end();
      return true;
    }
    const sid = url.searchParams.get('sessionId');
    void this.list(sid && /^[A-Za-z0-9_-]{1,80}$/.test(sid) ? sid : null)
      .then((commands) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
        res.end(JSON.stringify({ commands }));
      })
      .catch(() => {
        res.writeHead(500, cors);
        res.end();
      });
    return true;
  }
}
