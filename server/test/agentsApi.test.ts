import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentInfo, TimelineEvent } from '../../shared/protocol';
import { AgentsApi, type AgentTimelineSource } from '../src/agentsApi';

const SID = 'aaaaaaaa-1111-4222-8333-444444444444';
const AGENT: AgentInfo = {
  id: 'x1',
  description: 'neutral sub task',
  model: 'claude-haiku-5-5',
  effort: null,
  status: 'idle',
  thought: '',
  finished: false,
  lastActivity: 1700000000000,
};
const TIMELINE: TimelineEvent[] = [{ ts: 1700000000000, kind: 'text', text: 'line one\nline two' }];

const seen: { sessionId: string; agentId: string }[] = [];
const stub: AgentTimelineSource = {
  agentTimeline(sessionId, agentId) {
    seen.push({ sessionId, agentId });
    return sessionId === SID && agentId === 'x1' ? { agent: AGENT, timeline: TIMELINE } : null;
  },
};

const api = new AgentsApi({
  watcher: stub,
  originAllowed: (o) => o === undefined || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o),
});

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!api.handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface Resp {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function call(method: string, p: string, headers: Record<string, string> = {}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const LOOPBACK = 'http://127.0.0.1:5173';

describe('AgentsApi', () => {
  it('200 with the agent and its timeline, no-store and CORS for a loopback origin', async () => {
    seen.length = 0;
    const r = await call('GET', `/api/agents/${SID}/x1/timeline`, { Origin: LOOPBACK });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, agent: AGENT, timeline: TIMELINE });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['access-control-allow-origin']).toBe(LOOPBACK);
    expect(seen).toEqual([{ sessionId: SID, agentId: 'x1' }]);
  });

  it('404 for an unknown session or agent', async () => {
    const r = await call('GET', '/api/agents/bbbbbbbb-1111-4222-8333-444444444444/x1/timeline');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'not found' });
    const r2 = await call('GET', `/api/agents/${SID}/nope/timeline`);
    expect(r2.status).toBe(404);
  });

  it('404 for ids that do not match the strict patterns, without a lookup', async () => {
    seen.length = 0;
    const bad = [
      `/api/agents/..%2F..%2Fsecret/x1/timeline`,
      `/api/agents/${SID}/..%2F..%2Fx/timeline`,
      `/api/agents/${SID}/${'a'.repeat(81)}/timeline`,
      `/api/agents/ABCDEF12-1111/x1/timeline`,
      `/api/agents/short/x1/timeline`,
      `/api/agents/${SID}/x1/timeline/extra`,
    ];
    for (const p of bad) {
      const r = await call('GET', p);
      expect(r.status, p).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it('403 for a foreign origin', async () => {
    const r = await call('GET', `/api/agents/${SID}/x1/timeline`, { Origin: 'http://evil.example' });
    expect(r.status).toBe(403);
  });

  it('405 for POST, with Allow header', async () => {
    const r = await call('POST', `/api/agents/${SID}/x1/timeline`);
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET, HEAD');
  });

  it('answers the OPTIONS preflight for a loopback origin', async () => {
    const r = await call('OPTIONS', `/api/agents/${SID}/x1/timeline`, { Origin: LOOPBACK });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(LOOPBACK);
  });

  it('leaves other paths to the next handler', async () => {
    const r = await call('GET', '/api/gallery');
    expect(r.status).toBe(404);
  });
});
