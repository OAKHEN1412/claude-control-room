// Smoke render of the header account pill, its popover (open) and the provider wiring. Static markup only (node env).
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo } from '../../shared/accounts';
import { AccountsProvider, type AccountsCtx } from './accountsContext';
import { AccountMenu } from './components/AccountMenu';
import { Header } from './components/Header';
import type { UsageSnapshot } from '../../shared/usage';

const NOW = Date.now();

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

function render(el: ReturnType<typeof createElement>, value: AccountsCtx): string {
  return renderToStaticMarkup(createElement(AccountsProvider, { value, children: el }));
}

describe('AccountMenu smoke', () => {
  it('renders the pill with the Terminal fallback when the server sent no accounts', () => {
    const html = render(createElement(AccountMenu, { runners: {} }), ctx());
    expect(html).toContain('acct-pill');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('id="acct-pop"');
  });

  it('renders the open popover with the current profile, bars, manage link and add row', () => {
    const work = acct('work', 'Work', {
      usage: { fiveHour: { pct: 30, resetsAt: null }, sevenDay: { pct: 80, resetsAt: null }, updatedAt: NOW },
    });
    const home = acct('home', 'Home', {
      usage: { fiveHour: null, sevenDay: { pct: 100, resetsAt: NOW + 3600_000 }, updatedAt: NOW },
    });
    const html = render(
      createElement(AccountMenu, { runners: {}, initialOpen: true }),
      ctx({ accounts: [work, home], defaultAccountId: 'work' }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('สวัสดี, Work');
    expect(html).toContain('href="/accounts"');
    expect(html).toContain('Home');
    expect(html).toContain('ติด limit');
    expect(html).toContain('+ เพิ่มโปรไฟล์');
    expect(html).toContain('เปลี่ยนที่นี่ = ค่าเริ่มต้นของงานใหม่');
    expect(html).toContain('aria-expanded="true"');
  });

  it('shows the unlock link when the current profile is locked', () => {
    const work = acct('work', 'Work', { locked: true, hasPassword: true });
    const html = render(
      createElement(AccountMenu, { runners: {}, initialOpen: true }),
      ctx({ accounts: [work], defaultAccountId: 'work' }),
    );
    expect(html).toContain('acct-unlock-link');
    expect(html).toContain('ล็อกอยู่ — กดเพื่อปลดล็อก');
  });

  it('renders inside the Header without a provider too', () => {
    const html = renderToStaticMarkup(
      createElement(Header, {
        machine: 'pc',
        connected: false,
        lastMessageAt: null,
        demo: true,
        running: 0,
        waiting: 0,
        preset: 'standard',
        onPreset: () => {},
        runners: {},
      }),
    );
    expect(html).toContain('acct-pill');
  });
});

describe('AccountMenu main account usage (global snapshot)', () => {
  const GLOBAL: UsageSnapshot = {
    fiveHour: { pct: 35.2, resetsAt: NOW + 3600_000, updatedAt: NOW, sessionId: null, model: null },
    sevenDay: { pct: 73.4, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
    sessions: [],
  };
  const main = acct(TERMINAL_ACCOUNT_ID, 'Main', { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null });
  const work = acct('work', 'Work', { usage: { fiveHour: null, sevenDay: { pct: 10, resetsAt: null }, updatedAt: NOW } });

  it('shows the main account bars from the global snapshot when it is the current profile', () => {
    const html = render(
      createElement(AccountMenu, { runners: {}, initialOpen: true }),
      ctx({ accounts: [main, work], defaultAccountId: TERMINAL_ACCOUNT_ID, usage: GLOBAL }),
    );
    expect(html).toContain('35%');
    expect(html).toContain('73%');
  });

  it('shows the main account week badge in the list from the global snapshot', () => {
    const html = render(
      createElement(AccountMenu, { runners: {}, initialOpen: true }),
      ctx({ accounts: [work, main], defaultAccountId: 'work', usage: GLOBAL }),
    );
    expect(html).toContain('สัปดาห์ 73%');
  });
});
