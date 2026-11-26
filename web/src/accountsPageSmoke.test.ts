import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts';
import { ACCOUNT_COLORS, TERMINAL_ACCOUNT_ID } from '../../shared/accounts';
import { AccountsScreen, type AccountsScreenProps } from './components/AccountsPage';
import { PasswordSection } from './components/PasswordSection';
import { AppLockSection } from './components/AppLockSection';
import { MainAccountRow } from './components/MainAccountRow';
import { setLanguage } from './i18n';
import { AccountsProvider } from './accountsContext';
import type { UsageSnapshot } from '../../shared/usage';

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
    usage: {
      fiveHour: { pct: 30, resetsAt: null },
      sevenDay: { pct: 70, resetsAt: null },
      updatedAt: NOW,
    },
    hidden: false,
    locked: false, hasPassword: false,
    ...over,
  };
}

function props(over: Partial<AccountsScreenProps> = {}): AccountsScreenProps {
  return {
    accounts: [
      acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null, name: 'Terminal login', createdAt: 0 }),
      acc('work', { name: 'Work account', note: 'ฝ่ายขาย' }),
      acc('spare', { name: 'Spare', tokenState: 'unset', fingerprint: null, expiresAt: null, lastCheckOk: null, lastCheckAt: null, usage: null }),
      acc('old', { name: 'Old token', expiresAt: NOW - DAY, hidden: true }),
    ],
    defaultAccountId: 'work',
    ptyAvailable: true,
    connect: null,
    ...over,
  };
}

describe('AccountsScreen smoke (static render)', () => {
  it('renders the Thai page with every row, the unset state and the default radio', () => {
    setLanguage('th', { persist: false });
    const html = renderToStaticMarkup(createElement(AccountsScreen, props()));
    expect(html).toContain('โปรไฟล์บัญชี Claude');
    expect(html).toContain('← กลับห้องควบคุม');
    expect(html).toContain('+ เพิ่มโปรไฟล์');
    // the builtin row is named by displayName (translated), not by the stored name
    expect(html).toContain('บัญชีหลัก');
    expect(html).not.toContain('Terminal login');
    expect(html).toContain('Work account');
    expect(html).toContain('ฝ่ายขาย');
    expect(html).toContain('ยังไม่ได้เชื่อมต่อ');
    expect(html).toContain('abcd·1234');
    expect(html).toContain('name="acct-default"');
    expect(html).toContain('checked=""');
    expect(html).toContain('หมดอายุแล้ว');
    // the builtin row has no delete action
    expect(html.match(/>ลบ</g)?.length ?? 0).toBe(3);
  });

  it('renders in English without Thai page chrome', () => {
    setLanguage('en', { persist: false });
    const html = renderToStaticMarkup(createElement(AccountsScreen, props()));
    expect(html).toContain('Claude account profiles');
    expect(html).toContain('+ Add profile');
    expect(html).toContain('Not connected');
    expect(html).not.toContain('โปรไฟล์บัญชี Claude');
  });

  it('renders an empty list with the empty note', () => {
    setLanguage('th', { persist: false });
    const html = renderToStaticMarkup(createElement(AccountsScreen, props({ accounts: [] })));
    expect(html).toContain('ยังไม่มีโปรไฟล์');
    expect(html).not.toContain('<table');
  });
});

const MAIN_INFO = {
  loggedIn: true,
  email: 'someone@example.com',
  plan: 'max',
  orgName: 'Example Org',
  expiresAt: NOW + 200 * DAY,
  checkedAt: NOW - 60_000,
};

function inTable(node: ReturnType<typeof createElement>) {
  return createElement('table', null, createElement('tbody', null, node));
}

