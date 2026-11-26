import { describe, expect, it } from 'vitest';
import { PIN_LEN, backspace, emptyPin, formatCountdown, isComplete, lockoutRemaining, paste, pinErrorKey, toPin, typeDigit, type PinState } from './pinLogic';

const cells = (...c: string[]): PinState => [...c, ...Array.from({ length: PIN_LEN - c.length }, () => '')];

describe('pinLogic', () => {
  it('has six cells and starts empty', () => {
    expect(PIN_LEN).toBe(6);
    expect(emptyPin()).toEqual(['', '', '', '', '', '']);
    expect(toPin(emptyPin())).toBe('');
  });

  describe('typeDigit', () => {
    it('fills the cell and advances the focus', () => {
      expect(typeDigit(emptyPin(), 0, '7')).toEqual({ state: cells('7'), focus: 1 });
      expect(typeDigit(cells('1', '2'), 2, '3')).toEqual({ state: cells('1', '2', '3'), focus: 3 });
    });

    it('keeps the focus on the last cell when the last cell is filled', () => {
      expect(typeDigit(cells('1', '2', '3', '4', '5'), 5, '6')).toEqual({ state: cells('1', '2', '3', '4', '5', '6'), focus: 5 });
    });

    it('ignores anything that is not a single digit', () => {
      expect(typeDigit(cells('1'), 1, 'a')).toEqual({ state: cells('1'), focus: 1 });
      expect(typeDigit(cells('1'), 1, '12')).toEqual({ state: cells('1'), focus: 1 });
      expect(typeDigit(cells('1'), 1, ' ')).toEqual({ state: cells('1'), focus: 1 });
    });

    it('overwrites a filled cell', () => {
      expect(typeDigit(cells('1', '2'), 0, '9')).toEqual({ state: cells('9', '2'), focus: 1 });
    });
  });

  describe('backspace', () => {
    it('clears a filled cell and keeps the focus on it', () => {
      expect(backspace(cells('1', '2', '3'), 1)).toEqual({ state: cells('1', '', '3'), focus: 1 });
    });

    it('on an empty cell moves back and clears the previous cell', () => {
      expect(backspace(cells('1', '2'), 2)).toEqual({ state: cells('1', ''), focus: 1 });
    });

    it('on the first empty cell stays at the start', () => {
      expect(backspace(emptyPin(), 0)).toEqual({ state: emptyPin(), focus: 0 });
    });
  });

  describe('paste', () => {
    it('fills all six cells from a six-digit paste', () => {
      expect(paste(emptyPin(), 0, '123456')).toEqual({ state: cells('1', '2', '3', '4', '5', '6'), focus: 5 });
    });

    it('takes only the digits from a messy paste', () => {
      expect(paste(emptyPin(), 0, 'a1-2 3456')).toEqual({ state: cells('1', '2', '3', '4', '5', '6'), focus: 5 });
    });

    it('fills from the middle and puts the focus after the last filled cell', () => {
      expect(paste(cells('1', '2'), 2, '34')).toEqual({ state: cells('1', '2', '3', '4'), focus: 4 });
    });

    it('cuts a long paste at six digits', () => {
      expect(paste(emptyPin(), 0, '12345678')).toEqual({ state: cells('1', '2', '3', '4', '5', '6'), focus: 5 });
    });

    it('changes nothing for text without digits', () => {
      expect(paste(cells('1'), 1, 'abc')).toEqual({ state: cells('1'), focus: 1 });
    });
  });

  describe('completion', () => {
    it('is complete only when all six cells hold a digit', () => {
      expect(isComplete(cells('1', '2', '3', '4', '5'))).toBe(false);
      expect(isComplete(cells('1', '2', '3', '4', '5', '6'))).toBe(true);
      expect(isComplete(cells('1', '2', '', '4', '5', '6'))).toBe(false);
    });

    it('joins the cells into the PIN', () => {
      expect(toPin(cells('0', '0', '4', '2', '1', '9'))).toBe('004219');
    });
  });

  describe('formatCountdown', () => {
    it('formats m:ss and rounds up to the whole second', () => {
      expect(formatCountdown(105000)).toBe('1:45');
      expect(formatCountdown(30000)).toBe('0:30');
      expect(formatCountdown(600000)).toBe('10:00');
      expect(formatCountdown(1500)).toBe('0:02');
      expect(formatCountdown(0)).toBe('0:00');
      expect(formatCountdown(-5)).toBe('0:00');
    });
  });

  describe('lockoutRemaining', () => {
    it('is the time left, never negative', () => {
      expect(lockoutRemaining(10_000, 4_000)).toBe(6_000);
      expect(lockoutRemaining(10_000, 12_000)).toBe(0);
    });
  });

  describe('pinErrorKey', () => {
    it('maps a wrong PIN and an invalid format to their keys', () => {
      expect(pinErrorKey('BAD_PASSWORD')).toBe('acct.pin.err.wrong');
      expect(pinErrorKey('PIN_INVALID')).toBe('acct.pin.err.invalid');
    });

    it('returns null for other codes', () => {
      expect(pinErrorKey('TOO_MANY_TRIES')).toBeNull();
      expect(pinErrorKey('NETWORK')).toBeNull();
    });
  });
});
