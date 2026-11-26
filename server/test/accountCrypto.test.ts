// Password envelope for token profiles: round trip, wrong password, tampering, envelope shape. Small scrypt N
// (1024) keeps the tests fast; the default cost is checked once on the envelope produced without an override.
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, isEnvelope } from '../src/accountCrypto';

// Fake token only, shaped like a real one. Never a real credential.
const TOKEN = 'sk-ant-oat01-' + 'Crypto0123456789_-'.repeat(4);
const PASSWORD = 'correct horse 42';
const SMALL = { N: 1024 };

function fields(env: string): Record<string, unknown> {
  return JSON.parse(env) as Record<string, unknown>;
}

/** Re-encodes one field of an envelope as base64 of the bytes with one bit flipped. */
function flipBit(env: string, key: 'iv' | 'tag' | 'ct', byte = 0): string {
  const f = fields(env);
  const buf = Buffer.from(f[key] as string, 'base64');
  buf[byte] ^= 0x01;
  f[key] = buf.toString('base64');
  return JSON.stringify(f);
}

describe('encryptToken / decryptToken', () => {
  it('round-trips the token with the right password', () => {
    const env = encryptToken(TOKEN, PASSWORD, SMALL);
    expect(decryptToken(env, PASSWORD)).toBe(TOKEN);
  });

  it('returns null for a wrong password, an empty password and a non-string password', () => {
    const env = encryptToken(TOKEN, PASSWORD, SMALL);
    expect(decryptToken(env, 'wrong password')).toBeNull();
    expect(decryptToken(env, '')).toBeNull();
    expect(decryptToken(env, undefined as unknown as string)).toBeNull();
  });

  it('returns null for a tampered tag, ciphertext or iv', () => {
    const env = encryptToken(TOKEN, PASSWORD, SMALL);
    expect(decryptToken(flipBit(env, 'tag'), PASSWORD)).toBeNull();
    expect(decryptToken(flipBit(env, 'ct', 3), PASSWORD)).toBeNull();
    expect(decryptToken(flipBit(env, 'iv'), PASSWORD)).toBeNull();
  });

  it('returns null for a truncated ct or a bad salt length', () => {
    const env = encryptToken(TOKEN, PASSWORD, SMALL);
    const f = fields(env);
    expect(decryptToken(JSON.stringify({ ...f, ct: (f.ct as string).slice(0, 8) }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, salt: Buffer.from('short').toString('base64') }), PASSWORD)).toBeNull();
  });

  it('returns null for an N out of range, not a power of two, or a foreign kdf/version/r/p', () => {
    const env = encryptToken(TOKEN, PASSWORD, SMALL);
    const f = fields(env);
    expect(decryptToken(JSON.stringify({ ...f, N: 512 }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, N: 131072 }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, N: 1000 }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, N: 'big' }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, kdf: 'pbkdf2' }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, v: 2 }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, r: 1 }), PASSWORD)).toBeNull();
    expect(decryptToken(JSON.stringify({ ...f, p: 2 }), PASSWORD)).toBeNull();
  });

  it('returns null for text that is not an envelope at all', () => {
    expect(decryptToken('not json', PASSWORD)).toBeNull();
    expect(decryptToken('[]', PASSWORD)).toBeNull();
    expect(decryptToken(TOKEN, PASSWORD)).toBeNull();
  });

  it('never returns the password inside the envelope and never the token in plain text', () => {
    const env = encryptToken(TOKEN, PASSWORD, SMALL);
    expect(env).not.toContain(TOKEN);
    expect(env).not.toContain('sk-ant-oat01');
    expect(env).not.toContain(PASSWORD);
  });

  it('writes the envelope fields with the documented shape', () => {
    const f = fields(encryptToken(TOKEN, PASSWORD, SMALL));
    expect(Object.keys(f).sort()).toEqual(['N', 'ct', 'iv', 'kdf', 'p', 'r', 'salt', 'tag', 'v']);
    expect(f).toMatchObject({ v: 1, kdf: 'scrypt', N: 1024, r: 8, p: 1 });
    expect(Buffer.from(f.salt as string, 'base64')).toHaveLength(16);
    expect(Buffer.from(f.iv as string, 'base64')).toHaveLength(12);
    expect(Buffer.from(f.tag as string, 'base64')).toHaveLength(16);
  });

  it('uses a fresh salt and iv every time', () => {
    const a = fields(encryptToken(TOKEN, PASSWORD, SMALL));
    const b = fields(encryptToken(TOKEN, PASSWORD, SMALL));
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
  });

  it('defaults to scrypt N=32768 when no override is given', () => {
    const env = encryptToken(TOKEN, PASSWORD);
    expect(fields(env).N).toBe(32768);
    expect(decryptToken(env, PASSWORD)).toBe(TOKEN);
  });

  it('accepts the top of the N range (65536) on decrypt', () => {
    const env = encryptToken(TOKEN, PASSWORD, { N: 65536 });
    expect(decryptToken(env, PASSWORD)).toBe(TOKEN);
  });
});

describe('isEnvelope', () => {
  it('recognises an envelope and rejects a raw token or other text', () => {
    expect(isEnvelope(encryptToken(TOKEN, PASSWORD, SMALL))).toBe(true);
    expect(isEnvelope(TOKEN)).toBe(false);
    expect(isEnvelope('{"v":1}')).toBe(false);
    expect(isEnvelope('{"v":1,"kdf":"scrypt"}')).toBe(false);
    expect(isEnvelope('null')).toBe(false);
  });
});
