// Secret provider chain: where the server finds its keys (the ElevenLabs key and per-machine agent tokens).
//
// Default order (createDefaultChain): env -> DPAPI store (this Windows user only) -> secrets vault CLI (last).
// The vault CLI stays last so the owner's machine keeps working as before.
//
// Rules: a value leaves this module only through get(). Logs and error messages carry key names and
// reasons, never values. The secret goes to PowerShell over stdin, never in argv or the environment.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './cmdlog';
import { parseAgentToken } from './remote';
import { VAULT_ENTRY, parseKey, readKeyFromVault } from './voice';

export interface SecretProvider {
  readonly name: string;
  get(key: string): Promise<string | null>;
}

export interface WritableSecretStore {
  set(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

const MACHINE_RE = /^[a-z0-9-]{1,64}$/;
const STORE_FILE = 'secrets.dpapi.json';
const NEGATIVE_TTL_MS = 60_000;
const POWERSHELL_TIMEOUT_MS = 15_000;

type KeyRef = { kind: 'elevenlabs' } | { kind: 'agent'; id: string };

/** Maps a logical key name to what it is. Null for anything invalid. */
export function parseLogicalKey(key: unknown): KeyRef | null {
  if (key === 'elevenlabs') return { kind: 'elevenlabs' };
  if (typeof key !== 'string' || !key.startsWith('agent:')) return null;
  const id = key.slice('agent:'.length);
  return MACHINE_RE.test(id) ? { kind: 'agent', id } : null;
}

/** Env var that holds an agent token: CR_AGENT_TOKEN_<ID upper-cased, '-' -> '_'>. */
export function agentEnvName(id: string): string {
  return `CR_AGENT_TOKEN_${id.toUpperCase().replace(/-/g, '_')}`;
}

function clean(v: string | undefined): string | null {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' ? null : t;
}

/** Environment variables: ELEVENLABS_API_KEY and CR_AGENT_TOKEN_<ID>. */
export function envProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  return {
    name: 'env',
    async get(key) {
      const ref = parseLogicalKey(key);
      if (!ref) return null;
      return clean(ref.kind === 'elevenlabs' ? env.ELEVENLABS_API_KEY : env[agentEnvName(ref.id)]);
    },
  };
}

// PowerShell scripts. They contain no secret and no quotes, so they are safe as argv.
// The plaintext arrives on stdin (encrypt) and the blob arrives on stdin (decrypt).
const ENCRYPT_SCRIPT =
  'Add-Type -AssemblyName System.Security; ' +
  '$r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false))); ' +
  '$t = $r.ReadToEnd(); ' +
  '$b = (New-Object System.Text.UTF8Encoding($false)).GetBytes($t); ' +
  '$e = [System.Security.Cryptography.ProtectedData]::Protect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
  '[Console]::Out.Write([Convert]::ToBase64String($e))';
const DECRYPT_SCRIPT =
  'Add-Type -AssemblyName System.Security; ' +
  '$r = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), (New-Object System.Text.UTF8Encoding($false))); ' +
  '$t = $r.ReadToEnd().Trim(); ' +
  '$b = [Convert]::FromBase64String($t); ' +
  '$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser); ' +
  '$o = [Console]::OpenStandardOutput(); $o.Write($d, 0, $d.Length); $o.Flush()';

/** Runs a PowerShell script (argv = script), feeds stdin, returns stdout as UTF-8. Injectable for tests. */
export type PowerShellExec = (script: string, stdin: string) => Promise<string>;

export function runPowerShell(script: string, stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'], // stderr is dropped so it can never carry a value into an error
    });
    const out: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('dpapi: powershell timed out')));
    }, POWERSHELL_TIMEOUT_MS);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.on('error', () => finish(() => reject(new Error('dpapi: powershell not available'))));
    child.on('close', (code) =>
      finish(() => (code === 0 ? resolve(Buffer.concat(out).toString('utf8')) : reject(new Error(`dpapi: powershell exit ${code}`)))),
    );
    child.stdin.on('error', () => undefined); // EPIPE if the process died early; close handles the result
    child.stdin.end(stdin, 'utf8');
  });
}

export interface DpapiOptions {
  dir?: string;
  exec?: PowerShellExec;
  platform?: NodeJS.Platform;
}

export interface DpapiProvider extends SecretProvider, WritableSecretStore {}

/**
 * Windows DPAPI store (CurrentUser scope). The file holds only base64 blobs, never plaintext:
 * `<dir>/secrets.dpapi.json` = `{ version: 1, entries: { [key]: blob } }`.
 */
export function dpapiProvider(opts: DpapiOptions = {}): DpapiProvider {
  const dir = opts.dir ?? dataDir();
  const exec = opts.exec ?? runPowerShell;
  const platform = opts.platform ?? process.platform;
  const file = path.join(dir, STORE_FILE);
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const p = queue.then(job);
    queue = p.catch(() => undefined);
    return p;
  };

  /** Blob entries, or null when the file is missing or corrupt. Only well-formed logical keys are kept. */
  const readEntries = (): Record<string, string> | null => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      const rec = parsed as { version?: unknown; entries?: unknown };
      if (rec.version !== 1 || !rec.entries || typeof rec.entries !== 'object' || Array.isArray(rec.entries)) return null;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rec.entries as Record<string, unknown>)) {
        if (parseLogicalKey(k) && typeof v === 'string' && v !== '') out[k] = v;
      }
      return out;
    } catch {
      return null;
    }
  };

  const writeEntries = (entries: Record<string, string>): void => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
      throw e;
    }
  };

  return {
    name: 'dpapi',
    async get(key) {
      if (platform !== 'win32' || !parseLogicalKey(key)) return null;
      const blob = readEntries()?.[key];
      if (!blob) return null;
      try {
        const value = await exec(DECRYPT_SCRIPT, blob);
        return value === '' ? null : value;
      } catch {
        return null;
      }
    },
    async set(key, value) {
      if (platform !== 'win32') throw new Error('dpapi unsupported on this platform');
      if (!parseLogicalKey(key)) throw new Error('invalid secret key');
      if (typeof value !== 'string' || value === '') throw new Error('empty secret value');
      const blob = (await exec(ENCRYPT_SCRIPT, value)).trim();
      if (!/^[A-Za-z0-9+/=]{16,}$/.test(blob)) throw new Error('dpapi: unexpected output from powershell');
      await serial(async () => {
        const entries = readEntries() ?? {};
        entries[key] = blob;
        writeEntries(entries);
      });
    },
    async clear(key) {
      if (!parseLogicalKey(key)) throw new Error('invalid secret key');
      await serial(async () => {
        const entries = readEntries();
        if (!entries || !Object.prototype.hasOwnProperty.call(entries, key)) return;
        delete entries[key];
        writeEntries(entries);
      });
    },
  };
}

