import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import type { RunnerState } from '../../shared/protocol';
import { AccountsProvider, type AccountsCtx } from './accountsContext';
import { AccountChip } from './components/AccountChip';
import { LimitSwitchCard } from './components/LimitSwitchCard';

const NOW = Date.now();

function acct(over: Partial<AccountInfo> & { id: string }): AccountInfo {
  return {
    name: over.id,
    color: '#6366f1',
    letter: 'A',
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: 'abcd1234',
    createdAt: 1,
    tokenAt: 2,
    expiresAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

const ACCOUNTS: AccountInfo[] = [
  acct({ id: TERMINAL_ACCOUNT_ID, name: 'Terminal', builtin: true, tokenState: 'unset', fingerprint: null, letter: 'T' }),
  acct({ id: 'alice', name: 'Alice', letter: 'A' }),
  acct({
    id: 'dan',
    name: 'Dan',
    letter: 'D',
    usage: { fiveHour: { pct: 100, resetsAt: NOW + 3600_000 }, sevenDay: null, updatedAt: NOW },
  }),
];

function ctx(over: Partial<AccountsCtx> = {}): AccountsCtx {
  return {
    accounts: ACCOUNTS,
    defaultAccountId: 'alice',
    ptyAvailable: false,
    connect: null,
    setAccount: async () => ({ ok: true }),
    mainLogin: null,
    openAddDialog: () => {},
    openUnlockDialog: () => {},
    ...over,
  };
}

function runner(over: Partial<RunnerState> = {}): RunnerState {
  return { alive: true, busy: false, queued: 0, accountId: 'alice', ...over } as RunnerState;
}

function render(el: ReturnType<typeof createElement>, value: AccountsCtx = ctx()): string {
  return renderToStaticMarkup(createElement(AccountsProvider, { value, children: el }));
}

describe('AccountChip smoke', () => {
  it('renders the profile pill for a live local job', () => {
    const html = render(createElement(AccountChip, { sessionId: 's1', runner: runner() }));
    expect(html).toContain('acct-job-chip');
    expect(html).toContain('Alice');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain('disabled');
  });

  it('is disabled with a tooltip when the job is not alive', () => {
    const html = render(createElement(AccountChip, { sessionId: 's1', runner: runner({ alive: false }) }));
    expect(html).toContain('disabled');
    expect(html).toContain('title="งานนี้ไม่ได้รันอยู่');
  });

  it('shows the waiting label while a switch is pending', () => {
    const html = render(createElement(AccountChip, { sessionId: 's1', runner: runner({ accountPending: 'dan' }) }));
    expect(html).toContain('รอสลับเป็น Dan…');
  });

  it('renders nothing for a remote job or without a runner', () => {
    expect(render(createElement(AccountChip, { sessionId: 's1', runner: runner({ machineId: 'm1' }) }))).toBe('');
    expect(render(createElement(AccountChip, { sessionId: 's1' }))).toBe('');
  });

  it('read-only mode renders a plain pill with no button', () => {
    const html = render(createElement(AccountChip, { sessionId: 's1', runner: runner(), readOnly: true }));
    expect(html).toContain('is-readonly');
    expect(html).not.toContain('<button');
  });
});

describe('LimitSwitchCard smoke', () => {
  it('shows the label and lists other profiles, limited ones disabled', () => {
    const html = render(createElement(LimitSwitchCard, { sessionId: 's1', runner: runner(), label: 'ติดลิมิต' }));
    expect(html).toContain('ติดลิมิต');
    expect(html).toContain('ใช้โปรไฟล์อื่นต่อ');
    expect(html).toContain('Dan');
    expect(html).toContain('ติด limit');
    expect(html).toContain('disabled');
  });

  it('without other profiles shows the hint with a link to /accounts', () => {
    const html = render(
      createElement(LimitSwitchCard, { sessionId: 's1', runner: runner(), label: 'ติดลิมิต' }),
      ctx({ accounts: [ACCOUNTS[1]] }),
    );
    expect(html).toContain('href="/accounts"');
    expect(html).toContain('ยังไม่มีโปรไฟล์อื่นที่ใช้ได้');
  });

  it('shows the main account week badge and limit from the global snapshot', () => {
    const week = render(
      createElement(LimitSwitchCard, { sessionId: 's1', runner: runner(), label: 'ติดลิมิต' }),
      ctx({ usage: { fiveHour: null, sevenDay: { pct: 73.4, resetsAt: null, updatedAt: NOW, sessionId: null, model: null }, sessions: [] } }),
    );
    expect(week).toContain('สัปดาห์ 73%');

    const capped = render(
      createElement(LimitSwitchCard, { sessionId: 's1', runner: runner(), label: 'ติดลิมิต' }),
      ctx({ usage: { fiveHour: { pct: 100, resetsAt: NOW + 3600_000, updatedAt: NOW, sessionId: null, model: null }, sevenDay: null, sessions: [] } }),
    );
    // Dan and the main account are both at the cap now
    expect((capped.match(/ติด limit/g) ?? []).length).toBe(2);
  });
});
