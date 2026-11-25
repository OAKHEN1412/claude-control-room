// Pure helpers for the "สรุปและบันทึกงาน" widget (stage 4).
import type { WorklogCard } from '../../shared/protocol';
import { t, type TKey } from './i18n';

const MONTH_KEYS = ['panels.months.1', 'panels.months.2', 'panels.months.3', 'panels.months.4', 'panels.months.5', 'panels.months.6', 'panels.months.7', 'panels.months.8', 'panels.months.9', 'panels.months.10', 'panels.months.11', 'panels.months.12'] as const satisfies readonly TKey[];

/** Abbreviated month of a JS month index (0-11) in the current language. */
export const monthAbbr = (monthIndex: number): string => t(MONTH_KEYS[monthIndex]);

/** "23 พ.ย. 08:31" in local time. */
export function cardTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${monthAbbr(d.getMonth())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface CardView {
  resultText: string;
  resultTone: 'ok' | 'muted';
  bullets: string[];
  noFailures: boolean;
}

/** What a card shows: Haiku's line when there is one, otherwise a plain deterministic line. */
export function cardView(c: WorklogCard): CardView {
  const noFailures = c.bullets.length === 0 && c.failureCount === 0;
  if (c.result) return { resultText: c.result, resultTone: 'ok', bullets: c.bullets, noFailures };
  if (c.state === 'queued') {
    return { resultText: t('panels.summaryView.queued', { n: c.failureCount }), resultTone: 'muted', bullets: c.bullets, noFailures };
  }
  return {
    resultText: t('panels.summaryView.done', { n: c.failureCount }),
    resultTone: 'muted',
    bullets: c.bullets,
    noFailures,
  };
}
