import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const sb = getSupabase();
  const { data, error } = await sb.from('clients').select('*').order('name');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ clients: data });
}

export async function POST(req: NextRequest) {
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
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ client: data }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const sb = getSupabase();
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
  const { data, error } = await sb
    .from('clients')
    .update(update)
    .eq('id', body.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ client: data });
}

export async function DELETE(req: NextRequest) {
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
