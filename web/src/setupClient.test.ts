import { describe, expect, it, vi } from 'vitest';
import {
  applyUpdate,
  busyReason,
  buildSettingsPatch,
  canUpdateReasonKey,
  checkHintKey,
  checkTitleKey,
  CHECK_IDS,
  dismissVersion,
  draftFromConfig,
  fetchSettings,
  isDismissed,
  isHttpsUrl,
  isValidKeyInput,
  joinLines,
  keyState,
  keyStateKey,
  markSetupSeen,
  hasSeenSetup,
  parseLines,
  putSecret,
  statusClass,
  statusKey,
  updateNowDisabled,
  updateWhenIdleDisabled,
  type CrConfig,
  type FlagStore,
  type UpdateState,
} from './setupClient';
import { tx } from './i18n';
import { en } from './i18n/en';
import { th } from './i18n/th';

const BASE = 'http://127.0.0.1:9999';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function memStore(init: Record<string, string> = {}): FlagStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  } as FlagStore & { data: Record<string, string> };
}

const CONFIG: CrConfig = {
  language: 'auto',
  port: null,
  galleryRoots: ['C:/a'],
  videosDir: null,
  extraCwds: [],
  voices: [{ id: 'abcdefgh1234', name: 'Narrator' }],
  update: { check: true, channel: 'stable' },
};

function update(over: Partial<UpdateState> = {}): UpdateState {
  return {
    current: '1.0.0',
    latest: { version: '1.1.0', tag: 'v1.1.0', url: 'https://example.com/r', notes: '', publishedAt: '' },
    available: true,
    checkedAt: 0,
    enabled: true,
    failed: false,
    canUpdate: { ok: true },
    busy: { running: 0, waiting: 0, clips: 0 },
    scheduled: false,
    applying: false,
    ...over,
  };
}

describe('busy reason', () => {
  it('returns null when nothing is busy', () => {
    expect(busyReason({ running: 0, waiting: 0, clips: 0 })).toBeNull();
  });
  it('prefers running, then waiting, then clips', () => {
    expect(busyReason({ running: 2, waiting: 1, clips: 1 })).toEqual({ key: 'upd.busy.running', count: 2 });
    expect(busyReason({ running: 0, waiting: 3, clips: 1 })).toEqual({ key: 'upd.busy.waiting', count: 3 });
    expect(busyReason({ running: 0, waiting: 0, clips: 4 })).toEqual({ key: 'upd.busy.clips', count: 4 });
  });
});

describe('canUpdate reason mapping', () => {
  it('maps the known reasons and falls back to the generic key', () => {
    expect(canUpdateReasonKey('no-marker')).toBe('upd.reason.noMarker');
    expect(canUpdateReasonKey('dirty-tree')).toBe('upd.reason.dirtyTree');
    expect(canUpdateReasonKey('not-git')).toBe('upd.reason.notGit');
    expect(canUpdateReasonKey('something-new')).toBe('upd.reason.other');
    expect(canUpdateReasonKey(undefined)).toBe('upd.reason.other');
  });
});

describe('update button logic', () => {
  it('Update now is enabled only when idle, canUpdate ok and not applying', () => {
    expect(updateNowDisabled(update())).toBe(false);
    expect(updateNowDisabled(update({ busy: { running: 1, waiting: 0, clips: 0 } }))).toBe(true);
    expect(updateNowDisabled(update({ busy: { running: 0, waiting: 0, clips: 2 } }))).toBe(true);
    expect(updateNowDisabled(update({ canUpdate: { ok: false, reason: 'no-marker' } }))).toBe(true);
    expect(updateNowDisabled(update({ applying: true }))).toBe(true);
  });
  it('Update when idle is disabled when canUpdate is not ok or already scheduled', () => {
    expect(updateWhenIdleDisabled(update())).toBe(false);
    expect(updateWhenIdleDisabled(update({ canUpdate: { ok: false, reason: 'dirty-tree' } }))).toBe(true);
    expect(updateWhenIdleDisabled(update({ scheduled: true }))).toBe(true);
    expect(updateWhenIdleDisabled(update({ applying: true }))).toBe(true);
  });
});

