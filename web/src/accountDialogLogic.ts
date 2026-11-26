// Pure logic for the add-profile dialog (AccountAddDialog) and the shared avatar colours. No React, no I/O.
import {
  ACCOUNT_COLORS,
  ACCOUNT_LETTER_MAX,
  ACCOUNT_NAME_MAX,
  ACCOUNT_NOTE_MAX,
  TOKEN_RE,
  defaultLetter,
  type ConnectEvent,
  type ConnectStatus,
} from '../../shared/accounts';

export type DialogStep = 'form' | 'connect';

/** What the connect step shows: 'idle' when no connect event belongs to this profile yet, else the event status. */
export type ConnectViewKind = 'idle' | ConnectStatus;

export interface ProfileForm {
  name: string;
  color: string;
  /** The letter as the user left it. Ignored until letterEdited is true. */
  letter: string;
  /** False = the letter follows defaultLetter(name); true = the user typed it. */
  letterEdited: boolean;
  note: string;
}

export interface StatusView {
  kind: ConnectViewKind;
  /** The browser link may be shown: waiting for approval and the url is https. */
  showLink: boolean;
  /** The url attached to the event is https (never javascript:, http: or junk). */
  urlSafe: boolean;
  /** Done, but the token check after saving failed. */
  checkFailed: boolean;
}

/** Number of user-visible characters (code points), the same count the server uses. */
export function charCount(s: string): number {
  return [...s].length;
}

/** Name as the server stores it: trimmed, inner whitespace collapsed. */
export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Characters left for the name, shown as a counter. Negative when over the limit. */
export function nameLeft(name: string): number {
  return ACCOUNT_NAME_MAX - charCount(normalizeName(name));
}

/** Step 1 is skipped when the dialog is opened for an existing profile (reconnect / replace token). */
export function initialStep(hasAccountId: boolean): DialogStep {
  return hasAccountId ? 'connect' : 'form';
}

/** Moves from the form to the connect step, but only after the profile was created. */
export function nextStep(step: DialogStep, createOk: boolean): DialogStep {
  return step === 'form' && createOk ? 'connect' : step;
}

/** First palette colour no existing profile uses; when all are used, cycle by count. */
export function pickDefaultColor(accounts: readonly { color: string }[]): string {
  const used = new Set(accounts.map((a) => a.color));
  return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
}

/** Letter the avatar and the create call use: the auto value until the user edits it, then their text. */
export function effectiveLetter(form: Pick<ProfileForm, 'name' | 'letter' | 'letterEdited'>): string {
  if (!form.letterEdited) return defaultLetter(form.name);
  return form.letter.trim().toUpperCase();
}

/** Step 1 is valid: name 1..40, a palette colour, a letter 1..2 chars, note up to 80 chars. */
export function canProceed(form: ProfileForm): boolean {
  const n = charCount(normalizeName(form.name));
  if (n < 1 || n > ACCOUNT_NAME_MAX) return false;
  if (!(ACCOUNT_COLORS as readonly string[]).includes(form.color)) return false;
  const letterLen = charCount(effectiveLetter(form));
  if (letterLen < 1 || letterLen > ACCOUNT_LETTER_MAX) return false;
  if (charCount(form.note.trim()) > ACCOUNT_NOTE_MAX) return false;
  return true;
}

/** Body for POST /api/accounts built from a valid form. */
export function toCreateInput(form: ProfileForm): { name: string; color: string; letter: string; note: string } {
  return {
    name: normalizeName(form.name),
    color: form.color,
    letter: effectiveLetter(form),
    note: form.note.trim(),
  };
}

/** Avatar colour: the stored colour when it is in the palette, else the first palette colour. */
export function avatarColor(color: string): string {
  return (ACCOUNT_COLORS as readonly string[]).includes(color) ? color : ACCOUNT_COLORS[0];
}

/** Black or white letter, whichever reads better on the avatar colour (WCAG relative luminance). */
export function avatarInk(color: string): '#000000' | '#ffffff' {
  const hex = avatarColor(color).slice(1);
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  // Contrast with black = (L + 0.05) / 0.05; with white = 1.05 / (L + 0.05). Pick the larger.
  return (lum + 0.05) / 0.05 >= 1.05 / (lum + 0.05) ? '#000000' : '#ffffff';
}

/** Only an https url may become a link. javascript:, http:, data: and junk all return false. */
export function isSafeUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url.startsWith('https://')) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The connect event the dialog may act on. `initial` is the event that was already present when the dialog
 * mounted: it is stale (e.g. an old 'done' from an earlier connect), so it is ignored until a different
 * event object arrives. Returns null when there is no current event.
 */
export function currentConnect(
  initial: ConnectEvent | null | undefined,
  latest: ConnectEvent | null | undefined,
): ConnectEvent | null {
  if (!latest || latest === initial) return null;
  return latest;
}

/** Maps the live connect event to what step 2 shows. Events for other profiles are ignored. */
export function statusView(e: ConnectEvent | null | undefined, accountId: string): StatusView {
  if (!e || e.accountId !== accountId) return { kind: 'idle', showLink: false, urlSafe: false, checkFailed: false };
  const urlSafe = isSafeUrl(e.url);
  return {
    kind: e.status,
    showLink: e.status === 'waiting_browser' && urlSafe,
    urlSafe,
    checkFailed: e.status === 'done' && e.checkOk === false,
  };
}

/** A connect attempt is running: the cancel button and the close-cleanup apply. */
export function isConnectBusy(kind: ConnectViewKind): boolean {
  return kind === 'waiting_browser' || kind === 'captured' || kind === 'checking';
}

/** The last attempt ended without a token: offer a retry. */
export function canRetry(kind: ConnectViewKind): boolean {
  return kind === 'failed' || kind === 'timeout' || kind === 'cancelled';
}

/** Cancel is offered only while the browser approval is pending. */
export function canCancel(kind: ConnectViewKind): boolean {
  return kind === 'waiting_browser';
}

/** Token input is trimmed before the shape check and before it is sent. */
export function normalizeToken(raw: string): string {
  return raw.trim();
}

export function isValidToken(raw: string): boolean {
  return TOKEN_RE.test(normalizeToken(raw));
}

/**
 * Close-time cleanup of a profile this dialog created: delete it when no token was saved.
 * tokenState is the latest accounts entry's state (undefined when the entry is not known yet).
 */
export function shouldCleanupOnClose(input: { createdHere: boolean; tokenState: 'set' | 'unset' | undefined; sawDone: boolean }): boolean {
  if (!input.createdHere) return false;
  if (input.sawDone) return false;
  return input.tokenState !== 'set';
}

/** A running connect is cancelled before the profile is deleted on close. */
export function shouldCancelOnClose(kind: ConnectViewKind): boolean {
  return isConnectBusy(kind);
}
