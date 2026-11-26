import { describe, expect, it } from 'vitest';
import { explain } from '../src/cr.ts';

describe('explain', () => {
  it('says the profile is locked and keeps the raw server text', () => {
    const raw = 'account is locked: enter its password first';
    const out = explain(raw);
    expect(out).toContain('โปรไฟล์นี้ล็อกด้วยรหัสผ่าน');
    expect(out).toContain('--account');
    expect(out).toContain(`(${raw})`);
  });

  it('passes unknown errors through unchanged', () => {
    expect(explain('something else')).toBe('something else');
  });
});
