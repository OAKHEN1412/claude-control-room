import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { RunnerState, SessionInfo, WorklogCard } from '../../shared/protocol';
import { CHIPS, chipAnswer, doneAnswer, statusLine, waitLines, waitingAnswer } from '../../shared/observer';
import { parseClientMsg } from '../src/commands';
import { WorklogDb } from '../src/db';
import { HAIKU_ARGS, claudeHaiku, parseClaudeJson, type HaikuFn } from '../src/haiku';
import { ASK_PER_HOUR, AskError, Observer, buildAskPrompt, buildDigest } from '../src/observer';

const NOW = new Date(2026, 10, 23, 12, 0, 0).getTime();

function sess(over: Partial<SessionInfo>): SessionInfo {
  return {
    sessionId: 's', pid: 1, name: 'n', cwd: 'C:\\w\\proj', kind: 'k', title: 'งานหนึ่ง', model: 'claude-opus-5-5', effort: 'high',
    status: 'idle', thought: '', startedAt: NOW - 60_000, lastActivity: NOW - 60_000, timeline: [], subagents: [], ...over,
  };
}
const ask = (id: string, q: string, at: number) => ({
  id, kind: 'ask' as const, toolName: 'AskUserQuestion', label: 'ถามคุณ', detail: q, at,
  questions: [{ question: q, header: 'h', multiSelect: false, options: [] }],
});
function runner(sessionId: string, pending: RunnerState['pending'], alive = true): RunnerState {
  return { sessionId, cwd: 'C:\\w', alive, pid: 5, busy: true, queued: 0, model: 'haiku', effort: 'low', confirmed: true, permissionMode: 'default', remoteControl: false, pending, startedAt: NOW };
}

describe('deterministic chip answers (no model)', () => {
  const sessions = [
    sess({ sessionId: 'a', title: 'ทำหน้าเว็บ', status: 'running', thought: 'กำลังแก้ CSS' }),
    sess({ sessionId: 'b', title: 'ตรวจโค้ด', status: 'waiting', waitItems: [ask('w1', 'ใช้สีไหน?', NOW - 5000)] }),
    sess({ sessionId: 'c', title: 'งานเก่า', status: 'idle' }),
    sess({ sessionId: 'd', title: 'ปิดแล้ว', status: 'done' }),
  ];

  it('only "สรุปงานวันนี้" needs the model', () => {
    expect(CHIPS.map((c) => [c.label, c.model])).toEqual([['เสร็จยัง', false], ['มีอะไรรอฉัน', false], ['สรุปงานวันนี้', true]]);
    expect(chipAnswer('today', sessions)).toBeNull();
  });

  it('"เสร็จยัง" comes from the statuses', () => {
    const a = doneAnswer(sessions);
    expect(a).toContain('ยังไม่เสร็จ: กำลังทำ 1 งาน, รอคุณ 1 งาน, พักอยู่ 1 งาน');
    expect(a).toContain('• ทำหน้าเว็บ — กำลังทำ: กำลังแก้ CSS');
    expect(a).toContain('• ตรวจโค้ด — รอคุณ');
    expect(chipAnswer('done', sessions)).toBe(a);
  });

  it('"เสร็จยัง" when nothing is running, and when there are no sessions', () => {
    expect(doneAnswer([sess({ title: 'x', status: 'idle' })])).toContain('ไม่มีงานที่กำลังทำ');
    expect(doneAnswer([])).toBe('ยังไม่มีงานที่เปิดอยู่');
    expect(doneAnswer([sess({ status: 'done' })])).toBe('ไม่มีงานที่ยังเปิดอยู่ ทุกงานจบแล้ว');
  });

  it('"มีอะไรรอฉัน" lists the wait queue, oldest first', () => {
    const two = [
      ...sessions,
      sess({ sessionId: 'e', title: 'ตัวใหม่', status: 'waiting', waitItems: [{ id: 'p1', kind: 'permission', toolName: 'Write', label: 'ขออนุญาตเขียนไฟล์', detail: 'a.txt', at: NOW - 90_000 }] }),
    ];
    const a = waitingAnswer(two);
    expect(a.split('\n')[0]).toBe('รอคุณ 2 เรื่อง');
    expect(a.indexOf('ตัวใหม่')).toBeLessThan(a.indexOf('ตรวจโค้ด'));
    expect(a).toContain('ตรวจโค้ด — ถาม: ใช้สีไหน?');
    expect(waitingAnswer([sess({})])).toBe('ไม่มีอะไรรอคุณ');
  });

  it('a web-controlled session is represented by its Runner, not twice', () => {
    const s = [sess({ sessionId: 'r', title: 'งานจากเว็บ', status: 'waiting', waitItems: [ask('t1', 'ซ้ำ?', NOW - 3000)] })];
    const r = {
      r: runner('r', [
        { requestId: 'q1', toolUseId: 't1', toolName: 'Write', kind: 'permission', description: 'x', label: 'เขียนไฟล์: a.txt', inputPreview: '{}', at: NOW - 2000 },
      ]),
    };
    const lines = waitLines(s, r);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('ขออนุญาต เขียนไฟล์: a.txt');
  });

  it('status line counts in one line', () => {
    expect(statusLine(sessions)).toBe('กำลังทำ 1 · รอคุณ 1 คำถาม · พักอยู่ 1 · จบแล้ว 1');
    expect(statusLine([])).toBe('ยังไม่มีงานที่เปิดอยู่');
  });
});

