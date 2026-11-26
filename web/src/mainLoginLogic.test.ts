import { describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID, type AccountInfo, type MainAccountInfo, type MainLoginEvent } from '../../shared/accounts';
import { codeOk, gateVisible, isSafeUrl as reexported, loginUrlOk, panelView, viewOf } from './mainLoginLogic';
import { isSafeUrl } from './accountDialogLogic';

function acc(id: string, main?: MainAccountInfo): AccountInfo {
  return {
    id,
    name: id,
    color: ACCOUNT_COLORS[0],
    letter: 'A',
    note: '',
    builtin: id === TERMINAL_ACCOUNT_ID,
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

const MAIN_OUT: MainAccountInfo = { loggedIn: false, email: null, plan: null, orgName: null, expiresAt: null, checkedAt: 1 };
const MAIN_IN: MainAccountInfo = { ...MAIN_OUT, loggedIn: true };

describe('gateVisible', () => {
  it('is visible only when the terminal profile has main and main is not logged in', () => {
    expect(gateVisible([acc(TERMINAL_ACCOUNT_ID, MAIN_OUT)])).toBe(true);
    expect(gateVisible([acc(TERMINAL_ACCOUNT_ID, MAIN_IN)])).toBe(false);
  });

  it('is hidden when main is missing (old server) or the terminal profile is absent', () => {
    expect(gateVisible([acc(TERMINAL_ACCOUNT_ID)])).toBe(false);
    expect(gateVisible([acc('work-1')])).toBe(false);
    expect(gateVisible([])).toBe(false);
  });

  it('ignores main on other profiles', () => {
    expect(gateVisible([acc('work-1', MAIN_OUT), acc(TERMINAL_ACCOUNT_ID, MAIN_IN)])).toBe(false);
  });
});

describe('viewOf', () => {
  const stale: MainLoginEvent = { status: 'success' };
  const fresh: MainLoginEvent = { status: 'starting' };

  it('treats the event present at mount as stale', () => {
    expect(viewOf(stale, stale)).toBeNull();
  });

  it('returns a different event object', () => {
    expect(viewOf(fresh, stale)).toBe(fresh);
    expect(viewOf(fresh, null)).toBe(fresh);
  });

  it('returns null for no event', () => {
    expect(viewOf(null, null)).toBeNull();
    expect(viewOf(undefined, stale)).toBeNull();
  });
});

describe('codeOk', () => {
  it('accepts a normal code and rejects empty, blank, control characters and oversize', () => {
    expect(codeOk('abc-123')).toBe(true);
    expect(codeOk('  abc  ')).toBe(true);
    expect(codeOk('')).toBe(false);
    expect(codeOk('   ')).toBe(false);
    expect(codeOk('a\nb')).toBe(false);
    expect(codeOk('x'.repeat(513))).toBe(false);
    expect(codeOk(undefined)).toBe(false);
  });
});

describe('isSafeUrl re-export', () => {
  it('is the same function as the account dialog one', () => {
    expect(reexported).toBe(isSafeUrl);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('loginUrlOk', () => {
  it('allows https on the three login hosts and their subdomains only', () => {
    expect(loginUrlOk('https://claude.ai/oauth/authorize?x=1')).toBe(true);
    expect(loginUrlOk('https://claude.com/cai/oauth')).toBe(true);
    expect(loginUrlOk('https://console.anthropic.com/x')).toBe(true);
    expect(loginUrlOk('https://evil.example/claude.ai')).toBe(false);
    expect(loginUrlOk('https://claude.ai.evil.example/')).toBe(false);
    expect(loginUrlOk('http://claude.ai/')).toBe(false);
    expect(loginUrlOk(undefined)).toBe(false);
  });
});

describe('panelView', () => {
  it('idle with no event: start, no code, no link', () => {
    const v = panelView(null);
    expect(v).toMatchObject({ kind: 'idle', showLink: false, showCode: false, canStart: true, isRetry: false, canCancel: false });
  });

  it('starting: cancel only', () => {
    const v = panelView({ status: 'starting' });
    expect(v).toMatchObject({ canStart: false, canCancel: true, showCode: false });
  });

  it('waiting_browser: link when safe, code form shown, cancel offered', () => {
    const v = panelView({ status: 'waiting_browser', url: 'https://claude.ai/oauth/authorize', needCode: true });
    expect(v).toMatchObject({ showLink: true, showCode: true, canCancel: true, canStart: false });
  });

  it('waiting_browser with an unsafe url: no link', () => {
    expect(panelView({ status: 'waiting_browser', url: 'javascript:x' }).showLink).toBe(false);
  });

  it('needCode shows the code form even without waiting_browser', () => {
    expect(panelView({ status: 'starting', needCode: true }).showCode).toBe(true);
  });

  it('failed, timeout and cancelled offer a retry', () => {
    for (const status of ['failed', 'timeout', 'cancelled'] as const) {
      expect(panelView({ status }), status).toMatchObject({ canStart: true, isRetry: true, canCancel: false });
    }
  });

  it('success: nothing to start or cancel', () => {
    expect(panelView({ status: 'success' })).toMatchObject({ kind: 'success', canStart: false, canCancel: false, showCode: false });
  });
});
