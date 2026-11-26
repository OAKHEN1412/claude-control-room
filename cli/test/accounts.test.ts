import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../shared/accounts.ts';
import { resolveAccount } from '../src/accounts.ts';

const acc = (id: string, name: string, over: Partial<AccountInfo> = {}): AccountInfo => ({
  id,
  name,
  color: '#ef4444',
  letter: 'A',
  note: '',
  builtin: false,
  tokenState: 'set',
  fingerprint: 'abcd1234',
  createdAt: 1,
  tokenAt: 1,
  expiresAt: 2,
  lastCheckAt: null,
  lastCheckOk: null,
  usage: null,
  hidden: false,
  locked: false, hasPassword: false,
  ...over,
});

const terminal = acc('terminal', 'Terminal login', { builtin: true, tokenState: 'unset', fingerprint: null, tokenAt: null, expiresAt: null });
const work = acc('work-1', 'Work Account');
const home = acc('home', 'Shared');
const homeTwo = acc('home-2', 'shared');
const hidden = acc('old-one', 'Archive', { hidden: true });
const noToken = acc('fresh', 'Fresh', { tokenState: 'unset', fingerprint: null, tokenAt: null, expiresAt: null });
const all = [terminal, work, home, homeTwo, hidden, noToken];

describe('resolveAccount', () => {
  it('matches an id case-insensitively first', () => {
    expect(resolveAccount('WORK-1', all)).toEqual({ ok: true, id: 'work-1' });
    expect(resolveAccount('  work-1 ', all)).toEqual({ ok: true, id: 'work-1' });
  });

  it('the Terminal profile matches "terminal", its full name and a prefix of its name', () => {
    expect(resolveAccount('terminal', all)).toEqual({ ok: true, id: 'terminal' });
    expect(resolveAccount('Terminal Login', all)).toEqual({ ok: true, id: 'terminal' });
    expect(resolveAccount('term', all)).toEqual({ ok: true, id: 'terminal' });
  });

  it('matches an exact name, then a unique name prefix', () => {
    expect(resolveAccount('work account', all)).toEqual({ ok: true, id: 'work-1' });
    expect(resolveAccount('wor', all)).toEqual({ ok: true, id: 'work-1' });
  });

  it('a name shared by two profiles is ambiguous (the id still works)', () => {
    const r = resolveAccount('Shared', all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ตรงกับหลายตัว');
    expect(resolveAccount('home-2', all)).toEqual({ ok: true, id: 'home-2' });
    expect(resolveAccount('home', all)).toEqual({ ok: true, id: 'home' }); // exact id beats the shared name
  });

  it('a name prefix matching several profiles is ambiguous', () => {
    const r = resolveAccount('w', [work, acc('wx', 'Wallet')]);
    expect(r.ok).toBe(false);
  });

  it('an id wins over a name that equals it', () => {
    const list = [acc('ops', 'Other'), acc('x1', 'ops')];
    expect(resolveAccount('ops', list)).toEqual({ ok: true, id: 'ops' });
  });

  it('hidden profiles are still selectable', () => {
    expect(resolveAccount('old-one', all)).toEqual({ ok: true, id: 'old-one' });
    expect(resolveAccount('Archive', all)).toEqual({ ok: true, id: 'old-one' });
  });

  it('unknown or empty input fails in Thai and lists the available ids', () => {
    for (const input of ['nope', '', '   ']) {
      const r = resolveAccount(input, all);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('ไม่พบโปรไฟล์');
        expect(r.error).toContain('terminal, work-1, home, home-2, old-one, fresh');
      }
    }
    const none = resolveAccount('x', []);
    expect(!none.ok && none.error).toContain('ยังไม่มีโปรไฟล์');
  });

  it('a profile without a token is refused with the Thai message', () => {
    const r = resolveAccount('fresh', all);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('ยังไม่ได้เชื่อมต่อ token');
  });

  it('the error text never contains a token-looking value', () => {
    const r = resolveAccount('zzz', [acc('a', 'A', { fingerprint: 'deadbeef' })]);
    expect(!r.ok && r.error).not.toMatch(/sk-ant-/);
  });
});
