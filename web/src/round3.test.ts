import { describe, expect, it } from 'vitest';
import type { LinkInfo, ServerMsg } from '../../shared/protocol';
import { CARD_H, CARD_W, layoutCanvas, keySession, type Box } from './canvas/canvasLayout';
import { prunePositions } from './canvas/canvasStore';
import {
  LINK_OFFSET,
  chipT,
  detectForwards,
  linkActions,
  linkChip,
  linkCurve,
  linkEnds,
  linkOffset,
  linkWires,
  parseMaxForwards,
} from './canvas/linkWires';
import { RM_H, RM_W, attachWires, hitCard, hitMachine, isMachineKey, layoutMachines, machineKey, pruneMachinePositions, routeDrop, type DropCtx } from './canvas/machineLayout';
import { addPane, type PaneNode } from './canvas/paneStore';
import { demoLinks, demoMachines, demoSaved } from './demoNext';
import { demoSessions } from './demo';
import { EMPTY_MACHINE_FORM, applyPeer, formPayload, isValidMachine, validKeyPath, validateMachine, type MachineForm } from './machineForm';
import type { MachineInfo, SavedSession, ServerMsgNext } from './protocolNext';
import { SAVED_PAGE, countTab, dayLabel, filterSaved, groupByDay, limitGroups, resumeDefaults, rowActions } from './savedList';
import { INITIAL_SERVER_STATE, applyMsg, parseMsg } from './useServer';

const link = (over: Partial<LinkInfo> = {}): LinkInfo => ({
  id: 'l1',
  from: 'a',
  to: 'b',
  paused: false,
  state: 'ok',
  forwards: 2,
  maxForwards: 6,
  lastForwardAt: null,
  ...over,
});

const three = [
  { sessionId: 'a', subagents: [] },
  { sessionId: 'b', subagents: [] },
  { sessionId: 'c', subagents: [] },
];
/** One column (the default): cards stacked, so links between them are side loops. */
const layout = layoutCanvas(three);
/** One session per column: each card sits clearly right of the previous one. */
const wide = layoutCanvas(three, { perCol: 1 });

describe('wire drop routing (four targets)', () => {
  const panes: PaneNode[] = addPane([], { x: 2000, y: 0, source: null }).panes;
  const card = (id: string): Box => layout.sessions.find((s) => s.sessionId === id)!.card;
  const machines = layoutMachines([{ id: 'm1' }, { id: 'm2' }], layout.machine);
  const ctx: DropCtx = { panes, cards: layout.sessions.map((s) => ({ sessionId: s.sessionId, card: s.card })), machines };
  const src = { sessionId: 'a', agentId: null };
  const mid = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

  it('a pane under the pointer takes the wire', () => {
    expect(routeDrop(ctx, src, { x: 2100, y: 100 }, false)).toEqual({ kind: 'pane', id: panes[0].id });
  });
  it('another session body or its input port makes a link', () => {
    expect(routeDrop(ctx, src, mid(card('b')), true)).toEqual({ kind: 'link', toSessionId: 'b' });
    const b = card('b');
    expect(routeDrop(ctx, src, { x: b.x - 8, y: b.y + b.h / 2 }, false)).toEqual({ kind: 'link', toSessionId: 'b' });
    expect(hitCard(ctx.cards, { x: b.x - 40, y: b.y + b.h / 2 })).toBeNull();
  });
  it('a remote machine node attaches', () => {
    expect(routeDrop(ctx, src, mid(machines[1].box), true)).toEqual({ kind: 'attach', machineId: 'm2' });
    expect(hitMachine(machines, { x: machines[0].box.x + RM_W + 5, y: machines[0].box.y + 5 })).toBeNull();
  });
  it('empty canvas makes a new pane, any other node or the toolbar does nothing', () => {
    expect(routeDrop(ctx, src, { x: -500, y: -500 }, false)).toEqual({ kind: 'empty', at: { x: -500, y: -500 } });
    expect(routeDrop(ctx, src, { x: -500, y: -500 }, true)).toEqual({ kind: 'none' });
  });
  it('dropping on its own session does nothing; a subagent wire can only reach a pane or empty canvas', () => {
    expect(routeDrop(ctx, src, mid(card('a')), true)).toEqual({ kind: 'none' });
    const sub = { sessionId: 'a', agentId: 'x1' };
    expect(routeDrop(ctx, sub, mid(card('b')), true)).toEqual({ kind: 'none' });
    expect(routeDrop(ctx, sub, mid(machines[0].box), true)).toEqual({ kind: 'none' });
    expect(routeDrop(ctx, sub, { x: 2100, y: 100 }, false)).toEqual({ kind: 'pane', id: panes[0].id });
    expect(routeDrop(ctx, sub, { x: -500, y: -500 }, false).kind).toBe('empty');
  });
  it('a pane on top of a session wins', () => {
    const over = addPane([], { x: card('b').x, y: card('b').y - 10, source: null }).panes;
    const r = routeDrop({ ...ctx, panes: over }, src, mid(card('b')), true);
    expect(r.kind).toBe('pane');
  });
});

