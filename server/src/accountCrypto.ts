// Password envelope for a token profile. A token stored with a password is kept as this JSON text in the secret
// store (DPAPI entry `account:<id>`): AES-256-GCM, key = scrypt(password, salt). The token and the password never
// appear in the envelope itself. decryptToken never throws: any failure (wrong password, tampered field, unknown
// format or cost) returns null.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const VERSION = 1;
const KDF = 'scrypt';
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const DEFAULT_N = 32768;
const N_MIN = 1024;
const N_MAX = 65536;
// scrypt needs 128 * N * r bytes: N=65536 with r=8 is 64 MiB plus overhead, so the cap is 128 MiB to accept the full range.
const MAXMEM = 128 * 1024 * 1024;

interface Envelope {
  v: number;
  kdf: string;
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

function parseEnvelope(envelope: string): Envelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(envelope);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.salt !== 'string' || typeof e.iv !== 'string' || typeof e.tag !== 'string' || typeof e.ct !== 'string') return null;
  return {
    v: e.v as number,
    kdf: e.kdf as string,
    N: e.N as number,
    r: e.r as number,
    p: e.p as number,
    salt: e.salt,
    iv: e.iv,
    tag: e.tag,
    ct: e.ct,
  };
}

/** True when `s` has the shape of a password envelope (not a validity check: decryptToken decides that). */
export function isEnvelope(s: string): boolean {
  const e = parseEnvelope(s);
  return e !== null && e.v === VERSION && e.kdf === KDF;
}

/** Encrypts `token` with `password`. The default scrypt cost is N=32768; `opts.N` exists for tests only. */
export function encryptToken(token: string, password: string, opts?: { N?: number }): string {
  const N = opts?.N ?? DEFAULT_N;
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = scryptSync(password, salt, KEY_LEN, { N, r: R, p: P, maxmem: MAXMEM });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out: Envelope = {
    v: VERSION,
    kdf: KDF,
    N,
    r: R,
    p: P,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(out);
}

/** The token inside `envelope`, or null for a wrong password, a tampered or unknown envelope. Never throws. */
export function decryptToken(envelope: string, password: string): string | null {
  try {
    if (typeof password !== 'string') return null;
    const e = parseEnvelope(envelope);
    if (!e || e.v !== VERSION || e.kdf !== KDF) return null;
    if (e.r !== R || e.p !== P) return null;
    if (!Number.isInteger(e.N) || e.N < N_MIN || e.N > N_MAX || (e.N & (e.N - 1)) !== 0) return null;
    const salt = Buffer.from(e.salt, 'base64');
    const iv = Buffer.from(e.iv, 'base64');
    const tag = Buffer.from(e.tag, 'base64');
    const ct = Buffer.from(e.ct, 'base64');
    if (salt.length !== SALT_LEN || iv.length !== IV_LEN || tag.length !== TAG_LEN) return null;
    const key = scryptSync(password, salt, KEY_LEN, { N: e.N, r: R, p: P, maxmem: MAXMEM });
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    return null;
  }
}
