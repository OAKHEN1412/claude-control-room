import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '../../shared/protocol';
import { claudeDir } from '../src/paths';
import { Tail, Watcher, defaultIgnoreCwds, type TailSink } from '../src/watcher';
import { originAllowed, startServer, type RunningServer } from '../src/index';

const SECRET = 'SECRET_TOKEN_DO_NOT_LEAK';
const ALIVE_SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const DEAD_SID = 'bbbbbbbb-1111-4222-8333-444444444444';
const DEAD_PID = 2147480000; // not a live pid on any machine we run on

let root: string;
let watcher: Watcher | null = null;
let server: RunningServer | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timed out');
    await sleep(25);
  }
}

function writeSession(pid: number, sid: string): void {
  fs.writeFileSync(
    path.join(root, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: sid, cwd: 'C:\\demo', name: `name-${pid}`, kind: 'interactive', startedAt: 1700000000000 }),
  );
}

const jsonl = (obj: unknown): string => `${JSON.stringify(obj)}\n`;
const userLine = (text: string, ts: string): string =>
  jsonl({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const assistantLine = (text: string, ts: string): string =>
  jsonl({
    type: 'assistant',
    timestamp: ts,
    message: { role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }] },
  });

function projectDir(): string {
  return path.join(root, 'projects', '-demo-project');
}

function transcriptPath(): string {
  return path.join(projectDir(), `${ALIVE_SID}.jsonl`);
}

function startWatcher(pollMs = 50): Watcher {
  watcher = new Watcher({ claudeDir: root, pollMs });
  watcher.start();
  return watcher;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-watch-'));
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.mkdirSync(projectDir(), { recursive: true });
});

afterEach(async () => {
  watcher?.stop();
  watcher = null;
  if (server) await server.close();
  server = null;
  fs.rmSync(root, { recursive: true, force: true });
});

function spySink(): TailSink & { lines: string[]; resets: number } {
  const sink = {
    lines: [] as string[],
    resets: 0,
    reset() {
      this.resets += 1;
      this.lines = [];
    },
    line(text: string) {
      this.lines.push(text);
    },
  };
  return sink;
}

