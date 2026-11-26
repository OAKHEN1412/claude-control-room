// Pure logic for the 6-digit app PIN boxes (PinInput) and the lockout countdown. No React, no I/O.
// A PIN state is always PIN_LEN cells; each cell holds one digit or '' (empty).

export const PIN_LEN = 6;

export type PinState = string[];

export interface PinStep {
  state: PinState;
  focus: number; // the box that should get the cursor next
}

/** Six empty cells. */
export function emptyPin(): PinState {
  return Array.from({ length: PIN_LEN }, () => '');
}

function clampIndex(index: number): number {
  return Math.min(Math.max(index, 0), PIN_LEN - 1);
}

function withCells(state: PinState): PinState {
  const next = state.slice(0, PIN_LEN);
  while (next.length < PIN_LEN) next.push('');
  return next;
}

/**
 * A typed character at `index`. A digit fills the cell and moves the focus on (the last cell keeps the focus).
 * Anything that is not a single 0-9 character is ignored.
 */
export function typeDigit(state: PinState, index: number, ch: string): PinStep {
  const i = clampIndex(index);
  const cells = withCells(state);
  if (!/^[0-9]$/.test(ch)) return { state: cells, focus: i };
  cells[i] = ch;
  return { state: cells, focus: Math.min(i + 1, PIN_LEN - 1) };
}

/**
 * Backspace at `index`. A filled cell is cleared and the focus stays on it. An empty cell moves the focus back
 * and clears the cell before it (the first cell stays empty and keeps the focus).
 */
export function backspace(state: PinState, index: number): PinStep {
  const i = clampIndex(index);
  const cells = withCells(state);
  if (cells[i] !== '') {
    cells[i] = '';
    return { state: cells, focus: i };
  }
  if (i === 0) return { state: cells, focus: 0 };
  cells[i - 1] = '';
  return { state: cells, focus: i - 1 };
}

/**
 * Paste `text` starting at `index`. Only the digits in the text are used (so "a1-2 3456" pastes 123456), filled
 * from `index` and cut at PIN_LEN. The focus goes to the box after the last filled one (or stays on the last box).
 * Text without digits changes nothing.
 */
export function paste(state: PinState, index: number, text: string): PinStep {
  const i = clampIndex(index);
  const cells = withCells(state);
  const digits = text.replace(/\D/g, '');
  if (digits.length === 0) return { state: cells, focus: i };
  let filled = 0;
  for (let k = 0; k < digits.length && i + k < PIN_LEN; k++) {
    cells[i + k] = digits[k];
    filled++;
  }
  return { state: cells, focus: Math.min(i + filled, PIN_LEN - 1) };
}

/** True when every cell holds a digit. */
export function isComplete(state: PinState): boolean {
  const cells = withCells(state);
  return cells.every((c) => /^[0-9]$/.test(c));
}

/** The PIN string (only meaningful when isComplete). */
export function toPin(state: PinState): string {
  return withCells(state).join('');
}

/** Milliseconds as m:ss, rounded up to the whole second so a running countdown never shows 0:00 early. 105000 -> '1:45'. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Milliseconds left until `until` (a timestamp in ms), never negative. */
export function lockoutRemaining(until: number, now: number): number {
  return Math.max(0, until - now);
}

/** The acct.pin.err.* key for a PIN error code, or null when the caller should fall back to the shared error text. */
export function pinErrorKey(code: string): string | null {
  if (code === 'BAD_PASSWORD' || code === 'BAD_PIN') return 'acct.pin.err.wrong';
  if (code === 'PIN_INVALID') return 'acct.pin.err.invalid';
  return null;
}
