// Pure logic of the composer's slash menu: when it is open, how commands are ranked, what a key does,
// and what inserting a command does to the text. No DOM here (tested in slashMenu.test.ts).
import type { SlashCommand } from '../../shared/protocol';

export const MENU_MAX = 60; // rows kept (the list scrolls; about 12 are visible)

/**
 * The text typed after the leading "/" when the menu should be open, else null.
 * Open only while the text starts with "/" and the caret is still inside that first token (no whitespace before it).
 */
export function slashQuery(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const c = Math.max(0, Math.min(caret, text.length));
  if (c < 1) return null;
  const head = text.slice(1, c);
  if (/\s/.test(head)) return null;
  return head;
}

/** Exact name first, then prefix matches, then substring matches (case-insensitive on the name); original order inside each group. */
export function rankCommands(commands: readonly SlashCommand[], query: string, max = MENU_MAX): SlashCommand[] {
  const q = query.toLowerCase();
  if (q === '') return commands.slice(0, max);
  const exact: SlashCommand[] = [];
  const prefix: SlashCommand[] = [];
  const inside: SlashCommand[] = [];
  for (const c of commands) {
    const n = c.name.toLowerCase();
    if (n === q) exact.push(c);
    else if (n.startsWith(q)) prefix.push(c);
    else if (n.includes(q)) inside.push(c);
  }
  return [...exact, ...prefix, ...inside].slice(0, max);
}

/** Replaces the first token with "/name " (keeps the rest of the text) and puts the caret after the inserted space. */
export function insertCommand(text: string, name: string): { text: string; caret: number } {
  const m = /\s/.exec(text);
  const rest = m ? text.slice(m.index) : '';
  const head = `/${name}`;
  const tail = rest === '' ? ' ' : /^[ \t]/.test(rest) ? rest : ` ${rest}`;
  const out = head + tail;
  return { text: out, caret: head.length + 1 };
}

export type MenuAction = 'up' | 'down' | 'pick' | 'close';

/** What a key does while the menu is open with `count` rows; null = not ours (typing goes to the textarea). */
export function menuKey(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }, count: number): MenuAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case 'ArrowDown':
      return count > 0 ? 'down' : null;
    case 'ArrowUp':
      return count > 0 ? 'up' : null;
    case 'Enter':
    case 'Tab':
      return count > 0 && !e.shiftKey ? 'pick' : null;
    case 'Escape':
      return 'close';
    default:
      return null;
  }
}

/** Moves the highlighted row with wrap-around. */
export function moveIndex(index: number, action: 'up' | 'down', count: number): number {
  if (count <= 0) return 0;
  return action === 'down' ? (index + 1) % count : (index - 1 + count) % count;
}

export type SubmitMode = 'enter' | 'ctrl-enter';

/** Whether this key press sends the composer (never while an IME is composing or the menu took the key). */
export function shouldSubmit(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; isComposing?: boolean }, mode: SubmitMode): boolean {
  if (e.key !== 'Enter' || e.isComposing) return false;
  if (mode === 'ctrl-enter') return e.ctrlKey === true || e.metaKey === true;
  return !e.shiftKey && !e.ctrlKey && !e.metaKey;
}
