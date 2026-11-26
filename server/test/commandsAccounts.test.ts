import { describe, expect, it } from 'vitest';
import { parseClientMsg } from '../src/commands';

const base = {
  reqId: 'r1',
  cwd: 'C:/work',
  model: 'sonnet',
  effort: 'high',
  prompt: 'hi',
};

describe('parseClientMsg set_account', () => {
  it('accepts a valid sessionId and accountId', () => {
    const r = parseClientMsg({ type: 'set_account', reqId: 'r1', sessionId: 'sess-1', accountId: 'work-2' });
    expect(r).toEqual({ ok: true, msg: { type: 'set_account', reqId: 'r1', sessionId: 'sess-1', accountId: 'work-2' } });
  });

  it('accepts the built-in terminal id', () => {
    const r = parseClientMsg({ type: 'set_account', reqId: 'r1', sessionId: 'sess-1', accountId: 'terminal' });
    expect(r.ok).toBe(true);
  });

  it('rejects an accountId that does not match ACCOUNT_ID_RE', () => {
    for (const accountId of ['Work', 'a b', '', '../x', 'a'.repeat(65), 'a_b', 5, undefined]) {
      const r = parseClientMsg({ type: 'set_account', reqId: 'r1', sessionId: 'sess-1', accountId });
      expect(r).toEqual({ ok: false, error: 'accountId invalid', reqId: 'r1' });
    }
  });

  it('rejects a missing or invalid sessionId', () => {
    expect(parseClientMsg({ type: 'set_account', reqId: 'r1', accountId: 'work' })).toEqual({ ok: false, error: 'sessionId invalid', reqId: 'r1' });
    expect(parseClientMsg({ type: 'set_account', reqId: 'r1', sessionId: '../../x', accountId: 'work' })).toEqual({ ok: false, error: 'sessionId invalid', reqId: 'r1' });
  });
});

describe('parseClientMsg start with accountId', () => {
  it('keeps a valid accountId', () => {
    const r = parseClientMsg({ type: 'start', ...base, accountId: 'work-2' });
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === 'start') expect(r.msg.accountId).toBe('work-2');
  });

  it('leaves accountId absent when the field is absent', () => {
    const r = parseClientMsg({ type: 'start', ...base });
    expect(r.ok).toBe(true);
    if (r.ok) expect('accountId' in r.msg).toBe(false);
  });

  it('rejects an accountId that does not match ACCOUNT_ID_RE', () => {
    for (const accountId of ['Work', 'bad id', '', 'x'.repeat(65), 7, null]) {
      const r = parseClientMsg({ type: 'start', ...base, accountId });
      expect(r).toEqual({ ok: false, error: 'accountId invalid', reqId: 'r1' });
    }
  });
});
