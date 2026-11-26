// Smoke test: render the dialog and the avatar to static markup, so runtime errors in the components show up.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AccountInfo, ConnectEvent } from '../../shared/accounts';
import { AccountAddDialog } from './components/AccountAddDialog';
import { AccountAvatar } from './components/AccountAvatar';

const ACCOUNT: AccountInfo = {
  id: 'work-1',
  name: 'งานหลัก',
  color: '#ef4444',
  letter: 'ง',
  note: '',
  builtin: false,
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
};

const base = {
  open: true,
  onClose: () => {},
  accounts: [ACCOUNT],
  ptyAvailable: true,
  connect: null as ConnectEvent | null,
};

describe('AccountAddDialog smoke', () => {
  it('renders nothing when closed', () => {
    expect(renderToStaticMarkup(createElement(AccountAddDialog, { ...base, open: false }))).toBe('');
  });

  it('renders step 1 (form) for a new profile', () => {
    const html = renderToStaticMarkup(createElement(AccountAddDialog, base));
    expect(html).toContain('role="dialog"');
    expect(html).toContain('เพิ่มโปรไฟล์');
    expect(html).toContain('type="submit"');
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('type="password"');
  });

  it('renders step 2 directly for an existing profile, with the paste section', () => {
    const html = renderToStaticMarkup(createElement(AccountAddDialog, { ...base, accountId: 'work-1' }));
    expect(html).toContain('เชื่อมต่อบัญชี');
    expect(html).toContain('เปิดเบราว์เซอร์เพื่อเชื่อมต่อ');
    expect(html).toContain('type="password"');
    expect(html).toContain('autoComplete="off"');
    // Paste section is closed while the pty is available.
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it('opens the paste section and drops the browser button when there is no pty', () => {
    const html = renderToStaticMarkup(createElement(AccountAddDialog, { ...base, accountId: 'work-1', ptyAvailable: false }));
    expect(html).toMatch(/<details[^>]*\sopen/);
    expect(html).not.toContain('เปิดเบราว์เซอร์เพื่อเชื่อมต่อ');
    expect(html).toContain('เครื่องนี้เชื่อมต่ออัตโนมัติไม่ได้');
  });

  it('ignores a connect event that was already present at mount (stale, see currentConnect)', () => {
    const connect: ConnectEvent = { accountId: 'work-1', status: 'waiting_browser', url: 'https://claude.ai/oauth/x' };
    const html = renderToStaticMarkup(createElement(AccountAddDialog, { ...base, accountId: 'work-1', connect }));
    expect(html).not.toContain('href="https://claude.ai/oauth/x"');
    expect(html).not.toContain('กำลังรอการอนุมัติในเบราว์เซอร์');
  });

  it('never renders a javascript: link', () => {
    const connect: ConnectEvent = { accountId: 'work-1', status: 'waiting_browser', url: 'javascript:alert(1)' };
    const html = renderToStaticMarkup(createElement(AccountAddDialog, { ...base, accountId: 'work-1', connect }));
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('เปิดลิงก์ลงชื่อเข้าใช้เอง');
  });

  it('ignores a connect event for another profile', () => {
    const connect: ConnectEvent = { accountId: 'other', status: 'captured' };
    const html = renderToStaticMarkup(createElement(AccountAddDialog, { ...base, accountId: 'work-1', connect }));
    expect(html).not.toContain('ได้รับ token แล้ว');
  });

  it('does not show a stale failed attempt that was already present at mount', () => {
    const connect: ConnectEvent = { accountId: 'work-1', status: 'failed', error: 'PTY_UNAVAILABLE' };
    const html = renderToStaticMarkup(createElement(AccountAddDialog, { ...base, accountId: 'work-1', connect }));
    expect(html).not.toContain('ลองอีกครั้ง');
    expect(html).not.toContain('เครื่องนี้ล็อกอินอัตโนมัติไม่ได้');
    expect(html).toContain('เปิดเบราว์เซอร์เพื่อเชื่อมต่อ');
  });
});

describe('AccountAvatar smoke', () => {
  it('renders the letter with the name as aria-label and a palette colour', () => {
    const html = renderToStaticMarkup(createElement(AccountAvatar, { account: { name: 'Main', color: '#22c55e', letter: 'M' }, size: 40 }));
    expect(html).toContain('aria-label="Main"');
    expect(html).toContain('>M<');
    expect(html).toContain('#22c55e');
  });

  it('falls back to a palette colour and a placeholder letter', () => {
    const html = renderToStaticMarkup(createElement(AccountAvatar, { account: { name: 'x', color: '#123456', letter: '' } }));
    expect(html).toContain('#ef4444');
    expect(html).toContain('>?<');
  });
});
