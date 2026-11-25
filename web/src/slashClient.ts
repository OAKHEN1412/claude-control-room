// Fetches the slash-menu list once per session (kept in memory). New-job composers have no session: key ''.
import type { SlashCommand } from '../../shared/protocol';
import { apiBase } from './useServer';

const cache = new Map<string, Promise<SlashCommand[]>>();

export function loadSlashCommands(sessionId?: string): Promise<SlashCommand[]> {
  const key = sessionId ?? '';
  const hit = cache.get(key);
  if (hit) return hit;
  const q = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
  const p = fetch(`${apiBase()}/api/slash-commands${q}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ commands?: SlashCommand[] }>) : { commands: [] }))
    .then((j) => (Array.isArray(j.commands) ? j.commands : []))
    .catch(() => [] as SlashCommand[])
    .then((list) => {
      if (list.length === 0 && cache.get(key) === p) cache.delete(key); // empty = not known yet: ask again next time
      return list;
    });
  cache.set(key, p);
  return p;
}
