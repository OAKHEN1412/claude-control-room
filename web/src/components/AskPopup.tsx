// Stage 3 popup: one pending question / permission at a time, oldest first, with "1/3" paging.
// role="alertdialog". It never takes focus by itself; focus moves here only when `focusToken` changes
// (bell or notification click). Esc closes (items stay in the queue).
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandInput, CommandResult } from '../commands';
import { allAnswered, buildAnswers, toggleChoice } from '../control';
import { choosePlacement, optionLetter, recommendedIndex, type Box, type Placement, type QueueItem } from '../queue';
import { useT } from '../i18n';
import { serverText } from '../i18n/serverMsg';

type Command = (cmd: CommandInput) => Promise<CommandResult>;

export interface AskPopupProps {
  items: QueueItem[];
  activeKey: string | null;
  open: boolean;
  focusToken: number;
  command: Command;
  sessionLabel: (sessionId: string) => string;
  onActive: (key: string) => void;
  onClose: () => void;
}

const CORNER_W = 360;

function toBox(r: DOMRect): Box {
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export function AskPopup({ items, activeKey, open, focusToken, command, sessionLabel, onActive, onClose }: AskPopupProps) {
  const t = useT();
  const ref = useRef<HTMLElement>(null);
  const keyRef = useRef<((e: KeyboardEvent) => void) | null>(null);
  const [placement, setPlacement] = useState<Placement>('corner');
  const [top, setTop] = useState(60);

  const idx = Math.max(
    0,
    items.findIndex((i) => i.key === activeKey),
  );
  const item: QueueItem | undefined = items[idx];

  // Focus only on request (bell / notification), never on its own.
  useEffect(() => {
    if (focusToken > 0 && open) ref.current?.focus();
  }, [focusToken, open]);

  // Place under the header; if the corner would cover the control the user is typing in, use the top strip.
  useLayoutEffect(() => {
    if (!open || !item) return;
    const place = () => {
      const header = document.querySelector('.cr-header');
      const hb = header ? header.getBoundingClientRect().bottom : 0;
      setTop(Math.round(hb) + 8);
      const el = document.activeElement;
      const inside = el instanceof HTMLElement && ref.current?.contains(el);
      const focused = el instanceof HTMLElement && el !== document.body && !inside ? toBox(el.getBoundingClientRect()) : null;
      const w = window.innerWidth;
      const corner: Box = {
        left: w - 16 - Math.min(CORNER_W, w - 32),
        right: w - 16,
        top: hb + 8,
        bottom: hb + 8 + (ref.current?.offsetHeight ?? 320),
      };
      const h = ref.current?.offsetHeight ?? 320;
      const strip = Math.min(720, w - 32);
      const left = (w - strip) / 2;
      const topBox: Box = { left, right: left + strip, top: hb + 8, bottom: hb + 8 + h };
      const vh = window.innerHeight;
      const bottomBox: Box = { left, right: left + strip, top: vh - 16 - h, bottom: vh - 16 };
      setPlacement(choosePlacement(corner, focused, topBox, bottomBox));
    };
    place();
    document.addEventListener('focusin', place);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('focusin', place);
      window.removeEventListener('resize', place);
    };
  }, [open, item?.key]);

  if (!open || !item) return null;

  const go = (d: number) => onActive(items[(idx + d + items.length) % items.length].key);

  return (
    <section
      ref={ref}
      className={`ap-pop is-${placement}`}
      role="alertdialog"
      aria-labelledby="ap-title"
      aria-describedby="ap-text"
      tabIndex={-1}
      style={placement === 'bottom' ? undefined : { top }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
          return;
        }
        keyRef.current?.(e);
      }}
    >
      <PopupBody key={item.key} keyRef={keyRef} item={item} command={command} target={sessionLabel(item.sessionId)} />
      <div className="ap-nav">
        <span className="cr-mono ap-count" aria-label={t('panels.askPopup.itemOf', { i: idx + 1, n: items.length })}>
          {idx + 1}/{items.length}
        </span>
        {items.length > 1 && (
          <>
            <button type="button" className="cc-btn" onClick={() => go(-1)}>
              {t('panels.askPopup.prev')}
            </button>
            <button type="button" className="cc-btn" onClick={() => go(1)}>
              {t('panels.askPopup.next')}
            </button>
          </>
        )}
        <button type="button" className="cc-btn ap-close" onClick={onClose}>
          {t('panels.askPopup.closeLater')}
        </button>
      </div>
    </section>
  );
}

