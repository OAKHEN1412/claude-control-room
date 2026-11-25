import { useRef, useState, type FormEvent } from 'react';
import type { RunnerState, SessionInfo, WorklogCard } from '../../../shared/protocol';
import { CHIPS, TODAY_QUESTION, chipAnswer, statusLine, type ChipId } from '../../../shared/observer';
import type { CommandResult } from '../commands';
import { cardTime, cardView } from '../summaryView';
import { useT } from '../i18n';
import { serverText } from '../i18n/serverMsg';
import './summary.css';

export interface SummaryProps {
  sessions: SessionInfo[];
  runners: Record<string, RunnerState>;
  cards: WorklogCard[];
  ask: (question: string) => Promise<CommandResult>;
  offlineReason: string | null; // why the model cannot be asked, null = can
}

type Tab = 'sum' | 'log';
interface Bubble {
  id: number;
  q: string;
  a: string | null; // null while waiting
  via: 'rule' | 'haiku';
  error: boolean;
}

export function Summary({ sessions, runners, cards, ask, offlineReason }: SummaryProps) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('sum');
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const askModel = async (q: string) => {
    const id = ++seq.current;
    setBubbles((b) => [...b, { id, q, a: null, via: 'haiku', error: false }]);
    setBusy(true);
    const r = await ask(q);
    setBusy(false);
    setBubbles((b) =>
      b.map((x) => (x.id === id ? { ...x, a: r.ok && r.answer ? r.answer : (serverText(r) || t('panels.summary.noAnswer')), error: !r.ok } : x)),
    );
  };

  const onChip = (id: ChipId, label: string) => {
    const local = chipAnswer(id, sessions, runners);
    if (local !== null) {
      // Deterministic: answered here from the live state, no model call.
      setBubbles((b) => [...b, { id: ++seq.current, q: label, a: local, via: 'rule', error: false }]);
      return;
    }
    void askModel(id === 'today' ? TODAY_QUESTION : label);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q || busy || offlineReason) return;
    setText('');
    void askModel(q);
  };

  return (
    <div className="cs-root">
      <div className="cs-tabs" role="tablist" aria-label={t('panels.summary.tabsAria')}>
        <button type="button" role="tab" aria-selected={tab === 'sum'} className={`cs-tab${tab === 'sum' ? ' is-on' : ''}`} onClick={() => setTab('sum')}>
          {t('panels.summary.tabAssistant')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'log'} className={`cs-tab${tab === 'log' ? ' is-on' : ''}`} onClick={() => setTab('log')}>
          {t('panels.summary.tabLog')}{cards.length > 0 ? ` (${cards.length})` : ''}
        </button>
      </div>

      {tab === 'sum' ? (
        <div className="cs-body" role="tabpanel" aria-label={t('panels.summary.assistantAria')}>
          <div className="cs-status" role="status">
            {statusLine(sessions, runners)}
          </div>
          <div className="cs-chips">
            {CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                className="cs-chip"
                disabled={busy || (c.model && !!offlineReason)}
                onClick={() => onChip(c.id, c.label)}
                title={c.model ? t('panels.summary.chipHaiku') : t('panels.summary.viaRule')}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="cs-qa" aria-live="polite">
            {bubbles.map((m) => (
              <div key={m.id} className="cs-pair">
                <div className="cs-q">{m.q}</div>
                <div className={`cs-a${m.error ? ' is-error' : ''}`}>{m.a === null ? t('panels.summary.asking') : m.a}</div>
                {m.a !== null && !m.error && <div className="cs-via">{m.via === 'haiku' ? t('panels.summary.viaHaiku') : t('panels.summary.viaRule')}</div>}
              </div>
            ))}
          </div>
          <form className="cs-ask" onSubmit={onSubmit}>
            <input
              className="cs-input"
              aria-label={t('panels.summary.askAria')}
              placeholder={t('panels.summary.askPlaceholder')}
              value={text}
              maxLength={500}
              onChange={(e) => setText(e.target.value)}
              disabled={!!offlineReason}
            />
            <button type="submit" className="cs-send" disabled={busy || !text.trim() || !!offlineReason}>
              {t('panels.summary.ask')}
            </button>
          </form>
          <div className="cs-note">{offlineReason ?? t('panels.summary.note')}</div>
        </div>
      ) : (
        <div className="cs-body" role="tabpanel" aria-label={t('panels.summary.logAria')}>
          {cards.length === 0 && <p className="cs-empty">{t('panels.summary.logEmpty')}</p>}
          {cards.map((c) => {
            const v = cardView(c);
            return (
              <article key={c.sessionId} className="cs-card">
                <div className="cs-card-head">
                  <h3 className="cs-card-title">{c.title}</h3>
                  <span className="cs-card-time">{cardTime(c.finishedAt)}</span>
                </div>
                <div className={v.resultTone === 'ok' ? 'cs-result' : 'cs-result is-muted'}>{v.resultText}</div>
                {v.bullets.length > 0 ? (
                  <>
                    <div className="cs-bad">{t('panels.summary.badHeading')}</div>
                    <ul className="cs-bullets">
                      {v.bullets.map((b, i) => (
                        <li key={i}>{b}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="cs-none">{t('panels.summary.noFailures')}</div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
