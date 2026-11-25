import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIP_STAGE_CODES, CLIP_STAGES, limitLabel, limitLabelMsg, PERMISSION_MODE_CODES, PERMISSION_MODE_LABELS, PERMISSION_MODES } from '../../shared/protocol';
import { ageMsg, countdownMsg, formatAge, formatCountdown } from '../../shared/usage';
import { codeOf, CodedError } from '../src/codedError';
import { CommandError } from '../src/runner';

const MIN = 60_000;

/** Every srv.* code the server or shared code can send must have a Thai entry in the web dictionary. */
function listCodes(dir: string): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    if (!f.endsWith('.ts')) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of text.matchAll(/'(srv\.[A-Za-z0-9_.]+)'/g)) out.push(m[1]);
  }
  return out;
}

describe('server codes', () => {
  it('codeOf is empty for plain errors and carries code and vars for coded ones', () => {
    expect(codeOf(new Error('x'))).toEqual({});
    expect(codeOf(new CommandError('plain'))).toEqual({});
    expect(codeOf(new CommandError('t', 'srv.clip.presetFull', { max: 40 }))).toEqual({ code: 'srv.clip.presetFull', vars: { max: 40 } });
    expect(codeOf(new CodedError('t', 'srv.x'))).toEqual({ code: 'srv.x' });
  });

  it('CommandError keeps the Thai message unchanged', () => {
    const e = new CommandError('ตั้งชื่อชุดก่อน', 'srv.clip.presetNameRequired');
    expect(e.message).toBe('ตั้งชื่อชุดก่อน');
    expect(e).toBeInstanceOf(Error);
  });

  it('countdown and age codes produce the same text as the plain helpers', () => {
    const now = 1_000_000_000_000;
    const cases = [135 * MIN, 12 * MIN, 60 * MIN, (2 * 1440 + 3 * 60 + 40) * MIN, 1440 * MIN, -1];
    for (const c of cases) {
      const m = countdownMsg(now + c, now);
      expect(m?.text).toBe(formatCountdown(now + c, now));
      expect(m?.code.startsWith('srv.usage.')).toBe(true);
    }
    expect(countdownMsg(null, now)).toBeNull();
    expect(countdownMsg(now + 135 * MIN, now)).toMatchObject({ code: 'srv.usage.resetInHM', vars: { h: 2, m: 15 } });
    for (const ago of [5_000, 5 * MIN, 5 * 60 * MIN, 50 * 60 * MIN]) {
      expect(ageMsg(now - ago, now).text).toBe(formatAge(now - ago, now));
    }
    expect(ageMsg(now - 5 * MIN, now)).toMatchObject({ code: 'srv.usage.ageMin', vars: { n: 5 } });
  });

  it('limit label code matches the text', () => {
    expect(limitLabelMsg('You hit your limit')).toEqual({ text: 'ติดลิมิต', code: 'srv.usage.limit' });
    const m = limitLabelMsg('You have hit your 5-hour limit · resets 1:30pm (Asia/Bangkok)');
    expect(m.code).toBe('srv.usage.limitReset');
    expect(m.text).toBe(limitLabel('You have hit your 5-hour limit · resets 1:30pm (Asia/Bangkok)'));
  });

  it('clip stage and permission mode codes line up with their labels', () => {
    expect(CLIP_STAGE_CODES).toHaveLength(CLIP_STAGES.length);
    for (const mode of PERMISSION_MODES) expect(PERMISSION_MODE_CODES[mode]).toBeTruthy();
    expect(PERMISSION_MODE_LABELS.default).toBe('ถามทุกครั้ง');
  });

  it('every srv.* code used by server and shared has a Thai dictionary entry', () => {
    const dict = fs.readFileSync(fileURLToPath(new URL('../../web/src/i18n/parts/server.th.ts', import.meta.url)), 'utf8');
    const keys = new Set([...dict.matchAll(/^\s+'(srv\.[^']+)':/gm)].map((m) => m[1]));
    const used = new Set([
      ...listCodes(fileURLToPath(new URL('../src/', import.meta.url))),
      ...listCodes(fileURLToPath(new URL('../../shared/', import.meta.url))),
    ]);
    const missing = [...used].filter((c) => !keys.has(c));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(50);
  });
});
