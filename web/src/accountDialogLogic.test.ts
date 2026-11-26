import { describe, expect, it } from 'vitest';
import { ACCOUNT_COLORS, type ConnectEvent } from '../../shared/accounts';
import {
  avatarColor,
  avatarInk,
  canCancel,
  currentConnect,
  canProceed,
  canRetry,
  charCount,
  effectiveLetter,
  initialStep,
  isConnectBusy,
  isSafeUrl,
  isValidToken,
  nameLeft,
  nextStep,
  normalizeName,
  normalizeToken,
  pickDefaultColor,
  shouldCancelOnClose,
  shouldCleanupOnClose,
  statusView,
  toCreateInput,
  type ProfileForm,
} from './accountDialogLogic';

const VALID_TOKEN = 'sk-ant-oat01-' + 'a'.repeat(60);

function form(over: Partial<ProfileForm> = {}): ProfileForm {
  return { name: 'Main', color: ACCOUNT_COLORS[0], letter: '', letterEdited: false, note: '', ...over };
}

describe('charCount / name helpers', () => {
  it('counts code points, so Thai and emoji count once each', () => {
    expect(charCount('สมชาย')).toBe(5);
    expect(charCount('a😀b')).toBe(3);
    expect(charCount('')).toBe(0);
  });

  it('normalizes the name like the server: trim and collapse inner whitespace', () => {
    expect(normalizeName('  Main   work \t acct ')).toBe('Main work acct');
  });

  it('counts remaining name characters from the normalized name', () => {
    expect(nameLeft('')).toBe(40);
    expect(nameLeft('  a   b  ')).toBe(37);
    expect(nameLeft('x'.repeat(41))).toBe(-1);
  });
});

describe('step machine', () => {
  it('starts on the form, or straight on connect when an account id is given', () => {
    expect(initialStep(false)).toBe('form');
    expect(initialStep(true)).toBe('connect');
  });

  it('moves form -> connect only after a successful create', () => {
    expect(nextStep('form', true)).toBe('connect');
    expect(nextStep('form', false)).toBe('form');
    expect(nextStep('connect', true)).toBe('connect');
  });
});

describe('pickDefaultColor', () => {
  it('returns the first palette colour no existing profile uses', () => {
    expect(pickDefaultColor([])).toBe(ACCOUNT_COLORS[0]);
    expect(pickDefaultColor([{ color: ACCOUNT_COLORS[0] }])).toBe(ACCOUNT_COLORS[1]);
    expect(pickDefaultColor([{ color: ACCOUNT_COLORS[0] }, { color: ACCOUNT_COLORS[2] }])).toBe(ACCOUNT_COLORS[1]);
  });

  it('skips colours in use even when they are out of order', () => {
    const used = ACCOUNT_COLORS.slice(0, 3).map((color) => ({ color }));
    expect(pickDefaultColor(used)).toBe(ACCOUNT_COLORS[3]);
  });

  it('cycles by count once every colour is used', () => {
    const all = ACCOUNT_COLORS.map((color) => ({ color }));
    expect(pickDefaultColor(all)).toBe(ACCOUNT_COLORS[all.length % ACCOUNT_COLORS.length]);
  });

  it('ignores colours that are not in the palette', () => {
    expect(pickDefaultColor([{ color: '#123456' }])).toBe(ACCOUNT_COLORS[0]);
  });
});

describe('letter auto-fill vs edited', () => {
  it('follows the name until the user edits the letter', () => {
    expect(effectiveLetter(form({ name: 'hello world' }))).toBe('HW');
    expect(effectiveLetter(form({ name: 'สมชาย' }))).toBe('ส');
    expect(effectiveLetter(form({ name: 'Main' }))).toBe('M');
  });

  it('uses the typed letter, trimmed and upper-cased, once edited', () => {
    expect(effectiveLetter(form({ name: 'Main', letter: ' ab ', letterEdited: true }))).toBe('AB');
  });

  it('keeps an edited letter when the name changes', () => {
    expect(effectiveLetter(form({ name: 'Other', letter: 'Z', letterEdited: true }))).toBe('Z');
  });

  it('an emptied letter stays empty once edited (the form then cannot proceed)', () => {
    expect(effectiveLetter(form({ name: 'Main', letter: '', letterEdited: true }))).toBe('');
  });

  it('auto letter for a name with no letters is "?"', () => {
    expect(effectiveLetter(form({ name: '' }))).toBe('?');
  });
});

