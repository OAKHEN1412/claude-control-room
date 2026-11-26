// Accounts tables in WorklogDb: rows, partial updates, settings, session pins, defensive JSON, and the no-token column rule.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountUsage } from '../../shared/accounts';
import { type AccountRow, WorklogDb } from '../src/db';

const require_ = createRequire(import.meta.url);
const { DatabaseSync } = require_('node:sqlite') as typeof import('node:sqlite');

let dir: string;
let file: string;
let db: WorklogDb;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-accounts-db-'));
  file = path.join(dir, 'test.db');
  db = new WorklogDb(file);
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function row(over: Partial<AccountRow> & { id: string; createdAt: number }): AccountRow {
  return {
    name: over.id,
    color: '#ef4444',
    letter: 'A',
    note: '',
    fingerprint: null,
    tokenAt: null,
    lastCheckAt: null,
    lastCheckOk: null,
    lastUsage: null,
    hidden: false,
    ...over,
  };
}

const usage: AccountUsage = {
  fiveHour: { pct: 42, resetsAt: 1_700_000_000_000 },
  sevenDay: null,
  updatedAt: 1_699_999_000_000,
};

describe('accounts table', () => {
  it('insert then get round-trips every field, including usage JSON and nullable booleans', () => {
    db.insertAccount(row({ id: 'a1', createdAt: 10, fingerprint: 'abcd1234', tokenAt: 11, lastCheckAt: 12, lastCheckOk: true, lastUsage: usage, hidden: true, note: 'n' }));
    expect(db.getAccount('a1')).toEqual({
      id: 'a1',
      name: 'a1',
      color: '#ef4444',
      letter: 'A',
      note: 'n',
      fingerprint: 'abcd1234',
      createdAt: 10,
      tokenAt: 11,
      lastCheckAt: 12,
      lastCheckOk: true,
      lastUsage: usage,
      hidden: true,
    });
    db.insertAccount(row({ id: 'a2', createdAt: 20, lastCheckOk: false }));
    expect(db.getAccount('a2')?.lastCheckOk).toBe(false);
    expect(db.getAccount('a2')?.lastUsage).toBeNull();
    expect(db.getAccount('a2')?.hidden).toBe(false);
    expect(db.getAccount('missing')).toBeNull();
  });

  it('listAccounts is ordered by createdAt', () => {
    db.insertAccount(row({ id: 'late', createdAt: 300 }));
    db.insertAccount(row({ id: 'early', createdAt: 100 }));
    db.insertAccount(row({ id: 'mid', createdAt: 200 }));
    expect(db.listAccounts().map((a) => a.id)).toEqual(['early', 'mid', 'late']);
  });

  it('updateAccount writes only the given keys and leaves the rest alone', () => {
    db.insertAccount(row({ id: 'a1', createdAt: 1, name: 'Old', note: 'keep', fingerprint: 'ffff0000', hidden: false }));
    expect(db.updateAccount('a1', { name: 'New' })).toBe(true);
    let a = db.getAccount('a1');
    expect(a?.name).toBe('New');
    expect(a?.note).toBe('keep');
    expect(a?.fingerprint).toBe('ffff0000');

    expect(db.updateAccount('a1', { hidden: true, lastCheckOk: false, lastUsage: usage, tokenAt: 5, fingerprint: null })).toBe(true);
    a = db.getAccount('a1');
    expect(a?.hidden).toBe(true);
    expect(a?.lastCheckOk).toBe(false);
    expect(a?.lastUsage).toEqual(usage);
    expect(a?.tokenAt).toBe(5);
    expect(a?.fingerprint).toBeNull();
    expect(a?.name).toBe('New');

    expect(db.updateAccount('a1', { lastCheckOk: null, lastUsage: null })).toBe(true);
    expect(db.getAccount('a1')?.lastCheckOk).toBeNull();
    expect(db.getAccount('a1')?.lastUsage).toBeNull();
  });

  it('updateAccount: unknown id is false; an empty or undefined-only patch changes nothing', () => {
    db.insertAccount(row({ id: 'a1', createdAt: 1, name: 'Keep' }));
    expect(db.updateAccount('nope', { name: 'x' })).toBe(false);
    expect(db.updateAccount('nope', {})).toBe(false);
    expect(db.updateAccount('a1', {})).toBe(true);
    expect(db.updateAccount('a1', { name: undefined })).toBe(true);
    expect(db.getAccount('a1')?.name).toBe('Keep');
  });

  it('updateAccount ignores keys outside the whitelist (cannot reach id or created_at)', () => {
    db.insertAccount(row({ id: 'a1', createdAt: 1 }));
    const patch = { id: 'hijack', createdAt: 999, name: 'ok' } as unknown as Partial<AccountRow>;
    expect(db.updateAccount('a1', patch)).toBe(true);
    expect(db.getAccount('a1')?.name).toBe('ok');
    expect(db.getAccount('a1')?.createdAt).toBe(1);
    expect(db.getAccount('hijack')).toBeNull();
  });

  it('deleteAccount removes the row and reports unknown ids as false', () => {
    db.insertAccount(row({ id: 'a1', createdAt: 1 }));
    expect(db.deleteAccount('a1')).toBe(true);
    expect(db.getAccount('a1')).toBeNull();
    expect(db.deleteAccount('a1')).toBe(false);
  });

  it('a bad last_usage JSON reads as null, never throws', () => {
    db.insertAccount(row({ id: 'bad', createdAt: 1 }));
    db.insertAccount(row({ id: 'arr', createdAt: 2 }));
    db.insertAccount(row({ id: 'noupd', createdAt: 3 }));
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE accounts SET last_usage = ? WHERE id = ?').run('{not json', 'bad');
    raw.prepare('UPDATE accounts SET last_usage = ? WHERE id = ?').run('[1,2]', 'arr');
    raw.prepare('UPDATE accounts SET last_usage = ? WHERE id = ?').run('{"fiveHour":null}', 'noupd');
    raw.close();
    expect(db.getAccount('bad')?.lastUsage).toBeNull();
    expect(db.getAccount('arr')?.lastUsage).toBeNull();
    expect(db.getAccount('noupd')?.lastUsage).toBeNull();
    expect(db.listAccounts()).toHaveLength(3);
  });

  it('the table has exactly the expected columns and no column that could hold a token', () => {
    const raw = new DatabaseSync(file);
    const names = (raw.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map((c) => c.name);
    raw.close();
    expect(names).toEqual([
      'id',
      'name',
      'color',
      'letter',
      'note',
      'fingerprint',
      'created_at',
      'token_at',
      'last_check_at',
      'last_check_ok',
      'last_usage',
      'hidden',
    ]);
    // token_at is a timestamp; no other column may look like a secret store.
    expect(names.filter((n) => /token|secret|key|pass/i.test(n))).toEqual(['token_at']);
  });
});

describe('account settings', () => {
  it('get is null when unset; set then get; set overwrites', () => {
    expect(db.getAccountSetting('default')).toBeNull();
    db.setAccountSetting('default', 'terminal');
    expect(db.getAccountSetting('default')).toBe('terminal');
    db.setAccountSetting('default', 'a1');
    expect(db.getAccountSetting('default')).toBe('a1');
  });
});

describe('session accounts', () => {
  it('set then get; set overwrites the profile and the time', () => {
    expect(db.getSessionAccount('s1')).toBeNull();
    db.setSessionAccount('s1', 'a1', 100);
    expect(db.getSessionAccount('s1')).toBe('a1');
    db.setSessionAccount('s1', 'terminal', 200);
    expect(db.getSessionAccount('s1')).toBe('terminal');
  });

  it('prune removes rows older than the cutoff and returns the count', () => {
    db.setSessionAccount('old', 'a1', 100);
    db.setSessionAccount('edge', 'a1', 500);
    db.setSessionAccount('new', 'a1', 900);
    expect(db.pruneSessionAccounts(500)).toBe(1);
    expect(db.getSessionAccount('old')).toBeNull();
    expect(db.getSessionAccount('edge')).toBe('a1');
    expect(db.getSessionAccount('new')).toBe('a1');
    expect(db.pruneSessionAccounts(0)).toBe(0);
  });
});
