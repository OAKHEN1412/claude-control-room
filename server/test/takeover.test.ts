// "ยึดมาคุม": every refusal happens before anything is killed; the kill is one exact PID; adopt runs in bypass.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionMode, SessionInfo } from '../../shared/protocol';
import { BUSY_ERROR, buildTasklistArgs, buildTaskkillArgs, findSessionFiles, parseTasklistImage, takeover, type TakeoverDeps } from '../src/takeover';
import { parseClientMsg } from '../src/commands';

const SID = '123e4567-e89b-42d3-a456-426614174000';
const PID = 4242;
const NOW = 1_000_000;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-takeover-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeSessionFile(over: Record<string, unknown> = {}, pid = PID): void {
  fs.writeFileSync(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: SID, cwd: 'C:\\work', kind: 'interactive', status: 'idle', ...over }));
}

const info = (over: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId: SID, pid: PID, name: 'n', cwd: 'C:\\work', kind: 'interactive', title: 't', model: 'claude-haiku-5-5', effort: null, status: 'idle', thought: '', startedAt: 1, lastActivity: NOW - 60_000, timeline: [], subagents: [], ...over,
});

interface Harness {
  deps: TakeoverDeps;
  killed: number[];
  adopted: { sessionId: string; cwd: string; rawModel: string | null; permissionMode: PermissionMode }[];
  logs: Record<string, unknown>[];
  alive: Set<number>;
}

function harness(over: Partial<TakeoverDeps> = {}, session: SessionInfo | null = info()): Harness {
  const h: Harness = { deps: undefined as unknown as TakeoverDeps, killed: [], adopted: [], logs: [], alive: new Set([PID]) };
  h.deps = {
    sessionsDir: dir,
    snapshot: () => (session ? [session] : []),
    isRunnerJob: () => false,
    isClip: () => false,
    pidAlive: (pid) => h.alive.has(pid),
    imageName: async () => 'claude.exe',
    kill: async (pid) => {
      h.killed.push(pid);
      h.alive.delete(pid);
    },
    adopt: (req) => void h.adopted.push(req),
    now: () => NOW,
    sleep: async () => {},
    platform: 'win32',
    log: (e) => void h.logs.push(e),
    ...over,
  };
  return h;
}

