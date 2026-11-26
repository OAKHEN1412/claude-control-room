import { describe, expect, it } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import type { RunnerState, SessionInfo } from '../../shared/protocol';
import { AccountsProvider, type AccountsCtx } from './accountsContext';
import { AccountChip } from './components/AccountChip';
import { AccountAvatar } from './components/AccountAvatar';
import { AccountRow } from './canvas/AccountRow';
import { tx } from './i18n';

function acct(over: Partial<AccountInfo> & { id: string }): AccountInfo {
  return {
    name: over.id,
    color: '#6366f1',
    letter: over.id.slice(0, 1).toUpperCase(),
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
    locked: false,
    hasPassword: false,
    ...over,
  };
}

const ACCOUNTS: AccountInfo[] = [
  acct({ id: TERMINAL_ACCOUNT_ID, name: 'Terminal', builtin: true, tokenState: 'unset', fingerprint: null, letter: 'T' }),
  acct({ id: 'alice', name: 'Alice' }),
  acct({ id: 'carol', name: 'Carol', locked: true }),
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

const SESSION = { sessionId: 's1', name: 'job' } as unknown as SessionInfo;

function render(el: ReactElement, over: Partial<AccountsCtx> = {}): string {
  return renderToStaticMarkup(createElement(AccountsProvider, { value: ctx(over), children: el }));
}

describe('canvas account smoke', () => {
  it('renders the avatar with the profile name as title and aria-label', () => {
    const html = render(createElement(AccountAvatar, { account: { color: '#6366f1', letter: 'A', name: 'Alice' }, size: 16 }));
    expect(html).toContain('aria-label="Alice"');
    expect(html).toContain('width:16px');
  });

  it('renders the popover row as a select with the current profile ticked', () => {
    const html = render(createElement(AccountRow, { sessionId: 's1', runner: runner() }));
    expect(html).toContain('<select');
    expect(html).toContain('Alice ✓');
    expect(html).toContain('Carol');
    expect(html).not.toContain('disabled');
  });

  it('disables the row with the not-alive tooltip when the job is not running', () => {
    const html = render(createElement(AccountRow, { sessionId: 's1', runner: runner({ alive: false }) }));
    expect(html).toContain('disabled');
    expect(html).toContain('title="');
  });

  it('renders nothing for a remote job', () => {
    expect(render(createElement(AccountRow, { sessionId: 's1', runner: runner({ machineId: 'm1' }) }))).toBe('');
  });

  it('renders the full chip for a local job in the drawer / pane header', () => {
    const html = render(createElement(AccountChip, { sessionId: SESSION.sessionId, runner: runner() }));
    expect(html).toContain('acct-job-chip');
    expect(html).toContain('Alice');
  });

  it('shows the waiting-for-unlock state on the chip', () => {
    const html = render(createElement(AccountChip, { sessionId: 's1', runner: runner({ waitingUnlock: 'carol' } as Partial<RunnerState>) }));
    expect(html).toContain(tx('acct.job.waitingUnlock', { name: 'Carol' }));
  });
});
