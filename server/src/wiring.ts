// Small helpers that connect the config, secret chain and update modules to index.ts. Kept here so index.ts stays
// thin and the rules are unit-tested (server/test/wiring.test.ts). Nothing in this file ever logs or returns a key
// except through the explicit clip-env and secrets-admin paths.
import fs from 'node:fs';
import path from 'node:path';
import type { ClipJob, RunnerState } from '../../shared/protocol';
import type { SecretsAdmin } from './settingsApi';
import { repoFromPackage, type RepoRef } from './updateCheck';

export const ELEVEN_SECRET = 'elevenlabs';
const CLIP_KEY_ENV = 'ELEVENLABS_API_KEY';

/** The part of SecretChain the server uses. */
export interface KeyStore {
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  set(key: string, value: string): Promise<void>;
  clear(key: string): Promise<void>;
}

/**
 * Holds the ElevenLabs key in memory for the clip children. Refreshed at startup and after every Settings set/clear.
 * The value leaves only through clipEnv() (the child env). Logs say "available" or "not available", nothing else.
 */
export class ElevenKeyHolder {
  private key: string | null = null;

  constructor(
    private readonly store: KeyStore,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  /** Re-reads the key from the chain (never throws: a failing provider reads as empty). */
  async refresh(): Promise<boolean> {
    try {
      this.key = await this.store.get(ELEVEN_SECRET);
    } catch {
      this.key = null;
    }
    const ok = typeof this.key === 'string' && this.key !== '';
    this.log(`elevenlabs key: ${ok ? 'available' : 'not available'}`);
    return ok;
  }

  /** Synchronous child env for a clip job: {} when there is no key. */
  clipEnv(): Record<string, string> {
    return clipEnvFor(this.key);
  }

  /** The SecretsAdmin the Settings API uses: writes go to the chain, then the cache is refreshed. */
  secretsAdmin(): SecretsAdmin {
    return {
      has: (name) => this.store.has(name),
      set: async (name, value) => {
        await this.store.set(name, value);
        await this.refresh();
      },
      clear: async (name) => {
        await this.store.clear(name);
        await this.refresh();
      },
    };
  }
}

/** Env for a clip child: ELEVENLABS_API_KEY only when a key is present. */
export function clipEnvFor(key: string | null | undefined): Record<string, string> {
  return key ? { [CLIP_KEY_ENV]: key } : {};
}

/** Agent token lookup: the env token first (CR_AGENT_TOKEN_<ID>, CR_REMOTE_DIRECT), then the chain. */
export function agentTokenGetter(
  envToken: (id: string) => string | null | undefined,
  chain: Pick<KeyStore, 'get'>,
): (id: string) => Promise<string | null> {
  return async (id) => {
    const fromEnv = envToken(id);
    if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
    try {
      return await chain.get(`agent:${id}`);
    } catch {
      return null;
    }
  };
}

export interface BusyCounts {
  running: number; // a turn is in progress
  waiting: number; // a question or permission request waits for the user
  clips: number; // clip jobs still generating (not yet ready)
}

/** What the updater must wait for before it stops the server. */
export function busyCounts(
  states: readonly RunnerState[],
  clipJobs: readonly ClipJob[],
  isAlive: (sessionId: string) => boolean,
): BusyCounts {
  let running = 0;
  let waiting = 0;
  for (const s of states) {
    if (s.busy) running++;
    if (s.pending.length > 0) waiting++;
  }
  const clips = clipJobs.filter((j) => !j.ready && isAlive(j.sessionId)).length;
  return { running, waiting, clips };
}

export interface RootPackage {
  version: string;
  repo: RepoRef | null;
}

/** Reads the root package.json: its version and the GitHub repo (null when not a github URL). Never throws. */
export function readRootPackage(file: string): RootPackage {
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
    const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    return { version, repo: repoFromPackage(pkg) };
  } catch {
    return { version: '0.0.0', repo: null };
  }
}

/** The repo root for a file in server/src (two levels up). */
export function repoRootFrom(fileDir: string): string {
  return path.resolve(fileDir, '..', '..');
}
