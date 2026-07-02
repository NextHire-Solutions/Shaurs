// External client-onboarding endpoint. Server-to-server: an outside caller
// (Corofy onboarding, Zapier, etc.) POSTs the fields it knows about a new
// client — name, plan, weekly target, onboarding date, billing schedule —
// and the endpoint auto-links matching Instantly/Bison campaigns using the
// same name-matching rule the Add-Client modal applies.
//
// Auth: shared secret in `x-admin-token`, checked against ONBOARDING_TOKEN.
// If the env var is unset the endpoint refuses all requests (500 rather
// than accidentally exposing an open create endpoint).
//
// Fields that are server-managed (campaign IDs, flags, today's counters)
// are ignored if the caller supplies them.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';
import { autoMatchCampaignIds } from '@/lib/matchCampaigns';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLANS = ['minimum', 'production', 'partner'] as const;
const INTERVALS = ['biweekly', '28-days', 'monthly', 'custom'] as const;
type Plan = (typeof PLANS)[number];
type Interval = (typeof INTERVALS)[number];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(req: NextRequest) {
  const secret = process.env.ONBOARDING_TOKEN;
  if (!secret) return bad('server misconfigured: ONBOARDING_TOKEN not set', 500);
  if (req.headers.get('x-admin-token') !== secret) return bad('unauthorized', 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad('invalid JSON body');
  }

  // --- required fields ---
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return bad('name is required');

  const plan = body.plan as Plan;
  if (!PLANS.includes(plan)) return bad(`plan must be one of ${PLANS.join(', ')}`);

  const weeklyTarget = Number(body.weekly_target);
  if (!Number.isInteger(weeklyTarget) || weeklyTarget < 0) {
    return bad('weekly_target must be an integer >= 0');
  }

  // --- optional fields ---
  const startDate = body.start_date == null ? null : String(body.start_date);
  if (startDate && !ISO_DATE.test(startDate)) return bad('start_date must be YYYY-MM-DD');

  const billingAnchorDate = body.billing_anchor_date == null ? null : String(body.billing_anchor_date);
  if (billingAnchorDate && !ISO_DATE.test(billingAnchorDate)) {
    return bad('billing_anchor_date must be YYYY-MM-DD');
  }

  const billingInterval = (body.billing_interval as Interval | undefined) ?? 'biweekly';
  if (!INTERVALS.includes(billingInterval)) {
    return bad(`billing_interval must be one of ${INTERVALS.join(', ')}`);
  }

  let billingIntervalDays: number | null = null;
  if (body.billing_interval_days != null) {
    const n = Number(body.billing_interval_days);
    if (!Number.isInteger(n) || n <= 0) return bad('billing_interval_days must be a positive integer');
    billingIntervalDays = n;
  }
  if (billingInterval === 'custom' && billingIntervalDays == null) {
    return bad('billing_interval_days is required when billing_interval="custom"');
  }

  const sb = getSupabase();

  // Duplicate-name guard — case-insensitive exact match.
  const dupe = await sb.from('clients').select('id, name').ilike('name', name).limit(1);
  if (dupe.error) return bad(dupe.error.message, 500);
  if (dupe.data && dupe.data.length > 0) {
    return NextResponse.json(
      { error: 'client with this name already exists', existing_id: dupe.data[0].id },
      { status: 409 },
    );
  }

  // Auto-link campaigns by normalized-name substring — same rule as the
  // Add-Client modal in the dashboard.
  const [instantlyRes, bisonRes] = await Promise.all([
    sb.from('instantly_campaigns').select('id, name'),
    sb.from('bison_campaigns').select('id, name'),
  ]);
  if (instantlyRes.error) return bad(instantlyRes.error.message, 500);
  if (bisonRes.error) return bad(bisonRes.error.message, 500);

  const instantlyIds = autoMatchCampaignIds(name, instantlyRes.data ?? []);
  const bisonIds = autoMatchCampaignIds(name, bisonRes.data ?? []);

  const insert = await sb
    .from('clients')
    .insert({
      name,
      plan,
      weekly_target: weeklyTarget,
      start_date: startDate,
      billing_anchor_date: billingAnchorDate,
      billing_interval: billingInterval,
      billing_interval_days: billingIntervalDays,
      instantly_campaign_ids: instantlyIds,
      bison_campaign_ids: bisonIds,
    })
    .select()
    .single();

  if (insert.error) return bad(insert.error.message, 500);

  return NextResponse.json(
    {
      client: insert.data,
      linked: { instantly: instantlyIds, bison: bisonIds },
    },
    { status: 201 },
  );
}
