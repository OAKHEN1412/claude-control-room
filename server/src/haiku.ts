// The one place the server talks to a model: `claude -p --model haiku` with NO tools at all.
//   --tools ""            no built-in tool exists, so it cannot read, edit or run anything
//   --strict-mcp-config   (with no --mcp-config) no MCP server tools either
//   --setting-sources ""  no user/project settings: no hooks, no memory, no permission rules
//   --no-session-persistence  no transcript is kept. The CLI still writes sessions/<pid>.json while it runs, so the
//                             watcher ignores sessions whose cwd is summarizerDir() (see Watcher ignoreCwds).
// The prompt goes through stdin. The model sees only the digest text; the output is parsed, never executed.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { summarizerDir } from './cmdlog';
import { childEnv } from './runner';

export interface HaikuResult {
  text: string;
  ms: number;
  costUsd: number | null;
}
export type HaikuFn = (prompt: string, system: string) => Promise<HaikuResult>;

export const HAIKU_ARGS: readonly string[] = [
  '-p',
  '--model', 'haiku',
  '--output-format', 'json',
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--disable-slash-commands',
  '--no-session-persistence',
  '--max-budget-usd', '0.10',
];

export interface HaikuOptions {
  claudeBin?: string;
  timeoutMs?: number;
  cwd?: string;
  spawn?: typeof nodeSpawn;
}

/** Parses the JSON that `claude -p --output-format json` prints. Throws with a short reason. */
export function parseClaudeJson(stdout: string): { text: string; costUsd: number | null } {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    throw new Error('haiku: output is not JSON');
  }
  if (typeof v !== 'object' || v === null) throw new Error('haiku: unexpected output');
  const o = v as Record<string, unknown>;
  if (o.is_error === true) throw new Error(`haiku: ${typeof o.result === 'string' ? o.result.slice(0, 120) : 'error'}`);
  if (typeof o.result !== 'string' || o.result.trim() === '') throw new Error('haiku: empty answer');
  return { text: o.result.trim(), costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : null };
}

export function claudeHaiku(opts: HaikuOptions = {}): HaikuFn {
  const bin = opts.claudeBin ?? process.env.CR_CLAUDE_BIN ?? 'claude';
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const spawn = opts.spawn ?? nodeSpawn;
  return (prompt, system) =>
    new Promise<HaikuResult>((resolve, reject) => {
      const cwd = opts.cwd ?? summarizerDir();
      try {
        fs.mkdirSync(cwd, { recursive: true });
      } catch {
        // spawn will report a bad cwd
      }
      const started = Date.now();
      const child = spawn(bin, [...HAIKU_ARGS, '--system-prompt', system], {
        cwd,
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      // Kills only the exact child this call started.
      const timer = setTimeout(() => {
        done(() => reject(new Error('haiku: timed out')));
        try {
          child.kill();
        } catch {
          // already gone
        }
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-500)));
      child.on('error', (e) => done(() => reject(new Error(`haiku: ${e.message}`))));
      child.on('close', (code) =>
        done(() => {
          if (code !== 0 && out.trim() === '') return reject(new Error(`haiku: exit ${code} ${err.trim().split(/\r?\n/)[0] ?? ''}`.trim()));
          try {
            const r = parseClaudeJson(out);
            resolve({ text: r.text, costUsd: r.costUsd, ms: Date.now() - started });
          } catch (e) {
            reject(e);
          }
        }),
      );
      child.stdin?.on('error', () => {});
      child.stdin?.end(prompt, 'utf8');
    });
}
