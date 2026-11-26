// Header usage rings follow the header profile: pure mappers, the effective snapshot, and static renders (node env).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo, type AccountUsage } from '../../shared/accounts';
import { EMPTY_USAGE, type UsageSnapshot } from '../../shared/usage';
import { AccountsProvider, type AccountsCtx } from './accountsContext';
import { UsageRings } from './components/UsageRings';
import { awaitingProfileUsage, effectiveUsage, profileLabel, profileQuota, quotaRing, usageForProfile, withProfile } from './usageView';

const NOW = new Date(2026, 10, 24, 13, 0, 0).getTime();
const MIN = 60_000;

function acct(id: string, name: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    name,
    color: ACCOUNT_COLORS[1],
    letter: name[0]!.toUpperCase(),
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: null,
    createdAt: 1,
    tokenAt: null,
    expiresAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

const usageOf = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  fiveHour: { pct: 30, resetsAt: NOW + 2 * 60 * MIN },
  sevenDay: { pct: 80, resetsAt: null },
  updatedAt: NOW - MIN,
  ...over,
});

const GLOBAL: UsageSnapshot = {
  fiveHour: { pct: 10, resetsAt: null, updatedAt: NOW, sessionId: 'g', model: 'Opus' },
  sevenDay: { pct: 20, resetsAt: null, updatedAt: NOW, sessionId: 'g', model: 'Opus' },
  sessions: [{ sessionId: 's1', model: null, ctxPct: 40, ctxUsed: null, ctxWindow: null, estimated: false, updatedAt: NOW }],
};

function ctx(over: Partial<AccountsCtx> = {}): AccountsCtx {
  return {
    accounts: [],
    defaultAccountId: TERMINAL_ACCOUNT_ID,
    ptyAvailable: false,
    connect: null,
    setAccount: async () => ({ ok: true }),
    mainLogin: null,
    openAddDialog: () => {},
    openUnlockDialog: () => {},
    ...over,
  };
}

function renderRings(usage: UsageSnapshot, value: AccountsCtx): string {
  return renderToStaticMarkup(
    createElement(
      AccountsProvider,
      { value, children: createElement(UsageRings, { usage, sessions: [], runners: {}, selectedSessionId: null, now: NOW }) },
    ),
  );
}

describe('profileQuota', () => {
  it('maps a window to a ring quota, keeping resetsAt and taking the profile updatedAt', () => {
    expect(profileQuota({ pct: 42, resetsAt: 123 }, NOW)).toEqual({ pct: 42, resetsAt: 123, updatedAt: NOW, sessionId: null, model: null });
  });
  it('null window stays null', () => {
    expect(profileQuota(null, NOW)).toBeNull();
  });
});

describe('usageForProfile', () => {
  it('null usage gives two null windows and keeps the global sessions', () => {
    const m = usageForProfile(GLOBAL, null);
    expect(m.fiveHour).toBeNull();
    expect(m.sevenDay).toBeNull();
    expect(m.sessions).toBe(GLOBAL.sessions);
  });
  it('one window null, the other mapped; resetsAt kept', () => {
    const m = usageForProfile(GLOBAL, { fiveHour: null, sevenDay: { pct: 80, resetsAt: NOW + 5 * MIN }, updatedAt: NOW - MIN });
    expect(m.fiveHour).toBeNull();
    expect(m.sevenDay).toEqual({ pct: 80, resetsAt: NOW + 5 * MIN, updatedAt: NOW - MIN, sessionId: null, model: null });
  });
});

describe('effectiveUsage', () => {
  const work = acct('work', 'Work', { usage: usageOf() });
  const home = acct('home', 'Home', { usage: usageOf({ fiveHour: { pct: 90, resetsAt: null }, sevenDay: null }) });
  const accounts = [work, home];

  it('Terminal gets the global snapshot unchanged', () => {
    expect(effectiveUsage(GLOBAL, TERMINAL_ACCOUNT_ID, accounts)).toBe(GLOBAL);
  });
  it('another profile gets its own usage, not the global one', () => {
    const w = effectiveUsage(GLOBAL, 'work', accounts);
    expect(w.fiveHour?.pct).toBe(30);
    expect(w.sevenDay?.pct).toBe(80);
    expect(w.sessions).toBe(GLOBAL.sessions);
    const h = effectiveUsage(GLOBAL, 'home', accounts);
    expect(h.fiveHour?.pct).toBe(90);
    expect(h.sevenDay).toBeNull();
  });
  it('unknown profile id is treated as no usage', () => {
    expect(effectiveUsage(GLOBAL, 'gone', accounts).fiveHour).toBeNull();
  });
});

describe('awaitingProfileUsage and profileLabel', () => {
  const accounts = [acct('work', 'Work', { usage: usageOf() }), acct('fresh', 'Fresh')];
  it('only a non-Terminal profile without usage is awaiting', () => {
    expect(awaitingProfileUsage('fresh', accounts)).toBe(true);
    expect(awaitingProfileUsage('work', accounts)).toBe(false);
    expect(awaitingProfileUsage(TERMINAL_ACCOUNT_ID, accounts)).toBe(false);
  });
  it('label names the profile, Terminal uses its display name', () => {
    expect(profileLabel('work', accounts)).toBe('โปรไฟล์: Work');
    expect(profileLabel(TERMINAL_ACCOUNT_ID, accounts)).toBe('โปรไฟล์: บัญชีหลัก');
  });
  it('withProfile adds the label and swaps in the fetching text while awaiting', () => {
    const base = quotaRing('five', null, NOW);
    const awaiting = withProfile(base, 'โปรไฟล์: Fresh', true);
    expect(awaiting.lines).toEqual(['ยังไม่มีข้อมูล — กำลังดึง…', 'โปรไฟล์: Fresh']);
    expect(awaiting.pct).toBeNull();
    expect(withProfile(base, 'โปรไฟล์: Work', false).lines).toEqual([...base.lines, 'โปรไฟล์: Work']);
  });
});

describe('UsageRings follows the header profile', () => {
  const work = acct('work', 'Work', { usage: usageOf() });
  const fresh = acct('fresh', 'Fresh');
  const accounts = [work, fresh];

  it('switching the default profile changes the rendered numbers', () => {
    const forWork = renderRings(GLOBAL, ctx({ accounts, defaultAccountId: 'work' }));
    const forTerminal = renderRings(GLOBAL, ctx({ accounts, defaultAccountId: TERMINAL_ACCOUNT_ID }));
    expect(forWork).not.toBe(forTerminal);
    expect(forWork).toContain('>30<');
    expect(forWork).toContain('>80<');
    expect(forTerminal).toContain('>10<');
    expect(forTerminal).toContain('>20<');
  });

  it('a profile without usage shows the no-data dim state and the fetching text', () => {
    const html = renderRings(GLOBAL, ctx({ accounts, defaultAccountId: 'fresh' }));
    expect(html).toContain('is-dim');
    expect(html).toContain('ยังไม่มีข้อมูล — กำลังดึง…');
    expect(html).not.toContain('>10<');
  });

  it('the tooltip names the header profile', () => {
    expect(renderRings(GLOBAL, ctx({ accounts, defaultAccountId: 'work' }))).toContain('โปรไฟล์: Work');
    expect(renderRings(GLOBAL, ctx())).toContain('โปรไฟล์: บัญชีหลัก');
  });

  it('empty usage snapshot for a profile still renders without throwing', () => {
    expect(() => renderRings(EMPTY_USAGE, ctx({ accounts, defaultAccountId: 'work' }))).not.toThrow();
  });
});
