// Smoke test: render the gate and the panel to static markup, so runtime errors in the components show up.
// The panel ignores the event present at mount, so the SSR output here is always the idle or no-pty view.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo, type MainAccountInfo } from '../../shared/accounts';
import { MainLoginGate } from './components/MainLoginGate';
import { MainLoginPanel } from './components/MainLoginPanel';
import { setLanguage } from './i18n';

afterEach(() => setLanguage('th', { persist: false }));

const MAIN_OUT: MainAccountInfo = { loggedIn: false, email: null, plan: null, orgName: null, expiresAt: null, checkedAt: 1 };

function terminal(main?: MainAccountInfo): AccountInfo {
  return {
    id: TERMINAL_ACCOUNT_ID,
    name: 'Terminal',
    color: ACCOUNT_COLORS[0],
    letter: 'T',
    note: '',
    builtin: true,
    tokenState: 'unset',
    fingerprint: null,
    createdAt: 1,
    tokenAt: null,
    expiresAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    usage: null,
    hidden: false,
    locked: false,
    hasPassword: false,
    ...(main ? { main } : {}),
  };
}

describe('MainLoginGate smoke', () => {
  it('renders the dialog when the main account is logged out', () => {
    const html = renderToStaticMarkup(
      createElement(MainLoginGate, { accounts: [terminal(MAIN_OUT)], mainLogin: null, ptyAvailable: true }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('เข้าสู่ระบบบัญชีหลัก');
    expect(html).toContain('บัญชีหลักคือการล็อกอิน Claude Code');
  });

  it('renders nothing when logged in', () => {
    const html = renderToStaticMarkup(
      createElement(MainLoginGate, {
        accounts: [terminal({ ...MAIN_OUT, loggedIn: true })],
        mainLogin: null,
        ptyAvailable: true,
      }),
    );
    expect(html).toBe('');
  });

  it('renders nothing on an old server (no main field)', () => {
    const html = renderToStaticMarkup(createElement(MainLoginGate, { accounts: [terminal()], mainLogin: null, ptyAvailable: true }));
    expect(html).toBe('');
  });
});

describe('MainLoginPanel smoke', () => {
  it('idle with a pty: start button, no code form, no link', () => {
    const html = renderToStaticMarkup(createElement(MainLoginPanel, { mainLogin: null, ptyAvailable: true }));
    expect(html).toContain('เข้าสู่ระบบบัญชีหลัก');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('target="_blank"');
  });

  it('without a pty: explains the terminal login and offers the recheck button', () => {
    const html = renderToStaticMarkup(createElement(MainLoginPanel, { mainLogin: null, ptyAvailable: false }));
    expect(html).toContain('claude auth login');
    expect(html).toContain('ตรวจสอบอีกครั้ง');
    expect(html).not.toContain('type="password"');
  });

  it('English labels when the language is English', () => {
    setLanguage('en', { persist: false });
    const html = renderToStaticMarkup(createElement(MainLoginPanel, { mainLogin: null, ptyAvailable: false }));
    expect(html).toContain('Check again');
  });
});
