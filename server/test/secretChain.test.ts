import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SecretChain,
  agentEnvName,
  createDefaultChain,
  dpapiProvider,
  envProvider,
  parseLogicalKey,
  secretsCliProvider,
  type SecretProvider,
} from '../src/secretChain';

const FAKE_KEY = 'sk_test_0000000000000000';
const AGENT_TOKEN = 'tok_test_0000000000000000000000000000';

const roots: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-chain-'));
  roots.push(d);
  return d;
}

beforeAll(() => {
  process.env.CR_DATA_DIR = tmpDir();
});
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true });
});

/** Provider that answers from a map and records every call in a shared log. */
function fakeProvider(name: string, values: Record<string, string>, log: string[] = []): SecretProvider & { calls: number } {
  const p = {
    name,
    calls: 0,
    async get(key: string) {
      p.calls++;
      log.push(name);
      return values[key] ?? null;
    },
  };
  return p;
}

describe('provider order', () => {
  it('env beats dpapi beats cli', async () => {
    const log: string[] = [];
    const env = fakeProvider('env', { elevenlabs: 'from-env' }, log);
    const dp = fakeProvider('dpapi', { elevenlabs: 'from-dpapi' }, log);
    const cli = fakeProvider('secrets-cli', { elevenlabs: 'from-cli' }, log);
    const chain = new SecretChain([env, dp, cli]);
    expect(await chain.get('elevenlabs')).toBe('from-env');
    expect(dp.calls).toBe(0);
    expect(cli.calls).toBe(0);
  });

  it('dpapi answers when env is empty, and cli is not called', async () => {
    const log: string[] = [];
    const env = fakeProvider('env', {}, log);
    const dp = fakeProvider('dpapi', { elevenlabs: 'from-dpapi' }, log);
    const cli = fakeProvider('secrets-cli', { elevenlabs: 'from-cli' }, log);
    const chain = new SecretChain([env, dp, cli]);
    expect(await chain.get('elevenlabs')).toBe('from-dpapi');
    expect(cli.calls).toBe(0);
    expect(log).toEqual(['env', 'dpapi']);
  });

  it('cli is consulted last, only when the earlier providers miss', async () => {
    const log: string[] = [];
    const chain = new SecretChain([fakeProvider('env', {}, log), fakeProvider('dpapi', {}, log), fakeProvider('secrets-cli', { elevenlabs: 'from-cli' }, log)]);
    expect(await chain.get('elevenlabs')).toBe('from-cli');
    expect(log).toEqual(['env', 'dpapi', 'secrets-cli']);
    expect(await chain.sourceOf('elevenlabs')).toBe('secrets-cli');
  });

  it('a throwing provider counts as empty and the chain goes on', async () => {
    const broken: SecretProvider = {
      name: 'dpapi',
      async get() {
        throw new Error('boom');
      },
    };
    const chain = new SecretChain([broken, fakeProvider('secrets-cli', { elevenlabs: 'ok' })]);
    expect(await chain.get('elevenlabs')).toBe('ok');
  });

  it('sourceOf names the answering provider and never returns the value', async () => {
    const chain = new SecretChain([fakeProvider('env', { elevenlabs: FAKE_KEY })]);
    expect(await chain.sourceOf('elevenlabs')).toBe('env');
    expect(await chain.sourceOf('agent:box-1')).toBeNull();
    expect(await chain.sourceOf('bad key')).toBeNull();
  });
});