describe('link wires', () => {
  it('runs from the output port of the source card to the input port of the target card', () => {
    const e = linkEnds(wide, { from: 'a', to: 'b' })!;
    const a = wide.sessions[0].card;
    const b = wide.sessions[1].card;
    expect(e.side).toBe(false);
    expect(e.from).toEqual({ x: a.x + CARD_W, y: a.y + CARD_H / 2 });
    expect(e.to).toEqual({ x: b.x, y: b.y + CARD_H / 2 });
    expect(linkEnds(wide, { from: 'a', to: 'zzz' })).toBeNull();
  });
  it('cards stacked in one column: a "C" on the right side into the right edge of the target', () => {
    const e = linkEnds(layout, { from: 'a', to: 'b' })!;
    const b = layout.sessions[1].card;
    expect(e.side).toBe(true);
    expect(e.to.x).toBe(b.x + b.w);
    expect(e.to.y).toBeGreaterThan(b.y);
    expect(e.to.y).toBeLessThan(b.y + b.h / 2);
    const w = linkWires(layout, [link()])[0];
    expect(w.mid.x).toBeGreaterThan(b.x + b.w); // the chip sits outside the cards, not on top of them
  });
  it('skips links whose session is not on the canvas', () => {
    expect(linkWires(layout, [link(), link({ id: 'l2', to: 'gone' })]).map((w) => w.id)).toEqual(['l1']);
  });
  it('a single link is not offset; an A <-> B pair gets two curves on opposite sides', () => {
    const single = linkWires(wide, [link()])[0];
    expect(single.offset).toBe(0);
    const pair = [link({ id: 'ab' }), link({ id: 'ba', from: 'b', to: 'a' })];
    const [ab, ba] = linkWires(wide, pair);
    expect(linkOffset(pair[0], pair)).toBe(LINK_OFFSET);
    expect(linkOffset(pair[1], pair)).toBe(-LINK_OFFSET);
    expect(ab.d).not.toBe(ba.d);
    expect(Math.hypot(ab.mid.x - ba.mid.x, ab.mid.y - ba.mid.y)).toBeGreaterThan(30);
    // A -> B bows below its straight middle; B -> A runs backwards (target left of source) so it is a side loop
    const straight = linkCurve(ab.from, ab.to, 0).mid;
    expect(ab.mid.y).toBeGreaterThan(straight.y);
  });
  it('an A <-> B pair in one column nests the two side loops, chips apart', () => {
    const pair = [link({ id: 'ab' }), link({ id: 'ba', from: 'b', to: 'a' })];
    const [ab, ba] = linkWires(layout, pair);
    expect(ab.d).not.toBe(ba.d);
    expect(Math.hypot(ab.mid.x - ba.mid.x, ab.mid.y - ba.mid.y)).toBeGreaterThan(30);
  });
  it('a lone link has its chip in the middle, the two links of a pair 25 % along (next to their own source)', () => {
    expect(chipT(0)).toBe(0.5);
    expect(chipT(LINK_OFFSET)).toBe(0.25);
    expect(chipT(-LINK_OFFSET)).toBe(0.25);
    const a = { x: 0, y: 0 };
    const b = { x: 400, y: 0 };
    expect(linkCurve(a, b, 0, 0.25).mid.x).toBeLessThan(linkCurve(a, b, 0, 0.5).mid.x);
  });
  it('the chip sits at the middle of the bezier', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 400, y: 0 };
    expect(linkCurve(a, b).mid).toEqual({ x: 200, y: 0 });
  });
});

