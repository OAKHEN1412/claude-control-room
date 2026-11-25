// Release check for Claude Control Room: asks GitHub for the latest release (or a configured override) and
// remembers the result. Failures are silent to the UI: the last good result is kept and `failed` is set.
import fs from 'node:fs';

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string | null;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  url: string | null;
  notes: string;
  publishedAt: string | null;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface UpdateStatus {
  current: string;
  latest: ReleaseInfo | null;
  available: boolean;
  checkedAt: number | null;
  enabled: boolean;
  failed: boolean;
}

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface UpdateCheckerDeps {
  currentVersion: string;
  repo: RepoRef | null;
  /** Full override of the release source: an http(s) URL, or a local JSON file path. Also read from CR_UPDATE_URL. */
  url?: string;
  enabled: () => boolean;
  fetchFn?: FetchFn;
  readFile?: (path: string) => Promise<string>;
  intervalMs?: number;
  now?: () => number;
  log?: (m: string) => void;
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const NOTES_MAX = 4000;
const DEFAULT_INTERVAL_MS = 6 * 3600e3;

/** Parses 'v1.2.3', '1.2.3' or '1.2.3-rc.1'. Anything else gives null. */
export function parseVersion(s: unknown): Version | null {
  if (typeof s !== 'string') return null;
  const m = VERSION_RE.exec(s.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

function comparePre(a: string, b: string): -1 | 0 | 1 {
  const x = a.split('.');
  const y = b.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const xn = /^\d+$/.test(x[i]);
    const yn = /^\d+$/.test(y[i]);
    if (xn && yn) {
      const d = Number(x[i]) - Number(y[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xn) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (yn) {
      return 1;
    } else if (x[i] !== y[i]) {
      return x[i] < y[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compares two versions (strings or parsed). A prerelease is older than the same plain version.
 * Unparseable input compares as equal (0); use isNewer when that matters.
 */
export function compareVersions(a: string | Version, b: string | Version): -1 | 0 | 1 {
  const pa = typeof a === 'string' ? parseVersion(a) : a;
  const pb = typeof b === 'string' ? parseVersion(b) : b;
  if (!pa || !pb) return 0;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return comparePre(pa.pre, pb.pre);
}

/** True only when both versions parse and `latest` is strictly greater than `current`. */
export function isNewer(latest: string, current: string): boolean {
  if (!parseVersion(latest) || !parseVersion(current)) return false;
  return compareVersions(latest, current) > 0;
}

function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre !== null ? `-${v.pre}` : ''}`;
}

/** Reads a GitHub "latest release" payload. Drafts and prereleases, or a tag_name that does not parse, give null. */
export function parseRelease(json: unknown): ReleaseInfo | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (o.draft === true || o.prerelease === true) return null;
  const v = parseVersion(o.tag_name);
  if (!v) return null;
  const version = formatVersion(v);
  const url = typeof o.html_url === 'string' && o.html_url.startsWith('https://github.com/') ? o.html_url : null;
  const body = typeof o.body === 'string' ? o.body : '';
  return {
    version,
    tag: `v${version}`,
    url,
    notes: Array.from(body).slice(0, NOTES_MAX).join(''),
    publishedAt: typeof o.published_at === 'string' ? o.published_at : null,
  };
}

function parseGithubUrl(raw: string): RepoRef | null {
  const s = raw.trim().replace(/\/+$/, '');
  const seg = '([A-Za-z0-9_.-]+)';
  const patterns = [
    new RegExp(`^github:${seg}/${seg}$`),
    new RegExp(`^(?:git\\+)?(?:https?|git|ssh)://(?:[^@/]+@)?github\\.com/${seg}/${seg}$`),
    new RegExp(`^git@github\\.com:${seg}/${seg}$`),
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (!m) continue;
    const owner = m[1];
    const repo = m[2].replace(/\.git$/, '');
    if (!owner || !repo || repo === '.' || repo === '..') return null;
    return { owner, repo };
  }
  return null;
}

/** Reads the `repository` field (string or {url}) of a parsed package.json. Only github.com forms are accepted. */
export function repoFromPackage(pkg: unknown): RepoRef | null {
  if (!pkg || typeof pkg !== 'object') return null;
  let r: unknown = (pkg as Record<string, unknown>).repository;
  if (r && typeof r === 'object') r = (r as Record<string, unknown>).url;
  if (typeof r !== 'string') return null;
  return parseGithubUrl(r);
}

export function releasesUrl(repo: RepoRef): string {
  return `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`;
}

/** Error whose message is safe to log (we wrote it, it carries no URL). */
class CheckError extends Error {}

function reasonOf(e: unknown): string {
  if (e instanceof CheckError) return e.message;
  if (e instanceof Error && e.name === 'AbortError') return 'timeout';
  return 'network error';
}

async function readCapped(res: Response): Promise<string> {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) throw new CheckError('response too large');
  if (!res.body) {
    const t = await res.text();
    if (Buffer.byteLength(t) > MAX_BYTES) throw new CheckError('response too large');
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BYTES) {
      await reader.cancel();
      throw new CheckError('response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type Source = { kind: 'http'; url: string } | { kind: 'file'; path: string } | null;

export class UpdateChecker {
  private readonly deps: UpdateCheckerDeps;
  private readonly source: Source;
  private readonly fetchFn: FetchFn;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly interval: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private latest: ReleaseInfo | null = null;
  private checkedAt: number | null = null;
  private failed = false;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: UpdateCheckerDeps) {
    this.deps = deps;
    this.fetchFn = deps.fetchFn ?? ((url, init) => fetch(url, init));
    this.readFile = deps.readFile ?? ((p) => fs.promises.readFile(p, 'utf8'));
    this.interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.log(m));
    const override = (deps.url ?? process.env.CR_UPDATE_URL ?? '').trim();
    if (override) {
      this.source = /^https?:\/\//.test(override) ? { kind: 'http', url: override } : { kind: 'file', path: override };
    } else {
      this.source = deps.repo ? { kind: 'http', url: releasesUrl(deps.repo) } : null;
    }
  }

  status(): UpdateStatus {
    const current = this.deps.currentVersion;
    return {
      current,
      latest: this.latest,
      available: this.latest ? isNewer(this.latest.version, current) : false,
      checkedAt: this.checkedAt,
      enabled: this.deps.enabled(),
      failed: this.failed,
    };
  }

  /** One check. Resolves with the status; never rejects. Concurrent calls share one request. */
  checkNow(): Promise<UpdateStatus> {
    if (!this.deps.enabled() || !this.source) return Promise.resolve(this.status());
    if (!this.inflight) {
      this.inflight = this.doCheck().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight.then(() => this.status());
  }

  start(): void {
    this.stop();
    void this.checkNow();
    this.timer = setInterval(() => void this.checkNow(), this.interval);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async doCheck(): Promise<void> {
    const src = this.source;
    if (!src) return;
    try {
      const text = src.kind === 'http' ? await this.fetchText(src.url) : await this.readLocal(src.path);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new CheckError('bad JSON');
      }
      const rel = parseRelease(json);
      if (!rel) throw new CheckError('unrecognised release payload');
      this.latest = rel;
      this.checkedAt = this.now();
      this.failed = false;
    } catch (e) {
      this.failed = true;
      this.log(`update check failed: ${reasonOf(e)}`);
    }
  }

  private async readLocal(path: string): Promise<string> {
    const t = await this.readFile(path);
    if (Buffer.byteLength(t) > MAX_BYTES) throw new CheckError('response too large');
    return t;
  }

  private async fetchText(url: string): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const aborted = new Promise<never>((_, reject) => {
      ac.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    aborted.catch(() => undefined);
    try {
      return await Promise.race([
        (async () => {
          const res = await this.fetchFn(url, {
            headers: { 'User-Agent': 'claude-control-room', Accept: 'application/vnd.github+json' },
            signal: ac.signal,
          });
          if (!res.ok) throw new CheckError(`HTTP ${res.status}`);
          return readCapped(res);
        })(),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