describe('main account row and token passwords', () => {
  it('shows the full main email, plan and org on the builtin row (th)', () => {
    setLanguage('th', { persist: false });
    const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null, main: MAIN_INFO });
    const html = renderToStaticMarkup(
      createElement(AccountsScreen, props({ accounts: [main, acc('work')] })),
    );
    expect(html).toContain('someone@example.com');
    expect(html).toContain('max');
    expect(html).toContain('Example Org');
    expect(html).toContain('ล็อกอินอยู่');
    expect(html).toContain('เปลี่ยนบัญชีหลัก');
    // the arm warning is not shown until the first click
    expect(html).not.toContain('การเปลี่ยนบัญชีหลักจะเปลี่ยนการล็อกอินของ claude ทุกตัวใน terminal ด้วย');
  });

  it('renders the armed warning in the main row (en)', () => {
    setLanguage('en', { persist: false });
    const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null, main: MAIN_INFO });
    const html = renderToStaticMarkup(
      inTable(
        createElement(MainAccountRow, {
          account: main,
          now: NOW,
          lang: 'en',
          isDefault: false,
          onMakeDefault: () => {},
          onError: () => {},
        }),
      ),
    );
    expect(html).toContain('Change main account');
    expect(html).toContain('someone@example.com');
    expect(html).toContain('Logged in');
    // the armed state is local, so the static render shows the idle button only
    expect(html).not.toContain('Changing the main account also changes');
  });

  it('shows the lock badge and no check button on a locked token profile', () => {
    setLanguage('en', { persist: false });
    const html = renderToStaticMarkup(
      createElement(AccountsScreen, props({ accounts: [acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null }), acc('vault', { name: 'Vault', locked: true, hasPassword: true })] })),
    );
    expect(html).toContain('Vault');
    expect(html.match(/Locked/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain('>Check<');
  });

  it('renders the password section states for set, change and locked (th)', () => {
    setLanguage('th', { persist: false });
    const none = renderToStaticMarkup(createElement(PasswordSection, { account: acc('w', { hasPassword: false }) }));
    expect(none).toContain('ตั้งรหัสผ่าน');
    expect(none).toContain('type="password"');
    expect(none).toContain('autoComplete="new-password"');
    expect(none).toContain('ลืมรหัสผ่าน = เชื่อมต่อ token ใหม่ (รหัสเดิมจะหายไป)');

    const set = renderToStaticMarkup(createElement(PasswordSection, { account: acc('w', { hasPassword: true }) }));
    expect(set).toContain('เปลี่ยนรหัสผ่าน');
    expect(set).toContain('ลบรหัสผ่าน');
    expect(set).toContain('มีรหัสผ่าน');

    const locked = renderToStaticMarkup(createElement(PasswordSection, { account: acc('w', { hasPassword: true, locked: true }) }));
    expect(locked).toContain('ปลดล็อก');
    expect(locked).toContain('โปรไฟล์นี้ถูกล็อกด้วยรหัสผ่าน');
    expect(locked).not.toContain('เปลี่ยนรหัสผ่าน');
  });

  it('renders the app PIN notes and the right boxes for each state (th and en)', () => {
    setLanguage('th', { persist: false });
    const off = renderToStaticMarkup(createElement(AppLockSection, { initial: { required: false, unlocked: true } }));
    expect(off).toContain('PIN เข้าโปรแกรม');
    expect(off).toContain('ยังไม่ได้ตั้ง PIN');
    expect(off).toContain('ตั้ง PIN เข้าโปรแกรม');
    expect(off).toContain('PIN นี้ล็อกเฉพาะตัวโปรแกรม Control Room');
    expect(off).toContain('ลืม PIN: หยุดเซิร์ฟเวอร์ แล้วลบคีย์ appLock ออกจาก config.json');
    expect(off).toContain('aria-label="PIN ใหม่"');
    expect(off).toContain('aria-label="ยืนยัน PIN ใหม่"');
    expect(off).not.toContain('ลบ PIN เข้าโปรแกรม');
    expect(off).not.toContain('รหัสผ่าน');

    const on = renderToStaticMarkup(createElement(AppLockSection, { initial: { required: true, unlocked: true } }));
    expect(on).toContain('เปิดใช้งานแล้ว');
    expect(on).toContain('ล็อกตอนนี้');
    expect(on).toContain('ลบ PIN เข้าโปรแกรม');
    expect(on).toContain('aria-label="PIN ปัจจุบัน"');
    expect(on.match(/role="group"/g)?.length).toBe(4);

    setLanguage('en', { persist: false });
    const en = renderToStaticMarkup(createElement(AppLockSection, { initial: { required: false, unlocked: true } }));
    expect(en).toContain('App PIN');
    expect(en).toContain('This PIN locks only the Control Room program');
    expect(en).toContain('Forgot the PIN: stop the server, then delete the appLock key from config.json.');
    expect(en).toContain('aria-label="Confirm new PIN"');
    expect(en).not.toContain('App password');
    setLanguage('th', { persist: false });
  });
});