describe('Tail', () => {
  it('does not deliver a partial last line until its newline arrives', () => {
    const file = path.join(root, 'partial.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"b":');
    const sink = spySink();
    const tail = new Tail(file, sink);
    tail.poll();
    expect(sink.lines).toEqual(['{"a":1}']);

    fs.appendFileSync(file, '2}');
    tail.poll();
    expect(sink.lines).toEqual(['{"a":1}']); // still no newline

    fs.appendFileSync(file, '\n');
    tail.poll();
    expect(sink.lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('keeps multibyte UTF-8 intact when a read ends mid-character', () => {
    const file = path.join(root, 'utf8.jsonl');
    const full = Buffer.from('{"t":"ไทย"}\n', 'utf8');
    // "ไ" is 3 bytes starting at offset 6; cut in the middle of it.
    fs.writeFileSync(file, full.subarray(0, 7));
    const sink = spySink();
    const tail = new Tail(file, sink);
    tail.poll();
    expect(sink.lines).toEqual([]);
    fs.appendFileSync(file, full.subarray(7));
    tail.poll();
    expect(sink.lines).toEqual(['{"t":"ไทย"}']);
  });

  it('resets and re-reads from zero when the file is truncated', () => {
    const file = path.join(root, 'trunc.jsonl');
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n');
    const sink = spySink();
    const tail = new Tail(file, sink);
    tail.poll();
    expect(sink.lines).toEqual(['{"n":1}', '{"n":2}']);

    fs.writeFileSync(file, '{"n":9}\n');
    tail.poll();
    expect(sink.resets).toBe(1);
    expect(sink.lines).toEqual(['{"n":9}']);
  });

  it('drops the cut first line of a large file and keeps only the tail', () => {
    const file = path.join(root, 'big.jsonl');
    const pad = 'x'.repeat(1000);
    const count = 22000; // ~22 MB, above the 20 MB first-read threshold
    const fd = fs.openSync(file, 'w');
    const chunk: string[] = [];
    for (let i = 0; i < count; i++) {
      chunk.push(`{"i":${i},"pad":"${pad}"}\n`);
      if (chunk.length === 1000) {
        fs.writeSync(fd, chunk.join(''));
        chunk.length = 0;
      }
    }
    if (chunk.length) fs.writeSync(fd, chunk.join(''));
    fs.closeSync(fd);

    const sink = spySink();
    new Tail(file, sink).poll();
    expect(sink.lines.length).toBeGreaterThan(0);
    expect(sink.lines.length).toBeLessThan(count);
    for (const l of sink.lines) expect(() => JSON.parse(l)).not.toThrow();
    expect(JSON.parse(sink.lines[sink.lines.length - 1]).i).toBe(count - 1);
  });
});

describe('Watcher', () => {
  it('ignores the summarizer folder of CR_DATA_DIR and the main instance home one', () => {
    const prev = process.env.CR_DATA_DIR;
    const other = path.join(root, 'other-data');
    process.env.CR_DATA_DIR = other;
    try {
      const norm = (p: string) => path.resolve(p).toLowerCase();
      const list = defaultIgnoreCwds().map(norm);
      expect(list).toContain(norm(path.join(other, 'summarizer')));
      expect(list).toContain(norm(path.join(os.homedir(), '.claude-control-room', 'summarizer')));

      for (const [i, cwd] of [path.join(os.homedir(), '.claude-control-room', 'summarizer'), path.join(other, 'summarizer'), 'C:\demo'].entries()) {
        const sid = `cccccccc-000${i}-4222-8333-444444444444`;
        fs.writeFileSync(
          path.join(root, 'sessions', `${process.pid + i}.json`),
          JSON.stringify({ pid: process.pid, sessionId: sid, cwd, name: `n${i}`, kind: 'interactive', startedAt: 1700000000000 }),
        );
        fs.writeFileSync(path.join(projectDir(), `${sid}.jsonl`), userLine('hello', '2026-11-23T10:00:00.000Z'));
      }
      const snap = startWatcher().snapshot();
      expect(snap.map((s) => s.name).sort()).toEqual(['n2']);
    } finally {
      if (prev === undefined) delete process.env.CR_DATA_DIR;
      else process.env.CR_DATA_DIR = prev;
    }
  });

  it('lists the live session with its subagent and never exposes key files', () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(path.join(root, 'sessions', `${process.pid}.abcdef.key`), SECRET);
    fs.writeFileSync(
      transcriptPath(),
      userLine('neutral first prompt', '2026-11-23T10:00:00.000Z') +
        assistantLine('neutral reply', '2026-11-23T10:00:05.000Z'),
    );
    const subDir = path.join(projectDir(), ALIVE_SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-x1.jsonl'), assistantLine('sub reply', '2026-11-23T10:00:06.000Z'));
    fs.writeFileSync(
      path.join(subDir, 'agent-x1.meta.json'),
      JSON.stringify({ description: 'neutral sub task', model: 'haiku', finished: false }),
    );

    const w = startWatcher();
    const snap = w.snapshot();
    expect(snap).toHaveLength(1);
    const s = snap[0];
    expect(s.sessionId).toBe(ALIVE_SID);
    expect(s.name).toBe(`name-${process.pid}`);
    expect(s.status).not.toBe('done');
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0].id).toBe('x1');
    expect(s.subagents[0].description).toBe('neutral sub task');
    expect(s.subagents[0].finished).toBe(false);
    expect(JSON.stringify(snap)).not.toContain(SECRET);
  });

  it('agentTimeline keeps the last 60 subagent events with full multi-line text, null for unknown ids', () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(transcriptPath(), userLine('neutral first prompt', '2026-11-23T10:00:00.000Z'));
    const subDir = path.join(projectDir(), ALIVE_SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    const ts = (i: number): string => new Date(Date.parse('2026-11-23T10:00:00.000Z') + i * 1000).toISOString();
    let body = '';
    for (let i = 0; i < 69; i++) body += assistantLine(`step ${i}`, ts(i));
    body += assistantLine('final line one\nfinal line two\n\nfinal line three', ts(69));
    fs.writeFileSync(path.join(subDir, 'agent-x1.jsonl'), body);
    fs.writeFileSync(
      path.join(subDir, 'agent-x1.meta.json'),
      JSON.stringify({ description: 'neutral sub task', model: 'haiku', finished: false }),
    );

    const w = startWatcher();
    const got = w.agentTimeline(ALIVE_SID, 'x1');
    expect(got).not.toBeNull();
    expect(got?.agent).toEqual(w.snapshot()[0].subagents[0]);
    expect(got?.timeline).toHaveLength(60);
    expect(got?.timeline[0].text).toBe('step 10');
    expect(got?.timeline[59]).toEqual({ ts: Date.parse(ts(69)), kind: 'text', text: 'final line one\nfinal line two\n\nfinal line three' });
    expect(w.agentTimeline(ALIVE_SID, 'nope')).toBeNull();
    expect(w.agentTimeline('cccccccc-1111-4222-8333-444444444444', 'x1')).toBeNull();
    // the session payload keeps its own cap (30) and does not grow
    expect(w.snapshot()[0].timeline.length).toBeLessThanOrEqual(30);
  });

  it('emits a session event within 2 s after lines are appended', async () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(transcriptPath(), userLine('first', '2026-11-23T10:00:00.000Z'));
    const w = startWatcher();
    const events: SessionInfo[] = [];
    w.on('session', (s: SessionInfo) => events.push(s));

    fs.appendFileSync(transcriptPath(), assistantLine('later reply', '2026-11-23T10:01:00.000Z'));
    await waitFor(() => events.some((e) => e.sessionId === ALIVE_SID), 2000);
  });

  it('exposes a pending AskUserQuestion as a waitItem and drops it when the tool_result lands', async () => {
    writeSession(process.pid, ALIVE_SID);
    const ts = new Date().toISOString();
    fs.writeFileSync(
      transcriptPath(),
      userLine('go', ts) +
        jsonl({
          type: 'assistant',
          timestamp: ts,
          message: {
            role: 'assistant',
            model: 'claude-haiku-5-5',
            content: [
              {
                type: 'tool_use',
                id: 'tq1',
                name: 'AskUserQuestion',
                input: { questions: [{ question: 'Which?', header: 'h', multiSelect: false, options: [{ label: 'X', description: '' }] }] },
              },
            ],
          },
        }),
    );
    const w = startWatcher();
    const s = w.snapshot()[0];
    expect(s.status).toBe('waiting');
    expect(s.waitItems).toHaveLength(1);
    expect(s.waitItems?.[0]).toMatchObject({ id: 'tq1', kind: 'ask', detail: 'Which?' });

    const events: SessionInfo[] = [];
    w.on('session', (e: SessionInfo) => events.push(e));
    fs.appendFileSync(
      transcriptPath(),
      jsonl({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tq1', content: 'X' }] } }),
    );
    await waitFor(() => events.some((e) => e.sessionId === ALIVE_SID && !e.waitItems), 2000);
  });

  it('marks a session with a dead pid as done', () => {
    writeSession(DEAD_PID, DEAD_SID);
    const w = startWatcher();
    const s = w.snapshot().find((x) => x.sessionId === DEAD_SID);
    expect(s?.status).toBe('done');
  });

  it('ignores session files with bad JSON', () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(path.join(root, 'sessions', '4242.json'), '{not json');
    const w = startWatcher();
    const snap = w.snapshot();
    expect(snap.map((s) => s.sessionId)).toEqual([ALIVE_SID]);
  });

  it('picks up subagent meta that arrives after the jsonl', async () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(transcriptPath(), userLine('first', '2026-11-23T10:00:00.000Z'));
    const subDir = path.join(projectDir(), ALIVE_SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-late.jsonl'), assistantLine('sub', '2026-11-23T10:00:01.000Z'));

    const w = startWatcher();
    expect(w.snapshot()[0].subagents[0].description).toBe('');

    fs.writeFileSync(
      path.join(subDir, 'agent-late.meta.json'),
      JSON.stringify({ description: 'late meta', model: 'haiku', finished: true }),
    );
    await waitFor(() => w.snapshot()[0]?.subagents[0]?.description === 'late meta', 2000);
    expect(w.snapshot()[0].subagents[0].finished).toBe(true);
    expect(w.snapshot()[0].subagents[0].status).toBe('done');
  });

  it('survives a truncated transcript and keeps serving', () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(transcriptPath(), userLine('a long first prompt', '2026-11-23T10:00:00.000Z').repeat(5));
    const w = startWatcher();
    expect(w.snapshot()).toHaveLength(1);
    fs.writeFileSync(transcriptPath(), userLine('short', '2026-11-23T10:02:00.000Z'));
    expect(() => w.snapshot()).not.toThrow();
    expect(w.snapshot()[0].sessionId).toBe(ALIVE_SID);
  });

  it('resolves CR_CLAUDE_DIR for the default data root', () => {
    const prev = process.env.CR_CLAUDE_DIR;
    process.env.CR_CLAUDE_DIR = root;
    try {
      expect(claudeDir()).toBe(root);
    } finally {
      if (prev === undefined) delete process.env.CR_CLAUDE_DIR;
      else process.env.CR_CLAUDE_DIR = prev;
    }
  });
});

