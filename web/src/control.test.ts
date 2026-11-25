import { describe, expect, it, vi } from 'vitest';
import type { AskQuestion, PendingRequest, RunnerState, ServerMsg, SessionInfo } from '../../shared/protocol';
import { CLIP_PERMISSION_MODE, DEFAULT_PERMISSION_MODE, MODEL_OPTIONS, PERMISSION_MODE_LABELS } from '../../shared/protocol';
import { createCommander } from './commands';
import {
  CLOSE_CONFIRM_MS,
  adoptHint,
  allAnswered,
  buildAnswers,
  canCloseJob,
  closeClick,
  closeJobTitle,
  controlMode,
  cwdTail,
  disabledReason,
  effortValue,
  isQuickAsk,
  jobFlags,
  modeBadges,
  modeChoice,
  modeValue,
  modelOptionId,
  modelValue,
  runnerLine,
  targetLabel,
  toggleChoice,
} from './control';
import { INITIAL_SERVER_STATE, applyMsg, parseMsg } from './useServer';

function session(status: SessionInfo['status'], over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: 's1',
    pid: 5,
    name: 'job',
    cwd: 'C:\\Users\\you\\Desktop\\proj',
    kind: 'interactive',
    title: 't',
    model: 'claude-opus-5-5',
    effort: 'high',
    status,
    thought: '',
    startedAt: 0,
    lastActivity: 0,
    timeline: [],
    subagents: [],
    ...over,
  };
}

function runner(over: Partial<RunnerState> = {}): RunnerState {
  return {
    sessionId: 's1',
    cwd: 'C:\\x',
    alive: true,
    pid: 9,
    busy: false,
    queued: 0,
    model: 'claude-haiku-5-5',
    effort: 'low',
    confirmed: true,
    permissionMode: 'default',
    remoteControl: false,
    pending: [],
    startedAt: 0,
    ...over,
  };
}

describe('control mode', () => {
  it('runner alive wins; done terminal sessions can be adopted; live terminal sessions are read-only', () => {
    expect(controlMode(session('running'), runner())).toBe('runner');
    expect(controlMode(session('running'), undefined)).toBe('readonly');
    expect(controlMode(session('waiting'), undefined)).toBe('readonly');
    expect(controlMode(session('idle'), undefined)).toBe('readonly'); // process still alive
    expect(controlMode(session('done'), undefined)).toBe('adoptable');
    expect(controlMode(session('done'), runner({ alive: false }))).toBe('adoptable');
    expect(controlMode(session('running'), runner({ alive: false }))).toBe('readonly');
  });
  it('gives a reason for every disabled mode and none for runner', () => {
    expect(disabledReason('runner')).toBeNull();
    expect(disabledReason('readonly')).toContain('terminal');
    expect(disabledReason('adoptable')).toContain('ย้ายมาคุมจากเว็บ');
  });
});

describe('labels', () => {
  it('shows name and folder next to every send button', () => {
    expect(targetLabel(session('running'))).toBe('job — …\\Desktop\\proj');
    expect(cwdTail('C:\\a')).toBe('C:\\a');
  });
  it('maps CLI model strings to option ids', () => {
    expect(modelOptionId('claude-haiku-5-5')).toBe('haiku');
    expect(modelOptionId('opus')).toBe('opus');
    expect(modelOptionId('claude-sonnet-5-5')).toBe('sonnet');
    expect(modelOptionId('qwen3.8')).toBeNull();
    expect(modelOptionId(null)).toBeNull();
  });
  it('select values prefer the runner-confirmed values', () => {
    const s = session('running');
    expect(modelValue(runner(), s)).toBe('haiku');
    expect(modelValue(undefined, s)).toBe('opus');
    expect(effortValue(runner(), s)).toBe('low');
    expect(effortValue(undefined, s)).toBe('high');
  });
  it('summarises runner state', () => {
    expect(runnerLine(undefined)).toBe('');
    expect(runnerLine(runner({ busy: true, queued: 2, pending: [{} as PendingRequest] }))).toBe('กำลังทำ · รอคิว 2 งาน · รอคุณ 1');
    expect(runnerLine(runner({ alive: false, error: 'boom' }))).toContain('boom');
    expect(runnerLine(runner({ confirmed: false }))).toContain('รอยืนยัน');
  });
  it('lists the disabled models with their required tooltips', () => {
    const by = (id: string) => MODEL_OPTIONS.find((o) => o.id === id)!;
    expect(by('opus').disabled).toBeUndefined();
    expect(MODEL_OPTIONS[0].id).toBe('opus');
    expect(by('qwen').disabled).toBe('ช้า และยังเป็นแบบทดลอง');
    expect(by('tokenme-deepseek').disabled).toBe('TokenMe ปฏิเสธ: ยังไม่ได้สมัครแพ็กเกจ (2026-11-23)');
    expect(by('aipass').disabled).toBe('ยังไม่ตั้งค่า');
    expect(MODEL_OPTIONS.filter((o) => !o.disabled).map((o) => o.label)).toEqual(['Opus 5.5', 'Fable 5.2', 'Sonnet 5.5', 'Haiku 5.5']);
  });
});