describe('link chip label and state mapping', () => {
  it('ok shows the counter', () => {
    expect(linkChip(link())).toMatchObject({ text: '↻ 2/6', tone: 'ok' });
  });
  it('limit says it is full and invites a click', () => {
    const c = linkChip(link({ state: 'limit', forwards: 6 }));
    expect(c.text).toBe('ครบ 6 ครั้ง · กดไปต่อ');
    expect(c.tone).toBe('limit');
  });
  it('rate and error are red-ish and carry the error text (truncated in the chip, whole in the title)', () => {
    const long = 'ส่งต่อไม่สำเร็จ: งานปลายทางกำลังตอบอยู่และยังไม่พร้อมรับข้อความใหม่เลย';
    const c = linkChip(link({ state: 'error', error: long }));
    expect(c.tone).toBe('bad');
    expect(c.text.length).toBeLessThan(long.length);
    expect(c.text.endsWith('…')).toBe(true);
    expect(c.title).toBe(long);
    expect(linkChip(link({ state: 'rate' }))).toMatchObject({ tone: 'bad', text: '⚠ ส่งถี่เกินไป' });
    expect(linkChip(link({ state: 'error' })).text).toBe('⚠ ส่งต่อไม่สำเร็จ');
  });
  it('paused wins over every state', () => {
    expect(linkChip(link({ paused: true, state: 'limit' }))).toMatchObject({ tone: 'paused', text: '⏸ 2/6' });
  });
  it('menu: pause <-> resume label, "ไปต่อ" only when the link stopped by itself', () => {
    expect(linkActions(link())).toEqual({ pauseLabel: 'หยุดชั่วคราว', pausedNext: true, canContinue: false });
    expect(linkActions(link({ paused: true }))).toMatchObject({ pauseLabel: 'ทำต่อ', pausedNext: false });
    for (const state of ['limit', 'rate', 'error'] as const) expect(linkActions(link({ state })).canContinue).toBe(true);
  });
  it('max forwards is a whole number 1..50', () => {
    expect(parseMaxForwards('6')).toBe(6);
    expect(parseMaxForwards(50)).toBe(50);
    expect(parseMaxForwards(' 1 ')).toBe(1);
    for (const bad of ['0', '51', '2.5', '', 'abc', -3]) expect(parseMaxForwards(bad)).toBeNull();
  });
});

describe('detectForwards (flow animation trigger)', () => {
  it('records links the first time without firing', () => {
    const r = detectForwards(null, [{ id: 'x', lastForwardAt: 100 }]);
    expect(r.fired).toEqual([]);
    expect(r.next).toEqual({ x: 100 });
  });
  it('fires when lastForwardAt moves forward, including null -> time', () => {
    expect(detectForwards({ x: 100, y: null, z: 5 }, [{ id: 'x', lastForwardAt: 200 }, { id: 'y', lastForwardAt: 50 }, { id: 'z', lastForwardAt: 5 }]).fired).toEqual(['x', 'y']);
  });
  it('does not fire for a link that is new in this pass, or whose time went back / to null', () => {
    expect(detectForwards({ x: 100 }, [{ id: 'new', lastForwardAt: 1 }, { id: 'x', lastForwardAt: null }]).fired).toEqual([]);
    expect(detectForwards({ x: 100 }, [{ id: 'x', lastForwardAt: 90 }]).fired).toEqual([]);
  });
});

