// Server-side data loader. Pulls the last N weeks of metrics in a single
// query so the dashboard can switch weeks client-side without re-fetching.

import { getSupabase } from './supabase';
import { generateSeed } from './seed';
import {
  HISTORICAL_WEEKS,
  type BillingInterval,
  type BisonCampaign,
  type DashboardClient,
  type InstantlyCampaign,
  type Plan,
  type WeeklyMetric,
} from './types';
import { addDays, getMondayOf, weekKey } from './derive';

interface ClientRow {
  id: string;
  name: string;
  plan: Plan;
  weekly_target: number;
  start_date: string | null;
  instantly_campaign_ids: string[];
  bison_campaign_ids: string[];
  campaign_size: number;
  hidden: boolean;
  client_paused: boolean;
  portal_active: boolean;
  billing_anchor_date: string | null;
  billing_interval: BillingInterval | null;
  billing_interval_days: number | null;
  emails_today: number | null;
  emails_today_date: string | null;
  portal_synced_at: string | null;
  time_zone: string | null;
  dnc_count: number | null;
  agents_count: number | null;
  last_lead_activity_at: string | null;
  stagnant_intros_count: number | null;
  intros_since_last_billing: number | null;
}

export async function loadDashboardClients(): Promise<{
  clients: DashboardClient[];
  allInstantlyCampaigns: InstantlyCampaign[];
  allBisonCampaigns: BisonCampaign[];
  source: 'supabase' | 'seed';
  error?: string;
}> {
  let sb;
  try {
    sb = getSupabase();
  } catch (err) {
    return {
      clients: generateSeed(),
      allInstantlyCampaigns: [],
      allBisonCampaigns: [],
      source: 'seed',
      error: (err as Error).message,
    };
  }

  // Sliding window: this Monday minus N-1 weeks.
  const earliestMonday = weekKey(addDays(getMondayOf(new Date()), -7 * (HISTORICAL_WEEKS - 1)));

  // Supabase's PostgREST caps a single response at 1000 rows by default. With
  // 40+ clients × 26 weeks of history we bump straight into that ceiling and
  // random weeks get silently dropped from random clients (Chucktown/Howe hit
  // this and looked like they had zero intros this week). Paginate through
  // the metrics table explicitly so every row lands in memory. The other
  // three tables are small — one row per client / one per campaign — and
  // stay well under 1000.
  const PAGE_SIZE = 1000;
  async function fetchAllMetrics(): Promise<{ data: WeeklyMetric[]; error: { message: string } | null }> {
    const all: WeeklyMetric[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await sb!
        .from('weekly_metrics')
        .select('*')
        .gte('week_key', earliestMonday)
        .order('week_key', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);
      if (error) return { data: all, error };
      const rows = (data ?? []) as WeeklyMetric[];
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return { data: all, error: null };
  }

  const [clientsRes, metricsRes, campaignsRes, bisonRes] = await Promise.all([
    sb.from('clients').select('*').order('name'),
    fetchAllMetrics(),
    sb.from('instantly_campaigns').select('*'),
    sb.from('bison_campaigns').select('*'),
  ]);

  if (clientsRes.error) {
    return {
      clients: generateSeed(),
      allInstantlyCampaigns: [],
      allBisonCampaigns: [],
      source: 'seed',
      error: clientsRes.error.message,
    };
  }

  const allInstantlyCampaigns = (campaignsRes.data ?? []) as InstantlyCampaign[];
  const allBisonCampaigns = (bisonRes.data ?? []) as BisonCampaign[];
  const clients = (clientsRes.data ?? []) as ClientRow[];
  if (clients.length === 0) {
    return { clients: [], allInstantlyCampaigns, allBisonCampaigns, source: 'supabase' };
  }

  const metricsByClient = new Map<string, Record<string, WeeklyMetric>>();
  for (const m of (metricsRes.data ?? []) as WeeklyMetric[]) {
    let bucket = metricsByClient.get(m.client_id);
    if (!bucket) {
      bucket = {};
      metricsByClient.set(m.client_id, bucket);
    }
    bucket[m.week_key] = m;
  }

  const campaignsById = new Map<string, InstantlyCampaign>(
    allInstantlyCampaigns.map((c) => [c.id, c])
  );
  const bisonById = new Map<string, BisonCampaign>(
    allBisonCampaigns.map((c) => [c.id, c])
  );

  const dashboardClients: DashboardClient[] = clients.map((c) => {
    const linkedCampaigns = (c.instantly_campaign_ids ?? [])
      .map((id) => campaignsById.get(id))
      .filter((x): x is InstantlyCampaign => Boolean(x));
    const linkedBison = (c.bison_campaign_ids ?? [])
      .map((id) => bisonById.get(id))
      .filter((x): x is BisonCampaign => Boolean(x));

    return {
      id: c.id,
      name: c.name,
      plan: c.plan,
      weekly_target: c.weekly_target,
      start_date: c.start_date,
      instantly_campaign_ids: c.instantly_campaign_ids ?? [],
      bison_campaign_ids: c.bison_campaign_ids ?? [],
      campaign_size: c.campaign_size ?? 0,
      hidden: c.hidden ?? false,
      client_paused: c.client_paused ?? false,
      portal_active: c.portal_active ?? false,
      billing_anchor_date: c.billing_anchor_date ?? null,
      billing_interval: c.billing_interval ?? 'biweekly',
      billing_interval_days: c.billing_interval_days ?? null,
      emails_today: c.emails_today ?? 0,
      emails_today_date: c.emails_today_date ?? null,
      portal_synced_at: c.portal_synced_at ?? null,
      time_zone: c.time_zone ?? null,
      dnc_count: c.dnc_count ?? 0,
      agents_count: c.agents_count ?? 0,
      last_lead_activity_at: c.last_lead_activity_at ?? null,
      stagnant_intros_count: c.stagnant_intros_count ?? 0,
      intros_since_last_billing: c.intros_since_last_billing ?? 0,
      campaigns: linkedCampaigns,
      bisonCampaigns: linkedBison,
      metricsByWeek: metricsByClient.get(c.id) ?? {},
      portalActive: c.portal_active ?? false,
    };
  });

  return { clients: dashboardClients, allInstantlyCampaigns, allBisonCampaigns, source: 'supabase' };
}
