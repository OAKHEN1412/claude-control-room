// A subagent's own timeline, polled from the server: GET /api/agents/<sessionId>/<agentId>/timeline.
import { useEffect, useRef, useState } from 'react';
import type { AgentInfo, TimelineEvent } from '../../shared/protocol';
import { apiBase } from './useServer';

export const AGENT_POLL_MS = 1500;

export interface AgentTimeline {
  agent: AgentInfo;
  timeline: TimelineEvent[];
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function agentTimelineUrl(base: string, sessionId: string, agentId: string): string {
  return `${base}/api/agents/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}/timeline`;
}

/** Fetches one agent timeline. Returns null for an unknown agent (404) or a reply of the wrong shape; throws on network failure. */
export async function fetchAgentTimeline(
  base: string,
  sessionId: string,
  agentId: string,
  fetchFn: FetchLike = (u) => fetch(u),
): Promise<AgentTimeline | null> {
  const res = await fetchFn(agentTimelineUrl(base, sessionId, agentId));
  if (!res.ok) return null;
  const body = (await res.json()) as { ok?: unknown; agent?: unknown; timeline?: unknown } | null;
  if (!body || body.ok !== true || !body.agent || typeof body.agent !== 'object' || !Array.isArray(body.timeline)) return null;
  return { agent: body.agent as AgentInfo, timeline: body.timeline as TimelineEvent[] };
}

export interface PollState {
  enabled: boolean; // the pane is on screen, not compact, and shows an agent
  tabVisible: boolean;
  finished: boolean;
  /** When the agent last did anything (ms); only meaningful once finished. */
  finishedAt: number | null;
  /** When the last successful fetch started (ms), or null when never fetched. */
  lastFetchAt: number | null;
}

/** Whether to fetch now. A finished agent is fetched once more after it finished, then left alone. */
export function shouldPoll(s: PollState): boolean {
  if (!s.enabled || !s.tabVisible) return false;
  if (s.lastFetchAt === null) return true;
  if (!s.finished) return true;
  return s.finishedAt !== null && s.lastFetchAt < s.finishedAt;
}

export interface AgentTimelineState {
  data: AgentTimeline | null;
  /** True after a failed or empty reply and no data to show. */
  failed: boolean;
  loading: boolean;
}

/** Polls while `enabled` and the browser tab is visible. `finishedAt` is the agent's last activity once it is done. */
export function useAgentTimeline(
  sessionId: string | null,
  agentId: string | null,
  enabled: boolean,
  finished = false,
  finishedAt: number | null = null,
): AgentTimelineState {
  const [state, setState] = useState<AgentTimelineState>({ data: null, failed: false, loading: false });
  const lastFetch = useRef<number | null>(null);
  const flags = useRef({ finished, finishedAt });
  flags.current = { finished, finishedAt };
  const key = sessionId && agentId ? `${sessionId}/${agentId}` : null;

  // A different agent starts from scratch.
  useEffect(() => {
    lastFetch.current = null;
    setState({ data: null, failed: false, loading: key !== null });
  }, [key]);

  useEffect(() => {
    if (!key || !sessionId || !agentId) return;
    let stopped = false;
    let inflight = false;
    const base = apiBase();

    const tick = async () => {
      if (stopped || inflight) return;
      const now = Date.now();
      const f = flags.current;
      if (!shouldPoll({ enabled, tabVisible: document.visibilityState !== 'hidden', finished: f.finished, finishedAt: f.finishedAt, lastFetchAt: lastFetch.current })) return;
      inflight = true;
      try {
        const data = await fetchAgentTimeline(base, sessionId, agentId);
        if (stopped) return;
        lastFetch.current = now;
        setState((cur) => (data ? { data, failed: false, loading: false } : { data: cur.data, failed: cur.data === null, loading: false }));
      } catch {
        if (!stopped) setState((cur) => ({ data: cur.data, failed: cur.data === null, loading: false }));
      } finally {
        inflight = false;
      }
    };

    void tick();
    const t = setInterval(() => void tick(), AGENT_POLL_MS);
    const onVis = () => void tick();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      stopped = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [key, sessionId, agentId, enabled]);

  return state;
}