describe('takeover', () => {
  it('kills exactly the pid of the sessions file, then adopts in bypassPermissions with the file cwd', async () => {
    writeSessionFile();
    const h = harness();
    await expect(takeover(SID, h.deps)).resolves.toBe(PID);
    expect(h.killed).toEqual([PID]);
    expect(h.adopted).toEqual([{ sessionId: SID, cwd: 'C:\\work', rawModel: 'claude-haiku-5-5', permissionMode: 'bypassPermissions' }]);
    expect(h.logs.map((l) => l.stage)).toEqual(['kill', 'done']);
    expect(h.logs.every((l) => l.pid === PID && l.sessionId === SID)).toBe(true);
  });

  it('waits for the pid to disappear before adopting, and gives up after the wait', async () => {
    writeSessionFile();
    let t = NOW;
    const slow = harness({ kill: async () => {}, now: () => t, sleep: async (ms) => void (t += ms), exitWaitMs: 1000, pollMs: 200 });
    await expect(takeover(SID, slow.deps)).rejects.toThrow(/ยังไม่หาย/);
    expect(slow.adopted).toEqual([]);
    expect(slow.logs.at(-1)).toMatchObject({ stage: 'failed', pid: PID });
    // process leaves after two polls
    let polls = 0;
    const ok = harness({ kill: async () => {}, pidAlive: () => polls++ < 3 });
    await takeover(SID, ok.deps);
    expect(ok.adopted).toHaveLength(1);
  });

  it('an adopt failure after the kill gives a Thai error that says the transcript is safe, and is logged', async () => {
    writeSessionFile();
    const h = harness({
      adopt: () => {
        throw new Error('cwd does not exist');
      },
    });
    await expect(takeover(SID, h.deps)).rejects.toThrow(/เปิดต่อไม่สำเร็จ: cwd does not exist.*เปิดทำงานต่อ/);
    expect(h.killed).toEqual([PID]);
    expect(h.logs.at(-1)).toMatchObject({ stage: 'failed', pid: PID, error: 'adopt: cwd does not exist' });
  });

  describe('refusals (nothing is killed)', () => {
    const refused = async (h: Harness, re: RegExp | string): Promise<void> => {
      await expect(takeover(SID, h.deps)).rejects.toThrow(re);
      expect(h.killed).toEqual([]);
      expect(h.adopted).toEqual([]);
      expect(h.logs.at(-1)).toMatchObject({ stage: 'refused' });
    };

    it('a Runner job', async () => {
      writeSessionFile();
      await refused(harness({ isRunnerJob: (id) => id === SID }), 'งานนี้คุมจากเว็บอยู่แล้ว');
    });

    it('a clip session', async () => {
      writeSessionFile();
      await refused(harness({ isClip: () => true }), /Clip Studio/);
    });

    it('a session the watcher does not show', async () => {
      writeSessionFile();
      await refused(harness({}, null), /ไม่พบ session/);
    });

    it('sessionId mismatch: the file of that pid names another session', async () => {
      writeSessionFile({ sessionId: 'aaaaaaaa-e89b-42d3-a456-426614174000' });
      await refused(harness(), /ปิดไปแล้ว/);
    });

    it('the file name must be the pid it holds', async () => {
      fs.writeFileSync(path.join(dir, '999.json'), JSON.stringify({ pid: PID, sessionId: SID, cwd: 'C:\\work', kind: 'interactive' }));
      await refused(harness(), /ปิดไปแล้ว/);
    });

    it('the process is gone', async () => {
      writeSessionFile();
      const h = harness();
      h.alive.clear();
      await refused(h, /กด "ย้ายมาคุมจากเว็บ"/);
    });

    it('wrong image name, or no such process', async () => {
      writeSessionFile();
      await refused(harness({ imageName: async () => 'node.exe' }), /ไม่ใช่ claude\.exe/);
      await refused(harness({ imageName: async () => null }), /ไม่ใช่ claude\.exe/);
      await refused(
        harness({
          imageName: async () => {
            throw new Error('tasklist failed');
          },
        }),
        /ไม่ใช่ claude\.exe/,
      );
    });

    it('not an interactive session (a Runner-style claude -p)', async () => {
      writeSessionFile({ kind: 'sdk-cli' });
      await refused(harness(), /interactive/);
    });

    it('working or asking state', async () => {
      writeSessionFile();
      await refused(harness({}, info({ status: 'running' })), BUSY_ERROR);
      await refused(harness({}, info({ status: 'waiting' })), BUSY_ERROR);
      await refused(harness({}, info({ waitItems: [{ id: 'x', kind: 'ask', toolName: 'AskUserQuestion', label: '', detail: '', at: 1 }] })), BUSY_ERROR);
    });

    it('busy by the sessions file even when the transcript looks idle', async () => {
      writeSessionFile({ status: 'busy' });
      await refused(harness(), BUSY_ERROR);
      writeSessionFile({ status: 'waiting' });
      await refused(harness(), BUSY_ERROR);
    });

    it('a subagent that is still running', async () => {
      writeSessionFile();
      const sub = { id: 'a1', description: 'd', model: null, effort: null, status: 'running' as const, thought: '', finished: false, lastActivity: NOW };
      await refused(harness({}, info({ subagents: [sub] })), BUSY_ERROR);
      // a finished one does not block
      const done = harness({}, info({ subagents: [{ ...sub, status: 'done', finished: true }] }));
      await takeover(SID, done.deps);
      expect(done.killed).toEqual([PID]);
    });

    it('a transcript written in the last 15 s', async () => {
      writeSessionFile();
      await refused(harness({}, info({ lastActivity: NOW - 14_000 })), BUSY_ERROR);
      const ok = harness({}, info({ lastActivity: NOW - 16_000 }));
      await takeover(SID, ok.deps);
      expect(ok.killed).toEqual([PID]);
    });

    it('not on Windows', async () => {
      writeSessionFile();
      await refused(harness({ platform: 'linux' }), /Windows/);
    });
  });

  it('never reads the .key files next to the session files', () => {
    writeSessionFile();
    fs.writeFileSync(path.join(dir, `${PID}.deadbeef.key`), JSON.stringify({ pid: PID, sessionId: SID, secret: 'x' }));
    const found = findSessionFiles(dir, SID);
    expect(found).toHaveLength(1);
    expect(found[0]).not.toHaveProperty('secret');
  });
});

describe('takeover helpers', () => {
  it('kill and image lookup arguments: exact PID, process tree, no shell string', () => {
    expect(buildTaskkillArgs(4242)).toEqual(['/PID', '4242', '/T', '/F']);
    expect(buildTasklistArgs(4242)).toEqual(['/FI', 'PID eq 4242', '/FO', 'CSV', '/NH']);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildTaskkillArgs(bad)).toThrow();
      expect(() => buildTasklistArgs(bad)).toThrow();
    }
  });

  it('reads the image name from tasklist CSV output', () => {
    expect(parseTasklistImage('"claude.exe","10284","Console","1","412,000 K"\r\n')).toBe('claude.exe');
    expect(parseTasklistImage('INFO: No tasks are running which match the specified criteria.\r\n')).toBeNull();
    expect(parseTasklistImage('')).toBeNull();
  });

  it('the command needs a uuid session id and nothing else', () => {
    expect(parseClientMsg({ type: 'takeover', reqId: 'r1', sessionId: SID })).toEqual({ ok: true, msg: { type: 'takeover', reqId: 'r1', sessionId: SID } });
    expect(parseClientMsg({ type: 'takeover', reqId: 'r1', sessionId: '1; calc' })).toMatchObject({ ok: false });
    expect(parseClientMsg({ type: 'takeover', reqId: 'r1' })).toMatchObject({ ok: false });
  });
});