describe('machine nodes layout and attach wires', () => {
  it('stacks remote machines in a column under the local machine node', () => {
    const [m1, m2] = layoutMachines([{ id: 'm1' }, { id: 'm2' }], layout.machine);
    expect(m1.box.y).toBeGreaterThanOrEqual(layout.machine.y + layout.machine.h);
    expect(m2.box.y).toBeGreaterThanOrEqual(m1.box.y + RM_H);
    expect(m1.box.x).toBe(m2.box.x);
  });
  it('stored positions override the automatic spot and are pruned with the machine', () => {
    const stored = { [machineKey('m1')]: { x: 10, y: 20 }, [machineKey('gone')]: { x: 1, y: 1 }, a: { x: 5, y: 5 } };
    expect(layoutMachines([{ id: 'm1' }], layout.machine, stored)[0].box).toMatchObject({ x: 10, y: 20 });
    const pruned = pruneMachinePositions(stored, new Set(['m1']));
    expect(Object.keys(pruned).sort()).toEqual(['a', 'mc:m1']);
    expect(pruneMachinePositions(pruned, new Set(['m1']))).toBe(pruned);
  });
  it('machine keys are not session keys, so session pruning keeps them', () => {
    expect(isMachineKey('mc:m1')).toBe(true);
    expect(keySession('mc:m1')).toBeNull();
    const kept = prunePositions({ 'mc:m1': { x: 1, y: 2 }, deadsession: { x: 0, y: 0 }, machine: { x: 0, y: 0 } }, new Set(['a']));
    expect(Object.keys(kept).sort()).toEqual(['machine', 'mc:m1']);
  });
  it('an attachment is a wire from the session output port to the right edge of the machine', () => {
    const places = layoutMachines([{ id: 'm1' }], layout.machine);
    const [w] = attachWires(layout, places, [{ sessionId: 'b', machineId: 'm1', at: 0 }, { sessionId: 'nope', machineId: 'm1', at: 0 }, { sessionId: 'a', machineId: 'nope', at: 0 }]);
    expect(w.key).toBe('b>m1');
    const b = layout.sessions[1].card;
    expect(w.from).toEqual({ x: b.x + b.w, y: b.y + b.h / 2 });
    expect(w.to.x).toBe(places[0].box.x + RM_W);
    expect(attachWires(layout, places, [])).toEqual([]);
  });
});