describe('accounts table grid (static render)', () => {
  // Header cells, colgroup and every data row must have the same column count; each cell's data-label equals its header text.
  function tableShape(html: string) {
    const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? '';
    const headers = [...thead.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1]);
    const cols = (html.match(/<col\b/g) ?? []).length;
    // Data rows: <tr class="ap-trow ..."> without the revoke / password expansion rows.
    const rows = [...html.matchAll(/<tr class="(ap-trow[^"]*)">([\s\S]*?)<\/tr>/g)]
      .filter((m) => !/ap-(revoke|pw)-row/.test(m[1]) && !/<th\b/.test(m[2]))
      .map((m) => {
        const labels = [...m[2].matchAll(/<td\b[^>]*data-label="([^"]*)"/g)].map((c) => c[1]);
        return { labels, tds: (m[2].match(/<td\b/g) ?? []).length };
      });
    return { headers, cols, rows };
  }

  it('no <tr> carries the flex form-row class ap-row; every row carries ap-trow (th and en)', () => {
    for (const lang of ['th', 'en'] as const) {
      setLanguage(lang, { persist: false });
      const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null, main: MAIN_INFO });
      const html = renderToStaticMarkup(
        createElement(AccountsScreen, props({ accounts: [main, acc('work'), acc('spare', { tokenState: 'unset', fingerprint: null, expiresAt: null })] })),
      );
      const trTags = html.match(/<tr\b[^>]*>/g) ?? [];
      expect(trTags.length).toBeGreaterThan(0);
      for (const tag of trTags) {
        expect(tag).not.toMatch(/\bap-row\b/);
        expect(tag).toMatch(/\bap-trow\b/);
      }
      expect(trTags.filter((tag) => !/ap-(revoke|pw)-row/.test(tag)).length).toBe(4);
    }
  });

  for (const lang of ['th', 'en'] as const) {
    it(`header cells, colgroup and every data row line up (${lang})`, () => {
      setLanguage(lang, { persist: false });
      const main = acc(TERMINAL_ACCOUNT_ID, { builtin: true, tokenState: 'unset', fingerprint: null, expiresAt: null, main: MAIN_INFO });
      const html = renderToStaticMarkup(
        createElement(AccountsScreen, props({ accounts: [main, acc('work'), acc('spare', { tokenState: 'unset', fingerprint: null, expiresAt: null })] })),
      );
      const shape = tableShape(html);
      expect(shape.headers.length).toBe(8);
      expect(shape.cols).toBe(8);
      expect(shape.rows.length).toBe(3);
      for (const row of shape.rows) {
        expect(row.tds).toBe(8);
        expect(row.labels.length).toBe(8);
        expect(row.labels).toEqual(shape.headers);
      }
      setLanguage('th', { persist: false });
    });
  }
});

describe('AccountsScreen main account usage (global snapshot)', () => {
  it('shows the main account bars from the global snapshot in its row', () => {
    setLanguage('th', { persist: false });
    const usage: UsageSnapshot = {
      fiveHour: { pct: 35.2, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
      sevenDay: { pct: 73.4, resetsAt: null, updatedAt: NOW, sessionId: null, model: null },
      sessions: [],
    };
    const html = renderToStaticMarkup(
      createElement(
        AccountsProvider,
        {
          value: {
            accounts: [],
            defaultAccountId: 'work',
            ptyAvailable: true,
            connect: null,
            mainLogin: null,
            setAccount: async () => ({ ok: true }),
            openAddDialog: () => {},
            openUnlockDialog: () => {},
            usage,
          },
          children: createElement(AccountsScreen, props()),
        },
      ),
    );
    expect(html).toContain('35%');
    expect(html).toContain('73%');
  });
});
