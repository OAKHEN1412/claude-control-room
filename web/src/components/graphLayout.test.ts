import { describe, it, expect } from 'vitest';
import {
  layoutGraph,
  elbowPath,
  isRecentAgent,
  shortModel,
  badgeText,
  machineState,
  NODE_H,
  ROW_H,
  RECENT_MS,
  MIN_SUB_W,
  type LayoutSession,
  type LayoutAgent,
} from './graphLayout';

const NOW = 1_000_000_000_000;
const MIN = 60_000;

const subs = (sid: string, n: number, lastActivity = NOW): LayoutAgent[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${sid}-a${i}`, status: 'done', finished: true, lastActivity }));

const sample: LayoutSession[] = [
  { sessionId: 's1', subagents: subs('s1', 3) },
  { sessionId: 's2', subagents: [] },
  { sessionId: 's3', subagents: subs('s3', 2) },
];
const opts = { width: 800, minHeight: 300, now: NOW };

describe('layoutGraph', () => {
  it('is deterministic for the same input', () => {
    expect(layoutGraph(sample, opts)).toEqual(layoutGraph(sample, opts));
  });

  it('returns an empty layout with no sessions', () => {
    const l = layoutGraph([], opts);
    expect(l.empty).toBe(true);
    expect(l.nodes).toHaveLength(0);
    expect(l.edges).toHaveLength(0);
    expect(l.machine.w).toBeGreaterThan(0);
  });

  it('gives every node the same fixed height of at least 40 px', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ sessionId: `m${i}`, subagents: subs(`m${i}`, 3) }));
    for (const input of [sample, many]) {
      const l = layoutGraph(input, opts);
      for (const n of l.nodes) expect(n.h).toBe(NODE_H);
    }
    expect(NODE_H).toBeGreaterThanOrEqual(40);
  });

  it('grows the stage instead of shrinking nodes when there are many rows', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ sessionId: `m${i}`, subagents: [] }));
    const l = layoutGraph(many, opts);
    expect(l.height).toBeGreaterThanOrEqual(30 * ROW_H);
    for (const n of l.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y + n.h).toBeLessThanOrEqual(l.height);
      expect(n.x + n.w).toBeLessThanOrEqual(l.width);
    }
  });

  it('is at least minHeight tall so a small graph is centred', () => {
    expect(layoutGraph(sample, opts).height).toBeGreaterThanOrEqual(300);
  });

  it('does not overlap rows within a column', () => {
    const l = layoutGraph(sample, opts);
    for (const kind of ['session', 'subagent'] as const) {
      const col = l.nodes.filter((n) => n.kind === kind).sort((a, b) => a.y - b.y);
      for (let i = 1; i < col.length; i++) {
        expect(col[i - 1].y + col[i - 1].h).toBeLessThanOrEqual(col[i].y);
      }
    }
  });

  it('places every subagent to the right of its session', () => {
    const l = layoutGraph(sample, opts);
    const sessX = new Map(l.nodes.filter((n) => n.kind === 'session').map((n) => [n.sessionId, n.x + n.w]));
    const subNodes = l.nodes.filter((n) => n.kind === 'subagent');
    expect(subNodes.length).toBe(5);
    for (const n of subNodes) expect(n.x).toBeGreaterThan(sessX.get(n.sessionId)!);
  });

  it('gives one edge per session plus one per subagent', () => {
    const l = layoutGraph(sample, opts);
    expect(l.edges.filter((e) => e.kind === 'session')).toHaveLength(3);
    expect(l.edges.filter((e) => e.kind === 'subagent')).toHaveLength(5);
  });

  it('ends every connector at the vertical centre of its node', () => {
    const l = layoutGraph(sample, opts);
    const byKey = new Map(l.nodes.map((n) => [n.key, n]));
    for (const e of l.edges) {
      const nodeKey = e.key.startsWith('m:') ? `s:${e.key.slice(2)}` : e.key.startsWith('e:') && e.key.endsWith(':more')
        ? `more:${e.sessionId}` : `a:${e.key.slice(2)}`;
      const n = byKey.get(nodeKey)!;
      const endY = Number(/V ([\d.-]+) H/.exec(e.path)![1]);
      expect(endY).toBeCloseTo(n.y + n.h / 2, 1);
    }
  });
});

describe('subagent collapsing', () => {
  const old = NOW - (RECENT_MS + MIN);
  const mixed: LayoutSession = {
    sessionId: 'x',
    subagents: [
      { id: 'run', status: 'running', finished: false, lastActivity: old }, // running stays even if quiet
      { id: 'fresh', status: 'done', finished: true, lastActivity: NOW - 2 * MIN },
      { id: 'o1', status: 'done', finished: true, lastActivity: old },
      { id: 'o2', status: 'done', finished: true, lastActivity: old },
      { id: 'o3', status: 'done', finished: true, lastActivity: old },
    ],
  };

  it('treats running/waiting and recent agents as visible', () => {
    expect(isRecentAgent({ id: 'a', status: 'running', lastActivity: old }, NOW)).toBe(true);
    expect(isRecentAgent({ id: 'a', status: 'waiting', lastActivity: old }, NOW)).toBe(true);
    expect(isRecentAgent({ id: 'a', status: 'done', lastActivity: NOW - 9 * MIN }, NOW)).toBe(true);
    expect(isRecentAgent({ id: 'a', status: 'done', lastActivity: old }, NOW)).toBe(false);
  });

  it('folds agents finished more than 10 minutes ago into one collapsed node', () => {
    const l = layoutGraph([mixed], opts);
    expect(l.nodes.filter((n) => n.kind === 'subagent').map((n) => n.agentId)).toEqual(['run', 'fresh']);
    const c = l.nodes.filter((n) => n.kind === 'collapsed');
    expect(c).toHaveLength(1);
    expect(c[0].count).toBe(3);
    expect(c[0].expanded).toBe(false);
    expect(l.edges.filter((e) => e.kind === 'subagent')).toHaveLength(3);
  });

  it('shows every agent, plus a collapse node, once the session is expanded', () => {
    const l = layoutGraph([mixed], { ...opts, expanded: new Set(['x']) });
    expect(l.nodes.filter((n) => n.kind === 'subagent')).toHaveLength(5);
    const c = l.nodes.filter((n) => n.kind === 'collapsed');
    expect(c).toHaveLength(1);
    expect(c[0].expanded).toBe(true);
  });

  it('adds no collapsed node when nothing is old', () => {
    const l = layoutGraph([{ sessionId: 'y', subagents: subs('y', 4) }], opts);
    expect(l.nodes.filter((n) => n.kind === 'collapsed')).toHaveLength(0);
    expect(l.nodes.filter((n) => n.kind === 'subagent')).toHaveLength(4);
  });

  it('keeps a session with only old agents to its node plus one collapsed node', () => {
    const l = layoutGraph([{ sessionId: 'z', subagents: subs('z', 12, old) }], opts);
    expect(l.nodes.map((n) => n.kind)).toEqual(['session', 'collapsed']);
    expect(l.nodes[1].count).toBe(12);
  });
});

describe('elbowPath', () => {
  it('formats a horizontal-vertical-horizontal path', () => {
    expect(elbowPath({ x: 130, y: 300 }, { x: 180, y: 200 })).toBe('M 130 300 H 155 V 200 H 180');
    expect(elbowPath({ x: 0, y: 0 }, { x: 10, y: 10 })).toMatch(
      /^M [\d.-]+ [\d.-]+ H [\d.-]+ V [\d.-]+ H [\d.-]+$/,
    );
  });
});

describe('labels', () => {
  it('shortens model ids', () => {
    expect(shortModel('claude-opus-5-5')).toBe('opus 5.5');
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5');
    expect(shortModel('claude-haiku-5-5')).toBe('haiku 5.5');
    expect(shortModel(null)).toBeNull();
  });

  it('builds the badge with a dash for unknown parts', () => {
    expect(badgeText('claude-opus-5-5', 'high')).toBe('opus 5.5 · high');
    expect(badgeText(null, null)).toBe('—');
    expect(badgeText(null, 'low')).toBe('— · low');
  });

  it('picks the machine character state by priority', () => {
    expect(machineState([{ status: 'idle' }, { status: 'running' }, { status: 'waiting' }])).toBe('working');
    expect(machineState([{ status: 'waiting' }, { status: 'idle' }])).toBe('asking');
    expect(machineState([{ status: 'done' }])).toBe('idle');
    expect(machineState([])).toBe('idle');
  });
});

describe('subagent width', () => {
  it('stays inside the stage and never below MIN_SUB_W; stage widens when narrow', () => {
    for (const width of [300, 420, 600, 900, 1400]) {
      const l = layoutGraph(sample, { width, minHeight: 300, now: NOW });
      for (const n of l.nodes.filter((x) => x.kind === 'subagent')) {
        expect(n.w).toBeGreaterThanOrEqual(MIN_SUB_W);
        expect(n.x + n.w).toBeLessThanOrEqual(l.width);
      }
      expect(l.width).toBeGreaterThanOrEqual(Math.min(width, 1e9) >= 360 ? width : 360);
    }
    expect(layoutGraph(sample, { width: 1400, now: NOW }).width).toBe(1400);
  });
});