describe('saved list', () => {
  const NOW = new Date(2026, 10, 24, 15, 0).getTime();
  const at = (dayOffset: number, h = 10) => new Date(2026, 10, 24 - dayOffset, h, 0).getTime();
  const row = (id: string, over: Partial<SavedSession> = {}): SavedSession => ({
    sessionId: id,
    cwd: 'C:\\w\\proj',
    title: `งาน ${id}`,
    model: 'sonnet',
    effort: 'high',
    source: 'web',
    firstSeen: at(0, 1),
    lastActivity: at(0),
    hidden: false,
    live: false,
    ...over,
  });
  const list = [
    row('today1', { lastActivity: at(0, 9) }),
    row('today2', { lastActivity: at(0, 13), source: 'terminal', cwd: 'C:\\w\\shop' }),
    row('yest', { lastActivity: at(1) }),
    row('old', { lastActivity: at(9), source: 'clip', model: null }),
    row('lastyear', { lastActivity: new Date(2025, 11, 3, 8).getTime() }),
    row('bin', { lastActivity: at(2), hidden: true }),
  ];

  it('day labels', () => {
    expect(dayLabel(at(0, 1), NOW)).toBe('วันนี้');
    expect(dayLabel(at(1, 23), NOW)).toBe('เมื่อวาน');
    expect(dayLabel(at(9), NOW)).toBe('15 พ.ย.');
    expect(dayLabel(new Date(2025, 11, 3).getTime(), NOW)).toBe('3 ธ.ค. 2568');
  });
  it('splits the two tabs and sorts newest first', () => {
    expect(filterSaved(list, 'all', '').map((s) => s.sessionId)).toEqual(['today2', 'today1', 'yest', 'old', 'lastyear']);
    expect(filterSaved(list, 'trash', '').map((s) => s.sessionId)).toEqual(['bin']);
    expect([countTab(list, 'all'), countTab(list, 'trash')]).toEqual([5, 1]);
  });
  it('groups by day, newest group first', () => {
    const g = groupByDay(filterSaved(list, 'all', ''), NOW);
    expect(g.map((x) => x.label)).toEqual(['วันนี้', 'เมื่อวาน', '15 พ.ย.', '3 ธ.ค. 2568']);
    expect(g[0].items.map((s) => s.sessionId)).toEqual(['today2', 'today1']);
  });
  it('search matches title, folder, source and model, every word must hit', () => {
    const ids = (q: string) => filterSaved(list, 'all', q).map((s) => s.sessionId);
    expect(ids('today1')).toEqual(['today1']);
    expect(ids('shop')).toEqual(['today2']);
    expect(ids('คลิป')).toEqual(['old']);
    expect(ids('TERMINAL')).toEqual(['today2']);
    expect(ids('sonnet งาน')).toEqual(['today2', 'today1', 'yest', 'lastyear']);
    expect(ids('sonnet shop')).toEqual(['today2']);
    expect(ids('ไม่มีอันนี้')).toEqual([]);
  });
  it('actions: resume, go-to-block when live, restore in the trash', () => {
    expect(rowActions(row('x'), 'all', () => true)).toMatchObject({ primary: 'resume', primaryLabel: 'เปิดทำงานต่อ', primaryDisabled: null, canDelete: true });
    const live = row('x', { live: true });
    expect(rowActions(live, 'all', () => true)).toMatchObject({ primary: 'goto', primaryLabel: 'ไปที่บล็อก', primaryDisabled: null, canDelete: true });
    expect(rowActions(live, 'all', () => false).primaryDisabled).toMatch(/ไม่พบบล็อก/);
    expect(rowActions(row('x', { hidden: true }), 'trash', () => false)).toMatchObject({ primary: 'restore', primaryLabel: 'กู้คืน', primaryDisabled: null, canDelete: false });
  });
  it('pages a long list: whole groups first, the last one cut, nothing empty', () => {
    const many = Array.from({ length: 240 }, (_, i) => row(`r${i}`, { lastActivity: at(i % 20, 12) + i }));
    const groups = groupByDay(filterSaved(many, 'all', ''), NOW);
    const page = limitGroups(groups, SAVED_PAGE);
    expect(page.reduce((n, g) => n + g.items.length, 0)).toBe(SAVED_PAGE);
    expect(page.every((g) => g.items.length > 0)).toBe(true);
    expect(limitGroups(groups, 10_000).reduce((n, g) => n + g.items.length, 0)).toBe(240);
    expect(limitGroups(groups, 0)).toEqual([]);
  });
  it('resume form is prefilled from the saved row', () => {
    expect(resumeDefaults({ model: 'claude-sonnet-5-5', effort: 'medium' })).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(resumeDefaults({ model: null, effort: 'weird' })).toEqual({ model: 'opus', effort: 'high' });
  });
});

