// Shared client → Instantly campaign matching logic. Used by both the seed
// script (server-side, full campaign list) and the Add/Edit Client modal
// (client-side, list pulled at page load). Keep the rules identical so a
// client name added through the UI yields the same links as a re-seed would.

interface NamedCampaign {
  id: string;
  name: string;
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,()]/g, '')
    .replace(/&/g, 'and')
    .replace(/[-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whole-name match: a campaign matches a client if its normalized name
 * CONTAINS the normalized client name as a substring — or contains ANY of
 * the client's normalized aliases. Aliases are stored per-client on
 * clients.campaign_aliases and edited via the client modal, so ops can fix
 * naming drift without a code deploy.
 */
export function autoMatchCampaigns<T extends NamedCampaign>(
  clientName: string,
  campaigns: readonly T[],
  aliases: readonly string[] = [],
): T[] {
  const cnorm = normalizeForMatch(clientName);
  if (!cnorm) return [];
  const aliasNorms = aliases
    .map(normalizeForMatch)
    .filter((s) => s.length > 0);
  return campaigns.filter((c) => {
    const cn = normalizeForMatch(c.name);
    if (cn.includes(cnorm)) return true;
    return aliasNorms.some((a) => cn.includes(a));
  });
}

export function autoMatchCampaignIds(
  clientName: string,
  campaigns: readonly NamedCampaign[],
  aliases: readonly string[] = [],
): string[] {
  return autoMatchCampaigns(clientName, campaigns, aliases).map((c) => c.id);
}