describe('ask answers', () => {
  const single: AskQuestion = { question: 'Colour?', header: 'c', multiSelect: false, options: [{ label: 'Red', description: '' }, { label: 'Green', description: '' }] };
  const multi: AskQuestion = { question: 'Which?', header: 'w', multiSelect: true, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] };

  it('single select replaces, multi select toggles', () => {
    let c = toggleChoice({}, single, 'Red');
    c = toggleChoice(c, single, 'Green');
    expect(c).toEqual({ 'Colour?': 'Green' });
    c = toggleChoice(c, multi, 'A');
    c = toggleChoice(c, multi, 'B');
    expect(c['Which?']).toEqual(['A', 'B']);
    c = toggleChoice(c, multi, 'A');
    expect(c['Which?']).toEqual(['B']);
  });
  it('builds answers keyed by question text, joining multi-select with ", "', () => {
    expect(buildAnswers([single, multi], { 'Colour?': 'Green', 'Which?': ['A', 'B'] })).toEqual({ 'Colour?': 'Green', 'Which?': 'A, B' });
    expect(buildAnswers([single], {})).toEqual({});
    expect(buildAnswers([multi], { 'Which?': [] })).toEqual({});
  });
  it('allAnswered needs every question answered', () => {
    expect(allAnswered([single, multi], { 'Colour?': 'Red' })).toBe(false);
    expect(allAnswered([single, multi], { 'Colour?': 'Red', 'Which?': ['A'] })).toBe(true);
  });
  it('quick ask = exactly one single-select question', () => {
    const p = (questions: AskQuestion[]): PendingRequest => ({ requestId: 'r', toolUseId: 't', toolName: 'AskUserQuestion', kind: 'ask', description: '', inputPreview: '', questions, at: 0 });
    expect(isQuickAsk(p([single]))).toBe(true);
    expect(isQuickAsk(p([multi]))).toBe(false);
    expect(isQuickAsk(p([single, single]))).toBe(false);
    expect(isQuickAsk({ ...p([single]), kind: 'permission' })).toBe(false);
  });
});

describe('snapshot dedupe', () => {
  it('a snapshot with two entries for one sessionId keeps one', () => {
    const mk = (pid: number) => ({ sessionId: 'dup', pid }) as unknown as import('../../shared/protocol').SessionInfo;
    const st = applyMsg(INITIAL_SERVER_STATE, { type: 'snapshot', machine: 'm', serverTime: 0, sessions: [mk(1), mk(2)] }, 1);
    expect(st.sessions).toHaveLength(1);
    expect(st.sessions[0].pid).toBe(2);
  });
});

