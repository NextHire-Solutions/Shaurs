// Markets, MLS and Area each client covers, read live from the BrokerStaffer OS.
//
// The OS keeps them on its master client record (the Master Inbox Supabase,
// os_clients — migration 0022), as the client data sheet has them: Markets is
// a NUMBER, MLS a list of board codes, Area a list of names. Three independent
// facts, not paired rows (the client, 30 Sep). os_clients.ch_client_id is this
// dashboard's clients.id. Read-only, server-side only.
//
// Fail-soft: without the two env vars, or when the OS database is slow or
// down, this returns null and the dashboard renders without the markets line
// rather than failing the whole page.

export interface Market {
  /** How many markets — the sheet's number. Null when not recorded. */
  markets: number | null;
  mls: string[];
  areas: string[];
}

const TIMEOUT_MS = 4_000;

/** clients.id → that client's markets. Null when the OS can't be reached. */
export async function loadMarketsByClient(): Promise<Map<string, Market> | null> {
  const url = process.env.MASTER_INBOX_SUPABASE_URL;
  const key = process.env.MASTER_INBOX_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(
      `${url.replace(/\/$/, '')}/rest/v1/os_clients` +
        '?select=ch_client_id,market_count,mls_codes,areas&ch_client_id=not.is.null',
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
      market_count: number | null;
      mls_codes: string[] | null;
      areas: string[] | null;
    }[];
    const out = new Map<string, Market>();
    for (const r of rows) {
      out.set(r.ch_client_id, { markets: r.market_count ?? null, mls: r.mls_codes ?? [], areas: r.areas ?? [] });
    }
    return out;
  } catch (err) {
    console.warn(`[markets] could not read OS markets: ${(err as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "MLS: BRIGHT, CVR\nArea: greater Richmond" — the hover on "N markets". */
export function describeMarket(m: Market): string {
  return [m.mls.length ? `MLS: ${m.mls.join(', ')}` : null, m.areas.length ? `Area: ${m.areas.join(', ')}` : null]
    .filter(Boolean).join('\n');
}
