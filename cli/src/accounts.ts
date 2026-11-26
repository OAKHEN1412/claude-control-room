// `cr new --account <id|name>`: resolves the flag against the profiles the server reports. Pure: no I/O, unit-tested.
// Order: exact id, then exact name, then a unique name prefix (all case-insensitive). Hidden profiles are selectable.
import type { AccountInfo } from '../../shared/accounts.ts';

export type AccountResolution = { ok: true; id: string } | { ok: false; error: string };

/** Profile ids joined for an error message. Ids are slugs, so this never shows a token. */
export function accountIdList(accounts: readonly AccountInfo[]): string {
  return accounts.length > 0 ? accounts.map((a) => a.id).join(', ') : '(ยังไม่มีโปรไฟล์)';
}

export function resolveAccount(input: string, accounts: readonly AccountInfo[]): AccountResolution {
  const q = input.trim().toLowerCase();
  const available = `\nโปรไฟล์ที่ใช้ได้: ${accountIdList(accounts)}`;
  const fail = (error: string): AccountResolution => ({ ok: false, error: `${error}${available}` });

  let picked: AccountInfo | undefined;
  if (q !== '') {
    const byId = accounts.find((a) => a.id.toLowerCase() === q);
    if (byId) {
      picked = byId;
    } else {
      const exact = accounts.filter((a) => a.name.trim().toLowerCase() === q);
      const candidates = exact.length > 0 ? exact : accounts.filter((a) => a.name.trim().toLowerCase().startsWith(q));
      if (candidates.length > 1) {
        return fail(`ชื่อโปรไฟล์ตรงกับหลายตัว (${candidates.map((a) => a.id).join(', ')}) — ระบุ id ให้ชัด`);
      }
      picked = candidates[0];
    }
  }
  if (!picked) return fail('ไม่พบโปรไฟล์นี้');
  if (!picked.builtin && picked.tokenState === 'unset') {
    return fail(`ยังไม่ได้เชื่อมต่อ token ของโปรไฟล์ ${picked.id}`);
  }
  return { ok: true, id: picked.id };
}
