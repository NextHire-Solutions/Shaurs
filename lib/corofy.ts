// Corofy API client — second source of "Introduction" intros.
//
// Auth: `x-admin-token: <COROFY_ADMIN_TOKEN>` header (Supabase service-role JWT).
// Base: env COROFY_BASE_URL (e.g., https://alluring-ambition-production-d0b0.up.railway.app)
//
// Endpoints used:
//   GET /api/clients/intros — one row per intro with client_name + assigned_at
//
// Each intro row is matched to our clients by exact client_name ↔ clients.name.
// Unlike MasterInbox (which keys by campaign_id), Corofy's response is already
// keyed by client name — no campaign mapping needed.

const BASE = (process.env.COROFY_BASE_URL ?? '').replace(/\/$/, '');

function token(): string {
  const t = process.env.COROFY_ADMIN_TOKEN;
  if (!t) throw new Error('COROFY_ADMIN_TOKEN is not set');
  return t;
}

export interface CorofyIntro {
  client_name: string;
  assigned_at: string; // ISO 8601 UTC — when the lead entered this stage
  // Most recent lead-level modification (any writer, including automation).
  // Kept for backward-compat; superseded by client_activity_at.
  updated_at?: string;
  // Most recent CLIENT-DRIVEN action on this lead. Null when the client
  // has never touched it post-assignment. Excludes our-side automation
  // (FUB auto-push, move-agent, sync, new intro assignment). Used to
  // count "stagnant intros" per client on the Client Success tab.
  client_activity_at?: string | null;
  lead_email?: string | null;
  lead_name?: string | null;
  // Per-record campaign attribution (present on the Interested feed).
  // Instantly campaigns return a UUID string; Bison returns the integer id
  // as a short string (e.g. "55"). Match against instantly_campaigns.id
  // or against bison_campaigns.int_id (cast to string).
  campaign_id?: string | null;
  campaign_name?: string | null;
}

interface CorofyIntrosResp {
  ok: boolean;
  label: string;
  label_id: string;
  intros: CorofyIntro[];
}

// Defaults to "Introduction" (no label query param) for back-compat. Pass
// 'Interested' or 'Hired' to pull those labels instead. The 'Hired' label
// may not exist on the Corofy workspace yet — callers should treat 404s
// (label not found) as non-fatal and skip writing.
export async function listCorofyIntros(label?: 'Introduction' | 'Interested' | 'Hired'): Promise<CorofyIntro[]> {
  if (!BASE) throw new Error('COROFY_BASE_URL is not set');
  const url = new URL(`${BASE}/api/clients/intros`);
  if (label) url.searchParams.set('label', label);
  /*
   * A LOGIN PAGE IS NOT DATA, AND IT ARRIVES AS A 200.
   *
   * Master Inbox lets this call through on an `x-admin-token` header. While
   * that app is restarting — a deploy, or Railway moving the container — the
   * check briefly does not recognise the token, so the request is treated as an
   * unauthenticated browser visit and redirected to /login. `fetch` follows the
   * redirect and hands back that page, successfully, as HTML.
   *
   * The old code went straight to `res.json()`, which threw
   * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` and failed the
   * whole Corofy sync. Three of fourteen runs on 17 September died this way.
   *
   * So: recognise the page for what it is and try again after a moment. A
   * container restart is over in seconds, and the alternative — treating a
   * transient restart as a failed sync — is what made intro counts lag.
   */
  const attempt = async (): Promise<{ ok: boolean; status: number; body: string; isHtml: boolean }> => {
    const res = await fetch(url.toString(), {
      headers: { 'x-admin-token': token(), Accept: 'application/json' },
      cache: 'no-store',
    });
    const body = await res.text().catch(() => '');
    const type = res.headers.get('content-type') ?? '';
    const isHtml = !type.includes('json') || body.trimStart().startsWith('<');
    return { ok: res.ok, status: res.status, body, isHtml };
  };

  let r = await attempt();
  if (r.ok && r.isHtml) {
    console.warn('[corofy] got a web page instead of data — Master Inbox is probably restarting; retrying');
    await new Promise((done) => setTimeout(done, 3000));
    r = await attempt();
  }

  const what = `Corofy /api/clients/intros${label ? `?label=${label}` : ''}`;
  if (!r.ok) throw new Error(`${what} ${r.status}: ${r.body.slice(0, 200)}`);
  if (r.isHtml) {
    throw new Error(
      `${what} returned a web page rather than data, twice. Master Inbox may be down, ` +
        `or COROFY_ADMIN_TOKEN no longer matches its service-role key.`,
    );
  }

  let json: CorofyIntrosResp;
  try {
    json = JSON.parse(r.body) as CorofyIntrosResp;
  } catch {
    throw new Error(`${what} returned ${r.body.length} bytes that are not JSON: ${r.body.slice(0, 120)}`);
  }
  return json.intros ?? [];
}
