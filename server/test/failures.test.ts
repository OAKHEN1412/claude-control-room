import { describe, expect, it } from 'vitest';
import { createState, failureText, ingestLine } from '../src/parser';
import { stripSecrets } from '../src/secrets';

const T0 = '2026-11-23T08:00:00.000Z';
const ts = (n: number) => new Date(Date.parse(T0) + n * 1000).toISOString();

const toolUse = (id: string, name: string, input: unknown, n = 0) =>
  JSON.stringify({ type: 'assistant', timestamp: ts(n), uuid: `a-${id}`, message: { model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: unknown, isError: boolean | undefined, n = 1) =>
  JSON.stringify({
    type: 'user',
    timestamp: ts(n),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError === undefined ? {} : { is_error: isError }) }] },
  });

function feed(...lines: string[]) {
  const st = createState();
  for (const l of lines) ingestLine(st, l);
  return st;
}

describe('failure extraction', () => {
  it('records a tool_result with is_error, with the Thai tool label and the first error line', () => {
    const st = feed(
      toolUse('t1', 'Read', { file_path: 'C:\\x\\no-such-file.txt' }),
      result('t1', 'File does not exist.\nsecond line', true),
    );
    expect(st.failures).toHaveLength(1);
    const f = st.failures[0];
    expect(f.id).toBe('t1');
    expect(f.tool).toBe('อ่านไฟล์: no-such-file.txt');
    expect(f.text).toBe('File does not exist.');
    expect(f.ts).toBe(Date.parse(ts(1)));
  });

  it('joins "Exit code N" with the next line for a Bash failure', () => {
    const st = feed(
      toolUse('b1', 'Bash', { command: 'nosuchcmd', description: 'Run nosuchcmd' }),
      result('b1', 'Exit code 127\nbash: nosuchcmd: command not found', true),
    );
    expect(st.failures[0].tool).toBe('คำสั่ง: Run nosuchcmd');
    expect(st.failures[0].text).toBe('Exit code 127: bash: nosuchcmd: command not found');
  });

  it('records a non-zero Bash exit that is not flagged is_error, but not exit code 0', () => {
    const st = feed(
      toolUse('b1', 'Bash', { command: 'false' }),
      result('b1', 'Exit code 1\nboom', undefined),
      toolUse('b2', 'Bash', { command: 'true' }, 2),
      result('b2', 'Exit code 0\nfine', undefined, 3),
      toolUse('r1', 'Read', { file_path: 'a.txt' }, 4),
      result('r1', 'Exit code 1 in text of a normal read', undefined, 5),
    );
    expect(st.failures.map((f) => f.id)).toEqual(['b1']);
  });

  it('records a hook-blocked tool call (reported as an error result)', () => {
    const st = feed(
      toolUse('h1', 'Bash', { command: 'rm -rf x' }),
      result('h1', [{ type: 'text', text: 'PreToolUse:Bash hook error: blocked by policy' }], true),
    );
    expect(st.failures[0].text).toBe('PreToolUse:Bash hook error: blocked by policy');
  });

  it('ignores a user declining a tool or interrupting', () => {
    const st = feed(
      toolUse('d1', 'Write', { file_path: 'a.txt' }),
      result('d1', "The user doesn't want to proceed with this tool use. The tool use was rejected", true),
      toolUse('d2', 'Bash', { command: 'sleep 9' }, 2),
      result('d2', '[Request interrupted by user for tool use]', true, 3),
    );
    expect(st.failures).toEqual([]);
  });

  it('records a final API error entry (assistant with apiError) and not a successful answer', () => {
    const api = JSON.stringify({
      type: 'assistant',
      uuid: 'u-api',
      timestamp: ts(5),
      apiError: 'usage_limit_reached',
      message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit" }] },
    });
    const ok = JSON.stringify({ type: 'assistant', uuid: 'u-ok', timestamp: ts(6), message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'done' }] } });
    const st = feed(api, ok);
    expect(st.failures).toEqual([{ id: 'u-api', ts: Date.parse(ts(5)), tool: 'เรียก API', text: "You've hit your 5-hour limit" }]);
    expect(st.assistantTurns).toBe(1); // the API error is not a turn of work
    expect(st.lastTextFull).toBe('done');
  });

  it('records a system api_error only on its last retry', () => {
    const sys = (n: number, uuid: string) =>
      JSON.stringify({ type: 'system', subtype: 'api_error', uuid, timestamp: ts(n), retryAttempt: n, maxRetries: 3, error: { formatted: '529 overloaded' } });
    const st = feed(sys(1, 's1'), sys(2, 's2'), sys(3, 's3'));
    expect(st.failures.map((f) => f.id)).toEqual(['s3']);
  });

  it('dedupes by tool_use id when the same line is fed twice', () => {
    const lines = [toolUse('t1', 'Read', { file_path: 'a' }), result('t1', 'nope', true)];
    const st = feed(...lines, result('t1', 'nope', true));
    expect(st.failures).toHaveLength(1);
  });

  it('keeps the prompts, last assistant text and turn count the digest needs', () => {
    const st = feed(
      JSON.stringify({ type: 'user', timestamp: ts(0), message: { content: 'ทำสองอย่างนี้' } }),
      JSON.stringify({ type: 'assistant', timestamp: ts(1), message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'เสร็จแล้ว\nบรรทัดสอง' }] } }),
    );
    expect(st.prompts).toEqual(['ทำสองอย่างนี้']);
    expect(st.lastTextFull).toBe('เสร็จแล้ว บรรทัดสอง');
    expect(st.assistantTurns).toBe(1);
  });

  it('strips a secret from the failure text and from stored prompts', () => {
    const st = feed(
      JSON.stringify({ type: 'user', timestamp: ts(0), message: { content: 'ใช้ key sk-ant-abcdefghijklmnopqrstuvwxyz0123 หน่อย' } }),
      toolUse('t1', 'Bash', { command: 'curl' }),
      result('t1', 'Exit code 22\ncurl: (22) https://user:hunter2hunter@example.com/x failed', true),
    );
    expect(st.failures[0].text).not.toContain('hunter2hunter');
    expect(st.failures[0].text).toContain('[secret]');
    expect(st.prompts[0]).not.toContain('sk-ant-');
  });

  it('trims the error text to 200 characters', () => {
    expect(failureText('x'.repeat(500)).length).toBe(200);
    expect(failureText('')).toBe('(error)');
  });
});

