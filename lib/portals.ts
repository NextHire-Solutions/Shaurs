// Corofy portals API client — surfaces which clients have an active
// portal in the Corofy / MasterInbox system.
//
// Auth: same `x-admin-token` header as listCorofyIntros, but the token
// here is the Corofy app's Supabase service-role JWT, not the BrokerStaffer
// one. Both happen to be served by the same Railway deployment, just
// different routes.

const BASE = (process.env.COROFY_BASE_URL ?? '').replace(/\/$/, '');

export interface CorofyPortal {
  id: string;
  name: string;
  slug: string;
  aliases?: string[];
  portal_token: string;
  portal_url: string;
  portal_enabled: boolean;
  fub_connected: boolean;
  fub_connected_at: string | null;
  counts?: { pipeline: number; dnc: number; agents: number; team: number };
  created_at: string;
  updated_at: string;
  // Most recent updated_at across every lead in the portal (any stage).
  // Bumped on stage changes AND note additions. Null when the portal has
  // no leads or none have been touched since creation.
  last_lead_activity_at?: string | null;
}

interface CorofyPortalsResp {
  ok: boolean;
  workspace_id: string;
  count: number;
  clients: CorofyPortal[];
}

export async function listCorofyPortals(): Promise<CorofyPortal[]> {
  if (!BASE || !process.env.COROFY_ADMIN_TOKEN) return [];
  try {
    const res = await fetch(`${BASE}/api/clients/portals`, {
      headers: {
        'x-admin-token': process.env.COROFY_ADMIN_TOKEN,
        Accept: 'application/json',
      },
      cache: 'no-store',
    });
    if (!res.ok) return [];
    const json = (await res.json()) as CorofyPortalsResp;
    return json?.clients ?? [];
  } catch {
    // Network/parse error — degrade gracefully (portalActive flag will be
    // false for every client this load; next load may recover).
    return [];
  }
}