describe('cache', () => {
  it('caches a found value (no second provider call)', async () => {
    const p = fakeProvider('env', { elevenlabs: FAKE_KEY });
    const chain = new SecretChain([p]);
    await chain.get('elevenlabs');
    await chain.get('elevenlabs');
    expect(p.calls).toBe(1);
  });

  it('caches a miss for 60 s, then asks again', async () => {
    let now = 1_000_000;
    const p = fakeProvider('secrets-cli', {});
    const chain = new SecretChain([p], undefined, { now: () => now });
    expect(await chain.get('elevenlabs')).toBeNull();
    now += 59_000;
    expect(await chain.get('elevenlabs')).toBeNull();
    expect(p.calls).toBe(1);
    now += 2_000;
    expect(await chain.get('elevenlabs')).toBeNull();
    expect(p.calls).toBe(2);
  });

  it('concurrent identical gets share one provider call', async () => {
    const p = fakeProvider('env', { elevenlabs: FAKE_KEY });
    const chain = new SecretChain([p]);
    const [a, b] = await Promise.all([chain.get('elevenlabs'), chain.get('elevenlabs')]);
    expect(a).toBe(FAKE_KEY);
    expect(b).toBe(FAKE_KEY);
    expect(p.calls).toBe(1);
  });

  it('set invalidates a cached miss so the new value shows at once', async () => {
    const values: Record<string, string> = {};
    const p = fakeProvider('dpapi', values);
    const writable = {
      async set(key: string, value: string) {
        values[key] = value;
      },
      async clear(key: string) {
        delete values[key];
      },
    };
    const chain = new SecretChain([p], writable);
    expect(await chain.get('elevenlabs')).toBeNull();
    await chain.set('elevenlabs', FAKE_KEY);
    expect(await chain.get('elevenlabs')).toBe(FAKE_KEY);
    expect(await chain.has('elevenlabs')).toBe(true);
  });

  it('clear invalidates a cached value', async () => {
    const values: Record<string, string> = { elevenlabs: FAKE_KEY };
    const p = fakeProvider('dpapi', values);
    const writable = {
      async set(key: string, value: string) {
        values[key] = value;
      },
      async clear(key: string) {
        delete values[key];
      },
    };
    const chain = new SecretChain([p], writable);
    expect(await chain.get('elevenlabs')).toBe(FAKE_KEY);
    await chain.clear('elevenlabs');
    expect(await chain.get('elevenlabs')).toBeNull();
    expect(await chain.has('elevenlabs')).toBe(false);
  });

  it('a failed set still drops the cache, so the next get reads the provider', async () => {
    const p = fakeProvider('dpapi', {});
    const writable = {
      async set() {
        throw new Error('disk full');
      },
      async clear() {},
    };
    const chain = new SecretChain([p], writable);
    expect(await chain.get('elevenlabs')).toBeNull();
    await expect(chain.set('elevenlabs', FAKE_KEY)).rejects.toThrow('disk full');
    expect(await chain.get('elevenlabs')).toBeNull();
    expect(p.calls).toBe(2);
  });
});

describe('env names and key validation', () => {
  it('maps agent ids to CR_AGENT_TOKEN_<ID> with - -> _', () => {
    expect(agentEnvName('box-1')).toBe('CR_AGENT_TOKEN_BOX_1');
    expect(agentEnvName('a')).toBe('CR_AGENT_TOKEN_A');
  });

  it('envProvider reads ELEVENLABS_API_KEY and the agent token; blank is null', async () => {
    const env = { ELEVENLABS_API_KEY: `  ${FAKE_KEY}  `, CR_AGENT_TOKEN_BOX_1: AGENT_TOKEN, CR_AGENT_TOKEN_BLANK: '   ' };
    const p = envProvider(env);
    expect(p.name).toBe('env');
    expect(await p.get('elevenlabs')).toBe(FAKE_KEY);
    expect(await p.get('agent:box-1')).toBe(AGENT_TOKEN);
    expect(await p.get('agent:blank')).toBeNull();
    expect(await p.get('agent:other')).toBeNull();
    expect(await envProvider({}).get('elevenlabs')).toBeNull();
  });

  it('parseLogicalKey accepts only elevenlabs and agent:<machine id>', () => {
    expect(parseLogicalKey('elevenlabs')).toEqual({ kind: 'elevenlabs' });
    expect(parseLogicalKey('agent:box-1')).toEqual({ kind: 'agent', id: 'box-1' });
    expect(parseLogicalKey('agent:' + 'a'.repeat(64))).not.toBeNull();
  });

  const invalid = ['agent:', 'agent:Box', 'agent:box_1', 'agent:../x', 'agent:a b', 'agent:' + 'a'.repeat(65), 'agent:box\n', 'elevenlabs2', '', 'foo', 42];

  it('invalid ids: get is null, has is false, set and clear throw', async () => {
    const chain = new SecretChain([fakeProvider('env', { elevenlabs: FAKE_KEY })], { set: async () => {}, clear: async () => {} });
    for (const k of invalid) {
      expect(parseLogicalKey(k)).toBeNull();
      expect(await chain.get(k as string)).toBeNull();
      expect(await chain.has(k as string)).toBe(false);
      await expect(chain.set(k as string, 'v')).rejects.toThrow('invalid secret key');
      await expect(chain.clear(k as string)).rejects.toThrow('invalid secret key');
    }
  });

  it('set without a writable store throws', async () => {
    const chain = new SecretChain([fakeProvider('env', {})]);
    await expect(chain.set('elevenlabs', FAKE_KEY)).rejects.toThrow('no writable secret store');
    await expect(chain.clear('elevenlabs')).rejects.toThrow('no writable secret store');
  });

  it('set rejects an empty value', async () => {
    const chain = new SecretChain([fakeProvider('env', {})], { set: async () => {}, clear: async () => {} });
    await expect(chain.set('elevenlabs', '')).rejects.toThrow('empty secret value');
  });
});

