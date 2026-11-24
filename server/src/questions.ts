// Parses the input of an AskUserQuestion tool call. Shared by the Runner (held requests) and the
// transcript parser (terminal sessions).
import type { AskQuestion } from '../../shared/protocol';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseQuestions(input: unknown): AskQuestion[] | undefined {
  if (!isRecord(input) || !Array.isArray(input.questions)) return undefined;
  const out: AskQuestion[] = [];
  for (const q of input.questions) {
    if (!isRecord(q) || typeof q.question !== 'string') continue;
    const options = Array.isArray(q.options)
      ? q.options
          .filter((o): o is Record<string, unknown> => isRecord(o) && typeof o.label === 'string')
          .map((o) => ({ label: o.label as string, description: typeof o.description === 'string' ? o.description : '' }))
      : [];
    out.push({
      question: q.question,
      header: typeof q.header === 'string' ? q.header : '',
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : undefined;
}
