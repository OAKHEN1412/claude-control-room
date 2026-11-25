// Shared prompt box: a textarea that starts at one line and grows to ~10 lines, plus the "/" command menu.
// Used by the per-session composer (Controls), the new-job panel and the canvas "new AI" popover.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEventHandler, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SlashCommand } from '../../../shared/protocol';
import { loadSlashCommands } from '../slashClient';
import { insertCommand, menuKey, moveIndex, rankCommands, shouldSubmit, slashQuery, type SubmitMode } from '../slashMenu';
import { useT } from '../i18n';
import './composer.css';

export const COMPOSER_MAX_LINES = 10;

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** enter: Enter sends, Shift+Enter newline. ctrl-enter: Ctrl/Cmd+Enter sends, Enter is a newline. */
  submitOn?: SubmitMode;
  /** Whose command list to show (omit for a job that does not exist yet). */
  sessionId?: string;
  id?: string;
  className?: string;
  large?: boolean;
  disabled?: boolean;
  title?: string;
  placeholder?: string;
  'aria-label'?: string;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  autoFocus?: boolean;
}

interface Anchor {
  left: number;
  width: number;
  /** Placed above the textarea (bottom set) when there is room, else below it (top set). */
  bottom?: number;
  top?: number;
  maxHeight: number;
}

export function Composer(p: ComposerProps) {
  const t = useT();
  const { value, onChange, onSubmit, submitOn = 'enter', sessionId, large, disabled } = p;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const query = disabled || dismissed ? null : slashQuery(value, caret);
  const wanted = query !== null;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void loadSlashCommands(sessionId).then((l) => live && setCommands(l));
    return () => {
      live = false;
    };
  }, [wanted, sessionId]);

  const items = useMemo(() => (query === null ? [] : rankCommands(commands, query)), [commands, query]);
  const open = query !== null && items.length > 0;
  useEffect(() => setIndex(0), [query]);

  // Auto-grow: height follows the content up to COMPOSER_MAX_LINES lines, then the textarea scrolls.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize) || 14;
    const lh = parseFloat(cs.lineHeight) || fs * 1.4;
    const extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = 'auto';
    const max = lh * COMPOSER_MAX_LINES + extra;
    el.style.height = `${Math.min(el.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0), max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value]);

  // Put the caret after an inserted command.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ref.current) {
      ref.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      setCaret(pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  // The menu sits above the textarea, fixed to the viewport (portal) so no pane overflow can clip it.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const above = r.top - 8;
      const below = window.innerHeight - r.bottom - 8;
      const wide = Math.min(Math.max(r.width, 420), window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - wide - 8));
      if (above >= Math.min(220, below)) setAnchor({ left, width: wide, bottom: window.innerHeight - r.top + 4, maxHeight: Math.min(312, above) });
      else setAnchor({ left, width: wide, top: r.bottom + 4, maxHeight: Math.min(312, below) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, value]);

  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
  }, [index, open]);

  const pick = (c: SlashCommand) => {
    const r = insertCommand(value, c.name);
    pendingCaret.current = r.caret;
    setDismissed(false);
    onChange(r.text);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing;
    if (open && !composing) {
      const a = menuKey(e, items.length);
      if (a === 'up' || a === 'down') {
        e.preventDefault();
        setIndex((i) => moveIndex(i, a, items.length));
        return;
      }
      if (a === 'pick') {
        e.preventDefault();
        pick(items[Math.min(index, items.length - 1)]);
        return;
      }
      if (a === 'close') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (shouldSubmit({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, isComposing: composing }, submitOn)) {
      e.preventDefault();
      onSubmit();
    }
  };

  const sync = () => setCaret(ref.current?.selectionStart ?? 0);

  return (
    <>
      <textarea
        ref={ref}
        id={p.id}
        rows={1}
        aria-label={p['aria-label']}
        className={`cc-input cc-composer${large ? ' is-large' : ''}${p.className ? ` ${p.className}` : ''}`}
        value={value}
        disabled={disabled}
        title={p.title}
        placeholder={p.placeholder}
        autoFocus={p.autoFocus}
        onChange={(e) => {
          setDismissed(false);
          setCaret(e.target.selectionStart);
          onChange(e.target.value);
        }}
        onPaste={p.onPaste}
        onKeyDown={onKeyDown}
        onKeyUp={sync}
        onClick={sync}
        onSelect={sync}
        aria-expanded={open}
        aria-autocomplete="list"
      />
      {open && anchor &&
        createPortal(
          <div className="cc-slash" role="listbox" aria-label={t('shell.composer.listAria')} style={{ left: anchor.left, width: anchor.width, bottom: anchor.bottom, top: anchor.top, maxHeight: anchor.maxHeight }}>
            {items.map((c, i) => (
              <div
                key={c.name}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                role="option"
                aria-selected={i === index}
                className={`cc-slash-row${i === index ? ' is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setIndex(i)}
                onClick={() => pick(c)}
              >
                <span className="cc-slash-name">/{c.name}</span>
                {c.argumentHint && <span className="cc-slash-hint">{c.argumentHint}</span>}
                <span className="cc-slash-desc">{c.description}</span>
                <span className={`cc-slash-badge${c.builtin ? ' is-builtin' : ''}`}>{c.builtin ? t('shell.composer.builtin') : t('shell.composer.skill')}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
