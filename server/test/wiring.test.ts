import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipJob, RunnerState } from '../../shared/protocol';
import { defaultConfig, effectiveExtraCwds, effectiveGalleryRoots, effectivePort, effectiveVideosDir, envOverrides, type CrConfig } from '../src/config';
import { Runner, type ChildLike } from '../src/runner';
import { ELEVEN_SECRET, ElevenKeyHolder, agentTokenGetter, busyCounts, clipEnvFor, readRootPackage, repoRootFrom, type KeyStore } from '../src/wiring';

const KEY = 'sk_test_0000000000000000';

function cfg(patch: Partial<CrConfig> = {}): CrConfig {
  return { ...defaultConfig(), ...patch };
}

/** In-memory KeyStore that records calls; `secret` plays the role of the DPAPI/vault store. */
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const calls: string[] = [];
  const store: KeyStore = {
    async get(k) {
      calls.push(`get:${k}`);
      return data.get(k) ?? null;
    },
    async has(k) {
      return data.has(k);
    },
    async set(k, v) {
      calls.push(`set:${k}`);
      data.set(k, v);
    },
    async clear(k) {
      calls.push(`clear:${k}`);
      data.delete(k);
    },
  };
  return { store, calls, data };
}

describe('config precedence (env beats config.json)', () => {
  it('port: CR_PORT wins over config, config wins over the default, an invalid env value is skipped', () => {
    expect(effectivePort({ CR_PORT: '8799' }, cfg({ port: 8800 }), 8790)).toBe(8799);
    expect(effectivePort({ PORT: '8801' }, cfg({ port: 8800 }), 8790)).toBe(8801);
    expect(effectivePort({ CR_PORT: 'abc' }, cfg({ port: 8800 }), 8790)).toBe(8800);
    expect(effectivePort({}, cfg({ port: null }), 8790)).toBe(8790);
    expect(envOverrides({ CR_PORT: '8799' }).port).toBe(true);
  });

  it('gallery roots: CR_GALLERY_ROOTS wins over config.galleryRoots, which wins over ~/videos', () => {
    const sep = path.delimiter;
    expect(effectiveGalleryRoots({ CR_GALLERY_ROOTS: `D:/a${sep}D:/b` }, cfg({ galleryRoots: ['E:/c'] }))).toEqual(['D:/a', 'D:/b']);
    expect(effectiveGalleryRoots({}, cfg({ galleryRoots: ['E:/c'] }))).toEqual(['E:/c']);
    expect(effectiveGalleryRoots({}, cfg())).toEqual([path.join(os.homedir(), 'videos')]);
  });

  it('videos dir and extra cwds: env first, config merged in, duplicates dropped', () => {
    expect(effectiveVideosDir({ CR_VIDEOS_DIR: 'D:/v' }, cfg({ videosDir: 'E:/x' }))).toBe('D:/v');
    expect(effectiveVideosDir({}, cfg({ videosDir: 'E:/x' }))).toBe('E:/x');
    const sep = path.delimiter;
    expect(effectiveExtraCwds({ CR_EXTRA_CWDS: `D:/a${sep}D:/b` }, cfg({ extraCwds: ['D:/b', 'E:/c'] }))).toEqual(['D:/a', 'D:/b', 'E:/c']);
  });
});

describe('busyCounts', () => {
  const state = (over: Partial<RunnerState>): RunnerState =>
    ({ sessionId: 's', cwd: '/x', alive: true, pid: 1, busy: false, queued: 0, model: null, effort: null, confirmed: false, permissionMode: 'default', remoteControl: false, pending: [], startedAt: 0, ...over }) as RunnerState;
  const job = (over: Partial<ClipJob>): ClipJob => ({ sessionId: 'c', ready: false, ...over }) as ClipJob;

  it('counts working turns, waiting requests and still-generating clips (alive, not ready)', () => {
    const states = [
      state({ sessionId: 'a', busy: true }),
      state({ sessionId: 'b', pending: [{ requestId: 'q' } as never] }),
      state({ sessionId: 'c' }),
    ];
    const jobs = [job({ sessionId: 'c1' }), job({ sessionId: 'c2', ready: true }), job({ sessionId: 'c3' })];
    const alive = new Set(['c1', 'c2']);
    expect(busyCounts(states, jobs, (id) => alive.has(id))).toEqual({ running: 1, waiting: 1, clips: 1 });
    expect(busyCounts([], [], () => true)).toEqual({ running: 0, waiting: 0, clips: 0 });
  });
});

