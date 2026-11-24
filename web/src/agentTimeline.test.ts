import { describe, expect, it } from 'vitest';
import { agentTimelineUrl, fetchAgentTimeline, shouldPoll, type FetchLike } from './agentTimeline';

const agent = { id: 'a1', description: 'ตรวจ lint', model: 'haiku', effort: null, status: 'running', thought: 't', finished: false, lastActivity: 1 };

const reply = (status: number, body: unknown): FetchLike => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('fetchAgentTimeline', () => {
  it('builds the url with encoded ids', () => {
    expect(agentTimelineUrl('http://x:1', 'a/b', 'c d')).toBe('http://x:1/api/agents/a%2Fb/c%20d/timeline');
  });

  it('asks the right url and returns agent + timeline', async () => {
    const seen: string[] = [];
    const f: FetchLike = async (u) => {
      seen.push(u);
      return { ok: true, status: 200, json: async () => ({ ok: true, agent, timeline: [{ ts: 1, kind: 'tool', text: 'Read: a' }] }) };
    };
    const r = await fetchAgentTimeline('http://h', 's1', 'a1', f);
    expect(seen).toEqual(['http://h/api/agents/s1/a1/timeline']);
    expect(r?.agent.id).toBe('a1');
    expect(r?.timeline).toHaveLength(1);
  });

  it('returns null for 404 and for a reply of the wrong shape', async () => {
    expect(await fetchAgentTimeline('', 's', 'a', reply(404, { ok: false }))).toBeNull();
    expect(await fetchAgentTimeline('', 's', 'a', reply(200, { ok: true, agent }))).toBeNull();
    expect(await fetchAgentTimeline('', 's', 'a', reply(200, null))).toBeNull();
    expect(await fetchAgentTimeline('', 's', 'a', reply(200, { ok: false, agent, timeline: [] }))).toBeNull();
  });

  it('lets a network failure through for the hook to handle', async () => {
    const f: FetchLike = async () => {
      throw new Error('offline');
    };
    await expect(fetchAgentTimeline('', 's', 'a', f)).rejects.toThrow('offline');
  });
});

describe('shouldPoll', () => {
  const on = { enabled: true, tabVisible: true, finished: false, finishedAt: null, lastFetchAt: null };

  it('polls a running agent while the pane is shown and the tab is visible', () => {
    expect(shouldPoll(on)).toBe(true);
    expect(shouldPoll({ ...on, lastFetchAt: 5 })).toBe(true);
  });

  it('stops when the pane is off-screen, compact or the tab is hidden', () => {
    expect(shouldPoll({ ...on, enabled: false })).toBe(false);
    expect(shouldPoll({ ...on, tabVisible: false })).toBe(false);
  });

  it('fetches a finished agent once, then leaves it alone', () => {
    const fin = { ...on, finished: true, finishedAt: 1000 };
    expect(shouldPoll(fin)).toBe(true); // never fetched
    expect(shouldPoll({ ...fin, lastFetchAt: 500 })).toBe(true); // fetched before it finished
    expect(shouldPoll({ ...fin, lastFetchAt: 1000 })).toBe(false);
    expect(shouldPoll({ ...fin, lastFetchAt: 2000 })).toBe(false);
    expect(shouldPoll({ ...fin, finishedAt: null, lastFetchAt: 2000 })).toBe(false);
  });
});
