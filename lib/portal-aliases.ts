import { normalizeName } from './derive';

/**
 * Portal name → client name, for intros labelled with a client's OTHER
 * portals (see scripts/sync.ts). Built from each client's stored names
 * (`campaign_aliases`). An alias counts only when unambiguous: never another
 * client's own name, never claimed by two clients.
 */
export function buildAliasOverride(clients: { name: string; campaign_aliases: string[] | null }[]): Map<string, string> {
  const own = new Set(clients.map((c) => normalizeName(c.name)));
  const map = new Map<string, string>();
  const clash = new Set<string>();
  for (const c of clients) {
    for (const a of c.campaign_aliases ?? []) {
      const n = normalizeName(a);
      if (!n || own.has(n)) continue;
      const target = normalizeName(c.name);
      if (map.has(n) && map.get(n) !== target) clash.add(n);
      else map.set(n, target);
    }
  }
  for (const n of clash) map.delete(n);
  return map;
}