describe('secrets CLI provider', () => {
  it('elevenlabs reads tools/elevenlabs.enc with parseKey; agent reads tools/cr-agent-<id>.enc', async () => {
    const seen: string[] = [];
    // parseKey wants sk_ + alphanumerics (no underscore), so this CLI fixture uses that shape.
    const p = secretsCliProvider({
      available: () => true,
      read: async (entry, parse) => {
        seen.push(entry);
        return parse(entry.includes('elevenlabs') ? 'key = sk_0000000000000000000000\n' : `${AGENT_TOKEN}\n`);
      },
    });
    expect(p.name).toBe('secrets-cli');
    expect(await p.get('elevenlabs')).toBe('sk_0000000000000000000000');
    expect(await p.get('agent:box-1')).toBe(AGENT_TOKEN);
    expect(seen).toEqual(['tools/elevenlabs.enc', 'tools/cr-agent-box-1.enc']);
  });

  it('is not read when the CLI is missing, and never throws', async () => {
    let called = 0;
    const missing = secretsCliProvider({
      available: () => false,
      read: async () => {
        called++;
        return FAKE_KEY;
      },
    });
    expect(await missing.get('elevenlabs')).toBeNull();
    expect(called).toBe(0);

    const throwing = secretsCliProvider({
      available: () => true,
      read: async () => {
        throw new Error('bash exploded');
      },
    });
    expect(await throwing.get('elevenlabs')).toBeNull();
    expect(await secretsCliProvider({ available: () => true, read: async () => null }).get('agent:box-1')).toBeNull();
  });
});

describe('dpapi provider with an injected exec', () => {
  // Fake PowerShell: encrypt = base64 of a marker plus the input, decrypt = reverse of that.
  // Scripts are recorded so the test can check what went to argv and what went to stdin.
  function fakeExec() {
    const calls: { script: string; stdin: string }[] = [];
    const exec = async (script: string, stdin: string): Promise<string> => {
      calls.push({ script, stdin });
      if (script.includes('Unprotect')) {
        const raw = Buffer.from(stdin, 'base64').toString('utf8');
        if (!raw.startsWith('FAKE-DPAPI|')) throw new Error('bad blob');
        return raw.slice('FAKE-DPAPI|'.length);
      }
      if (script.includes('Protect')) return Buffer.from(`FAKE-DPAPI|${stdin}`, 'utf8').toString('base64');
      throw new Error('unexpected script');
    };
    return { calls, exec };
  }

  it('roundtrip: the blob (not plaintext) lands in the file; stdin carries the secret; argv never does', async () => {
    const dir = tmpDir();
    const { calls, exec } = fakeExec();
    const dp = dpapiProvider({ dir, exec, platform: 'win32' });
    await dp.set('agent:box-1', AGENT_TOKEN);

    const setCalls = calls.filter((c) => c.stdin === AGENT_TOKEN);
    expect(setCalls).toHaveLength(1);
    for (const c of calls) expect(c.script).not.toContain(AGENT_TOKEN);

    const text = fs.readFileSync(path.join(dir, 'secrets.dpapi.json'), 'utf8');
    expect(text).not.toContain(AGENT_TOKEN);
    const doc = JSON.parse(text) as { version: number; entries: Record<string, string> };
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.entries)).toEqual(['agent:box-1']);
    expect(doc.entries['agent:box-1']).toBe(Buffer.from(`FAKE-DPAPI|${AGENT_TOKEN}`, 'utf8').toString('base64'));

    expect(await dp.get('agent:box-1')).toBe(AGENT_TOKEN);
    // A fresh provider instance (new process, same file) reads the same value.
    expect(await dpapiProvider({ dir, exec, platform: 'win32' }).get('agent:box-1')).toBe(AGENT_TOKEN);
    for (const c of calls) expect(c.script).not.toContain(AGENT_TOKEN);
  });

  it('clear removes one entry and keeps the others; no temp file is left behind', async () => {
    const dir = tmpDir();
    const { exec } = fakeExec();
    const dp = dpapiProvider({ dir, exec, platform: 'win32' });
    await dp.set('elevenlabs', FAKE_KEY);
    await dp.set('agent:box-1', AGENT_TOKEN);
    await dp.clear('elevenlabs');
    expect(await dp.get('elevenlabs')).toBeNull();
    expect(await dp.get('agent:box-1')).toBe(AGENT_TOKEN);
    expect(fs.readdirSync(dir).sort()).toEqual(['secrets.dpapi.json']);
  });

  it('missing or corrupt file: get is null without running PowerShell', async () => {
    const dir = tmpDir();
    let execCalls = 0;
    const exec = async () => {
      execCalls++;
      return '';
    };
    const dp = dpapiProvider({ dir, exec, platform: 'win32' });
    expect(await dp.get('elevenlabs')).toBeNull();
    fs.writeFileSync(path.join(dir, 'secrets.dpapi.json'), '{not json', 'utf8');
    expect(await dp.get('elevenlabs')).toBeNull();
    fs.writeFileSync(path.join(dir, 'secrets.dpapi.json'), JSON.stringify({ version: 2, entries: { elevenlabs: 'AAAAAAAAAAAAAAAAAA==' } }), 'utf8');
    expect(await dp.get('elevenlabs')).toBeNull();
    expect(execCalls).toBe(0);
  });

  it('a failing decrypt (wrong user, changed blob) is null, never a throw', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'secrets.dpapi.json'), JSON.stringify({ version: 1, entries: { elevenlabs: 'AAAAAAAAAAAAAAAAAAAA==' } }), 'utf8');
    const dp = dpapiProvider({
      dir,
      platform: 'win32',
      exec: async () => {
        throw new Error('dpapi: powershell exit 1');
      },
    });
    expect(await dp.get('elevenlabs')).toBeNull();
  });

  it('off Windows: get is null and set throws the platform error', async () => {
    const dir = tmpDir();
    let execCalls = 0;
    const dp = dpapiProvider({
      dir,
      platform: 'linux',
      exec: async () => {
        execCalls++;
        return '';
      },
    });
    expect(await dp.get('elevenlabs')).toBeNull();
    await expect(dp.set('elevenlabs', FAKE_KEY)).rejects.toThrow('dpapi unsupported on this platform');
    expect(execCalls).toBe(0);
    expect(fs.existsSync(path.join(dir, 'secrets.dpapi.json'))).toBe(false);
  });

  it('rejects a PowerShell output that is not a base64 blob', async () => {
    const dir = tmpDir();
    const dp = dpapiProvider({ dir, platform: 'win32', exec: async () => 'not base64 at all!' });
    await expect(dp.set('elevenlabs', FAKE_KEY)).rejects.toThrow('unexpected output');
    expect(fs.existsSync(path.join(dir, 'secrets.dpapi.json'))).toBe(false);
  });
});

