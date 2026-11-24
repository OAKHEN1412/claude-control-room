// scripts/install-remote.mjs: env var naming, ssh/scp argument arrays, target validation, install plan shape.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildPlan,
  scpArgs,
  sha256Hex,
  sshBaseArgs,
  tokenEnvName,
  validateTarget,
} from '../../scripts/install-remote.mjs';

const target = { host: 'pc.example.test', user: 'User', keyPath: 'C:\\Users\\Demo\\.ssh\\id_ed25519' };
const SECRET = 'SECRET-TOKEN-do-not-leak-9f3a';
const HASH = sha256Hex(SECRET);

let tmp: string;
let sshDir: string;
let keyFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-installremote-'));
  sshDir = path.join(tmp, '.ssh');
  fs.mkdirSync(sshDir);
  keyFile = path.join(sshDir, 'id_ed25519');
  fs.writeFileSync(keyFile, 'not a real key');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('tokenEnvName', () => {
  it('upper-cases and maps every non [A-Z0-9] char to underscore', () => {
    expect(tokenEnvName('pc-hands.1')).toBe('CR_AGENT_TOKEN_PC_HANDS_1');
    expect(tokenEnvName('desktop-demo')).toBe('CR_AGENT_TOKEN_DESKTOP_DEMO');
    expect(tokenEnvName('abc')).toBe('CR_AGENT_TOKEN_ABC');
  });
});

describe('sha256Hex', () => {
  it('matches the known sha256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('ssh and scp argument arrays', () => {
  it('sshBaseArgs is exact', () => {
    expect(sshBaseArgs({ host: 'h.test', user: 'User', keyPath: 'K' })).toEqual([
      '-i', 'K',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      'User@h.test',
    ]);
  });

  it('scpArgs puts options before the local file and the remote target last', () => {
    expect(scpArgs({ host: 'h.test', user: 'User', keyPath: 'K' }, 'L.tar', 'C:/Users/User/x.tar')).toEqual([
      '-i', 'K',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', 'StrictHostKeyChecking=accept-new',
      'L.tar',
      'User@h.test:C:/Users/User/x.tar',
    ]);
  });
});

describe('validateTarget', () => {
  it('accepts a key file directly under the ssh dir', () => {
    expect(validateTarget({ host: 'pc.example.test', user: 'User', keyPath: keyFile }, sshDir)).toBeNull();
  });

  it('rejects a key outside the ssh dir', () => {
    const outside = path.join(tmp, 'other', 'id_ed25519');
    fs.mkdirSync(path.dirname(outside));
    fs.writeFileSync(outside, 'x');
    expect(validateTarget({ host: 'pc.example.test', user: 'User', keyPath: outside }, sshDir)).toMatch(/must sit directly/);
  });

  it('rejects a key path containing ".."', () => {
    const sneaky = sshDir + '/../.ssh/id_ed25519'; // raw string: path.join would normalise the '..' away
    expect(validateTarget({ host: 'pc.example.test', user: 'User', keyPath: sneaky }, sshDir)).toMatch(/\.\./);
  });

  it('rejects a host starting with a dash', () => {
    expect(validateTarget({ host: '-oProxyCommand=x', user: 'User', keyPath: keyFile }, sshDir)).toMatch(/host/);
  });

  it('rejects a user with a space', () => {
    expect(validateTarget({ host: 'pc.example.test', user: 'us er', keyPath: keyFile }, sshDir)).toMatch(/user/);
  });

  it('rejects a missing key file', () => {
    expect(validateTarget({ host: 'pc.example.test', user: 'User', keyPath: path.join(sshDir, 'nope') }, sshDir)).toMatch(/not found/);
  });
});

describe('buildPlan', () => {
  let plan: ReturnType<typeof buildPlan>;
  beforeEach(() => {
    plan = buildPlan(target, { tarPath: path.join(tmp, 'pack.tar'), sha256: HASH, repoRoot: tmp });
  });

  it('has 8 steps in the documented order', () => {
    expect(plan.map((s) => s.name)).toEqual(['check node', 'pack', 'upload', 'unpack', 'stop agent', 'npm ci', 'token hash', 'autostart']);
  });

  it('never puts the plaintext token in any arg, cmd, stdin or cwd', () => {
    const blob = JSON.stringify(plan);
    expect(blob).not.toContain(SECRET);
    expect(blob).toContain(HASH);
  });

  it('sends the token step stdin as exactly the sha256 plus a newline', () => {
    const step = plan.find((s) => s.name === 'token hash');
    expect(step?.stdin).toBe(`${HASH}\n`);
  });

  it('uses bare program names only (no shell strings)', () => {
    for (const s of plan) {
      expect(['ssh', 'scp', 'git']).toContain(s.cmd);
      expect(s.cmd).not.toMatch(/[\s&|;"]/);
    }
  });

  it('has no double quote in any remote command string', () => {
    for (const s of plan.filter((x) => x.cmd === 'ssh')) {
      const remote = s.args[s.args.length - 1];
      expect(remote).not.toContain('"');
    }
  });

  it('runs the node version check with a major >= 22 requirement', () => {
    expect(plan[0].check).toBe('node>=22');
    expect(plan[0].args[plan[0].args.length - 1]).toBe('node --version');
  });

  it('polls agent status after autostart', () => {
    const poll = plan[7].poll;
    expect(poll?.timeoutMs).toBe(30000);
    expect(poll?.intervalMs).toBe(3000);
    expect(poll?.args[poll.args.length - 1]).toContain('agent-setup.mjs status');
  });
});