/** True when the `secrets` vault script exists at the path readKeyFromVault uses. */
export function secretsCliAvailable(): boolean {
  const script = process.env.CR_SECRETS_BIN || path.join(process.env.USERPROFILE || process.env.HOME || '', 'secrets', 'bin', 'secrets');
  try {
    return fs.statSync(script).isFile();
  } catch {
    return false;
  }
}

export interface SecretsCliOptions {
  read?: (entry: string, parse: (out: string) => string | null) => Promise<string | null>;
  available?: () => boolean;
}

/** The secrets vault CLI, last in the chain. Never throws: any failure is null. */
export function secretsCliProvider(opts: SecretsCliOptions = {}): SecretProvider {
  const read = opts.read ?? readKeyFromVault;
  const available = opts.available ?? secretsCliAvailable;
  return {
    name: 'secrets-cli',
    async get(key) {
      const ref = parseLogicalKey(key);
      if (!ref) return null;
      try {
        if (!available()) return null;
        const v =
          ref.kind === 'elevenlabs'
            ? await read(VAULT_ENTRY, parseKey)
            : await read(`tools/cr-agent-${ref.id}.enc`, parseAgentToken);
        return v && v !== '' ? v : null;
      } catch {
        return null;
      }
    },
  };
}

interface Hit {
  value: string;
  source: string;
}

interface CacheEntry {
  at: number;
  hit: Hit | null;
}

/**
 * Ordered providers with a cache. Found values are cached until set/clear; misses are cached for 60 s.
 * The writable store is the target of set/clear (the DPAPI store in the default chain).
 */
export class SecretChain {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<Hit | null>>();
  private readonly generation = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly providers: SecretProvider[],
    private readonly writable?: WritableSecretStore,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private invalidate(key: string): void {
    this.cache.delete(key);
    this.inflight.delete(key);
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
  }

  private lookup(key: string): Promise<Hit | null> {
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.hit) return Promise.resolve(cached.hit);
      if (this.now() - cached.at < NEGATIVE_TTL_MS) return Promise.resolve(null);
    }
    const running = this.inflight.get(key);
    if (running) return running;
    const gen = this.generation.get(key) ?? 0;
    const job = (async (): Promise<Hit | null> => {
      let hit: Hit | null = null;
      for (const p of this.providers) {
        let v: string | null = null;
        try {
          v = await p.get(key);
        } catch {
          v = null; // a failing provider is treated as empty
        }
        if (typeof v === 'string' && v !== '') {
          hit = { value: v, source: p.name };
          break;
        }
      }
      if ((this.generation.get(key) ?? 0) === gen) this.cache.set(key, { at: this.now(), hit });
      return hit;
    })();
    this.inflight.set(key, job);
    const done = () => {
      if (this.inflight.get(key) === job) this.inflight.delete(key);
    };
    job.then(done, done);
    return job;
  }

  /** First non-empty value in provider order; null when none answers or the key is invalid. */
  async get(key: string): Promise<string | null> {
    if (!parseLogicalKey(key)) return null;
    return (await this.lookup(key))?.value ?? null;
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async set(key: string, value: string): Promise<void> {
    if (!parseLogicalKey(key)) throw new Error('invalid secret key');
    if (typeof value !== 'string' || value === '') throw new Error('empty secret value');
    if (!this.writable) throw new Error('no writable secret store');
    try {
      await this.writable.set(key, value);
    } finally {
      this.invalidate(key);
    }
  }

  async clear(key: string): Promise<void> {
    if (!parseLogicalKey(key)) throw new Error('invalid secret key');
    if (!this.writable) throw new Error('no writable secret store');
    try {
      await this.writable.clear(key);
    } finally {
      this.invalidate(key);
    }
  }

  /** Name of the provider that answers now (never the value). Null when none does. */
  async sourceOf(key: string): Promise<string | null> {
    if (!parseLogicalKey(key)) return null;
    return (await this.lookup(key))?.source ?? null;
  }
}

export interface DefaultChainOptions {
  dir?: string;
  env?: NodeJS.ProcessEnv;
  exec?: PowerShellExec;
  read?: SecretsCliOptions['read'];
  available?: SecretsCliOptions['available'];
  platform?: NodeJS.Platform;
}

/** env -> DPAPI store -> secrets vault CLI. Writes go to the DPAPI store. */
export function createDefaultChain(opts: DefaultChainOptions = {}): SecretChain {
  const dpapi = dpapiProvider({ dir: opts.dir, exec: opts.exec, platform: opts.platform });
  return new SecretChain(
    [envProvider(opts.env ?? process.env), dpapi, secretsCliProvider({ read: opts.read, available: opts.available })],
    dpapi,
  );
}