describe('canProceed', () => {
  it('accepts a valid form', () => {
    expect(canProceed(form())).toBe(true);
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(canProceed(form({ name: '' }))).toBe(false);
    expect(canProceed(form({ name: '   ' }))).toBe(false);
  });

  it('accepts a 40-character name and rejects 41', () => {
    expect(canProceed(form({ name: 'n'.repeat(40) }))).toBe(true);
    expect(canProceed(form({ name: 'n'.repeat(41) }))).toBe(false);
  });

  it('rejects a colour outside the palette', () => {
    expect(canProceed(form({ color: '#000000' }))).toBe(false);
  });

  it('rejects an empty edited letter and accepts a 2-char one', () => {
    expect(canProceed(form({ letter: '', letterEdited: true }))).toBe(false);
    expect(canProceed(form({ letter: 'ABC', letterEdited: true }))).toBe(false);
    expect(canProceed(form({ letter: 'AB', letterEdited: true }))).toBe(true);
  });

  it('allows a note up to 80 characters and rejects 81', () => {
    expect(canProceed(form({ note: 'x'.repeat(80) }))).toBe(true);
    expect(canProceed(form({ note: 'x'.repeat(81) }))).toBe(false);
  });

  it('does not count surrounding note whitespace', () => {
    expect(canProceed(form({ note: '  ' + 'x'.repeat(80) + '  ' }))).toBe(true);
  });
});

describe('toCreateInput', () => {
  it('builds the create body from the form, normalized', () => {
    expect(toCreateInput(form({ name: '  Main   work ', note: ' แผนหลัก ' }))).toEqual({
      name: 'Main work',
      color: ACCOUNT_COLORS[0],
      letter: 'MW',
      note: 'แผนหลัก',
    });
  });

  it('sends the edited letter, not the auto one', () => {
    expect(toCreateInput(form({ letter: 'q', letterEdited: true })).letter).toBe('Q');
  });
});

describe('avatar colour and ink', () => {
  it('falls back to the first palette colour for an unknown colour', () => {
    expect(avatarColor('#123456')).toBe(ACCOUNT_COLORS[0]);
    expect(avatarColor(ACCOUNT_COLORS[3])).toBe(ACCOUNT_COLORS[3]);
  });

  it('picks the ink with the higher contrast for every palette colour', () => {
    const lum = (hex: string): number => {
      const ch = (i: number): number => {
        const c = parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
    };
    for (const c of ACCOUNT_COLORS) {
      const L = lum(c);
      const black = (L + 0.05) / 0.05;
      const white = 1.05 / (L + 0.05);
      expect(avatarInk(c)).toBe(black >= white ? '#000000' : '#ffffff');
    }
  });

  it('indigo gets black ink (higher WCAG contrast than white, about 4.7 vs 4.5)', () => {
    expect(avatarInk('#6366f1')).toBe('#000000');
  });
});

describe('isSafeUrl (only https may become a link)', () => {
  it('accepts an https url', () => {
    expect(isSafeUrl('https://claude.ai/oauth/authorize?x=1')).toBe(true);
  });

  it('rejects javascript:, http:, data: and non-strings', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('http://claude.ai/x')).toBe(false);
    expect(isSafeUrl('data:text/html,hi')).toBe(false);
    expect(isSafeUrl('HTTPS://claude.ai/x')).toBe(false);
    expect(isSafeUrl(undefined)).toBe(false);
    expect(isSafeUrl(42)).toBe(false);
    expect(isSafeUrl('https://')).toBe(false);
  });
});

describe('statusView', () => {
  const id = 'work-1';

  it('is idle when there is no event or the event is for another profile', () => {
    expect(statusView(null, id).kind).toBe('idle');
    expect(statusView(undefined, id).kind).toBe('idle');
    expect(statusView({ accountId: 'other', status: 'captured' }, id).kind).toBe('idle');
  });

  it('shows the link only while waiting with an https url', () => {
    const v = statusView({ accountId: id, status: 'waiting_browser', url: 'https://claude.ai/x' }, id);
    expect(v).toEqual({ kind: 'waiting_browser', showLink: true, urlSafe: true, checkFailed: false });
  });

  it('never links a javascript: or http: url, but still reports the status', () => {
    const js = statusView({ accountId: id, status: 'waiting_browser', url: 'javascript:void(0)' }, id);
    expect(js).toEqual({ kind: 'waiting_browser', showLink: false, urlSafe: false, checkFailed: false });
    const http = statusView({ accountId: id, status: 'waiting_browser', url: 'http://claude.ai/x' }, id);
    expect(http.showLink).toBe(false);
  });

  it('does not show a link without a url', () => {
    expect(statusView({ accountId: id, status: 'waiting_browser' }, id).showLink).toBe(false);
  });

  it('does not show a link outside the waiting state even with a safe url', () => {
    expect(statusView({ accountId: id, status: 'captured', url: 'https://claude.ai/x' }, id).showLink).toBe(false);
  });

  it('flags a failed token check after done', () => {
    expect(statusView({ accountId: id, status: 'done', checkOk: false }, id).checkFailed).toBe(true);
    expect(statusView({ accountId: id, status: 'done', checkOk: true }, id).checkFailed).toBe(false);
    expect(statusView({ accountId: id, status: 'done' }, id).checkFailed).toBe(false);
  });

  it('passes through the other statuses', () => {
    for (const status of ['captured', 'checking', 'done', 'failed', 'timeout', 'cancelled'] as const) {
      expect(statusView({ accountId: id, status }, id).kind).toBe(status);
    }
  });
});