describe('isHttpsUrl', () => {
  it('accepts only https URLs', () => {
    expect(isHttpsUrl('https://github.com/x/y/releases/tag/v1.0.0')).toBe(true);
    expect(isHttpsUrl('http://example.com')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
    expect(isHttpsUrl(42)).toBe(false);
    expect(isHttpsUrl(undefined)).toBe(false);
  });
});

describe('status mapping', () => {
  it('maps ok, warn and fail to classes and text keys', () => {
    expect(statusClass('ok')).toBe('st-ok');
    expect(statusClass('warn')).toBe('st-warn');
    expect(statusClass('fail')).toBe('st-fail');
    expect(statusClass('weird')).toBe('st-warn');
    expect(statusKey('ok')).toBe('doc.status.ok');
    expect(statusKey('warn')).toBe('doc.status.warn');
    expect(statusKey('fail')).toBe('doc.status.fail');
  });
  it('translates every known check id and leaves unknown ids untranslated', () => {
    for (const id of CHECK_IDS) {
      expect(checkTitleKey(id)).toBe(`doc.check.${id}.title`);
      expect(checkHintKey(id)).toBe(`doc.check.${id}.hint`);
    }
    expect(checkTitleKey('madeUpCheck')).toBeNull();
    expect(checkHintKey('madeUpCheck')).toBeNull();
  });
});

describe('key state (write-only secret)', () => {
  it('only ever yields set or unset', () => {
    expect(keyState('set')).toBe('set');
    expect(keyState('unset')).toBe('unset');
    expect(keyState('sk-live-123456789')).toBe('unset');
    expect(keyState(undefined)).toBe('unset');
    expect(keyStateKey('set')).toBe('set.key.set');
    expect(keyStateKey('unset')).toBe('set.key.unset');
  });
  it('validates key input with the server rule and returns a boolean only', () => {
    expect(isValidKeyInput('abcdefgh')).toBe(true);
    expect(isValidKeyInput('  abcdefgh  ')).toBe(true);
    expect(isValidKeyInput('short')).toBe(false);
    expect(isValidKeyInput('has space inside')).toBe(false);
    expect(isValidKeyInput('x'.repeat(201))).toBe(false);
  });
  it('putSecret returns only the key state, never the value it sent or the echoed body', async () => {
    const secret = 'sk-test-SECRETVALUE-42';
    const f = vi.fn(async () => jsonResponse({ ok: true, value: secret, secrets: { elevenlabs: 'set' } }));
    const r = await putSecret(secret, BASE, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: 'set' });
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('putSecret surfaces only the server error code', async () => {
    const f = vi.fn(async () => jsonResponse({ ok: false, error: 'INVALID_VALUE' }, 400));
    const r = await putSecret('bad value', BASE, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: false, error: 'INVALID_VALUE' });
  });
});

describe('patch builder', () => {
  it('returns an empty patch when nothing changed', () => {
    expect(buildSettingsPatch(CONFIG, draftFromConfig(CONFIG))).toEqual({});
  });
  it('includes only the changed fields', () => {
    const d = draftFromConfig(CONFIG);
    d.language = 'th';
    d.updateCheck = false;
    expect(buildSettingsPatch(CONFIG, { ...d })).toEqual({ language: 'th', update: { check: false } });
  });
  it('compares path lists after parsing lines, ignoring blank lines and spaces', () => {
    const d = draftFromConfig(CONFIG);
    d.galleryRootsText = '  C:/a  \n\n';
    expect(buildSettingsPatch(CONFIG, d)).toEqual({});
    d.galleryRootsText = 'C:/a\nD:/b';
    expect(buildSettingsPatch(CONFIG, d)).toEqual({ galleryRoots: ['C:/a', 'D:/b'] });
  });
  it('sends an empty videosDir as null so it clears the value', () => {
    const saved: CrConfig = { ...CONFIG, videosDir: 'E:/v' };
    const d = draftFromConfig(saved);
    d.videosDir = '   ';
    expect(buildSettingsPatch(saved, d)).toEqual({ videosDir: null });
  });
  it('sends a changed port and a changed voices list in full', () => {
    const d = draftFromConfig(CONFIG);
    d.port = 8800;
    d.voices = [...d.voices, { id: 'zzzzzzzz9999', name: 'Second' }];
    expect(buildSettingsPatch(CONFIG, d)).toEqual({
      port: 8800,
      voices: [
        { id: 'abcdefgh1234', name: 'Narrator' },
        { id: 'zzzzzzzz9999', name: 'Second' },
      ],
    });
  });
  it('line helpers round-trip', () => {
    expect(parseLines('a\r\n\r\n b ')).toEqual(['a', 'b']);
    expect(joinLines(['a', 'b'])).toBe('a\nb');
  });
});

describe('local flags', () => {
  it('first-run flag is set once and read back', () => {
    const s = memStore();
    expect(hasSeenSetup(s)).toBe(false);
    markSetupSeen(s);
    expect(hasSeenSetup(s)).toBe(true);
  });
  it('dismiss is per version', () => {
    const s = memStore();
    dismissVersion('1.1.0', s);
    expect(isDismissed('1.1.0', s)).toBe(true);
    expect(isDismissed('1.2.0', s)).toBe(false);
  });
  it('survives storage that throws', () => {
    const bad: FlagStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(hasSeenSetup(bad)).toBe(false);
    expect(() => markSetupSeen(bad)).not.toThrow();
    expect(isDismissed('1.1.0', bad)).toBe(false);
    expect(() => dismissVersion('1.1.0', bad)).not.toThrow();
  });
});

describe('network helpers', () => {
  it('fetchSettings returns the config and never adds a secret value', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        config: CONFIG,
        warnings: [],
        envOverrides: { port: false, galleryRoots: false, videosDir: false, extraCwds: false },
        secrets: { elevenlabs: 'set' },
        dataDir: 'D:/data',
        file: 'D:/data/config.json',
      }),
    );
    const r = await fetchSettings(BASE, f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.secrets.elevenlabs).toBe('set');
    expect(String(f.mock.calls[0][0])).toBe(`${BASE}/api/settings`);
  });
  it('applyUpdate sends whenIdle and reads the result', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ ok: true, applying: false, scheduled: true }));
    const r = await applyUpdate(true, BASE, f as unknown as typeof fetch);
    expect(r).toEqual({ ok: true, value: { applying: false, scheduled: true } });
    const init = f.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ whenIdle: true });
  });
  it('returns NETWORK when fetch throws', async () => {
    const f = vi.fn(async () => {
      throw new Error('offline');
    });
    expect(await fetchSettings(BASE, f as unknown as typeof fetch)).toEqual({ ok: false, error: 'NETWORK' });
  });
});

