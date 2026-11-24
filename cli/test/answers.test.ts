import { describe, expect, it } from 'vitest';
import type { AskQuestion, PendingRequest } from '../../shared/protocol.ts';
import { AnswerFlow, mapChoice } from '../src/answers.ts';
import { makePaint } from '../src/format.ts';

const plain = makePaint(false);
const q = (question: string, labels: string[], multiSelect = false): AskQuestion => ({
  question,
  header: 'H',
  multiSelect,
  options: labels.map((label) => ({ label, description: '' })),
});
const ask = (questions: AskQuestion[]): PendingRequest => ({
  requestId: 'req1',
  toolUseId: 't1',
  toolName: 'AskUserQuestion',
  kind: 'ask',
  description: 'ask',
  inputPreview: '{}',
  questions,
  at: 0,
});
const perm: PendingRequest = { requestId: 'req2', toolUseId: 't2', toolName: 'Bash', kind: 'permission', description: 'run ls', label: 'Bash: ls', inputPreview: '{}', at: 0 };

describe('mapChoice', () => {
  const single = q('Which?', ['A', 'B', 'C']);
  const multi = q('Which?', ['A', 'B', 'C'], true);
  it('numbers pick labels, n+1 asks for free text, other text is free text', () => {
    expect(mapChoice(single, '2')).toEqual({ value: 'B' });
    expect(mapChoice(single, ' 1 ')).toEqual({ value: 'A' });
    expect(mapChoice(single, '4')).toEqual({ askOther: true });
    expect(mapChoice(single, '5')).toBeNull();
    expect(mapChoice(single, '0')).toBeNull();
    expect(mapChoice(single, '')).toBeNull();
    expect(mapChoice(single, '1,2')).toBeNull(); // single select takes one
    expect(mapChoice(single, 'อย่างอื่น')).toEqual({ value: 'อย่างอื่น' });
  });
  it('multi-select joins labels like the web does', () => {
    expect(mapChoice(multi, '1,3')).toEqual({ value: 'A, C' });
    expect(mapChoice(multi, '3 1 3')).toEqual({ value: 'C, A' });
    expect(mapChoice(multi, '1,9')).toBeNull();
  });
});

describe('AnswerFlow', () => {
  it('permission: 1/y allows, 2/n denies, anything else asks again', () => {
    const f = new AnswerFlow(perm, plain);
    expect(f.intro().join('\n')).toContain('Bash: ls');
    expect(f.handle('maybe').done).toBeUndefined();
    expect(f.handle('1').done).toEqual({ behavior: 'allow' });
    expect(new AnswerFlow(perm, plain).handle('n').done).toEqual({ behavior: 'deny' });
    expect(new AnswerFlow(perm, plain).handle('/skip').done?.behavior).toBe('deny');
  });

  it('one question: a number answers with the label (key = the question text)', () => {
    const f = new AnswerFlow(ask([q('Pick one', ['Yes', 'No'])]), plain);
    const intro = f.intro().join('\n');
    expect(intro).toContain('1) Yes');
    expect(intro).toContain('2) No');
    expect(intro).toContain('3) อื่น ๆ');
    expect(f.handle('2').done).toEqual({ behavior: 'allow', answers: { 'Pick one': 'No' } });
  });

  it('"Other" takes the next line as free text; typing text directly also works', () => {
    const f = new AnswerFlow(ask([q('Pick one', ['Yes', 'No'])]), plain);
    expect(f.handle('3').done).toBeUndefined();
    expect(f.prompt()).toContain('พิมพ์คำตอบ');
    expect(f.handle('').done).toBeUndefined();
    expect(f.handle('something else').done).toEqual({ behavior: 'allow', answers: { 'Pick one': 'something else' } });
    expect(new AnswerFlow(ask([q('Pick one', ['Yes', 'No'])]), plain).handle('maybe later').done?.answers).toEqual({ 'Pick one': 'maybe later' });
  });

  it('several questions are asked in order and answered together', () => {
    const f = new AnswerFlow(ask([q('First', ['a', 'b']), q('Second', ['x', 'y', 'z'], true)]), plain);
    const s1 = f.handle('1');
    expect(s1.done).toBeUndefined();
    expect(s1.lines.join('\n')).toContain('Second');
    expect(f.handle('1,3').done).toEqual({ behavior: 'allow', answers: { First: 'a', Second: 'x, z' } });
  });

  it('bad input keeps the question open', () => {
    const f = new AnswerFlow(ask([q('Pick one', ['Yes', 'No'])]), plain);
    expect(f.handle('9').done).toBeUndefined();
    expect(f.handle('').done).toBeUndefined();
    expect(f.handle('/skip').done).toMatchObject({ behavior: 'deny' });
  });
});
