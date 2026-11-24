// Subagent timeline API: GET /api/agents/<sessionId>/<agentId>/timeline.
// The ids are checked against strict patterns before any lookup, and the answer comes only from the
// watcher's in-memory readers, so no file path is ever built from the request.
import type http from 'node:http';
import type { AgentInfo, TimelineEvent } from '../../shared/protocol';

const PREFIX = '/api/agents/';
const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const TIMELINE_RE = /^\/api\/agents\/([^/]+)\/([^/]+)\/timeline$/;

export interface AgentTimelineSource {
  agentTimeline(sessionId: string, agentId: string): { agent: AgentInfo; timeline: TimelineEvent[] } | null;
}

export interface AgentsApiDeps {
  watcher: AgentTimelineSource;
  originAllowed: (origin: string | undefined) => boolean;
}

export class AgentsApi {
  constructor(private readonly deps: AgentsApiDeps) {}

  /** Returns true when the request was a /api/agents route (handled). */
  handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith(PREFIX)) return false;
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!this.deps.originAllowed(origin)) {
      res.writeHead(403);
      res.end();
      return true;
    }
    const cors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...cors, Allow: 'GET, HEAD' });
      res.end();
      return true;
    }
    try {
      this.timeline(req, res, url.pathname, cors);
    } catch {
      if (!res.headersSent) this.json(req, res, 500, { ok: false, error: 'server error' }, cors);
      else res.destroy();
    }
    return true;
  }

  private timeline(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, cors: Record<string, string>): void {
    const m = TIMELINE_RE.exec(pathname);
    const sessionId = m?.[1] ?? '';
    const agentId = m?.[2] ?? '';
    if (!m || !SESSION_ID_RE.test(sessionId) || !AGENT_ID_RE.test(agentId)) {
      this.json(req, res, 404, { ok: false, error: 'not found' }, cors);
      return;
    }
    const found = this.deps.watcher.agentTimeline(sessionId, agentId);
    if (!found) {
      this.json(req, res, 404, { ok: false, error: 'not found' }, cors);
      return;
    }
    this.json(req, res, 200, { ok: true, agent: found.agent, timeline: found.timeline }, cors);
  }

  private json(req: http.IncomingMessage, res: http.ServerResponse, code: number, body: unknown, cors: Record<string, string>): void {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  }
}
