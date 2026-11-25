// `cr update`: argument parsing and the arguments handed to scripts/update.mjs (the updater itself is tested on the
// server side, server/test/updater.test.ts).
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/args.ts';
import { REPO_ROOT, runUpdateCommand, updateScriptArgs } from '../src/update.ts';
import type { UpdateCommand } from '../src/update.ts';

const parse = (argv: string[]) => parseArgs(argv, 'C:\\work', {});

describe('cr update: parseArgs', () => {
  it('--latest or --tag vX.Y.Z, with --skills and --dry-run as flags', () => {
    expect(parse(['update', '--latest'])).toMatchObject({
      ok: true,
      command: { kind: 'update', latest: true, skills: false, dryRun: false },
    });
    expect(parse(['update', '--tag', 'v0.2.0', '--skills', '--dry-run'])).toMatchObject({
      ok: true,
      command: { kind: 'update', tag: 'v0.2.0', latest: false, skills: true, dryRun: true },
    });
    expect(parse(['update', '--tag=v1.10.3'])).toMatchObject({ command: { kind: 'update', tag: 'v1.10.3' } });
  });

  it('needs exactly one of --latest / --tag, a well-formed tag, and no extra words', () => {
    expect(parse(['update'])).toMatchObject({ ok: false });
    expect(parse(['update', '--latest', '--tag', 'v1.0.0'])).toMatchObject({ ok: false });
    expect(parse(['update', '--tag', 'v1.0'])).toMatchObject({ ok: false });
    expect(parse(['update', '--tag', 'main'])).toMatchObject({ ok: false });
    expect(parse(['update', '--tag', 'v1.0.0; del'])).toMatchObject({ ok: false });
    expect(parse(['update', '--latest', 'extra'])).toMatchObject({ ok: false });
  });

  it('keeps the usual port handling and refuses a bad tag with Thai text', () => {
    expect(parse(['update', '--latest', '--port', '9001'])).toMatchObject({ ok: true, port: 9001 });
    const bad = parse(['update', '--tag', 'x']);
    expect(bad.ok === false && bad.error).toContain('vX.Y.Z');
  });
});

describe('cr update: arguments for scripts/update.mjs', () => {
  const base: UpdateCommand = { kind: 'update', latest: true, skills: false, dryRun: false };

  it('runs the script under the repo root with the flags passed through', () => {
    expect(updateScriptArgs(base)).toEqual([path.join(REPO_ROOT, 'scripts', 'update.mjs'), '--latest']);
    expect(updateScriptArgs({ kind: 'update', tag: 'v0.3.1', latest: false, skills: true, dryRun: true })).toEqual([
      path.join(REPO_ROOT, 'scripts', 'update.mjs'),
      '--tag',
      'v0.3.1',
      '--skills',
      '--dry-run',
    ]);
  });

  it('returns the updater exit code, inheriting stdio; a spawn error gives 1', () => {
    const seen: Array<{ args: string[]; opts: { stdio?: string } }> = [];
    const fakeSpawn = ((_cmd: string, args: string[], opts: { stdio?: string }) => {
      seen.push({ args, opts });
      return { status: 3, error: undefined };
    }) as unknown as typeof import('node:child_process').spawnSync;
    expect(runUpdateCommand(base, fakeSpawn)).toBe(3);
    expect(seen[0].opts.stdio).toBe('inherit');
    const broken = (() => ({ status: null, error: new Error('ENOENT') })) as unknown as typeof import('node:child_process').spawnSync;
    expect(runUpdateCommand(base, broken)).toBe(1);
  });
});
