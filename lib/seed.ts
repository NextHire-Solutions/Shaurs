import { addDays, weekKey } from './derive';
import type { DashboardClient } from './types';

// Generates the seed dataset matching client-dashboard.html, used until
// Supabase + sync worker are wired in. Real deployments replace this entirely.
export function generateSeed(): DashboardClient[] {
  const now = new Date();
  const W0 = weekKey(now);

  // Helper to build a metrics row for a given week + values.
  const m = (clientId: string, key: string, emails: number, intros: number, lastIntro?: string | null) => ({
    client_id: clientId,
    week_key: key,
    emails_sent: emails,
    intros_corofy: intros,
    last_corofy_intro_at: lastIntro ?? null,
    interested_corofy: 0,
    last_interested_at: null,
    hired_corofy: 0,
    last_hired_at: null,
  });

  // For seed/preview we hand out one fictional "current week" metrics row per client.
  // The map() below fills all default-able fields so the literals here can omit them.
  type SeedCampaign<T> = Omit<T, 'reply_count' | 'interested_count'>;
  const seed: (Omit<
    DashboardClient,
    'hidden'
    | 'client_paused'
    | 'portal_active'
    | 'portalActive'
    | 'billing_anchor_date'
    | 'billing_interval'
    | 'billing_interval_days'
    | 'emails_today'
    | 'emails_today_date'
    | 'portal_synced_at'
    | 'time_zone'
    | 'dnc_count'
    | 'agents_count'
    | 'last_lead_activity_at'
    | 'stagnant_intros_count'
    | 'intros_since_last_billing'
    | 'monthly_target'
    | 'intros_this_month'
    | 'campaigns'
    | 'bisonCampaigns'
  > & {
    campaigns: SeedCampaign<DashboardClient['campaigns'][number]>[];
    bisonCampaigns: SeedCampaign<DashboardClient['bisonCampaigns'][number]>[];
  })[] = [
    {
      id: 'de001',
      name: 'Douglas Elliman',
      plan: 'partner',
      weekly_target: 6,
      start_date: '2026-02-10',
      instantly_campaign_ids: ['camp_de001'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 2200,
      campaigns: [
        { id: 'camp_de001', name: 'NYC Broker Outreach', status: 'running', emails_sent_total: 1238, campaign_size: 2200, progress_pct: 56 },
      ],
      metricsByWeek: { [W0]: m('de001', W0, 212, 8, addDays(now, -1).toISOString()) },
    },
    {
      id: 'cp001',
      name: 'Compass',
      plan: 'partner',
      weekly_target: 6,
      start_date: '2026-01-28',
      instantly_campaign_ids: ['camp_cp001a', 'camp_cp001b'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 1600,
      campaigns: [
        { id: 'camp_cp001a', name: 'Bay Area Sequence', status: 'running', emails_sent_total: 980, campaign_size: 1200, progress_pct: 82 },
        { id: 'camp_cp001b', name: 'Re-engagement', status: 'paused', emails_sent_total: 131, campaign_size: 400, progress_pct: 33 },
      ],
      metricsByWeek: { [W0]: m('cp001', W0, 187, 4, addDays(now, -2).toISOString()) },
    },
    {
      id: 'kw001',
      name: 'Keller Williams Realty Partners',
      plan: 'production',
      weekly_target: 3,
      start_date: '2026-03-10',
      instantly_campaign_ids: ['camp_kw001'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 900,
      campaigns: [
        { id: 'camp_kw001', name: 'Mid-Market Push', status: 'running', emails_sent_total: 798, campaign_size: 900, progress_pct: 89 },
      ],
      metricsByWeek: { [W0]: m('kw001', W0, 134, 5, addDays(now, 0).toISOString()) },
    },
    {
      id: 'c21001',
      name: 'Century 21 Signature Group',
      plan: 'production',
      weekly_target: 3,
      start_date: '2026-02-24',
      instantly_campaign_ids: ['camp_c21001'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 1100,
      campaigns: [
        { id: 'camp_c21001', name: 'Spring Campaign', status: 'paused', emails_sent_total: 731, campaign_size: 1100, progress_pct: 66 },
      ],
      metricsByWeek: { [W0]: m('c21001', W0, 0, 1, addDays(now, -10).toISOString()) },
    },
    {
      id: 'lf001',
      name: 'Long & Foster Real Estate',
      plan: 'partner',
      weekly_target: 6,
      start_date: '2026-01-05',
      instantly_campaign_ids: ['camp_lf001a', 'camp_lf001b'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 1400,
      campaigns: [
        { id: 'camp_lf001a', name: 'DC Metro Sequence', status: 'running', emails_sent_total: 730, campaign_size: 1100, progress_pct: 66 },
        { id: 'camp_lf001b', name: 'Virginia Follow-up', status: 'finished', emails_sent_total: 300, campaign_size: 300, progress_pct: 100 },
      ],
      metricsByWeek: { [W0]: m('lf001', W0, 167, 7, addDays(now, -3).toISOString()) },
    },
    {
      id: 'ev001',
      name: 'Engel & Volkers Chicago',
      plan: 'production',
      weekly_target: 3,
      start_date: '2026-04-07',
      instantly_campaign_ids: ['camp_ev001'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 600,
      campaigns: [
        { id: 'camp_ev001', name: 'Chicago Launch', status: 'running', emails_sent_total: 380, campaign_size: 600, progress_pct: 63 },
      ],
      metricsByWeek: { [W0]: m('ev001', W0, 96, 3, addDays(now, -4).toISOString()) },
    },
    {
      id: 'wr001',
      name: 'William Raveis Real Estate',
      plan: 'minimum',
      weekly_target: 1,
      start_date: '2026-02-03',
      instantly_campaign_ids: ['camp_wr001'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 450,
      campaigns: [
        { id: 'camp_wr001', name: 'New England Sequence', status: 'finished', emails_sent_total: 450, campaign_size: 450, progress_pct: 100 },
      ],
      metricsByWeek: { [W0]: m('wr001', W0, 56, 1, addDays(now, -16).toISOString()) },
    },
    {
      id: 'rf001',
      name: 'Redfin Premier',
      plan: 'minimum',
      weekly_target: 1,
      start_date: '2026-04-21',
      instantly_campaign_ids: ['camp_rf001'],
      bison_campaign_ids: [],
      bisonCampaigns: [],
      campaign_size: 300,
      campaigns: [
        { id: 'camp_rf001', name: 'West Coast Outreach', status: 'running', emails_sent_total: 152, campaign_size: 300, progress_pct: 51 },
      ],
      metricsByWeek: { [W0]: m('rf001', W0, 79, 0, null) },
    },
  ];

  return seed.map((c) => ({
    ...c,
    hidden: false,
    client_paused: false,
    portal_active: false,
    portalActive: false,
    billing_anchor_date: null,
    billing_interval: 'biweekly' as const,
    billing_interval_days: null,
    emails_today: 0,
    emails_today_date: null,
    portal_synced_at: null,
    time_zone: null,
    dnc_count: 0,
    agents_count: 0,
    last_lead_activity_at: null,
    stagnant_intros_count: 0,
    intros_since_last_billing: 0,
    monthly_target: 0,
    intros_this_month: 0,
    // Fill reply_count + interested_count on every nested campaign so they
    // satisfy the InstantlyCampaign / BisonCampaign types without bloating
    // each literal above.
    campaigns: c.campaigns.map((cc) => ({ ...cc, reply_count: 0, interested_count: 0 })),
    bisonCampaigns: c.bisonCampaigns.map((cc) => ({ ...cc, reply_count: 0, interested_count: 0 })),
  }));
}
