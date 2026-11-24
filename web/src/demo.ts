import type { SessionInfo } from '../../shared/protocol';

// Built-in sample for ?demo=1 (no server needed). Two sessions; the first has two subagents.
export const DEMO_MACHINE = 'demo-pc';

function baseSessions(now: number): SessionInfo[] {
  const m = 60_000;
  return [
    {
      sessionId: 'demo-portfolio',
      pid: 1001,
      name: 'portfolio',
      cwd: 'C:\\Users\\Demo\\portfolio',
      kind: 'interactive',
      title: 'ปรับหน้า portfolio',
      model: 'opus',
      effort: 'high',
      status: 'waiting',
      thought: 'รอคำตอบก่อนทำต่อ',
      startedAt: now - 42 * m,
      lastActivity: now - 20_000,
      timeline: [
        { ts: now - 9 * m, kind: 'user', text: 'ปรับหน้า portfolio ให้โหลดเร็วขึ้น' },
        { ts: now - 6 * m, kind: 'tool', text: 'Read: src/App.tsx' },
        { ts: now - 1 * m, kind: 'text', text: 'เลือกได้ 2 แนวทาง ต้องการแบบไหน?' },
      ],
      subagents: [],
    },
    {
      sessionId: 'demo-pchands',
      pid: 1002,
      name: 'pc-hands',
      cwd: 'C:\\Users\\Demo\\pc-hands',
      kind: 'interactive',
      title: 'วัดผล pc-hands เทียบของเดิม',
      model: 'sonnet',
      effort: 'medium',
      status: 'running',
      thought: 'กำลังเทียบผลการวัดกับเวอร์ชันเดิม',
      startedAt: now - 15 * m,
      lastActivity: now - 4_000,
      timeline: [
        { ts: now - 8 * m, kind: 'user', text: 'วัดผลเทียบกับของเดิม' },
        { ts: now - 5 * m, kind: 'tool', text: 'Bash: npm run bench' },
        { ts: now - 2 * m, kind: 'text', text: 'ได้ตัวเลขแล้ว กำลังสรุป' },
      ],
      subagents: [
        {
          id: 'a1',
          description: 'สำรวจ API ของ benchmark',
          model: 'sonnet',
          effort: 'medium',
          status: 'running',
          thought: 'อ่าน bench/ และรายงานผล',
          finished: false,
          lastActivity: now - 3_000,
        },
        {
          id: 'a2',
          description: 'ตรวจ lint',
          model: 'haiku',
          effort: null,
          status: 'done',
          thought: 'lint ผ่าน 0 error',
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
  const names = ['แก้ bug ช่องค้นหา', 'เขียน test ตะกร้า', 'ตรวจ a11y', 'ทำ migration', 'เช็ก lint', 'อ่าน log server', 'ปรับ CSS ปุ่ม', 'สรุป diff', 'ตรวจ type', 'ลบโค้ดตาย', 'อัปเดต README'];
  const agents = names.map((description, i) => ({
    id: `b${i}`,
    description,
    model: MODELS[i % MODELS.length],
    effort: i % 2 ? 'medium' : null,
    status: (i < 3 ? 'running' : 'done') as 'running' | 'done',
    thought: i < 3 ? 'กำลังทำงานย่อย' : 'เสร็จแล้ว',
    finished: i >= 3,
    lastActivity: now - (i < 3 ? 2_000 + i * 1000 : (i - 2) * m),
  }));
  return {
    sessionId: 'demo-shop',
    pid: 1003,
    name: 'webshop',
    cwd: 'C:\\Users\\Demo\\webshop',
    kind: 'interactive',
    title: 'ปรับตะกร้าและหน้าชำระเงิน',
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    status: 'running',
    thought: 'แยกงานให้ subagent หลายตัวพร้อมกัน แล้วรวมผลตอนท้าย',
    startedAt: now - 70 * m,
    lastActivity: now - 1_500,
    timeline: [
      { ts: now - 14 * m, kind: 'user', text: 'ปรับตะกร้าให้คำนวณส่วนลดถูกต้อง แล้วเทสต์ให้ครบ' },
      { ts: now - 13 * m, kind: 'text', text: 'ขอดูโค้ดตะกร้ากับชุดเทสต์เดิมก่อน' },
      { ts: now - 12 * m, kind: 'tool', text: 'Read: src/cart/discount.ts' },
      { ts: now - 11 * m, kind: 'tool', text: 'Grep: applyDiscount' },
      { ts: now - 10 * m, kind: 'tool', text: 'Bash: npm test -- cart' },
      { ts: now - 10 * m, kind: 'error', text: 'exit code 1: 2 failed, 14 passed (cart/discount.test.ts)' },
      { ts: now - 8 * m, kind: 'text', text: 'เจอสาเหตุ: ปัดเศษก่อนรวมส่วนลด จะแก้และเพิ่มเทสต์' },
      { ts: now - 7 * m, kind: 'tool', text: 'Edit: src/cart/discount.ts' },
      { ts: now - 5 * m, kind: 'tool', text: 'Bash: npm test -- cart' },
      { ts: now - 3 * m, kind: 'text', text: 'ผ่านครบแล้ว สรุปสิ่งที่แก้:\n- discount.ts: ปัดเศษหลังรวมส่วนลดแล้ว ไม่ใช่ก่อน\n- เพิ่มเทสต์ 3 กรณีขอบ (0%, 100%, หลายคูปอง)\nกำลังให้ subagent ตรวจ a11y กับ lint ต่อ' },
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
      description: `งานย่อย ${i + 1}.${j + 1}`,
      model: MODELS[j % MODELS.length],
      effort: null,
      status: (j % 3 === 0 ? 'running' : 'done') as 'running' | 'done',
      thought: 'ทำงานอยู่',
      finished: j % 3 !== 0,
      lastActivity: now - j * 20_000,
    }));
    return { ...s, sessionId: `${s.sessionId}-${i}`, name: `${s.name}-${i + 1}`, subagents: subs };
  });
}
