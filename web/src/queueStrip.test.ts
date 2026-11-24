import { describe, expect, it } from 'vitest';
import type { RunnerState, SessionInfo } from '../../shared/protocol';
import { queueStrip, runningNow, sinceLabel } from './control';

const runner = (over: Partial<RunnerState> = {}): RunnerState => ({
  sessionId: 's',
  cwd: 'C:\\w',
  alive: true,
  pid: 1,
  busy: true,
  queued: 0,
  model: 'haiku',
  effort: 'high',
  confirmed: true,
  permissionMode: 'default',
  remoteControl: false,
  pending: [],
  startedAt: 0,
  ...over,
});
const session = (timeline: SessionInfo['timeline']): SessionInfo => ({
  sessionId: 's', pid: 1, name: 'n', cwd: 'C:\\w', kind: 'sdk', title: 't', model: null, effort: null,
  status: 'running', thought: '', startedAt: 0, lastActivity: 0, timeline, subagents: [],
});

describe('queue strip', () => {
  const NOW = 10 * 60_000;
  it('is null when nothing waits or the job is dead', () => {
    expect(queueStrip(undefined, undefined, NOW)).toBeNull();
    expect(queueStrip(session([]), runner({ queued: 0 }), NOW)).toBeNull();
    expect(queueStrip(session([]), runner({ queued: 2, alive: false }), NOW)).toBeNull();
  });
  it('shows the count, the texts and what is running now', () => {
    const s = session([
      { ts: 0, kind: 'user', text: 'build it' },
      { ts: 4 * 60_000, kind: 'tool', text: 'Bash: cargo build --release -p pdfcraft' },
    ]);
    const strip = queueStrip(s, runner({ queued: 2, queuedTexts: [{ text: 'a', at: 1 }, { text: 'b', at: 2 }] }), NOW);
    expect(strip?.headline).toBe('ข้อความรอส่ง 2 · จะถึง Claude หลังคำสั่งที่กำลังรันเสร็จ');
    expect(strip?.texts.map((t) => t.text)).toEqual(['a', 'b']);
    expect(strip?.running).toBe('Bash: cargo build --release -p pdfcraft · 6 นาที');
  });
  it('works with an older server that sends only the count; no running line when the last event is not a tool', () => {
    const strip = queueStrip(session([{ ts: 0, kind: 'text', text: 'hi' }]), runner({ queued: 1 }), NOW);
    expect(strip?.texts).toEqual([]);
    expect(strip?.running).toBeNull();
    expect(runningNow(session([{ ts: 0, kind: 'tool', text: 'Bash: ls' }]), runner({ busy: false }), NOW)).toBeNull();
  });
  it('sinceLabel', () => {
    expect(sinceLabel(0, 30_000)).toBe('ไม่ถึงนาที');
    expect(sinceLabel(0, 65 * 60_000)).toBe('1 ชม. 5 นาที');
  });
});