describe('server state reducers for runners', () => {
  it('snapshot carries runners and cwds; runner messages add/replace; runner_removed deletes', () => {
    let st = applyMsg(INITIAL_SERVER_STATE, { type: 'snapshot', machine: 'm', serverTime: 0, sessions: [], runners: [runner()], cwds: ['C:\\a'] }, 1);
    expect(st.runners.s1.model).toBe('claude-haiku-5-5');
    expect(st.cwds).toEqual(['C:\\a']);
    st = applyMsg(st, { type: 'runner', serverTime: 0, runner: runner({ busy: true, queued: 1 }) }, 2);
    expect(st.runners.s1).toMatchObject({ busy: true, queued: 1 });
    st = applyMsg(st, { type: 'runner', serverTime: 0, runner: runner({ sessionId: 's2' }) }, 3);
    expect(Object.keys(st.runners).sort()).toEqual(['s1', 's2']);
    st = applyMsg(st, { type: 'runner_removed', serverTime: 0, sessionId: 's1' }, 4);
    expect(Object.keys(st.runners)).toEqual(['s2']);
    st = applyMsg(st, { type: 'cwds', serverTime: 0, cwds: ['C:\\b'] }, 5);
    expect(st.cwds).toEqual(['C:\\b']);
  });
  it('an old-style snapshot without runners resets them; acks do not touch state', () => {
    const st0 = { ...INITIAL_SERVER_STATE, runners: { s1: runner() }, cwds: ['x'] };
    const st = applyMsg(st0, { type: 'snapshot', machine: 'm', serverTime: 0, sessions: [] }, 1);
    expect(st.runners).toEqual({});
    expect(st.cwds).toEqual(['x']);
    expect(applyMsg(st0, { type: 'ack', serverTime: 0, reqId: 'a', ok: true }, 2)).toBe(st0);
  });
  it('parseMsg accepts the new message types and rejects malformed ones', () => {
    expect(parseMsg(JSON.stringify({ type: 'runner', serverTime: 1, runner: runner() }))?.type).toBe('runner');
    expect(parseMsg(JSON.stringify({ type: 'runner', serverTime: 1, runner: { sessionId: 'x' } }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'cwds', cwds: ['a'] }))?.type).toBe('cwds');
    expect(parseMsg(JSON.stringify({ type: 'cwds', cwds: 'a' }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'ack', reqId: 'r', ok: false, error: 'e' }))?.type).toBe('ack');
    expect(parseMsg(JSON.stringify({ type: 'ack', ok: true }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'runner_removed', sessionId: 's' }))?.type).toBe('runner_removed');
  });
});

describe('commander', () => {
  it('sends JSON with a reqId and resolves on the matching ack', async () => {
    const sent: string[] = [];
    const c = createCommander((t) => (sent.push(t), true));
    const p = c.send({ type: 'send', sessionId: 's1', text: 'hi' });
    const frame = JSON.parse(sent[0]);
    expect(frame).toMatchObject({ type: 'send', sessionId: 's1', text: 'hi' });
    expect(typeof frame.reqId).toBe('string');
    c.onMessage({ type: 'ack', serverTime: 0, reqId: 'other', ok: true } as ServerMsg); // not ours
    expect(c.pendingCount()).toBe(1);
    c.onMessage({ type: 'ack', serverTime: 0, reqId: frame.reqId, ok: false, error: 'nope' });
    await expect(p).resolves.toEqual({ ok: false, error: 'nope', sessionId: undefined });
    expect(c.pendingCount()).toBe(0);
  });
  it('fails at once when the socket is not open, on timeout, and on disconnect', async () => {
    const closed = createCommander(() => false);
    await expect(closed.send({ type: 'stop', sessionId: 's' })).resolves.toMatchObject({ ok: false });
    vi.useFakeTimers();
    try {
      const c = createCommander(() => true, { timeoutMs: 50 });
      const p = c.send({ type: 'stop', sessionId: 's' });
      vi.advanceTimersByTime(60);
      await expect(p).resolves.toMatchObject({ ok: false, error: 'เซิร์ฟเวอร์ไม่ตอบ' });
    } finally {
      vi.useRealTimers();
    }
    const d = createCommander(() => true);
    const p1 = d.send({ type: 'stop', sessionId: 's' });
    const p2 = d.send({ type: 'stop', sessionId: 't' });
    d.failAll('ขาดการเชื่อมต่อ');
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { ok: false, error: 'ขาดการเชื่อมต่อ' },
      { ok: false, error: 'ขาดการเชื่อมต่อ' },
    ]);
  });
});