describe('setup UI dictionary keys', () => {
  // Every key the setup UI builds at runtime (doctor check, busy reason, update reason, status, key state) must exist in
  // both languages, or the UI would show a raw key.
  const usedKeys = (): string[] => {
    const keys: string[] = [];
    for (const id of CHECK_IDS) {
      keys.push(checkTitleKey(id) ?? '', checkHintKey(id) ?? '');
    }
    for (const running of [1, 0]) {
      for (const waiting of [1, 0]) {
        for (const clips of [1, 0]) {
          const r = busyReason({ running, waiting, clips });
          if (r) keys.push(r.key);
        }
      }
    }
    for (const reason of ['no-marker', 'dirty-tree', 'not-git', 'something-new', undefined]) {
      keys.push(canUpdateReasonKey(reason));
    }
    for (const s of ['ok', 'warn', 'fail']) keys.push(statusKey(s));
    keys.push(keyStateKey('set'), keyStateKey('unset'));
    return keys;
  };

  it('has every runtime-built key in both th and en', () => {
    for (const k of usedKeys()) {
      expect(th, `th:${k}`).toHaveProperty([k]);
      expect(en, `en:${k}`).toHaveProperty([k]);
    }
  });

  it('shows the raw id when a doctor check id is unknown', () => {
    expect(checkTitleKey('madeUpCheck')).toBeNull();
    expect(tx(checkTitleKey('madeUpCheck'), undefined, 'madeUpCheck')).toBe('madeUpCheck');
  });
});