describe('digest and Observer', () => {
  const sessions = [
    sess({
      sessionId: 'a', title: 'ทำหน้าเว็บ', status: 'running', thought: 'แก้ CSS',
      timeline: Array.from({ length: 8 }, (_, i) => ({ ts: NOW - (8 - i) * 1000, kind: 'tool' as const, text: `เครื่องมือ ${i}` })),
    }),
  ];
  const cards: WorklogCard[] = [
    { sessionId: 'z', title: 'งานจบ', cwd: 'C:\\w', finishedAt: NOW - 600_000, result: 'เสร็จ: ok', bullets: ['คำสั่ง: พัง'], failureCount: 1, state: 'haiku', updatedAt: NOW },
  ];

  it('digest has title, status, model, thought, last 5 timeline lines and today\'s cards', () => {
    const d = buildDigest(sessions, {}, cards, NOW);
    expect(d).toContain('ทำหน้าเว็บ | สถานะ=running | โมเดล=claude-opus-5-5');
    expect(d).toContain('คิดอยู่: แก้ CSS');
    expect(d).toContain('เครื่องมือ 7');
    expect(d).toContain('เครื่องมือ 3');
    expect(d).not.toContain('เครื่องมือ 2');
    expect(d).toContain('งานจบ | เสร็จ: ok | ล้มเหลว 1');
    expect(d).toContain('ไม่เวิร์ก: คำสั่ง: พัง');
    expect(buildAskPrompt('สรุปงานวันนี้', d)).toContain('คำถามของผู้ใช้: สรุปงานวันนี้');
  });

  function mk(haiku: HaikuFn, now = () => NOW) {
    const db = new WorklogDb(':memory:');
    return { db, obs: new Observer({ haiku, db, sessions: () => sessions, runners: () => [], cards: () => cards, now }) };
  }

  it('asks Haiku once per question with the digest and logs the call; nothing polls', async () => {
    const seen: string[] = [];
    const { db, obs } = mk(async (p) => (seen.push(p), { text: 'ตอบสั้น ๆ', ms: 5, costUsd: 0.0001 }));
    expect(seen).toHaveLength(0); // constructing it asks nothing
    expect(await obs.ask('สรุปงานวันนี้')).toBe('ตอบสั้น ๆ');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('งานจบ');
    expect(db.callsSince(0, 'ask')).toHaveLength(1);
  });

  it('refuses empty / long questions, a second question while one is running, and over-quota', async () => {
    let release: (() => void) | undefined;
    const { obs, db } = mk(() => new Promise((res) => (release = () => res({ text: 'ok', ms: 1, costUsd: null }))));
    await expect(obs.ask('   ')).rejects.toBeInstanceOf(AskError);
    await expect(obs.ask('x'.repeat(501))).rejects.toBeInstanceOf(AskError);
    const first = obs.ask('เสร็จยัง');
    await expect(obs.ask('อีกข้อ')).rejects.toThrow('กำลังตอบ');
    release?.();
    await first;
    for (let i = 0; i < ASK_PER_HOUR; i++) db.logCall({ ts: NOW - 1000, kind: 'ask', ok: true, ms: 1 });
    await expect(obs.ask('อีก')).rejects.toThrow('โควตา');
  });

  it('turns a Haiku failure into a Thai error the UI can show', async () => {
    const { obs } = mk(async () => {
      throw new Error('haiku: timed out');
    });
    await expect(obs.ask('x')).rejects.toThrow('ถาม Haiku ไม่สำเร็จ: haiku: timed out');
  });
});

