// Markets each client covers, read live from the BrokerStaffer OS.
//
// The OS keeps them in its own database (the Master Inbox Supabase):
// os_client_markets rows hang off os_clients, and os_clients.ch_client_id is
// this dashboard's clients.id. Read-only, server-side only.
//
// Fail-soft: without the two env vars, or when the OS database is slow or
// down, this returns null and the dashboard renders without the markets line
// rather than failing the whole page.

export interface Market {
  market: string;
  mls: string | null;
  area: string | null;
}

const TIMEOUT_MS = 4_000;

/** clients.id → that client's markets. Null when the OS can't be reached. */
export async function loadMarketsByClient(): Promise<Map<string, Market[]> | null> {
  const url = process.env.MASTER_INBOX_SUPABASE_URL;
  const key = process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/os_clients` +
        '?select=ch_client_id,os_client_markets(market,mls,area)&ch_client_id=not.is.null',
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        cache: 'no-store',
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      console.warn(`[markets] OS returned ${res.status}`);
      return null;
    }
    const rows = (await res.json()) as {
      ch_client_id: string;
      os_client_markets: Market[] | null;
    }[];
    const out = new Map<string, Market[]>();
    for (const r of rows) {
      const list = out.get(r.ch_client_id) ?? [];
      list.push(...(r.os_client_markets ?? []));
      out.set(r.ch_client_id, list);
    }
    return out;
  } catch (err) {
    console.warn(`[markets] could not read OS markets: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function describeMarket(m: Market): string {
  return [m.market, m.mls, m.area].filter(Boolean).join(' · ');
}
