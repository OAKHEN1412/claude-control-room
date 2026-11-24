// Pure helpers for the "สรุปและบันทึกงาน" widget (stage 4).
import type { WorklogCard } from '../../shared/protocol';

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "23 พ.ย. 08:31" in local time. */
export function cardTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
    return { resultText: `กำลังรอสรุป · ล้มเหลว ${c.failureCount} ครั้ง`, resultTone: 'muted', bullets: c.bullets, noFailures };
  }
  return {
    resultText: `จบแล้ว · ล้มเหลว ${c.failureCount} ครั้ง (สรุปด้วย Haiku ไม่ได้ แสดงเฉพาะรายการที่ไม่เวิร์ก)`,
    resultTone: 'muted',
    bullets: c.bullets,
    noFailures,
  };
}