describe('ask command + Haiku call shape', () => {
  it('validates the ask command', () => {
    expect(parseClientMsg({ type: 'ask', reqId: 'r1', question: ' สรุปงานวันนี้ ' })).toEqual({ ok: true, msg: { type: 'ask', reqId: 'r1', question: 'สรุปงานวันนี้' } });
    expect(parseClientMsg({ type: 'ask', reqId: 'r1', question: '' }).ok).toBe(false);
    expect(parseClientMsg({ type: 'ask', reqId: 'r1', question: 'x'.repeat(501) }).ok).toBe(false);
    expect(parseClientMsg({ type: 'ask', reqId: 'r1' }).ok).toBe(false);
  });

  it('the Haiku call has no tools, no MCP, no settings and writes no session', () => {
    const a = [...HAIKU_ARGS];
    const i = a.indexOf('--tools');
    expect(a[i + 1]).toBe(''); // no built-in tool at all
    expect(a).toContain('--strict-mcp-config');
    expect(a[a.indexOf('--setting-sources') + 1]).toBe('');
    expect(a).toContain('--no-session-persistence');
    expect(a[a.indexOf('--model') + 1]).toBe('haiku');
    expect(a[a.indexOf('--output-format') + 1]).toBe('json');
    expect(a).not.toContain('--dangerously-skip-permissions');
  });

  it('parses claude -p json output, and reports errors', () => {
    expect(parseClaudeJson('{"result":" ตอบ ","total_cost_usd":0.001,"is_error":false}')).toEqual({ text: 'ตอบ', costUsd: 0.001 });
    expect(() => parseClaudeJson('not json')).toThrow('not JSON');
    expect(() => parseClaudeJson('{"result":"x","is_error":true}')).toThrow('haiku: x');
    expect(() => parseClaudeJson('{"result":""}')).toThrow('empty');
  });

  it('feeds the prompt on stdin with the exact args and a CLAUDE*-free env', async () => {
    let captured: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } | null = null;
    let stdinText = '';
    const fakeSpawn = ((cmd: string, args: string[], o: { env: NodeJS.ProcessEnv }) => {
      captured = { cmd, args, env: o.env };
      const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      child.stdin.on('data', (d: Buffer) => (stdinText += d.toString('utf8')));
      child.stdin.on('end', () => {
        child.stdout.end('{"result":"ตอบ","total_cost_usd":0.0002}');
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }) as unknown as typeof import('node:child_process').spawn;
    process.env.CLAUDE_CODE_TEST_VAR = 'x';
    const run = claudeHaiku({ claudeBin: 'claude-test', spawn: fakeSpawn, cwd: process.env.TEMP ?? '.' });
    const r = await run('ข้อมูล ภาษาไทย', 'ระบบ');
    delete process.env.CLAUDE_CODE_TEST_VAR;
    expect(r.text).toBe('ตอบ');
    expect(stdinText).toBe('ข้อมูล ภาษาไทย');
    expect(captured!.cmd).toBe('claude-test');
    expect(captured!.args).toEqual([...HAIKU_ARGS, '--system-prompt', 'ระบบ']);
    expect(Object.keys(captured!.env).some((k) => k.toUpperCase().startsWith('CLAUDE'))).toBe(false);
  });
});

describe('watcher ignores the summary helper', () => {
  it('a session started in the helper folder is not listed, so it never becomes a job or a card', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { Watcher } = await import('../src/watcher');
    const { summarizerDir } = await import('../src/cmdlog');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-ign-'));
    fs.mkdirSync(path.join(root, 'sessions'));
    const put = (pid: number, sid: string, cwd: string) =>
      fs.writeFileSync(path.join(root, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId: sid, cwd, name: 'n', kind: 'sdk-cli', startedAt: 1 }));
    put(11, 'helper-1', summarizerDir().toUpperCase()); // case-insensitive on Windows
    put(12, 'real-1', 'C:\w\real');
    const w = new Watcher({ claudeDir: root, pollMs: 50, isPidAlive: () => true });
    w.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(w.snapshot().map((s) => s.sessionId)).toEqual(['real-1']);
    w.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
