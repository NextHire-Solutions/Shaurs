import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { requireRead, requireWrite } from '@/lib/route-auth';
import { effectiveStatus, pushPortalStatus } from '@/lib/portal-status-push';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Auth is enforced HERE, not only in middleware.
//
// Master Inbox reads this route server-to-server (lib/portals/client-plan.ts)
// with x-admin-token and no cookie. Once DASHBOARD_PASSWORD was set, the
// middleware started refusing it — and Master Inbox swallows the error, so
// every client's plan silently became null with nothing in any log.
//
// Reads now accept READ_ONLY_TOKEN. Writes never do: a token handed to
// "lower-trust consumers" (its own words) must not be able to delete a client.
//
// PORTAL PUSH. This dashboard decides whether a client is active, paused or
// churned; MasterInbox switches that client's portal on or off to match. It
// polls on a schedule, so without a nudge a churned client's portal can stay
// open until the next run. Each write below therefore calls pushPortalStatus()
// AFTER it has succeeded — fire-and-forget, never able to fail the save.
// See lib/portal-status-push.ts.
//
// DELETE deliberately does NOT push. MasterInbox never touches a client that
// is absent from this feed — that rule is what stops an empty feed closing
// every portal at once — so a deleted client has nothing to reconcile.

export async function GET(req: NextRequest) {
  const denied = await requireRead(req);
  if (denied) return denied;

  const sb = getSupabase();
  const { data, error } = await sb.from('clients').select('*').order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clients: data });
}

export async function POST(req: NextRequest) {
  const denied = await requireWrite(req);
  if (denied) return denied;

  const body = await req.json();
  const sb = getSupabase();
  const { data, error } = await sb
    .from('clients')
    .insert({
      name: body.name,
      plan: body.plan,
      weekly_target: body.weekly_target,
      start_date: body.start_date ?? null,
      instantly_campaign_ids: body.instantly_campaign_ids ?? [],
      bison_campaign_ids: body.bison_campaign_ids ?? [],
      campaign_size: body.campaign_size ?? 0,
      billing_anchor_date: body.billing_anchor_date ?? null,
      billing_interval: body.billing_interval ?? 'biweekly',
      billing_interval_days: body.billing_interval_days ?? null,
      monthly_target: body.monthly_target ?? 0,
      campaign_aliases: body.campaign_aliases ?? [],
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // A new client is active, and MasterInbox may already hold a portal under
  // this name with the switch off. Let it reconcile now rather than wait.
  pushPortalStatus(`client created: ${data?.name ?? body.name}`);

  return NextResponse.json({ client: data }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const denied = await requireWrite(req);
  if (denied) return denied;

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const sb = getSupabase();

  // Read the row first, but only when this PATCH could actually move a portal.
  // MasterInbox matches clients BY NAME, so a rename changes which portal a
  // status applies to and counts as portal-affecting just as much as the two
  // flags do. Every other field (targets, billing, campaign ids) cannot, and
  // skips the extra round trip.
  const mayAffectPortal =
    body.hidden !== undefined ||
    body.client_paused !== undefined ||
    typeof body.name === 'string';
  const before = mayAffectPortal
    ? (
        await sb
          .from('clients')
          .select('name, hidden, client_paused')
          .eq('id', body.id)
          .maybeSingle()
      ).data
    : null;

  const update: Record<string, unknown> = {
    name: body.name,
    plan: body.plan,
    weekly_target: body.weekly_target,
    start_date: body.start_date,
    instantly_campaign_ids: body.instantly_campaign_ids,
  };
  // Only include bison_campaign_ids if the caller sent it — keeps older
  // clients from accidentally clearing the array via PATCH.
  if (body.bison_campaign_ids !== undefined) update.bison_campaign_ids = body.bison_campaign_ids;
  if (body.hidden !== undefined) update.hidden = body.hidden;
  if (body.client_paused !== undefined) update.client_paused = body.client_paused;
  if (body.portal_active !== undefined) update.portal_active = body.portal_active;
  if (body.billing_anchor_date !== undefined) update.billing_anchor_date = body.billing_anchor_date;
  if (body.billing_interval !== undefined) update.billing_interval = body.billing_interval;
  if (body.billing_interval_days !== undefined) update.billing_interval_days = body.billing_interval_days;
  if (body.time_zone !== undefined) update.time_zone = body.time_zone;
  if (body.monthly_target !== undefined) update.monthly_target = body.monthly_target;
  if (body.campaign_aliases !== undefined) update.campaign_aliases = body.campaign_aliases;
  const { data, error } = await sb
    .from('clients')
    .update(update)
    .eq('id', body.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Compare what the database actually stored, not what the caller asked for:
  // a no-op toggle (hiding an already-hidden client) must not fire a push, and
  // a field the update silently dropped must not look like a change.
  if (before && data) {
    const wasStatus = effectiveStatus(before);
    const nowStatus = effectiveStatus(data);
    if (wasStatus !== nowStatus) {
      pushPortalStatus(`${data.name}: ${wasStatus} -> ${nowStatus}`);
    } else if (before.name !== data.name) {
      pushPortalStatus(`renamed: ${before.name} -> ${data.name}`);
    }
  }

  return NextResponse.json({ client: data });
}

export async function DELETE(req: NextRequest) {
  const denied = await requireWrite(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const sb = getSupabase();

  // 1. Read the client's linked campaign IDs (both sources) so we can clean
  //    up orphans afterwards.
  const { data: clientRow, error: readErr } = await sb
    .from('clients')
    .select('instantly_campaign_ids, bison_campaign_ids')
    .eq('id', id)
    .single();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  const linkedInstantlyIds: string[] = clientRow?.instantly_campaign_ids ?? [];
  const linkedBisonIds: string[] = clientRow?.bison_campaign_ids ?? [];

  // 2. Delete the client. weekly_metrics rows cascade automatically
  //    (FK on weekly_metrics.client_id is ON DELETE CASCADE).
  const { error: delErr } = await sb.from('clients').delete().eq('id', id);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 400 });

  // 3. For each previously linked campaign, drop it from its source table if
  //    no OTHER client still references it. The next sync will re-add it
  //    if it still exists in the vendor — but until then the row is gone, so
  //    re-adding the same client doesn't show stale campaign data.
  let orphansRemoved = 0;
  for (const campaignId of linkedInstantlyIds) {
    const { data: stillLinked, error: lookupErr } = await sb
      .from('clients')
      .select('id')
      .contains('instantly_campaign_ids', [campaignId])
      .limit(1);
    if (lookupErr) continue;
    if (!stillLinked || stillLinked.length === 0) {
      const { error: campDelErr } = await sb
        .from('instantly_campaigns')
        .delete()
        .eq('id', campaignId);
      if (!campDelErr) orphansRemoved++;
    }
  }
  for (const campaignId of linkedBisonIds) {
    const { data: stillLinked, error: lookupErr } = await sb
      .from('clients')
      .select('id')
      .contains('bison_campaign_ids', [campaignId])
      .limit(1);
    if (lookupErr) continue;
    if (!stillLinked || stillLinked.length === 0) {
      const { error: campDelErr } = await sb
        .from('bison_campaigns')
        .delete()
        .eq('id', campaignId);
      if (!campDelErr) orphansRemoved++;
    }
  }

  return NextResponse.json({ ok: true, orphansRemoved });
}
