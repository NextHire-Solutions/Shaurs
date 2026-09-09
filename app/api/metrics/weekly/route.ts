// Weekly metrics, for other systems to read.
//
// The numbers people argue about most — emails sent, and introductions per
// week — are computed here and rendered straight into the dashboard. Nothing
// publishes them, so no other tool can check its own figures against ours, and
// "your intro count doesn't match mine" has never been settleable.
//
// This is the smallest thing that fixes that: one read-only endpoint over
// weekly_metrics, authenticated exactly like /api/clients/status.
//
// Auth: x-admin-token vs READ_ONLY_TOKEN. Unset → 500, never open. Matching
// the existing route rather than inventing a third convention, because a
// consumer that already reads /api/clients/status can reuse its token and its
// error handling unchanged.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabase } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Monday-start ISO week key, matching how the dashboard buckets. */
const WEEK_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** Weeks returned when the caller names no range. One quarter. */
const DEFAULT_WEEKS = 13;

/** Hard ceiling. The table holds 26 weeks per client across ~40 clients; an
 *  unbounded query would be a slow full scan on a route a poller may hit. */
const MAX_WEEKS = 26;

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const expected = process.env.READ_ONLY_TOKEN;
  if (!expected) {
    return NextResponse.json(
      { error: 'server misconfigured: READ_ONLY_TOKEN not set' },
      { status: 500 },
    );
  }
  if (req.headers.get('x-admin-token') !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const weeksParam = url.searchParams.get('weeks');

  if (from && !WEEK_KEY.test(from)) return bad('from must be YYYY-MM-DD (a Monday week_key)');
  if (to && !WEEK_KEY.test(to)) return bad('to must be YYYY-MM-DD (a Monday week_key)');

  let weeks = DEFAULT_WEEKS;
  if (weeksParam !== null) {
    const parsed = Number(weeksParam);
    if (!Number.isInteger(parsed) || parsed < 1) return bad('weeks must be a positive integer');
    weeks = Math.min(parsed, MAX_WEEKS);
  }

  const sb = getSupabase();

  let query = sb
    .from('weekly_metrics')
    .select('client_id, week_key, emails_sent, intros, intros_corofy, interested_corofy, last_intro_at')
    .order('week_key', { ascending: false });

  if (from) query = query.gte('week_key', from);
  if (to) query = query.lte('week_key', to);

  // Only cap by week count when the caller gave no explicit range — otherwise
  // a narrow range would be silently truncated, which is the kind of quiet
  // wrongness this endpoint exists to eliminate.
  const { data: rows, error } = await (from || to ? query : query.limit(weeks * 200));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: clients, error: clientsError } = await sb
    .from('clients')
    .select('id, name, plan, weekly_target, hidden, client_paused');
  if (clientsError) {
    return NextResponse.json({ error: clientsError.message }, { status: 500 });
  }

  const byId = new Map((clients ?? []).map((c) => [c.id, c]));

  // Names are included alongside ids because every other tool in the stack
  // joins clients by NAME, not by our id. Forcing them to make a second call
  // to resolve one would guarantee they cache it and drift.
  const metrics = (rows ?? []).map((r) => {
    const client = byId.get(r.client_id);
    return {
      client_id: r.client_id,
      client_name: client?.name ?? null,
      plan: client?.plan ?? null,
      weekly_target: client?.weekly_target ?? null,
      status: !client ? null : client.hidden ? 'churned' : client.client_paused ? 'paused' : 'active',
      week_key: r.week_key,
      emails_sent: r.emails_sent,
      intros: r.intros,
      intros_corofy: r.intros_corofy,
      interested_corofy: r.interested_corofy,
      last_intro_at: r.last_intro_at,
    };
  });

  const weekKeys = [...new Set(metrics.map((m) => m.week_key))].sort();

  return NextResponse.json({
    ok: true,
    // Stated rather than assumed: every consumer has to bucket by the same
    // week boundary or the comparison is meaningless.
    week_starts_on: 'monday',
    definitions: {
      emails_sent: 'Emails sent that week, summed from Instantly and EmailBison.',
      intros: 'Introductions recorded that week by this app.',
      intros_corofy: 'Introductions imported from Master Inbox for that week.',
      interested_corofy: 'Threads labelled Interested in Master Inbox for that week.',
    },
    range: { from: weekKeys[0] ?? null, to: weekKeys[weekKeys.length - 1] ?? null },
    week_count: weekKeys.length,
    count: metrics.length,
    metrics,
  });
}
