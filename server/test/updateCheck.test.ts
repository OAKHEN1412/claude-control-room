import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateApi } from '../src/updateApi';
import {
  UpdateChecker,
  compareVersions,
  isNewer,
  parseRelease,
  parseVersion,
  releasesUrl,
  repoFromPackage,
  type FetchFn,
} from '../src/updateCheck';

const rel = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/acme/tool/releases/tag/${tag}`,
  body: 'what changed',
  published_at: '2026-11-01T10:00:00Z',
  draft: false,
  prerelease: false,
  ...extra,
});

/** Fake GitHub: answers with whatever `state` says at call time, and records each URL it was asked for. */
function fakeGithub(state: { body?: string; status?: number; tag?: string; extra?: Record<string, unknown> }, calls: string[] = []): FetchFn {
  return async (url) => {
    calls.push(url);
    const body = state.body ?? JSON.stringify(rel(state.tag ?? 'v1.2.0', state.extra));
    return new Response(body, { status: state.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('parseVersion', () => {
  it.each([
    ['v1.2.3', { major: 1, minor: 2, patch: 3, pre: null }],
    ['1.2.3', { major: 1, minor: 2, patch: 3, pre: null }],
    ['1.2.3-rc.1', { major: 1, minor: 2, patch: 3, pre: 'rc.1' }],
    [' v0.10.0 ', { major: 0, minor: 10, patch: 0, pre: null }],
  ])('accepts %s', (s, want) => {
    expect(parseVersion(s)).toEqual(want);
  });

  it.each(['', 'v1.2', '1.2.3.4', 'abc', 'v1.2.x', '1.2.3-', 'latest', '-1.2.3'])('rejects %s', (s) => {
    expect(parseVersion(s)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseVersion(123)).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });
});

describe('compareVersions / isNewer', () => {
  it.each([
    ['1.2.3', '1.2.3', 0],
    ['v1.0.0', '1.0.0', 0],
    ['1.2.4', '1.2.3', 1],
    ['1.10.0', '1.9.9', 1],
    ['2.0.0', '10.0.0', -1],
    ['1.2.3-rc.1', '1.2.3', -1],
    ['1.2.3', '1.2.3-rc.1', 1],
    ['1.2.3-rc.1', '1.2.3-rc.1', 0],
    ['1.2.3-rc.2', '1.2.3-rc.10', -1],
    ['1.2.3-alpha', '1.2.3-beta', -1],
    ['1.2.3-1', '1.2.3-alpha', -1],
    ['1.2.3-rc', '1.2.3-rc.1', -1],
  ])('compare(%s, %s) = %i', (a, b, want) => {
    expect(compareVersions(a, b)).toBe(want);
  });

  it('isNewer is strict and false for garbage', () => {
    expect(isNewer('1.2.4', '1.2.3')).toBe(true);
    expect(isNewer('v2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.2.3', '1.2.3')).toBe(false);
    expect(isNewer('1.2.2', '1.2.3')).toBe(false);
    expect(isNewer('1.2.3', '1.2.3-rc.1')).toBe(true);
    expect(isNewer('garbage', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'garbage')).toBe(false);
  });
});

describe('parseRelease', () => {
  it('reads a normal release', () => {
    expect(parseRelease(rel('v1.2.3'))).toEqual({
      version: '1.2.3',
      tag: 'v1.2.3',
      url: 'https://github.com/acme/tool/releases/tag/v1.2.3',
      notes: 'what changed',
      publishedAt: '2026-11-01T10:00:00Z',
    });
  });

  it('adds the v prefix to a bare tag and keeps the prerelease suffix in version', () => {
    const r = parseRelease(rel('1.2.3-rc.1', { prerelease: false }));
    expect(r?.version).toBe('1.2.3-rc.1');
    expect(r?.tag).toBe('v1.2.3-rc.1');
  });

  it('ignores drafts and prereleases', () => {
    expect(parseRelease(rel('v1.2.3', { draft: true }))).toBeNull();
    expect(parseRelease(rel('v1.2.3', { prerelease: true }))).toBeNull();
  });

  it('returns null for a tag that does not parse or a non-object', () => {
    expect(parseRelease(rel('nightly'))).toBeNull();
    expect(parseRelease({ body: 'x' })).toBeNull();
    expect(parseRelease(null)).toBeNull();
    expect(parseRelease('v1.2.3')).toBeNull();
  });

  it('sets url to null unless html_url is a github.com https link', () => {
    expect(parseRelease(rel('v1.2.3', { html_url: 'http://github.com/acme/tool' }))?.url).toBeNull();
    expect(parseRelease(rel('v1.2.3', { html_url: 'https://evil.example/x' }))?.url).toBeNull();
    expect(parseRelease(rel('v1.2.3', { html_url: undefined }))?.url).toBeNull();
  });

  it('truncates notes to 4000 characters and tolerates a missing body', () => {
    expect(parseRelease(rel('v1.2.3', { body: 'x'.repeat(5000) }))?.notes).toHaveLength(4000);
    expect(parseRelease(rel('v1.2.3', { body: 'short' }))?.notes).toBe('short');
    expect(parseRelease(rel('v1.2.3', { body: undefined }))?.notes).toBe('');
    expect(parseRelease(rel('v1.2.3', { published_at: undefined }))?.publishedAt).toBeNull();
  });
});

describe('repoFromPackage / releasesUrl', () => {
  it.each([
    [{ repository: 'git+https://github.com/acme/tool.git' }, { owner: 'acme', repo: 'tool' }],
    [{ repository: { url: 'https://github.com/acme/tool' } }, { owner: 'acme', repo: 'tool' }],
    [{ repository: 'github:acme/tool' }, { owner: 'acme', repo: 'tool' }],
    [{ repository: { url: 'https://github.com/acme/tool.git/' } }, { owner: 'acme', repo: 'tool' }],
    [{ repository: 'https://gitlab.com/acme/tool' }, null],
    [{ repository: 'https://github.com/acme/tool/tree/main' }, null],
    [{ repository: { type: 'git' } }, null],
    [{}, null],
    [null, null],
  ])('%j', (pkg, want) => {
    expect(repoFromPackage(pkg)).toEqual(want);
  });

  it('builds the latest-release API URL', () => {
    expect(releasesUrl({ owner: 'acme', repo: 'tool' })).toBe('https://api.github.com/repos/acme/tool/releases/latest');
  });
});

describe('UpdateChecker', () => {
  const URL_ = 'https://api.github.com/repos/acme/tool/releases/latest';
  let logs: string[];
  beforeEach(() => {
    logs = [];
  });

  it('reports a newer release as available', async () => {
    const c = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: null,
      url: URL_,
      enabled: () => true,
      fetchFn: fakeGithub({ tag: 'v1.2.0' }),
      now: () => 1700000000000,
      log: (m) => logs.push(m),
    });
    const s = await c.checkNow();
    expect(s.available).toBe(true);
    expect(s.latest?.tag).toBe('v1.2.0');
    expect(s.checkedAt).toBe(1700000000000);
    expect(s.failed).toBe(false);
    expect(s.enabled).toBe(true);
    expect(s.current).toBe('1.0.0');
  });

  it('reports the same version as not available', async () => {
    const c = new UpdateChecker({ currentVersion: '1.2.0', repo: null, url: URL_, enabled: () => true, fetchFn: fakeGithub({ tag: 'v1.2.0' }), log: () => {} });
    const s = await c.checkNow();
    expect(s.available).toBe(false);
    expect(s.latest?.version).toBe('1.2.0');
  });

  it('reports an older release as not available', async () => {
    const c = new UpdateChecker({ currentVersion: '2.0.0', repo: null, url: URL_, enabled: () => true, fetchFn: fakeGithub({ tag: 'v1.2.0' }), log: () => {} });
    expect((await c.checkNow()).available).toBe(false);
  });

  it('keeps the last good result on failure, sets failed, and recovers', async () => {
    const state: { tag?: string; status?: number } = { tag: 'v1.2.0' };
    const c = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: null,
      url: URL_,
      enabled: () => true,
      fetchFn: fakeGithub(state),
      log: (m) => logs.push(m),
    });
    await c.checkNow();
    state.status = 503;
    const bad = await c.checkNow();
    expect(bad.failed).toBe(true);
    expect(bad.latest?.version).toBe('1.2.0');
    expect(bad.available).toBe(true);
    expect(logs).toEqual(['update check failed: HTTP 503']);
    state.status = 200;
    expect((await c.checkNow()).failed).toBe(false);
  });

  it('treats bad JSON and an unusable payload as failure without logging the body', async () => {
    const c = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: null,
      url: URL_,
      enabled: () => true,
      fetchFn: fakeGithub({ body: '<html>SECRET-BODY' }),
      log: (m) => logs.push(m),
    });
    const s = await c.checkNow();
    expect(s.failed).toBe(true);
    expect(s.latest).toBeNull();
    expect(logs).toEqual(['update check failed: bad JSON']);
    const d = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: null,
      url: URL_,
      enabled: () => true,
      fetchFn: fakeGithub({ tag: 'v1.2.0', extra: { draft: true } }),
      log: (m) => logs.push(m),
    });
    expect((await d.checkNow()).failed).toBe(true);
    expect(logs.join('\n')).not.toContain('SECRET-BODY');
  });

  it('logs network errors without the URL or its query string', async () => {
    const c = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: null,
      url: 'https://api.example.test/latest?token=SECRET123',
      enabled: () => true,
      fetchFn: async () => {
        throw new Error('getaddrinfo failed for https://api.example.test/latest?token=SECRET123');
      },
      log: (m) => logs.push(m),
    });
    const s = await c.checkNow();
    expect(s.failed).toBe(true);
    expect(logs).toEqual(['update check failed: network error']);
    expect(logs.join('\n')).not.toContain('SECRET123');
  });

  it('sends the User-Agent and Accept headers', async () => {
    const seen: Record<string, string>[] = [];
    const c = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: { owner: 'acme', repo: 'tool' },
      enabled: () => true,
      fetchFn: async (_u, init) => {
        seen.push(init.headers);
        return new Response(JSON.stringify(rel('v1.2.0')), { status: 200 });
      },
      log: () => {},
    });
    await c.checkNow();
    expect(seen[0]).toMatchObject({ 'User-Agent': 'claude-control-room', Accept: 'application/vnd.github+json' });
  });

  it('builds the URL from the repo when no override is given', async () => {
    const calls: string[] = [];
    const prev = process.env.CR_UPDATE_URL;
    delete process.env.CR_UPDATE_URL;
    try {
      const c = new UpdateChecker({ currentVersion: '1.0.0', repo: { owner: 'acme', repo: 'tool' }, enabled: () => true, fetchFn: fakeGithub({ tag: 'v1.2.0' }, calls), log: () => {} });
      await c.checkNow();
    } finally {
      if (prev !== undefined) process.env.CR_UPDATE_URL = prev;
    }
    expect(calls).toEqual(['https://api.github.com/repos/acme/tool/releases/latest']);
  });

  it('does nothing when disabled', async () => {
    const calls: string[] = [];
    const c = new UpdateChecker({ currentVersion: '1.0.0', repo: null, url: URL_, enabled: () => false, fetchFn: fakeGithub({ tag: 'v9.0.0' }, calls), log: () => {} });
    const s = await c.checkNow();
    expect(calls).toEqual([]);
    expect(s.enabled).toBe(false);
    expect(s.latest).toBeNull();
    expect(s.available).toBe(false);
    expect(s.checkedAt).toBeNull();
  });

  it('reads a local JSON file when the override is a path', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-upd-'));
    try {
      const file = path.join(dir, 'release.json');
      fs.writeFileSync(file, JSON.stringify(rel('v3.0.0')));
      const calls: string[] = [];
      const c = new UpdateChecker({ currentVersion: '1.0.0', repo: null, url: file, enabled: () => true, fetchFn: fakeGithub({}, calls), log: () => {} });
      const s = await c.checkNow();
      expect(calls).toEqual([]);
      expect(s.latest?.version).toBe('3.0.0');
      expect(s.available).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the override from CR_UPDATE_URL when no url is passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-upd-'));
    const prev = process.env.CR_UPDATE_URL;
    try {
      const file = path.join(dir, 'release.json');
      fs.writeFileSync(file, JSON.stringify(rel('v1.5.0')));
      process.env.CR_UPDATE_URL = file;
      const calls: string[] = [];
      const c = new UpdateChecker({ currentVersion: '1.0.0', repo: { owner: 'acme', repo: 'tool' }, enabled: () => true, fetchFn: fakeGithub({}, calls), log: () => {} });
      expect((await c.checkNow()).latest?.version).toBe('1.5.0');
      expect(calls).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CR_UPDATE_URL;
      else process.env.CR_UPDATE_URL = prev;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up after 10 s with a timeout failure', async () => {
    vi.useFakeTimers();
    try {
      const fetchFn: FetchFn = (_u, init) =>
        new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      const c = new UpdateChecker({ currentVersion: '1.0.0', repo: null, url: URL_, enabled: () => true, fetchFn, log: (m) => logs.push(m) });
      const p = c.checkNow();
      await vi.advanceTimersByTimeAsync(10_000);
      const s = await p;
      expect(s.failed).toBe(true);
      expect(logs).toEqual(['update check failed: timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a response over 256 KB', async () => {
    const c = new UpdateChecker({
      currentVersion: '1.0.0',
      repo: null,
      url: URL_,
      enabled: () => true,
      fetchFn: fakeGithub({ body: 'x'.repeat(300 * 1024) }),
      log: (m) => logs.push(m),
    });
    const s = await c.checkNow();
    expect(s.failed).toBe(true);
    expect(logs).toEqual(['update check failed: response too large']);
  });

  it('start() checks at once and then on each interval; stop() ends the timer', async () => {
    vi.useFakeTimers();
    try {
      const calls: string[] = [];
      const c = new UpdateChecker({
        currentVersion: '1.0.0',
        repo: null,
        url: URL_,
        enabled: () => true,
        fetchFn: fakeGithub({ tag: 'v1.2.0' }, calls),
        intervalMs: 1000,
        log: () => {},
      });
      c.start();
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toHaveLength(2);
      c.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('UpdateApi', () => {
  interface Harness {
    port: number;
    close: () => Promise<void>;
    api: UpdateApi;
    checker: UpdateChecker;
    busy: { running: number; waiting: number; clips: number };
    can: { ok: boolean; reason?: string };
    started: string[];
    startResult: { ok: boolean; error?: string };
    gh: { tag: string };
    gets: { n: number };
  }

  let h: Harness;

  async function setup(opts: { current?: string; tag?: string } = {}): Promise<Harness> {
    const busy = { running: 0, waiting: 0, clips: 0 };
    const can: { ok: boolean; reason?: string } = { ok: true };
    const started: string[] = [];
    const startResult: { ok: boolean; error?: string } = { ok: true };
    const gh = { tag: opts.tag ?? 'v1.2.0' };
    const gets = { n: 0 };
    const checker = new UpdateChecker({
      currentVersion: opts.current ?? '1.0.0',
      repo: null,
      url: 'https://api.github.com/repos/acme/tool/releases/latest',
      enabled: () => true,
      fetchFn: async () => {
        gets.n++;
        return new Response(JSON.stringify(rel(gh.tag)), { status: 200 });
      },
      log: () => {},
    });
    await checker.checkNow();
    const api = new UpdateApi({
      originAllowed: (o) => o === undefined || o === 'http://127.0.0.1:8790',
      checker,
      canUpdate: async () => ({ ...can }),
      busy: () => ({ ...busy }),
      startUpdater: async (tag) => {
        started.push(tag);
        return { ...startResult };
      },
      poll: 10,
    });
    const server = http.createServer((req, res) => {
      if (!api.handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    return {
      port,
      api,
      checker,
      busy,
      can,
      started,
      startResult,
      gh,
      gets,
      close: () =>
        new Promise<void>((r) => {
          api.stop();
          server.close(() => r());
        }),
    };
  }

  function call(port: number, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const r = http.request(
        {
          host: '127.0.0.1',
          port,
          method,
          path: p,
          headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } : headers,
        },
        (res) => {
          let t = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => (t += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null }));
        },
      );
      r.on('error', reject);
      if (data) r.write(data);
      r.end();
    });
  }

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  afterEach(async () => {
    if (h) await h.close();
  });

  it('GET /api/update returns the status payload', async () => {
    h = await setup();
    const r = await call(h.port, 'GET', '/api/update');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      current: '1.0.0',
      available: true,
      latest: { version: '1.2.0', tag: 'v1.2.0' },
      failed: false,
      canUpdate: { ok: true },
      busy: { running: 0, waiting: 0, clips: 0 },
      scheduled: false,
      applying: false,
    });
  });

  it('POST /api/update/check runs a fresh check and returns the payload', async () => {
    h = await setup();
    h.gh.tag = 'v1.3.0';
    const before = h.gets.n;
    const r = await call(h.port, 'POST', '/api/update/check');
    expect(h.gets.n).toBe(before + 1);
    expect(r.json.latest.version).toBe('1.3.0');
  });

  it('refuses apply with no-update when already current', async () => {
    h = await setup({ current: '2.0.0' });
    const r = await call(h.port, 'POST', '/api/update/apply', {});
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, error: 'no-update' });
    expect(h.started).toEqual([]);
  });

  it('refuses apply with cannot-update on a dev checkout and says why', async () => {
    h = await setup();
    h.can.ok = false;
    h.can.reason = 'dev checkout';
    const r = await call(h.port, 'POST', '/api/update/apply', {});
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, error: 'cannot-update', reason: 'dev checkout' });
    expect(h.started).toEqual([]);
  });

  it('refuses apply with busy and the busy counts while work is running', async () => {
    h = await setup();
    h.busy.running = 1;
    const r = await call(h.port, 'POST', '/api/update/apply', {});
    expect(r.status).toBe(409);
    expect(r.json).toEqual({ ok: false, error: 'busy', busy: { running: 1, waiting: 0, clips: 0 } });
    expect(h.started).toEqual([]);
  });

  it('whenIdle schedules the apply and fires exactly once when busy turns to zero', async () => {
    h = await setup();
    h.busy.waiting = 2;
    h.busy.clips = 1;
    const r = await call(h.port, 'POST', '/api/update/apply', { whenIdle: true });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, scheduled: true });
    expect((await call(h.port, 'GET', '/api/update')).json.scheduled).toBe(true);
    await new Promise((res) => setTimeout(res, 60));
    expect(h.started).toEqual([]);
    h.busy.waiting = 0;
    h.busy.clips = 0;
    await waitFor(() => h.started.length > 0);
    await new Promise((res) => setTimeout(res, 80));
    expect(h.started).toEqual(['v1.2.0']);
    const after = (await call(h.port, 'GET', '/api/update')).json;
    expect(after.scheduled).toBe(false);
    expect(after.applying).toBe(true);
  });

  it('cancel clears a scheduled apply so it never fires', async () => {
    h = await setup();
    h.busy.running = 1;
    await call(h.port, 'POST', '/api/update/apply', { whenIdle: true });
    const c = await call(h.port, 'POST', '/api/update/cancel');
    expect(c.json).toMatchObject({ ok: true, scheduled: false });
    h.busy.running = 0;
    await new Promise((res) => setTimeout(res, 80));
    expect(h.started).toEqual([]);
    expect((await call(h.port, 'GET', '/api/update')).json.scheduled).toBe(false);
  });

  it('starts the updater with the checker tag, never the tag in the body', async () => {
    h = await setup();
    const r = await call(h.port, 'POST', '/api/update/apply', { tag: 'v9.9.9' });
    expect(r.json).toEqual({ ok: true, applying: true });
    expect(h.started).toEqual(['v1.2.0']);
  });

  it('refuses a tag that is not vX.Y.Z (a prerelease) with bad-tag', async () => {
    h = await setup({ tag: 'v1.2.0-rc.1' });
    const r = await call(h.port, 'POST', '/api/update/apply', {});
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ ok: false, error: 'bad-tag' });
    expect(h.started).toEqual([]);
  });

  it('allows only one apply at a time', async () => {
    h = await setup();
    expect((await call(h.port, 'POST', '/api/update/apply', {})).json).toEqual({ ok: true, applying: true });
    const again = await call(h.port, 'POST', '/api/update/apply', {});
    expect(again.status).toBe(409);
    expect(again.json.error).toBe('already-applying');
    expect(h.started).toEqual(['v1.2.0']);
  });

  it('reports a failed updater start as 500 and leaves applying false', async () => {
    h = await setup();
    h.startResult.ok = false;
    h.startResult.error = 'boom';
    const r = await call(h.port, 'POST', '/api/update/apply', {});
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ ok: false, error: 'boom' });
    expect((await call(h.port, 'GET', '/api/update')).json.applying).toBe(false);
  });

  it('answers 403 to a non-loopback origin', async () => {
    h = await setup();
    const r = await call(h.port, 'GET', '/api/update', undefined, { Origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  it('answers 404 for an unknown /api/update path and ignores other /api paths', async () => {
    h = await setup();
    expect((await call(h.port, 'GET', '/api/update/nope')).status).toBe(404);
    expect(h.api.handle({ url: '/api/clip-config', headers: {}, method: 'GET' } as unknown as http.IncomingMessage, {} as http.ServerResponse)).toBe(false);
  });
});