describe('server', () => {
  it('originAllowed accepts no origin and loopback origins only', () => {
    expect(originAllowed(undefined)).toBe(true);
    expect(originAllowed('http://127.0.0.1:5173')).toBe(true);
    expect(originAllowed('http://localhost:5173')).toBe(true);
    expect(originAllowed('https://evil.example')).toBe(false);
    expect(originAllowed('not a url')).toBe(false);
  });

  it('serves /health and sends a snapshot over WebSocket without leaking secrets', async () => {
    writeSession(process.pid, ALIVE_SID);
    fs.writeFileSync(path.join(root, 'sessions', `${process.pid}.abcdef.key`), SECRET);
    const w = startWatcher();
    server = await startServer({ watcher: w, port: 0, machine: 'test-host', pingMs: 60_000 });
    const base = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(data.toString()));
      ws.once('error', reject);
    });
    ws.close();
    const msg = JSON.parse(first);
    expect(msg.type).toBe('snapshot');
    expect(msg.machine).toBe('test-host');
    expect(msg.sessions).toHaveLength(1);
    expect(first).not.toContain(SECRET);
  });

  it('refuses a non-loopback Origin during the WebSocket handshake', async () => {
    const w = startWatcher();
    server = await startServer({ watcher: w, port: 0, pingMs: 60_000 });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { headers: { Origin: 'https://evil.example' } });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    ws.terminate();
    expect(outcome).toBe('error');
  });
});