function PopupBody({ item, command, target, keyRef }: { item: QueueItem; command: Command; target: string; keyRef: { current: ((e: KeyboardEvent) => void) | null } }) {
  const t = useT();
  const [choices, setChoices] = useState<Record<string, string[] | string>>({});
  const [free, setFree] = useState('');
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (behavior: 'allow' | 'deny', answers?: Record<string, string>, message?: string) => {
    if (item.requestId === null || working) return;
    setWorking(true);
    setError(null);
    const r = await command({ type: 'answer', sessionId: item.sessionId, requestId: item.requestId, behavior, answers, message });
    setWorking(false);
    if (!r.ok) setError(serverText(r) || t('panels.askPopup.sendFailed'));
  };

  const qs = item.questions;
  const title = `${item.kind === 'ask' ? t('panels.askPopup.askFrom', { job: item.job }) : t('panels.askPopup.permFrom', { job: item.job })}${item.model ? ` · ${item.model}` : ''}`;
  const quick = item.kind === 'ask' && qs.length === 1 && !qs[0].multiSelect;

  const pick = (q: (typeof qs)[number], label: string) => {
    if (quick) void send('allow', buildAnswers(qs, { [q.question]: label }));
    else setChoices((c) => toggleChoice(c, q, label));
  };

  // 1/2/3 pick an option of the first question while the popup (not a text field) has focus.
  const onKey = (e: KeyboardEvent) => {
    if (item.source !== 'runner' || item.kind !== 'ask' || qs.length === 0) return;
    const tgt = e.target;
    if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const n = Number(e.key);
    if (!Number.isInteger(n) || n < 1) return;
    const o = qs[0].options[n - 1];
    if (!o) return;
    e.preventDefault();
    pick(qs[0], o.label);
  };

  keyRef.current = onKey;

  if (item.source === 'terminal') {
    return (
      <div className="ap-body">
        <h2 id="ap-title" className="ap-title">
          {title}
        </h2>
        <p id="ap-text" className="ap-text">
          {item.text}
        </p>
        {qs.map((q) => (
          <div key={q.question} className="ap-ro">
            {qs.length > 1 && <div className="ap-qtext">{q.question}</div>}
            <ul className="ap-ro-opts">
              {q.options.map((o, i) => (
                <li key={o.label}>
                  <b>{optionLetter(i)}</b> {o.label}
                  {o.description && <span className="cc-muted"> — {o.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {item.kind === 'permission' && item.detail && <pre className="cc-pend-input">{item.detail}</pre>}
        <p className="ap-terminal">{t('panels.askPopup.answerTerminal')}</p>
        <div className="cc-target">{target}</div>
      </div>
    );
  }

  if (item.kind === 'ask' && qs.length > 0) {
    return (
      <div className="ap-body">
        <h2 id="ap-title" className="ap-title">
          {title}
        </h2>
        {qs.map((q, qi) => {
          const cur = choices[q.question];
          const rec = recommendedIndex(q.options);
          // Once anything is picked, only the picked option is highlighted (the recommendation stops looking selected).
          const picked = Array.isArray(cur) ? cur.length > 0 : typeof cur === 'string' && cur !== '';
          return (
            <div key={q.question} className="ap-q">
              <p id={qi === 0 ? 'ap-text' : undefined} className="ap-text">
                {q.question}
              </p>
              {q.multiSelect && <div className="cc-muted">{t('panels.askPopup.multi')}</div>}
              {q.options.map((o, i) => {
                const on = Array.isArray(cur) ? cur.includes(o.label) : cur === o.label;
                return (
                  <button
                    key={o.label}
                    type="button"
                    className={`ap-opt${i === rec && !picked ? ' is-rec' : ''}${on ? ' is-on' : ''}`}
                    disabled={working}
                    aria-pressed={quick ? undefined : on}
                    title={o.description || undefined}
                    onClick={() => pick(q, o.label)}
                  >
                    <span>
                      {optionLetter(i)} · {o.label}
                    </span>
                    {o.description && <span className="ap-opt-desc">{o.description}</span>}
                  </button>
                );
              })}
            </div>
          );
        })}
        <div className="ap-free">
          <input
            aria-label={t('panels.askPopup.freeAria')}
            className="cr-sel"
            value={free}
            placeholder={t('panels.askPopup.freePlaceholder')}
            onChange={(e) => setFree(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && free.trim() !== '' && qs.length === 1) void send('allow', buildAnswers(qs, { [qs[0].question]: free.trim() }));
            }}
          />
          <button
            type="button"
            className="ap-answer"
            disabled={working || (qs.length === 1 ? free.trim() === '' && !allAnswered(qs, choices) : !allAnswered(qs, choices))}
            onClick={() => {
              const merged: Record<string, string[] | string> = { ...choices };
              if (qs.length === 1 && free.trim() !== '') merged[qs[0].question] = free.trim();
              void send('allow', buildAnswers(qs, merged));
            }}
          >
            {t('panels.askPopup.answer')}
          </button>
        </div>
        {error && (
          <div className="cc-error" role="alert">
            {error}
          </div>
        )}
        <div className="cc-target">{target}</div>
      </div>
    );
  }

  return (
    <div className="ap-body">
      <h2 id="ap-title" className="ap-title">
        {title}
      </h2>
      <p id="ap-text" className="ap-text">
        {item.text}
      </p>
      {item.detail && <pre className="cc-pend-input">{item.detail}</pre>}
      <input
        aria-label={t('panels.askPopup.reason')}
        className="cr-sel"
        value={reason}
        placeholder={t('panels.askPopup.reason')}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="ap-row">
        <button type="button" className="ap-opt is-rec" disabled={working} onClick={() => void send('allow')}>
          {t('panels.askPopup.allow')}
        </button>
        <button type="button" className="ap-opt" disabled={working} onClick={() => void send('deny', undefined, reason.trim() || undefined)}>
          {t('panels.askPopup.deny')}
        </button>
      </div>
      {error && (
        <div className="cc-error" role="alert">
          {error}
        </div>
      )}
      <div className="cc-target">{target}</div>
    </div>
  );
}
