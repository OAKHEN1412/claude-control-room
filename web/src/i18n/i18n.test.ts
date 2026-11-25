import { afterEach, describe, expect, it } from 'vitest';
import { applyConfigLanguage, getLanguage, setLanguage, t, tx } from './index';
import { th } from './th';
import { en } from './en';

afterEach(() => setLanguage('th', { persist: false }));

describe('i18n', () => {
  it('en has exactly the th keys, with no Thai text left in English values', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(th).sort());
    for (const [k, v] of Object.entries(en)) expect(v, k).not.toMatch(/[฀-๿]/);
  });

  it('placeholders match between th and en', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const k of Object.keys(th)) expect(vars(en[k] ?? ''), k).toBe(vars((th as Record<string, string>)[k]));
  });

  it('switches language and interpolates', () => {
    setLanguage('en', { persist: false });
    expect(getLanguage()).toBe('en');
    expect(t('lang.toggle')).toBe(en['lang.toggle']);
    setLanguage('th', { persist: false });
    expect(t('lang.toggle')).toBe(th['lang.toggle']);
  });

  it('tx falls back for unknown keys', () => {
    expect(tx('srv.nope.nothing', undefined, 'fallback')).toBe('fallback');
    expect(tx(undefined, undefined, 'x')).toBe('x');
  });

  it('config language applies, ignoring invalid values', () => {
    applyConfigLanguage('en');
    expect(getLanguage()).toBe('en');
    applyConfigLanguage('auto');
    expect(getLanguage()).toBe('en');
  });
});
