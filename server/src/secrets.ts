// Strips anything that looks like a secret from text that is about to be stored or shown.
// Patterned after SECRETS in ~/.claude/memory/lint.py (same shapes), plus a few common extras
// (JWT, bearer tokens, NAME=value assignments where NAME looks like a secret name).
const PATTERNS: RegExp[] = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, // API key (sk-)
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, // GitHub token
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, // private key
  /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/g, // age secret key
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];
// user:password@ in a connection URL, unless the password is a <placeholder> / *** / $VAR
const URL_PASSWORD = /(:\/\/[^\s:/@`]+:)(?!<|\*|\$)[^\s@/`]{6,}(@)/g;
// Authorization: Bearer xxx
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
// NAME=value / NAME: value where NAME looks like a secret name
const ASSIGN =
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passwd|password|credential)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(?!<|\*|\$|\[secret\])("[^"]{6,}"|'[^']{6,}'|[^\s"',;]{8,})/gi;

export const REDACTED = '[secret]';

export function stripSecrets(text: string): string {
  let out = text;
  for (const rx of PATTERNS) out = out.replace(rx, REDACTED);
  out = out.replace(URL_PASSWORD, `$1${REDACTED}$2`);
  out = out.replace(BEARER, `$1${REDACTED}`);
  out = out.replace(ASSIGN, `$1$2${REDACTED}`);
  return out;
}