describe('permission mode helpers', () => {
  it('modeValue: the Runner report while alive, empty (disabled select) otherwise', () => {
    expect(modeValue(runner({ permissionMode: 'plan' }))).toBe('plan');
    expect(modeValue(runner({ alive: false }))).toBe('');
    expect(modeValue(undefined)).toBe('');
  });
  it('modeChoice: bypassPermissions always goes through the confirm step; same value does nothing', () => {
    expect(modeChoice('default', 'acceptEdits')).toBe('apply');
    expect(modeChoice('acceptEdits', 'plan')).toBe('apply');
    expect(modeChoice('default', 'bypassPermissions')).toBe('confirm');
    expect(modeChoice('', 'bypassPermissions')).toBe('confirm');
    expect(modeChoice('plan', 'plan')).toBe('none');
    expect(modeChoice('bypassPermissions', 'default')).toBe('apply'); // leaving bypass needs no confirm
  });
  it('jobFlags: confirm only travels with an explicitly confirmed bypass; RC only when on', () => {
    expect(jobFlags('default', false, false)).toEqual({ permissionMode: 'default' });
    expect(jobFlags('acceptEdits', true, true)).toEqual({ permissionMode: 'acceptEdits', remoteControl: true });
    expect(jobFlags('bypassPermissions', false, false)).toEqual({ permissionMode: 'bypassPermissions' }); // server will reject
    expect(jobFlags('bypassPermissions', true, false)).toEqual({ permissionMode: 'bypassPermissions', confirm: true });
  });
  it('modeBadges: nothing for default / dead jobs; mode and RC otherwise', () => {
    expect(modeBadges(runner())).toEqual([]);
    expect(modeBadges(runner({ permissionMode: 'acceptEdits' }))).toEqual(['acceptEdits']);
    expect(modeBadges(runner({ permissionMode: 'bypassPermissions', remoteControl: true }))).toEqual(['bypassPermissions', 'RC']);
    expect(modeBadges(runner({ remoteControl: true }))).toEqual(['RC']);
    expect(modeBadges(runner({ permissionMode: 'plan', alive: false }))).toEqual([]);
    expect(modeBadges(undefined)).toEqual([]);
  });
  it('labels are the agreed Thai texts', () => {
    expect(PERMISSION_MODE_LABELS).toEqual({
      default: 'ถามทุกครั้ง',
      acceptEdits: 'แก้ไฟล์ได้เลย · คำสั่งยังถาม',
      plan: 'วางแผนอย่างเดียว',
      bypassPermissions: 'ไม่ถามเลย (เสี่ยง)',
    });
    expect(CLIP_PERMISSION_MODE).toBe('acceptEdits');
    expect(DEFAULT_PERMISSION_MODE).toBe('default');
  });
});

describe('close job ("ปิดงาน")', () => {
  it('can close only a live Runner job', () => {
    expect(canCloseJob('runner')).toBe(true);
    expect(canCloseJob('adoptable')).toBe(false);
    expect(canCloseJob('readonly')).toBe(false);
  });

  it('a terminal session is disabled with the terminal reason; an ended job with the adopt hint; a live one has no title', () => {
    expect(closeJobTitle('readonly')).toBe('งานที่เปิดจาก terminal ต้องปิดจาก terminal');
    expect(closeJobTitle('adoptable')).toBe(adoptHint());
    expect(closeJobTitle('runner')).toContain('ปิดงาน');
  });

  it('two clicks send the close; the first only arms; nothing happens when the job cannot be closed', () => {
    expect(closeClick(false, true)).toBe('arm');
    expect(closeClick(true, true)).toBe('send');
    expect(closeClick(false, false)).toBe('none');
    expect(closeClick(true, false)).toBe('none');
    expect(CLOSE_CONFIRM_MS).toBe(4000);
  });
});