describe('stripSecrets', () => {
  it('removes the secret shapes in lint.py', () => {
    const cases = [
      'sk-ant-api03-abcdefghijklmnopqrstuv',
      'ghp_' + 'a'.repeat(36),
      'github_pat_' + 'B'.repeat(40),
      'AKIAABCDEFGHIJKLMNOP',
      'xoxb-1234567890-abcdef',
      'AIza' + 'c'.repeat(35),
      'AGE-SECRET-KEY-1' + 'Q'.repeat(58),
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
    ];
    for (const c of cases) {
      const out = stripSecrets(`before ${c} after`);
      expect(out, c).toBe('before [secret] after');
    }
  });

  it('removes a private key block and a password inside a URL', () => {
    expect(stripSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----')).toBe('[secret]');
    expect(stripSecrets('postgres://admin:s3cretpass@example.com:5432/x')).toBe('postgres://admin:[secret]@example.com:5432/x');
  });

  it('removes bearer tokens and NAME=value assignments with a secret-looking name', () => {
    expect(stripSecrets('Authorization: Bearer abcdef0123456789abcdef')).toBe('Authorization: Bearer [secret]');
    expect(stripSecrets('API_KEY=abcdef123456')).toBe('API_KEY=[secret]');
    expect(stripSecrets('password: "correct horse"')).toBe('password: [secret]');
  });

  it('leaves placeholders and ordinary text alone', () => {
    const keep = ['postgres://user:<password>@host/db', 'token: ***', 'API_KEY=$API_KEY', 'File does not exist.', 'คำสั่งไม่พบ: nosuchcmd'];
    for (const k of keep) expect(stripSecrets(k)).toBe(k);
  });
});
