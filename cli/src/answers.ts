// Answering a pending question / permission from the terminal. Pure state machine: `intro()` says what to print,
// `handle(line)` takes one typed line and returns more text to print and, when finished, the answer to send.
import type { AskQuestion, PendingRequest } from '../../shared/protocol.ts';
import type { Paint } from './format.ts';
import { clip } from './format.ts';

export interface AnswerResult {
  behavior: 'allow' | 'deny';
  answers?: Record<string, string>;
  message?: string;
}

export interface Step {
  lines: string[];
  done?: AnswerResult;
}

const YES = new Set(['1', 'y', 'yes', 'a', 'allow', 'ใช่', 'อนุญาต']);
const NO = new Set(['2', 'n', 'no', 'd', 'deny', 'ไม่', 'ไม่อนุญาต']);

export const SKIP_COMMAND = '/skip';

/** Number list for the options of one question, plus an "other" entry that takes free text. */
export function optionLines(q: AskQuestion, p: Paint): string[] {
  const out: string[] = [];
  q.options.forEach((o, i) => {
    const desc = o.description ? p.dim(` — ${clip(o.description.replace(/\s+/g, ' '), 70)}`) : '';
    out.push(`  ${p.bold(`${i + 1})`)} ${o.label}${desc}`);
  });
  out.push(`  ${p.bold(`${q.options.length + 1})`)} อื่น ๆ — พิมพ์คำตอบเอง`);
  return out;
}

/**
 * Maps one typed line to the answer of a question: option numbers (several, separated by comma or space, when the
 * question is multi-select) give the option labels; anything else is free text ("Other"). null = not usable yet
 * (empty line, bad number, or the "other" entry chosen: the next line is the free text).
 */
export function mapChoice(q: AskQuestion, input: string): { value: string } | { askOther: true } | null {
  const t = input.trim();
  if (t === '') return null;
  const n = q.options.length;
  const nums = t.split(/[\s,]+/).filter(Boolean);
  if (nums.every((x) => /^\d+$/.test(x))) {
    const picks = nums.map(Number);
    if (picks.some((k) => k < 1 || k > n + 1)) return null;
    if (picks.includes(n + 1)) return { askOther: true };
    const labels = [...new Set(picks)].map((k) => q.options[k - 1].label);
    if (!q.multiSelect && labels.length > 1) return null;
    return { value: labels.join(', ') };
  }
  return { value: t }; // free text
}

export class AnswerFlow {
  private readonly p: PendingRequest;
  private readonly paint: Paint;
  private qi = 0;
  private other = false;
  private readonly answers: Record<string, string> = {};

  constructor(p: PendingRequest, paint: Paint) {
    this.p = p;
    this.paint = paint;
  }

  get requestId(): string {
    return this.p.requestId;
  }

  private get questions(): AskQuestion[] {
    return this.p.questions ?? [];
  }

  /** What to print when this request first shows up. */
  intro(): string[] {
    const p = this.paint;
    if (this.p.kind === 'ask' && this.questions.length > 0) return [p.yellow('? Claude ถามคำถาม'), ...this.questionLines()];
    const what = this.p.label || this.p.toolName;
    return [
      p.yellow(`? ขออนุญาตใช้เครื่องมือ: ${what}`),
      ...(this.p.description && this.p.description !== this.p.toolName ? [p.dim(`  ${clip(this.p.description.replace(/\s+/g, ' '), 140)}`)] : []),
      `  ${p.bold('1)')} อนุญาต   ${p.bold('2)')} ไม่อนุญาต`,
    ];
  }

  prompt(): string {
    if (this.p.kind === 'ask' && this.questions.length > 0) return this.other ? 'พิมพ์คำตอบ> ' : 'เลือก> ';
    return 'อนุญาต? (1/2)> ';
  }

  private questionLines(): string[] {
    const q = this.questions[this.qi];
    const total = this.questions.length;
    const head = total > 1 ? `[${this.qi + 1}/${total}] ` : '';
    return [
      `${head}${this.paint.bold(q.header ? `${q.header}: ` : '')}${q.question}`,
      ...optionLines(q, this.paint),
      ...(q.multiSelect ? [this.paint.dim('  (เลือกได้หลายข้อ: 1,3)')] : []),
      this.paint.dim(`  (${SKIP_COMMAND} = ข้ามคำถามนี้)`),
    ];
  }

  handle(line: string): Step {
    const t = line.trim();
    if (t === SKIP_COMMAND) return { lines: [this.paint.dim('ข้ามแล้ว')], done: { behavior: 'deny', message: 'ข้ามจาก cr (terminal)' } };
    if (this.p.kind !== 'ask' || this.questions.length === 0) {
      const w = t.toLowerCase();
      if (YES.has(w)) return { lines: [], done: { behavior: 'allow' } };
      if (NO.has(w)) return { lines: [], done: { behavior: 'deny' } };
      return { lines: [this.paint.dim('พิมพ์ 1 (อนุญาต) หรือ 2 (ไม่อนุญาต)')] };
    }
    const q = this.questions[this.qi];
    if (this.other) {
      if (t === '') return { lines: [this.paint.dim('พิมพ์คำตอบ หรือ /skip')] };
      return this.record(q, t);
    }
    const m = mapChoice(q, t);
    if (m === null) return { lines: [this.paint.dim(`เลือกเลข 1-${q.options.length + 1} หรือพิมพ์คำตอบเอง`)] };
    if ('askOther' in m) {
      this.other = true;
      return { lines: [this.paint.dim('พิมพ์คำตอบของคุณ:')] };
    }
    return this.record(q, m.value);
  }

  private record(q: AskQuestion, value: string): Step {
    this.answers[q.question] = value;
    this.other = false;
    this.qi++;
    if (this.qi >= this.questions.length) return { lines: [], done: { behavior: 'allow', answers: { ...this.answers } } };
    return { lines: this.questionLines() };
  }
}
