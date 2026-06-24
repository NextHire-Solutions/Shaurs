export type Plan = 'minimum' | 'production' | 'partner';

export type CampaignStatus = 'running' | 'paused' | 'finished';

export type CampaignSource = 'instantly' | 'bison';

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: CampaignStatus | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number; // 0-100
  status_changed_at?: string | null;
}

export interface BisonCampaign {
  id: string;
  name: string;
  status: CampaignStatus | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number; // 0-100
  status_changed_at?: string | null;
}

export interface Client {
  id: string;
  name: string;
  plan: Plan;
  weekly_target: number;
  start_date: string | null; // ISO date
  instantly_campaign_ids: string[];
  bison_campaign_ids: string[];
  campaign_size: number;
  hidden: boolean;        // manual per-client hide flag (default false)
  client_paused: boolean; // manual "service temporarily paused" flag (default false)
  portal_active: boolean; // synced from Corofy /api/clients/portals by sync-worker
}

export interface WeeklyMetric {
  client_id: string;
  week_key: string; // YYYY-MM-DD (Monday)
  emails_sent: number;
  intros_corofy: number;                // Corofy "Introduction" count
  last_corofy_intro_at: string | null;
  interested_corofy: number;            // Corofy "Interested" count
  last_interested_at: string | null;
}

export interface DashboardClient extends Client {
  campaigns: InstantlyCampaign[];
  bisonCampaigns: BisonCampaign[];
  // All weekly metrics this client has, keyed by ISO Monday (YYYY-MM-DD).
  // Lookup for the current visible week is O(1) — no DB hit on week change.
  metricsByWeek: Record<string, WeeklyMetric>;
  // Derived runtime field (not a DB column): true when the client appears
  // in Corofy's /api/clients/portals response with portal_enabled=true.
  portalActive: boolean;
}

export const HISTORICAL_WEEKS = 26;

export const PLAN_LABEL: Record<Plan, string> = {
  minimum: 'Minimum',
  production: 'Production',
  partner: 'Partner',
};

export const PLAN_BADGE_CLASS: Record<Plan, string> = {
  minimum: 'plan-min',
  production: 'plan-prod',
  partner: 'plan-partner',
};

export const PLAN_DEFAULT_TARGET: Record<Plan, number> = {
  minimum: 1,
  production: 3,
  partner: 6,
};