describe('machine form validation', () => {
  const ok: MachineForm = { name: 'desktop-server', host: '100.88.12.4', user: 'admin', keyPath: '~/.ssh/id_ed25519', shell: 'cmd', notes: '' };
  it('accepts a good form and an empty key path (not configured yet)', () => {
    expect(validateMachine(ok)).toEqual({});
    expect(isValidMachine({ ...ok, keyPath: '' })).toBe(true);
    expect(isValidMachine({ ...ok, host: 'desktop-server.tailnet.ts.net' })).toBe(true);
  });
  it('requires name, host and user', () => {
    const e = validateMachine(EMPTY_MACHINE_FORM);
    expect(Object.keys(e).sort()).toEqual(['host', 'name', 'user']);
  });
  it('rejects hosts and users that could be read as ssh options or shell text', () => {
    for (const host of ['-oProxyCommand=x', 'a b', 'host;rm', 'host/../x', '.bad']) expect(validateMachine({ ...ok, host }).host, host).toBeTruthy();
    for (const user of ['-x', 'a b', 'a;b', 'a@b', '.dot']) expect(validateMachine({ ...ok, user }).user, user).toBeTruthy();
  });
  it('the key must be a file directly under a .ssh folder', () => {
    for (const k of ['~/.ssh/id_ed25519', '~\\.ssh\\id_rsa', 'C:\\Users\\Demo\\.ssh\\key.pem', '$HOME/.ssh/k', '/home/u/.ssh/k']) expect(validKeyPath(k), k).toBe(true);
    for (const k of ['~/id_rsa', '~/.ssh/../etc/passwd', '~/.ssh/sub/key', '/etc/ssh/key', '~/.ssh/a b', '~/.ssh/', 'C:/keys/x', '~/.ssh/k;ls']) expect(validKeyPath(k), k).toBe(false);
  });
  it('limits name and notes length', () => {
    expect(validateMachine({ ...ok, name: 'x'.repeat(41) }).name).toBeTruthy();
    expect(validateMachine({ ...ok, notes: 'x'.repeat(301) }).notes).toBeTruthy();
  });
  it('picking a Tailscale peer prefills name and host only', () => {
    const f = applyPeer({ ...ok, user: 'me', name: '', host: '' }, { name: 'laptop-office', ip: '100.1.2.3' });
    expect(f).toMatchObject({ name: 'laptop-office', host: '100.1.2.3', user: 'me' });
  });
  it('the payload is trimmed and drops empty notes', () => {
    expect(formPayload({ ...ok, name: ' a ', notes: '  ' })).toEqual({ name: 'a', host: '100.88.12.4', user: 'admin', keyPath: '~/.ssh/id_ed25519', shell: 'cmd' });
    expect(formPayload({ ...ok, notes: ' n ' }).notes).toBe('n');
  });
});

