// Read-only client-status listing. Returns id + name + status for every
// client in the DB, no filtering. Consumed by external systems that need
// a full roster snapshot without pulling the whole client profile.
//
// Auth: shared secret in `x-admin-token`, checked against READ_ONLY_TOKEN.
// Distinct from ONBOARDING_TOKEN so this read-only path can be handed to
// lower-trust consumers without exposing write access.
//
// Status semantics (3-way, mirrors the dashboard's filter views):
//   churned = hidden=true            (dashboard "Hidden" view)
//   paused  = client_paused=true AND !hidden   (dashboard "Client Paused" view)
//   active  = !hidden AND !client_paused       (everyone else — default view)
// hidden wins if both flags are set, matching how the dashboard prioritizes
// the Hidden filter (line 169 of app/Dashboard.tsx).

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ClientStatus = 'active' | 'paused' | 'churned';

export async function GET(req: NextRequest) {
  const secret = process.env.READ_ONLY_TOKEN;
  if (!secret) return NextResponse.json({ error: 'server misconfigured: READ_ONLY_TOKEN not set' }, { status: 500 });
  if (req.headers.get('x-admin-token') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const sb = getSupabase();
  const { data, error } = await sb
    .from('clients')
    .select('id, name, hidden, client_paused')
    .order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const clients = (data ?? []).map((c) => {
    let status: ClientStatus;
    if (c.hidden) status = 'churned';
    else if (c.client_paused) status = 'paused';
    else status = 'active';
    return { id: c.id, name: c.name, status };
  });

  const counts = clients.reduce(
    (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
    { active: 0, paused: 0, churned: 0 } as Record<ClientStatus, number>,
  );

  return NextResponse.json({ total: clients.length, counts, clients });
}