describe('createDefaultChain', () => {
  it('order is env, then dpapi, then the CLI; writes go to dpapi', async () => {
    const dir = tmpDir();
    const stored: Record<string, string> = {};
    const exec = async (script: string, stdin: string) => {
      if (script.includes('Unprotect')) return Buffer.from(stdin, 'base64').toString('utf8').replace('FAKE|', '');
      return Buffer.from(`FAKE|${stdin}`, 'utf8').toString('base64');
    };
    const chain = createDefaultChain({
      dir,
      platform: 'win32',
      exec,
      env: { ELEVENLABS_API_KEY: 'sk_test_env_0000000000000000' },
      available: () => true,
      read: async (entry) => {
        stored[entry] = 'cli';
        return entry === 'tools/elevenlabs.enc' ? 'sk_test_cli_0000000000000000' : null;
      },
    });
    expect(await chain.sourceOf('elevenlabs')).toBe('env');
    expect(Object.keys(stored)).toHaveLength(0); // the CLI was never reached

    await chain.set('agent:box-1', AGENT_TOKEN);
    expect(await chain.sourceOf('agent:box-1')).toBe('dpapi');
    expect(await chain.get('agent:box-1')).toBe(AGENT_TOKEN);
    expect(fs.existsSync(path.join(dir, 'secrets.dpapi.json'))).toBe(true);
    expect(await chain.sourceOf('agent:other-box')).toBeNull();

    // No env, no dpapi entry: the CLI answers.
    expect(await chain.get('elevenlabs')).toBe('sk_test_env_0000000000000000');
    const noEnv = createDefaultChain({
      dir,
      platform: 'win32',
      exec,
      env: {},
      available: () => true,
      read: async (entry) => (entry === 'tools/elevenlabs.enc' ? 'sk_test_cli_0000000000000000' : null),
    });
    expect(await noEnv.sourceOf('elevenlabs')).toBe('secrets-cli');
  });
});

describe('dpapi real roundtrip (Windows only)', () => {
  it.runIf(process.platform === 'win32')(
    'encrypts with the real DPAPI, persists only the blob, and decrypts it back',
    async () => {
      const dir = tmpDir();
      const dp = dpapiProvider({ dir });
      await dp.set('agent:win-test', FAKE_KEY);
      const file = path.join(dir, 'secrets.dpapi.json');
      expect(fs.readFileSync(file, 'utf8')).not.toContain(FAKE_KEY);
      expect(await dpapiProvider({ dir }).get('agent:win-test')).toBe(FAKE_KEY);
      await dp.clear('agent:win-test');
      expect(await dp.get('agent:win-test')).toBeNull();
    },
    60_000,
  );
});
