import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SlashCommand } from '../../shared/protocol';
import { Runner, RunnerSession, type ChildLike } from '../src/runner';
import { SlashCommandApi, trimCommands } from '../src/slashCommands';

class Fake extends EventEmitter implements ChildLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1;
  kills = 0;
  written: Record<string, any>[] = [];
  constructor(private readonly answer?: (req: Record<string, any>) => Record<string, unknown> | null) {
    super();
    this.stdin.on('data', (d: Buffer) => {
      for (const l of d.toString().split('\n').filter(Boolean)) {
        const w = JSON.parse(l);
        this.written.push(w);
        const a = this.answer?.(w);
        if (a) this.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: w.request_id, response: a } })}\n`);
      }
    });
  }
  kill(): boolean {
    this.kills += 1;
    return true;
  }
}

const cmd = (name: string): SlashCommand => ({ name, description: '', argumentHint: '', builtin: false });
const initAnswer = (w: Record<string, any>) => (w.request?.subtype === 'initialize' ? { commands: [{ name: 'compact', description: 'd', argumentHint: '', builtin: true }] } : null);

describe('trimCommands', () => {
  it('clips descriptions, flattens whitespace, keeps hints/builtin, drops junk and duplicates', () => {
    const out = trimCommands([
      { name: 'compact', description: 'a\n\nb', argumentHint: '[x]', builtin: true },
      { name: 'long', description: 'x'.repeat(500) },
      { name: 'compact' },
      { name: 'bad name' },
      { description: 'no name' },
      null,
    ]);
    expect(out.map((c) => c.name)).toEqual(['compact', 'long']);
    expect(out[0]).toEqual({ name: 'compact', description: 'a b', argumentHint: '[x]', builtin: true });
    expect(out[1].description.length).toBe(160);
    expect(out[1].builtin).toBe(false);
    expect(trimCommands('nope')).toEqual([]);
  });
});

describe('RunnerSession.loadCommands', () => {
  it('sends initialize and stores the trimmed list (not in state)', async () => {
    const child = new Fake(initAnswer);
    const session = new RunnerSession({ sessionId: 's', cwd: 'C:\\x', child, model: 'haiku', effort: 'low' });
    const list = await session.loadCommands();
    expect(child.written[0].request).toEqual({ subtype: 'initialize' });
    expect(list.map((c) => c.name)).toEqual(['compact']);
    expect(session.commandList()).toEqual(list);
    expect(JSON.stringify(session.state())).not.toContain('compact');
  });
});

describe('Runner slash commands', () => {
  it('asks every launched child for initialize and remembers the last answered list', async () => {
    const kids: Fake[] = [];
    const runner = new Runner({
      allowedCwds: () => [os.tmpdir()],
      spawn: () => {
        const f = new Fake(initAnswer);
        kids.push(f);
        return f;
      },
    });
    const id = runner.start({ cwd: os.tmpdir(), model: 'haiku', effort: 'low', prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 50));
    expect(kids[0].written.filter((w) => w.request?.subtype === 'initialize')).toHaveLength(1);
    expect(runner.commandsFor(id)?.map((c) => c.name)).toEqual(['compact']);
    expect(runner.lastCommands()?.map((c) => c.name)).toEqual(['compact']);
    expect(runner.commandsFor('nope')).toBeNull();
    runner.shutdown();
  });
});

describe('SlashCommandApi.list', () => {
  const mk = (runner: { own?: SlashCommand[] | null; last?: SlashCommand[] | null }, spawn?: () => ChildLike, probeTimeoutMs = 50) =>
    new SlashCommandApi({
      runner: { commandsFor: () => runner.own ?? null, lastCommands: () => runner.last ?? null },
      spawn: spawn as never,
      probeTimeoutMs,
      originAllowed: () => true,
    });

  it('prefers the session list, then the last known list, then a probe', async () => {
    let spawns = 0;
    const spawn = () => {
      spawns += 1;
      return new Fake(() => ({ commands: [{ name: 'probed' }] }));
    };
    expect((await mk({ own: [cmd('own')], last: [cmd('last')] }, spawn).list('s')).map((c) => c.name)).toEqual(['own']);
    expect((await mk({ last: [cmd('last')] }, spawn).list('s')).map((c) => c.name)).toEqual(['last']);
    expect(spawns).toBe(0);
    expect((await mk({}, spawn).list(null)).map((c) => c.name)).toEqual(['probed']);
    expect(spawns).toBe(1);
  });

  it('probe: concurrent requests share one child, it is killed, result cached; never sends a user message', async () => {
    const kids: Fake[] = [];
    const api = mk({}, () => {
      const f = new Fake(() => ({ commands: [{ name: 'x' }] }));
      kids.push(f);
      return f;
    });
    const [a, b] = await Promise.all([api.list(null), api.list(null)]);
    expect(a).toEqual(b);
    expect(kids).toHaveLength(1);
    expect(kids[0].kills).toBe(1);
    expect(kids[0].written.every((w) => w.type === 'control_request')).toBe(true);
    await api.list(null);
    expect(kids).toHaveLength(1);
  });

  it('probe kills the child on timeout and answers empty (not cached)', async () => {
    const kids: Fake[] = [];
    const api = mk(
      {},
      () => {
        const f = new Fake();
        kids.push(f);
        return f;
      },
      30,
    );
    expect(await api.list(null)).toEqual([]);
    expect(kids[0].kills).toBe(1);
    await api.list(null);
    expect(kids).toHaveLength(2);
  });
});