describe('one entry per session id, and ended sessions leave the graph', () => {
  const SID = 'cccccccc-1111-4222-8333-444444444444';
  const put = (pid: number, sid: string, startedAt: number) =>
    fs.writeFileSync(
      path.join(root, 'sessions', `${pid}.json`),
      JSON.stringify({ pid, sessionId: sid, cwd: 'C:\\demo', name: `n${pid}`, kind: 'sdk-cli', startedAt }),
    );

  it('a resumed session (new pid file, old file still there) is listed once, with the live pid', async () => {
    put(111, SID, 1000);
    put(222, SID, 2000);
    watcher = new Watcher({ claudeDir: root, pollMs: 20, isPidAlive: (pid) => pid === 222 });
    const events: SessionInfo[] = [];
    watcher.on('session', (e: SessionInfo) => events.push(e));
    watcher.start();
    await sleep(120);
    const snap = watcher.snapshot().filter((s) => s.sessionId === SID);
    expect(snap).toHaveLength(1);
    expect(snap[0].pid).toBe(222);
    expect(snap[0].status).not.toBe('done');
    expect(events.every((e) => e.pid === 222)).toBe(true);
  });

  it('old pid file gone after a resume: the old entry never shadows the new one and no "removed" is sent', async () => {
    let t = 1_000_000;
    put(111, SID, 1000);
    watcher = new Watcher({ claudeDir: root, pollMs: 20, now: () => t, isPidAlive: (pid) => pid === 222 || pid === 111 });
    const removed: string[] = [];
    watcher.on('removed', (id: string) => removed.push(id));
    watcher.start();
    await sleep(60);
    fs.rmSync(path.join(root, 'sessions', '111.json'));
    put(222, SID, 2000);
    await sleep(80);
    t += 120_000; // past the grace period of the vanished file
    await sleep(80);
    const snap = watcher.snapshot().filter((s) => s.sessionId === SID);
    expect(snap).toHaveLength(1);
    expect(snap[0].pid).toBe(222);
    expect(removed).toEqual([]);
  });

  it('a stale registry file of a killed process is dropped after the grace period, and not re-added', async () => {
    let t = 1_000_000;
    put(DEAD_PID, DEAD_SID, 1000);
    put(process.pid, ALIVE_SID, 1000);
    watcher = new Watcher({ claudeDir: root, pollMs: 20, now: () => t });
    const removed: string[] = [];
    watcher.on('removed', (id: string) => removed.push(id));
    watcher.start();
    await sleep(80);
    expect(watcher.snapshot().find((s) => s.sessionId === DEAD_SID)?.status).toBe('done');
    t += 61_000;
    await sleep(120);
    expect(watcher.snapshot().map((s) => s.sessionId)).toEqual([ALIVE_SID]);
    expect(removed).toEqual([DEAD_SID]);
  });

  it('keepAlive protects a session whose pid is not alive (still held by the Runner)', async () => {
    let t = 1_000_000;
    put(DEAD_PID, DEAD_SID, 1000);
    watcher = new Watcher({ claudeDir: root, pollMs: 20, now: () => t, keepAlive: (id) => id === DEAD_SID });
    watcher.start();
    await sleep(60);
    t += 300_000;
    await sleep(80);
    expect(watcher.snapshot().map((s) => s.sessionId)).toEqual([DEAD_SID]);
  });

  it('forget() drops the session at once, emits "removed" once, and its registry file is not re-added on the next scan', async () => {
    put(process.pid, ALIVE_SID, 1000);
    watcher = new Watcher({ claudeDir: root, pollMs: 20 });
    const removed: string[] = [];
    watcher.on('removed', (id: string) => removed.push(id));
    watcher.start();
    await sleep(80);
    expect(watcher.snapshot().map((s) => s.sessionId)).toEqual([ALIVE_SID]);
    watcher.forget(ALIVE_SID);
    watcher.forget(ALIVE_SID); // nothing left to drop: no second event
    expect(watcher.snapshot()).toEqual([]);
    await sleep(120); // several polls with the file still on disk
    expect(watcher.snapshot()).toEqual([]);
    expect(removed).toEqual([ALIVE_SID]);
  });
});
