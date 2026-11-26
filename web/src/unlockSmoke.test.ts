// Smoke test: render the unlock dialog and the app lock page to static markup, so runtime errors show up.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts';
import { AppLockPage } from './components/AppLockPage';
import { PinInput } from './components/PinInput';
import { UnlockDialog } from './components/UnlockDialog';
import { setLanguage } from './i18n';

const ACCOUNT: AccountInfo = {
  id: 'work-1',
  name: 'งานหลัก',
  color: '#ef4444',
  letter: 'ง',
  note: '',
  builtin: false,
  tokenState: 'set',
  fingerprint: 'abcd1234',
  createdAt: 1,
  tokenAt: 1,
  expiresAt: null,
  lastCheckAt: null,
  lastCheckOk: null,
  usage: null,
  hidden: false,
  locked: true,
  hasPassword: true,
};

const noop = () => {};

describe('UnlockDialog smoke', () => {
  it('renders nothing when closed or when there is no account', () => {
    expect(renderToStaticMarkup(createElement(UnlockDialog, { open: false, account: ACCOUNT, onClose: noop, onUnlocked: noop }))).toBe('');
    expect(renderToStaticMarkup(createElement(UnlockDialog, { open: true, account: null, onClose: noop, onUnlocked: noop }))).toBe('');
  });

  it('renders the avatar, name, a password field with current-password autocomplete and the submit button', () => {
    const html = renderToStaticMarkup(createElement(UnlockDialog, { open: true, account: ACCOUNT, onClose: noop, onUnlocked: noop }));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('งานหลัก');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('ปลดล็อก');
    expect(html).not.toContain('value="secret');
  });
});

describe('PinInput smoke', () => {
  it('renders six masked numeric boxes with digit labels and no autofill, in a labelled group (th and en)', () => {
    setLanguage('th', { persist: false });
    const th = renderToStaticMarkup(createElement(PinInput, { label: 'PIN 6 หลัก', onComplete: noop }));
    expect(th).toContain('role="group"');
    expect(th).toContain('aria-label="PIN 6 หลัก"');
    expect(th.match(/type="password"/g)?.length).toBe(6);
    expect(th.match(/inputMode="numeric"/g)?.length).toBe(6);
    expect(th.match(/autoComplete="off"/g)?.length).toBe(6);
    expect(th).toContain('aria-label="หลักที่ 1 จาก 6"');
    expect(th).toContain('aria-label="หลักที่ 6 จาก 6"');
    expect(th.match(/maxLength="1"/g)?.length).toBe(6);

    setLanguage('en', { persist: false });
    const en = renderToStaticMarkup(createElement(PinInput, { label: '6-digit PIN', onComplete: noop, error: true }));
    expect(en).toContain('aria-label="Digit 3 of 6"');
    expect(en).toContain('is-error');
    expect(en).toContain('aria-invalid="true"');
    setLanguage('th', { persist: false });
  });
});

describe('AppLockPage smoke', () => {
  it('renders the full-screen PIN page with six PIN boxes and no password field (th and en)', () => {
    setLanguage('th', { persist: false });
    const html = renderToStaticMarkup(createElement(AppLockPage, { onUnlocked: noop }));
    expect(html).toContain('unlock-page');
    expect(html).toContain('ใส่ PIN เข้าโปรแกรม');
    expect(html).toContain('aria-label="PIN 6 หลัก"');
    expect(html.match(/type="password"/g)?.length).toBe(6);
    expect(html.match(/inputMode="numeric"/g)?.length).toBe(6);
    expect(html).not.toContain('current-password');
    expect(html).not.toContain('new-password');

    setLanguage('en', { persist: false });
    const en = renderToStaticMarkup(createElement(AppLockPage, { onUnlocked: noop }));
    expect(en).toContain('Enter the app PIN');
    expect(en).toContain('aria-label="6-digit PIN"');
    expect(en).toContain('aria-label="Digit 1 of 6"');
    setLanguage('th', { persist: false });
  });
});
