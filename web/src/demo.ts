import type { SessionInfo } from '../../shared/protocol';
import { t } from './i18n';

// Built-in sample for ?demo=1 (no server needed). Two sessions; the first has two subagents.
export const DEMO_MACHINE = 'demo-pc';

function baseSessions(now: number): SessionInfo[] {
  const m = 60_000;
  return [
    {
      sessionId: 'demo-portfolio',
      pid: 1001,
      name: 'portfolio',
      cwd: 'C:\\Users\\you\\portfolio',
      kind: 'interactive',
      title: t('panels.demo.portfolioTitle'),
      model: 'opus',
      effort: 'high',
      status: 'waiting',
      thought: t('panels.demo.portfolioThought'),
      startedAt: now - 42 * m,
      lastActivity: now - 20_000,
      timeline: [
        { ts: now - 9 * m, kind: 'user', text: t('panels.demo.portfolioUser') },
        { ts: now - 6 * m, kind: 'tool', text: 'Read: src/App.tsx' },
        { ts: now - 1 * m, kind: 'text', text: t('panels.demo.portfolioQuestion') },
      ],
      subagents: [],
    },
    {
      sessionId: 'demo-pchands',
      pid: 1002,
      name: 'pc-hands',
      cwd: 'C:\\Users\\you\\pc-hands',
      kind: 'interactive',
      title: t('panels.demo.pcHandsTitle'),
      model: 'sonnet',
      effort: 'medium',
      status: 'running',
      thought: t('panels.demo.pcHandsThought'),
      startedAt: now - 15 * m,
      lastActivity: now - 4_000,
      timeline: [
        { ts: now - 8 * m, kind: 'user', text: t('panels.demo.pcHandsUser') },
        { ts: now - 5 * m, kind: 'tool', text: 'Bash: npm run bench' },
        { ts: now - 2 * m, kind: 'text', text: t('panels.demo.pcHandsText') },
      ],
      subagents: [
        {
          id: 'a1',
          description: t('panels.demo.benchApi'),
          model: 'sonnet',
          effort: 'medium',
          status: 'running',
          thought: t('panels.demo.benchApiThought'),
          finished: false,
          lastActivity: now - 3_000,
        },
        {
          id: 'a2',
          description: t('panels.demo.lint'),
          model: 'haiku',
          effort: null,
          status: 'done',
          thought: t('panels.demo.lintThought'),
          finished: true,
          lastActivity: now - 2 * m,
        },
      ],
    },
  ];
}

const MODELS = ['opus', 'sonnet', 'haiku', 'qwen'];

/** A session with many subagents, to show the "+N" circle and a longer timeline with a failed tool call. */
function busySession(now: number): SessionInfo {
  const m = 60_000;
  const names = [
    t('panels.demo.busy1'), t('panels.demo.busy2'), t('panels.demo.busy3'), t('panels.demo.busy4'), t('panels.demo.busy5'), t('panels.demo.busy6'),
    t('panels.demo.busy7'), t('panels.demo.busy8'), t('panels.demo.busy9'), t('panels.demo.busy10'), t('panels.demo.busy11'),
  ];
  const agents = names.map((description, i) => ({
    id: `b${i}`,
    description,
    model: MODELS[i % MODELS.length],
    effort: i % 2 ? 'medium' : null,
    status: (i < 3 ? 'running' : 'done') as 'running' | 'done',
    thought: i < 3 ? t('panels.demo.working') : t('panels.demo.done'),
    finished: i >= 3,
    lastActivity: now - (i < 3 ? 2_000 + i * 1000 : (i - 2) * m),
  }));
  return {
    sessionId: 'demo-shop',
    pid: 1003,
    name: 'webshop',
    cwd: 'C:\\Users\\you\\webshop',
    kind: 'interactive',
    title: t('panels.demo.shopTitle'),
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    status: 'running',
    thought: t('panels.demo.shopThought'),
    startedAt: now - 70 * m,
    lastActivity: now - 1_500,
    timeline: [
      { ts: now - 14 * m, kind: 'user', text: t('panels.demo.shopUser') },
      { ts: now - 13 * m, kind: 'text', text: t('panels.demo.shopText1') },
      { ts: now - 12 * m, kind: 'tool', text: 'Read: src/cart/discount.ts' },
      { ts: now - 11 * m, kind: 'tool', text: 'Grep: applyDiscount' },
      { ts: now - 10 * m, kind: 'tool', text: 'Bash: npm test -- cart' },
      { ts: now - 10 * m, kind: 'error', text: 'exit code 1: 2 failed, 14 passed (cart/discount.test.ts)' },
      { ts: now - 8 * m, kind: 'text', text: t('panels.demo.shopText2') },
      { ts: now - 7 * m, kind: 'tool', text: 'Edit: src/cart/discount.ts' },
      { ts: now - 5 * m, kind: 'tool', text: 'Bash: npm test -- cart' },
      { ts: now - 3 * m, kind: 'text', text: t('panels.demo.shopSummary') },
    ],
    subagents: agents,
  };
}

/** `?demo=1`: three sessions. `?demo=1&big=1`: 15 sessions x 8 subagents (stress test for the canvas). */
export function demoSessions(now: number): SessionInfo[] {
  const base = [...baseSessions(now), busySession(now)];
  let big = false;
  try {
    big = new URLSearchParams(window.location.search).get('big') === '1';
  } catch {
    /* not in a browser */
  }
  if (!big) return base;
  return Array.from({ length: 15 }, (_, i) => {
    const s = base[i % base.length];
    const subs = Array.from({ length: 8 }, (_, j) => ({
      id: `${i}-${j}`,
      description: t('panels.demo.bigSub', { i: i + 1, j: j + 1 }),
      model: MODELS[j % MODELS.length],
      effort: null,
      status: (j % 3 === 0 ? 'running' : 'done') as 'running' | 'done',
      thought: t('panels.demo.bigThought'),
      finished: j % 3 !== 0,
      lastActivity: now - j * 20_000,
    }));
    return { ...s, sessionId: `${s.sessionId}-${i}`, name: `${s.name}-${i + 1}`, subagents: subs };
  });
}
