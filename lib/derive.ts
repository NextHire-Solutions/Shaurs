import type { DashboardClient, WeeklyMetric } from './types';

const EMPTY_METRIC: Omit<WeeklyMetric, 'client_id' | 'week_key'> = {
  emails_sent: 0,
  intros_corofy: 0,
  last_corofy_intro_at: null,
};

export function metricFor(c: DashboardClient, weekKey: string): WeeklyMetric {
  return c.metricsByWeek[weekKey] ?? {
    client_id: c.id,
    week_key: weekKey,
    ...EMPTY_METRIC,
  };
}

// All calendar math is done in UTC. Mixing local-tz `setDate` with date arithmetic
// crosses DST boundaries silently — 175 days of local-time addition can drift the
// UTC calendar date by ±1, which produced rogue "Sunday" week keys in Supabase.

function asUTC(d: Date | string): Date {
  if (typeof d === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + 'T00:00:00Z');
    return new Date(d);
  }
  return d;
}

export function getMondayOf(d: Date | string): Date {
  const date = asUTC(d);
  const day = date.getUTCDay();
  const result = new Date(date);
  result.setUTCDate(date.getUTCDate() - day + (day === 0 ? -6 : 1));
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

export function weekKey(d: Date | string): string {
  return getMondayOf(d).toISOString().split('T')[0];
}

export function addDays(d: Date | string, n: number): Date {
  const date = asUTC(d);
  const result = new Date(date);
  result.setUTCDate(date.getUTCDate() + n);
  return result;
}

export function fmtDate(d: Date | string): string {
  return asUTC(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Collapse non-alphanumeric runs to single spaces. Used to match client names
// across minor formatting drift (e.g. "C21 Results - Elite Team" from Corofy
// vs "C21 Results Elite Team" in clients.name).
export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function formatWeek(monday: Date): string {
  return `${fmtDate(monday)} – ${fmtDate(addDays(monday, 6))}`;
}

export function isCurrentWeek(key: string): boolean {
  return key === weekKey(new Date());
}

export function daysSinceLastIntro(lastIntroAt: string | null | undefined): number | null {
  if (!lastIntroAt) return null;
  const last = new Date(lastIntroAt);
  last.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today.getTime() - last.getTime()) / 86400000);
}

export interface DerivedRow {
  emails: number;
  intros: number;
  hasEmails: boolean;
  hasIntros: boolean;
  metTarget: boolean;
  status: 'risk' | 'ok' | 'done' | 'pending';
  convPct: number | null; // intros per 1,000 emails (displayed with "%" suffix per product spec)
  convClass: 'good' | 'mid' | 'low' | 'none';
  leftThisWeek: number; // 0 if met
  daysSince: number | null;
  campaignsAvgPct: number;
}

export function derive(c: DashboardClient, weekKey: string): DerivedRow {
  const m = metricFor(c, weekKey);
  const hasEmails = m.emails_sent > 0;
  const intros = m.intros_corofy;
  const lastAt = m.last_corofy_intro_at;
  const hasIntros = intros > 0 || lastAt !== null;
  const emails = m.emails_sent;

  const metTarget = c.weekly_target > 0 && intros >= c.weekly_target;
  // Status precedence: pending (no target) → done (target met) → risk
  // (below half) → ok (between half and target).
  const status: 'risk' | 'ok' | 'done' | 'pending' = c.weekly_target === 0
    ? 'pending'
    : metTarget
      ? 'done'
      : intros < c.weekly_target / 2
        ? 'risk'
        : 'ok';

  let convPct: number | null = null;
  let convClass: 'good' | 'mid' | 'low' | 'none' = 'none';
  if (emails > 0) {
    convPct = (intros / emails) * 1000;
    convClass = convPct >= 50 ? 'good' : convPct >= 20 ? 'mid' : 'low';
  }

  const leftThisWeek = Math.max(0, c.weekly_target - intros);

  // Match the displayed Campaign Progress cell exactly: weighted average
  // across ACTIVE (running) campaigns only, union of Instantly + Bison.
  // Σ(completed leads) / Σ(total leads) × 100. Returns 0 when no running
  // campaign so those rows sink to the bottom of a descending sort.
  const runningAll = [
    ...c.campaigns.filter((x) => x.status === 'running'),
    ...c.bisonCampaigns.filter((x) => x.status === 'running'),
  ];
  const cpTotal = runningAll.reduce((a, b) => a + b.campaign_size, 0);
  const cpCompleted = runningAll.reduce(
    (a, b) => a + Math.round(b.campaign_size * (b.progress_pct / 100)),
    0,
  );
  const campaignsAvgPct = cpTotal > 0 ? (cpCompleted / cpTotal) * 100 : 0;

  return {
    emails,
    intros,
    hasEmails,
    hasIntros,
    metTarget,
    status,
    convPct,
    convClass,
    leftThisWeek,
    daysSince: daysSinceLastIntro(lastAt),
    campaignsAvgPct,
  };
}