describe('reducer: links, saved sessions, machines', () => {
  const machine: MachineInfo = { id: 'm', name: 'n', host: 'h', user: 'u', keyPath: '', shell: 'cmd', notes: '', reach: 'unknown', ssh: 'untested', lastCheck: null };
  const s0 = INITIAL_SERVER_STATE;

  it('starts empty', () => {
    expect([s0.links, s0.saved, s0.machines, s0.attachments, s0.peers]).toEqual([[], [], [], [], []]);
  });
  it('applies links, saved and machines messages', () => {
    const a = applyMsg(s0, { type: 'links', serverTime: 1, links: [link()] }, 5);
    expect(a.links).toHaveLength(1);
    expect(a.lastMessageAt).toBe(5);
    const savedRow: SavedSession = { sessionId: 's', cwd: 'c', title: 't', model: null, effort: null, source: 'web', firstSeen: 1, lastActivity: 2, hidden: false, live: false };
    const b = applyMsg(a, { type: 'saved', serverTime: 1, sessions: [savedRow] } satisfies ServerMsgNext, 6);
    expect(b.saved).toEqual([savedRow]);
    expect(b.links).toHaveLength(1);
    const c = applyMsg(b, { type: 'machines', serverTime: 1, machines: [machine], attachments: [{ sessionId: 's', machineId: 'm', at: 1 }], peers: [{ name: 'p', ip: '1.1.1.1', os: 'linux', online: true }] } satisfies ServerMsgNext, 7);
    expect([c.machines.length, c.attachments.length, c.peers.length]).toEqual([1, 1, 1]);
    expect(c.saved).toHaveLength(1);
  });
  it('a later message replaces the list (a deleted link disappears)', () => {
    const a = applyMsg(s0, { type: 'links', serverTime: 1, links: [link(), link({ id: 'l2' })] });
    expect(applyMsg(a, { type: 'links', serverTime: 2, links: [link({ id: 'l2' })] }).links.map((l) => l.id)).toEqual(['l2']);
    expect(applyMsg(a, { type: 'links', serverTime: 2, links: [] }).links).toEqual([]);
  });
  it('the snapshot carries the new fields, and an old server without them leaves the state alone', () => {
    const snap = { type: 'snapshot', machine: 'pc', serverTime: 1, sessions: [], links: [link()], saved: [], machines: [machine], attachments: [], peers: [] } as ServerMsg;
    const a = applyMsg(s0, snap, 1);
    expect(a.links).toHaveLength(1);
    expect(a.machines).toHaveLength(1);
    const old = { type: 'snapshot', machine: 'pc', serverTime: 2, sessions: [] } as ServerMsg;
    const b = applyMsg(a, old, 2);
    expect(b.links).toHaveLength(1);
    expect(b.machines).toHaveLength(1);
    expect(b.saved).toEqual([]);
  });
  it('ignores malformed fields instead of crashing', () => {
    const bad = { type: 'snapshot', machine: 'pc', serverTime: 1, sessions: [], links: 'x', saved: 3, machines: null } as unknown as ServerMsg;
    const a = applyMsg(s0, bad);
    expect([a.links, a.saved, a.machines]).toEqual([[], [], []]);
    expect(applyMsg(s0, { type: 'machines', serverTime: 1 } as unknown as ServerMsgNext).machines).toEqual([]);
  });
  it('parseMsg accepts the new messages and rejects broken ones', () => {
    expect(parseMsg(JSON.stringify({ type: 'links', serverTime: 1, links: [] }))?.type).toBe('links');
    expect(parseMsg(JSON.stringify({ type: 'saved', serverTime: 1, sessions: [] }))?.type).toBe('saved');
    expect(parseMsg(JSON.stringify({ type: 'machines', serverTime: 1, machines: [], attachments: [], peers: [] }))?.type).toBe('machines');
    expect(parseMsg(JSON.stringify({ type: 'links', links: 1 }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'saved' }))).toBeNull();
    expect(parseMsg(JSON.stringify({ type: 'machines', machines: {} }))).toBeNull();
  });
});

describe('demo data covers every state', () => {
  const now = Date.now();
  const sessions = demoSessions(now);
  it('links in ok / limit / error / rate / paused, with an A <-> B pair', () => {
    const links = demoLinks(now, sessions);
    expect(new Set(links.map((l) => (l.paused ? 'paused' : l.state)))).toEqual(new Set(['ok', 'limit', 'error', 'rate', 'paused']));
    expect(links.some((l) => links.some((o) => o.from === l.to && o.to === l.from))).toBe(true);
    expect(linkWires(layoutCanvas(sessions.map((s) => ({ sessionId: s.sessionId, subagents: [] }))), links)).toHaveLength(links.length);
  });
  it('saved: today, older, hidden, live', () => {
    const saved = demoSaved(now, sessions);
    expect(saved.some((s) => s.hidden)).toBe(true);
    expect(saved.some((s) => s.live)).toBe(true);
    expect(new Set(saved.map((s) => s.source))).toEqual(new Set(['terminal', 'web', 'clip']));
  });
  it('two machines, peers and one attachment', () => {
    const m = demoMachines(now, sessions);
    expect(m.machines).toHaveLength(2);
    expect(m.peers.length).toBeGreaterThan(1);
    expect(m.attachments).toHaveLength(1);
  });
});