describe('connect button rules', () => {
  it('busy while the browser approval, capture or check is running', () => {
    expect(isConnectBusy('waiting_browser')).toBe(true);
    expect(isConnectBusy('captured')).toBe(true);
    expect(isConnectBusy('checking')).toBe(true);
    expect(isConnectBusy('idle')).toBe(false);
    expect(isConnectBusy('done')).toBe(false);
    expect(isConnectBusy('failed')).toBe(false);
  });

  it('retry offered after failed, timeout or cancelled only', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('timeout')).toBe(true);
    expect(canRetry('cancelled')).toBe(true);
    expect(canRetry('waiting_browser')).toBe(false);
    expect(canRetry('done')).toBe(false);
    expect(canRetry('idle')).toBe(false);
  });

  it('cancel offered only while waiting for the browser', () => {
    expect(canCancel('waiting_browser')).toBe(true);
    expect(canCancel('captured')).toBe(false);
    expect(canCancel('checking')).toBe(false);
  });
});

describe('token input (shape check uses TOKEN_RE)', () => {
  it('accepts a well-formed token with surrounding whitespace trimmed', () => {
    expect(isValidToken(VALID_TOKEN)).toBe(true);
    expect(isValidToken('  ' + VALID_TOKEN + '\n')).toBe(true);
    expect(normalizeToken('  ' + VALID_TOKEN + ' ')).toBe(VALID_TOKEN);
  });

  it('rejects a wrong prefix, a short body, a long body and bad characters', () => {
    expect(isValidToken('sk-ant-api03-' + 'a'.repeat(60))).toBe(false);
    expect(isValidToken('sk-ant-oat01-' + 'a'.repeat(59))).toBe(false);
    expect(isValidToken('sk-ant-oat01-' + 'a'.repeat(201))).toBe(false);
    expect(isValidToken('sk-ant-oat01-' + 'a'.repeat(59) + '!')).toBe(false);
    expect(isValidToken('')).toBe(false);
    expect(isValidToken('sk-ant-oat01-' + 'a'.repeat(30) + ' ' + 'a'.repeat(30))).toBe(false);
  });
});

describe('shouldCleanupOnClose', () => {
  it('deletes a profile this dialog created that never got a token', () => {
    expect(shouldCleanupOnClose({ createdHere: true, tokenState: 'unset', sawDone: false })).toBe(true);
  });

  it('deletes when the latest entry is not known yet and no done was seen', () => {
    expect(shouldCleanupOnClose({ createdHere: true, tokenState: undefined, sawDone: false })).toBe(true);
  });

  it('keeps the profile once a token is set in the latest entry', () => {
    expect(shouldCleanupOnClose({ createdHere: true, tokenState: 'set', sawDone: false })).toBe(false);
  });

  it('keeps the profile once done was seen, even if the entry is stale', () => {
    expect(shouldCleanupOnClose({ createdHere: true, tokenState: 'unset', sawDone: true })).toBe(false);
  });

  it('never deletes a profile that already existed (not created here)', () => {
    expect(shouldCleanupOnClose({ createdHere: false, tokenState: 'unset', sawDone: false })).toBe(false);
  });
});

describe('shouldCancelOnClose', () => {
  it('cancels a running connect before the cleanup delete', () => {
    expect(shouldCancelOnClose('waiting_browser')).toBe(true);
    expect(shouldCancelOnClose('checking')).toBe(true);
    expect(shouldCancelOnClose('idle')).toBe(false);
    expect(shouldCancelOnClose('failed')).toBe(false);
  });
});

describe('currentConnect', () => {
  const oldDone: ConnectEvent = { accountId: 'a1', status: 'done', checkOk: true };
  const newWaiting: ConnectEvent = { accountId: 'a1', status: 'waiting_browser', url: 'https://claude.ai/x' };

  it('ignores the event that was already present at mount, even when it is a final one', () => {
    expect(currentConnect(oldDone, oldDone)).toBeNull();
  });

  it('takes a different event object as current', () => {
    expect(currentConnect(oldDone, newWaiting)).toBe(newWaiting);
  });

  it('takes a new event object even when it has the same status as the one at mount', () => {
    const again: ConnectEvent = { accountId: 'a1', status: 'done', checkOk: true };
    expect(currentConnect(oldDone, again)).toBe(again);
  });

  it('accepts an event that arrives after an empty mount', () => {
    expect(currentConnect(null, newWaiting)).toBe(newWaiting);
    expect(currentConnect(undefined, oldDone)).toBe(oldDone);
  });

  it('returns null when there is no event at all', () => {
    expect(currentConnect(null, null)).toBeNull();
    expect(currentConnect(undefined, undefined)).toBeNull();
  });
});
