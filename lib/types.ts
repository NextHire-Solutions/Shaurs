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
  reply_count: number;       // unique replies (from Instantly analytics)
  interested_count: number;  // Corofy "Interested" labels attributed to this campaign
}

export interface BisonCampaign {
  id: string;
  name: string;
  status: CampaignStatus | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number; // 0-100
  status_changed_at?: string | null;
  reply_count: number;       // unique replies (from Bison campaign list)
  interested_count: number;  // Corofy "Interested" labels attributed to this campaign
}

export type BillingInterval = 'biweekly' | '28-days' | 'monthly' | 'custom';

export const BILLING_INTERVAL_LABEL: Record<BillingInterval, string> = {
  biweekly: 'Bi-weekly (14 days)',
  '28-days': 'Every 28 days',
  monthly: 'Monthly',
  custom: 'Custom (every N days)',
};

// Per-plan biweekly introduction targets. Applied uniformly regardless of
// billing_interval — a monthly-billed Production client still has target 5.
export const BIWEEKLY_TARGET: Record<Plan, number> = {
  partner: 12,
  production: 5,
  minimum: 2,
};

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
  billing_anchor_date: string | null; // ISO date, anchor for billing cycle math
  billing_interval: BillingInterval;
  billing_interval_days: number | null; // only meaningful when billing_interval='custom'
  emails_today: number;               // today's emails sent (EST)
  emails_today_date: string | null;   // YYYY-MM-DD the emails_today value is for (EST)
  // Client Success tab fields:
  portal_synced_at: string | null;    // ISO timestamp of the last portal sync tick that touched this row
  time_zone: string | null;           // IANA string, e.g. 'America/New_York'; editable via modal
  dnc_count: number;                  // mirror of Corofy portals counts.dnc; refreshed by sync
  agents_count: number;               // mirror of Corofy portals counts.agents; refreshed by sync
  // Refinement fields (migration 0012):
  last_lead_activity_at: string | null;  // mirror of Corofy portals.last_lead_activity_at
  stagnant_intros_count: number;         // Introduction-feed rows where updated_at ≈ assigned_at
  intros_since_last_billing: number;     // Introduction-feed rows with assigned_at >= last billing day
  // Monthly-target fields (migration 0013):
  monthly_target: number;                // per-client goal for one monthly cycle; 0 = unset
  intros_this_month: number;             // Introduction-feed rows since the current monthly-cycle start
}

export interface WeeklyMetric {
  client_id: string;
  week_key: string; // YYYY-MM-DD (Monday)
  emails_sent: number;
  intros_corofy: number;                // Corofy "Introduction" count
  last_corofy_intro_at: string | null;
  interested_corofy: number;            // Corofy "Interested" count
  last_interested_at: string | null;
  hired_corofy: number;                 // Corofy "Hired" count (0 until Corofy exposes the label)
  last_hired_at: string | null;
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

// Time-zone dropdown for the client edit modal + Client Success tab. Store
// the IANA string; render the short code in the table.
export interface TimeZoneOption {
  value: string; // IANA string persisted to the DB
  short: string; // 2-3 letter code shown in the table cell
  label: string; // full label shown in the modal dropdown
}
export const TIME_ZONES: TimeZoneOption[] = [
  { value: 'America/New_York',    short: 'ET',  label: 'Eastern (ET)' },
  { value: 'America/Chicago',     short: 'CT',  label: 'Central (CT)' },
  { value: 'America/Denver',      short: 'MT',  label: 'Mountain (MT)' },
  { value: 'America/Phoenix',     short: 'AZ',  label: 'Arizona (AZ, no DST)' },
  { value: 'America/Los_Angeles', short: 'PT',  label: 'Pacific (PT)' },
  { value: 'America/Anchorage',   short: 'AKT', label: 'Alaska (AKT)' },
  { value: 'Pacific/Honolulu',    short: 'HAT', label: 'Hawaii (HAT)' },
];
export const TZ_SHORT_BY_VALUE: Record<string, string> = Object.fromEntries(
  TIME_ZONES.map((t) => [t.value, t.short]),
);
