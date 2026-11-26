import { describe, expect, it, afterEach } from 'vitest';
import { setLanguage } from './i18n';
import { INITIAL_DIALOGS, dialogsReducer, setAccountOutcome, unlockAccountOf, type HostDialogs } from './accountsHost';
import type { AccountInfo } from '../../shared/accounts';

afterEach(() => setLanguage('th', { persist: false }));

describe('setAccountOutcome', () => {
  it('reports ok without an error', () => {
    expect(setAccountOutcome({ ok: true })).toEqual({ ok: true });
  });

  it('falls back to the raw server error text when the code is missing', () => {
    expect(setAccountOutcome({ ok: false, error: 'boom' })).toEqual({ ok: false, error: 'boom' });
  });

  it('uses SERVER_ERROR when the server sent no text at all', () => {
    expect(setAccountOutcome({ ok: false })).toEqual({ ok: false, error: 'SERVER_ERROR' });
  });

  it('translates a known code', () => {
    setLanguage('en', { persist: false });
    const out = setAccountOutcome({ ok: false, code: 'acct.err.PTY_UNAVAILABLE', error: 'fallback' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).not.toBe('fallback');
  });
});

describe('dialogsReducer', () => {
  it('opens the add dialog with or without a profile', () => {
    const a = dialogsReducer(INITIAL_DIALOGS, { type: 'openAdd', accountId: 'work' });
    expect(a).toMatchObject({ addOpen: true, addAccountId: 'work' });
    const b = dialogsReducer(a, { type: 'openAdd' });
    expect(b).toMatchObject({ addOpen: true, addAccountId: undefined });
  });

  it('closes the add dialog, and returns the same object when already closed', () => {
    const open = dialogsReducer(INITIAL_DIALOGS, { type: 'openAdd' });
    expect(dialogsReducer(open, { type: 'closeAdd' }).addOpen).toBe(false);
    expect(dialogsReducer(INITIAL_DIALOGS, { type: 'closeAdd' })).toBe(INITIAL_DIALOGS);
  });

  it('keeps the unlock request, including its callback, until closed', () => {
    let ran = 0;
    const s = dialogsReducer(INITIAL_DIALOGS, { type: 'openUnlock', accountId: 'vault', then: () => ran++ });
    expect(s.unlock?.accountId).toBe('vault');
    s.unlock?.then?.();
    expect(ran).toBe(1);
    expect(dialogsReducer(s, { type: 'closeUnlock' }).unlock).toBeNull();
    expect(dialogsReducer(INITIAL_DIALOGS, { type: 'closeUnlock' })).toBe(INITIAL_DIALOGS);
  });

  it('does not touch the add dialog when the unlock dialog changes', () => {
    const add: HostDialogs = dialogsReducer(INITIAL_DIALOGS, { type: 'openAdd', accountId: 'x' });
    const s = dialogsReducer(add, { type: 'openUnlock', accountId: 'y' });
    expect(s).toMatchObject({ addOpen: true, addAccountId: 'x' });
  });
});

describe('unlockAccountOf', () => {
  const accounts = [{ id: 'vault' }, { id: 'work' }] as AccountInfo[];

  it('finds the requested profile, or null when none is requested or it is unknown', () => {
    expect(unlockAccountOf(accounts, { accountId: 'work' })).toBe(accounts[1]);
    expect(unlockAccountOf(accounts, { accountId: 'gone' })).toBeNull();
    expect(unlockAccountOf(accounts, null)).toBeNull();
  });
});