describe('ElevenKeyHolder', () => {
  let logs: string[];
  let spies: ReturnType<typeof vi.spyOn>[];

  beforeEach(() => {
    logs = [];
    spies = [
      vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))),
      vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))),
      vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))),
    ];
  });
  afterEach(() => {
    for (const s of spies) s.mockRestore();
  });

  it('clipEnv is empty when no key is stored, and holds the key once refreshed', async () => {
    const { store } = fakeStore();
    const holder = new ElevenKeyHolder(store, (l) => logs.push(l));
    expect(holder.clipEnv()).toEqual({});
    expect(await holder.refresh()).toBe(false);
    expect(holder.clipEnv()).toEqual({});
    expect(logs).toContain('elevenlabs key: not available');
  });

  it('set and clear through the SecretsAdmin refresh the cached key (clipEnv follows at once)', async () => {
    const { store, calls, data } = fakeStore();
    const holder = new ElevenKeyHolder(store, (l) => logs.push(l));
    const admin = holder.secretsAdmin();
    await admin.set(ELEVEN_SECRET, KEY);
    expect(calls).toContain(`set:${ELEVEN_SECRET}`);
    expect(holder.clipEnv()).toEqual({ ELEVENLABS_API_KEY: KEY });
    expect(await admin.has(ELEVEN_SECRET)).toBe(true);
    await admin.clear(ELEVEN_SECRET);
    expect(data.has(ELEVEN_SECRET)).toBe(false);
    expect(holder.clipEnv()).toEqual({});
  });

  it('the key never appears in any logged line, through refresh, set and clear', async () => {
    const { store } = fakeStore({ [ELEVEN_SECRET]: KEY });
    const holder = new ElevenKeyHolder(store, (l) => logs.push(l));
    await holder.refresh();
    await holder.secretsAdmin().set(ELEVEN_SECRET, KEY);
    await holder.secretsAdmin().clear(ELEVEN_SECRET);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(KEY);
    expect(logs.some((l) => l === 'elevenlabs key: available')).toBe(true);
  });

  it('a store that throws reads as no key (never throws out of refresh)', async () => {
    const broken: KeyStore = {
      get: async () => {
        throw new Error('boom');
      },
      has: async () => false,
      set: async () => undefined,
      clear: async () => undefined,
    };
    const holder = new ElevenKeyHolder(broken, (l) => logs.push(l));
    await expect(holder.refresh()).resolves.toBe(false);
    expect(holder.clipEnv()).toEqual({});
  });

  it('clipEnvFor gives the env var only for a non-empty key', () => {
    expect(clipEnvFor(null)).toEqual({});
    expect(clipEnvFor('')).toEqual({});
    expect(clipEnvFor(KEY)).toEqual({ ELEVENLABS_API_KEY: KEY });
  });
});

describe('agentTokenGetter', () => {
  it('env token first, then the chain under agent:<id>; a failing chain reads as null', async () => {
    const asked: string[] = [];
    const chain = { get: async (k: string) => (asked.push(k), k === 'agent:pc-b' ? 'tok-from-chain' : null) };
    const get = agentTokenGetter((id) => (id === 'pc-a' ? 'tok-env' : null), chain);
    expect(await get('pc-a')).toBe('tok-env');
    expect(asked).toEqual([]);
    expect(await get('pc-b')).toBe('tok-from-chain');
    expect(asked).toEqual(['agent:pc-b']);
    expect(await get('pc-c')).toBeNull();
    const broken = agentTokenGetter(() => null, { get: async () => { throw new Error('x'); } });
    expect(await broken('pc-d')).toBeNull();
  });
});

describe('root package helpers', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-wiring-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('readRootPackage reads the version and the github repo; a missing file gives 0.0.0 and no repo', () => {
    const file = path.join(tmp, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ version: '1.2.3', repository: { type: 'git', url: 'git+https://github.com/OAKHEN1412/claude-control-room.git' } }));
    expect(readRootPackage(file)).toEqual({ version: '1.2.3', repo: { owner: 'OAKHEN1412', repo: 'claude-control-room' } });
    expect(readRootPackage(path.join(tmp, 'missing.json'))).toEqual({ version: '0.0.0', repo: null });
  });

  it('repoRootFrom goes two levels up from server/src', () => {
    expect(repoRootFrom(path.resolve('app', 'server', 'src'))).toBe(path.resolve('app'));
  });
});

describe('Runner envForSession (clip key after a restart)', () => {
  let tmp: string;
  let calls: { env: NodeJS.ProcessEnv }[];

  class FakeChild extends EventEmitter implements ChildLike {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    pid = 4343;
    kill(): boolean {
      return true;
    }
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-wiring-runner-'));
    calls = [];
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adopt gets the envForSession env; a plain start does not', () => {
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const clipId = '11111111-2222-3333-4444-555555555555';
      const r = new Runner({
        allowedCwds: () => [tmp],
        spawn: (_cmd, _args, o) => {
          calls.push({ env: o.env });
          return new FakeChild();
        },
        envForSession: (id): Record<string, string> => (id === clipId ? { ELEVENLABS_API_KEY: KEY } : {}),
      });
      r.adopt({ sessionId: clipId, cwd: tmp }, { trustedCwd: true });
      r.start({ cwd: tmp, model: 'haiku', effort: 'low', prompt: 'hi' });
      expect(calls[0].env.ELEVENLABS_API_KEY).toBe(KEY);
      expect(calls[1].env).not.toHaveProperty('ELEVENLABS_API_KEY');
      r.shutdown();
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = saved;
    }
  });
});
