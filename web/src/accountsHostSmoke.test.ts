import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID } from '../../shared/accounts';
import { AccountsScreen } from './components/AccountsPage';
import { AccountsHost } from './components/AccountsHost';
import { useAccounts } from './accountsContext';
import { INITIAL_SERVER_STATE, type ServerApi } from './useServer';
import { setLanguage } from './i18n';

afterEach(() => setLanguage('th', { persist: false }));

const NOW = Date.now();
const DAY = 24 * 3600_000;

function acc(id: string, over: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id,
    name: id,
    color: ACCOUNT_COLORS[1],
    letter: 'A',
    note: '',
    builtin: false,
    tokenState: 'set',
    fingerprint: 'abcd1234',
    createdAt: NOW - 10 * DAY,
    tokenAt: NOW - 10 * DAY,
    expiresAt: NOW + 200 * DAY,
    lastCheckAt: NOW - 60_000,
    lastCheckOk: true,
    usage: null,
    hidden: false,
    locked: false,
    hasPassword: false,
    ...over,
  };
}

const MAIN_LOGGED_IN = {
  loggedIn: true,
  email: 'someone@example.com',
  plan: 'max',
  orgName: 'Example Org',
  expiresAt: NOW + 200 * DAY,
  checkedAt: NOW - 60_000,
};

/** A ServerApi with the given fields; the command and socket parts are inert stubs (no connection is opened). */
function fakeServer(over: Partial<ServerApi> = {}): ServerApi {
  return {
    ...INITIAL_SERVER_STATE,
    demo: false,
    accounts: [acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null, name: 'Terminal login', createdAt: 0, main: MAIN_LOGGED_IN }), acc('work', { name: 'Work account' })],
    defaultAccountId: 'work',
    ptyAvailable: true,
    command: async () => ({ ok: false, error: 'stub' }),
    ask: async () => ({ ok: false, error: 'stub' }),
    clearAppLock: () => {},
    ...over,
  };
}

/** The opening <button ...> tag that contains the given label. */
function buttonTagFor(html: string, label: string): string {
  const at = html.indexOf(label);
  if (at < 0) throw new Error(`label not rendered: ${label}`);
  const start = html.lastIndexOf('<button', at);
  return html.slice(start, html.indexOf('>', start) + 1);
}

describe('AccountsHost with AccountsScreen', () => {
  it('leaves the change-main-account button enabled when the server reports ptyAvailable', () => {
    setLanguage('th', { persist: false });
    const server = fakeServer({ ptyAvailable: true });
    const html = renderToStaticMarkup(
      createElement(AccountsHost, {
        server,
        children: createElement(AccountsScreen, {
          accounts: server.accounts,
          defaultAccountId: server.defaultAccountId,
          ptyAvailable: server.ptyAvailable,
          connect: null,
        }),
      }),
    );
    const tag = buttonTagFor(html, 'เปลี่ยนบัญชีหลัก');
    expect(tag).not.toContain('disabled');
  });

  it('disables the change-main-account button when the server has no pty', () => {
    setLanguage('en', { persist: false });
    const server = fakeServer({ ptyAvailable: false });
    const html = renderToStaticMarkup(
      createElement(AccountsHost, {
        server,
        children: createElement(AccountsScreen, {
          accounts: server.accounts,
          defaultAccountId: server.defaultAccountId,
          ptyAvailable: server.ptyAvailable,
          connect: null,
        }),
      }),
    );
    const tag = buttonTagFor(html, 'Change main account');
    expect(tag).toContain('disabled');
  });
});

describe('AccountsHost context', () => {
  function Probe() {
    const ctx = useAccounts();
    return createElement('span', { 'data-probe': '1' }, `${ctx.accounts.length}|${ctx.defaultAccountId}|${String(ctx.ptyAvailable)}`);
  }

  it('provides the server accounts, default and pty flag to a child calling useAccounts()', () => {
    const server = fakeServer({ ptyAvailable: true });
    const html = renderToStaticMarkup(createElement(AccountsHost, { server, children: createElement(Probe) }));
    expect(html).toContain('data-probe="1">2|work|true<');
  });

  it('renders the children and no dialog when nothing is open', () => {
    const server = fakeServer();
    const html = renderToStaticMarkup(createElement(AccountsHost, { server, children: createElement('p', null, 'hello') }));
    expect(html).toContain('>hello<');
    expect(html).not.toContain('role="dialog"');
  });
});
