import type { BillingInterval, DashboardClient, WeeklyMetric } from './types';
import { completedCycles } from './billing';

const EMPTY_METRIC: Omit<WeeklyMetric, 'client_id' | 'week_key'> = {
  emails_sent: 0,
  replies: 0,
  intros_corofy: 0,
  last_corofy_intro_at: null,
  interested_corofy: 0,
  last_interested_at: null,
  hired_corofy: 0,
  last_hired_at: null,
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

// YYYY-MM-DD for "today" in America/New_York. Matches the date keys we get
// from Bison's line-area-chart-stats and Instantly's daily analytics.
export function todayInET(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// Compute the MOST RECENT billing date on or before today (start of the
// current billing cycle). Returns null when no anchor is provided OR when
// the anchor itself is in the future (there is no "last" cycle yet).
export function lastBillingDate(
  anchorISO: string | null,
  interval: BillingInterval,
  today: Date = new Date(),
  customDays: number | null = null,
): Date | null {
  if (!anchorISO) return null;
  const anchor = asUTC(anchorISO);
  if (anchor.getTime() > today.getTime()) return null;
  let step: number | null = null;
  if (interval === 'biweekly') step = 14;
  else if (interval === '28-days') step = 28;
  else if (interval === 'custom') {
    step = customDays && customDays > 0 ? Math.floor(customDays) : null;
    if (step === null) return null;
  }
  if (step !== null) {
    const daysSince = Math.floor((today.getTime() - anchor.getTime()) / 86400000);
    const cyclesElapsed = Math.floor(daysSince / step);
    return addDays(anchor, cyclesElapsed * step);
  }
  // Monthly: iterate months forward from the anchor, but stop AT the last one
  // that's <= today (so `prev` is the current cycle's start).
  const cursor = new Date(anchor);
  while (true) {
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    if (next.getTime() > today.getTime()) return cursor;
    cursor.setTime(next.getTime());
  }
}

// Compute the START of the CURRENT monthly cycle (calendar-month step from
// the anchor). Independent of billing_interval — a biweekly-billed client
// still has a well-defined "monthly cycle" for the monthly target column,
// anchored to the same date that governs their billing.
//
// Example: anchor July 22, today Sep 3 → monthly cycles are 7/22 → 8/21,
// 8/22 → 9/21. Current cycle start = 8/22. Anchor null or in the future → null.
export function monthlyCycleStart(
  anchorISO: string | null,
  today: Date = new Date(),
): Date | null {
  if (!anchorISO) return null;
  const anchor = asUTC(anchorISO);
  if (anchor.getTime() > today.getTime()) return null;
  const cursor = new Date(anchor);
  while (true) {
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    if (next.getTime() > today.getTime()) return cursor;
    cursor.setTime(next.getTime());
  }
}

// Compute the NEXT billing date based on anchor + interval. Returns null when
// no anchor is provided (caller is expected to fall back to start_date), or
// when interval='custom' but no positive day count is configured yet.
export function nextBillingDate(
  anchorISO: string | null,
  interval: BillingInterval,
  today: Date = new Date(),
  customDays: number | null = null,
): Date | null {
  if (!anchorISO) return null;
  const anchor = asUTC(anchorISO);
  if (anchor.getTime() > today.getTime()) return anchor;
  // N-day intervals — 14, 28, or custom-N.
  let step: number | null = null;
  if (interval === 'biweekly') step = 14;
  else if (interval === '28-days') step = 28;
  else if (interval === 'custom') {
    step = customDays && customDays > 0 ? Math.floor(customDays) : null;
    if (step === null) return null;
  }
  if (step !== null) {
    const daysSince = Math.floor((today.getTime() - anchor.getTime()) / 86400000);
    const cyclesSince = Math.max(1, Math.ceil(daysSince / step));
    return addDays(anchor, cyclesSince * step);
  }
  // Monthly: step month-by-month from the anchor until on or after today.
  const next = new Date(anchor);
  while (next.getTime() <= today.getTime()) next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export function daysUntil(target: Date, today: Date = new Date()): number {
  const t0 = new Date(today);
  t0.setUTCHours(0, 0, 0, 0);
  const t1 = new Date(target);
  t1.setUTCHours(0, 0, 0, 0);
  return Math.round((t1.getTime() - t0.getTime()) / 86400000);
}

// Client Score — 0.0–10.0 rating of how reliably a client's billing cycles
// hit their target. Over the last SCORE_WINDOW_CYCLES completed cycles:
//   hitRate   = fraction of cycles where delivered >= cycle target (0..1)
//   avgRatio  = mean of min(delivered / cycle target, 2.0)
// Combined:  score = 10 * (0.7 * hitRate + 0.15 * avgRatio)
//   → 0.7 rewards consistency, 0.15 (max 0.3) rewards volume above target,
//     capped at 2× so a single huge cycle doesn't dominate.
// Anchors: always ≥2× target → 10.0, always exactly at target → 8.5,
// zero every cycle → 0.0. Null with fewer than SCORE_MIN_CYCLES completed
// cycles, or no monthly target, so brand-new clients don't get a misleading
// score. Uses the base cycle target, not carry-forward: the score is about
// each cycle's own delivery.
export interface ClientScore {
  score: number | null;
  cyclesUsed: number;
  hitRate: number;
  avgRatio: number;
}
const SCORE_WINDOW_CYCLES = 4;
const SCORE_MIN_CYCLES = 2;
const RATIO_CAP = 2.0;
export function clientScore(c: DashboardClient, today: Date = new Date()): ClientScore {
  const cycles = completedCycles(c, today, SCORE_WINDOW_CYCLES);
  if (cycles.length < SCORE_MIN_CYCLES) {
    return { score: null, cyclesUsed: cycles.length, hitRate: 0, avgRatio: 0 };
  }
  const hits = cycles.filter((x) => x.delivered >= x.target).length;
  const hitRate = hits / cycles.length;
  const avgRatio =
    cycles.reduce((sum, x) => sum + Math.min(x.delivered / x.target, RATIO_CAP), 0) / cycles.length;
  const raw = 10 * (0.7 * hitRate + 0.15 * avgRatio);
  return { score: Math.round(raw * 10) / 10, cyclesUsed: cycles.length, hitRate, avgRatio };
}

// Intros in the last 14 days = current Monday-week + previous Monday-week
// buckets. Independent of the client's billing interval.
export function biweeklyIntros(
  metricsByWeek: Record<string, WeeklyMetric>,
  today: Date = new Date(),
): number {
  const thisMonday = weekKey(getMondayOf(today));
  const prevMonday = weekKey(addDays(getMondayOf(today), -7));
  return (
    (metricsByWeek[thisMonday]?.intros_corofy ?? 0) +
    (metricsByWeek[prevMonday]?.intros_corofy ?? 0)
  );
}

export function formatWeek(monday: Date): string {
  return `${fmtDate(monday)} – ${fmtDate(addDays(monday, 6))}`;
}

export function isCurrentWeek(key: string): boolean {
  return key === weekKey(new Date());
}

// Whole calendar days since the last intro, counted on US Eastern dates — the
// same business clock as "Daily Emails Sent". Using the machine's local
// timezone made the server (UTC) and the viewer's browser disagree near
// midnight, which forced React to re-render the whole table on load.
export function daysSinceLastIntro(lastIntroAt: string | null | undefined, now = new Date()): number | null {
  if (!lastIntroAt) return null;
  const last = new Date(lastIntroAt);
  if (!Number.isFinite(last.getTime())) return null;
  const lastET = Date.parse(todayInET(last) + 'T00:00:00Z');
  const todayET = Date.parse(todayInET(now) + 'T00:00:00Z');
  return Math.max(0, Math.round((todayET - lastET) / 86400000));
}

export interface DerivedRow {
  emails: number;
  intros: number;
  interested: number; // Corofy "Interested" count for the visible week
  hasEmails: boolean;
  hasIntros: boolean;
  convPct: number | null; // intros per 1,000 emails (displayed with "%" suffix per product spec)
  convClass: 'good' | 'mid' | 'low' | 'none';
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

  // No weekly target any more: status, "done" and "left" come from the
  // client's billing cycle and 28-day period (lib/billing.ts).

  let convPct: number | null = null;
  let convClass: 'good' | 'mid' | 'low' | 'none' = 'none';
  if (emails > 0) {
    convPct = (intros / emails) * 1000;
    convClass = convPct >= 50 ? 'good' : convPct >= 20 ? 'mid' : 'low';
  }

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
    interested: m.interested_corofy ?? 0,
    hasEmails,
    hasIntros,
    convPct,
    convClass,
    daysSince: daysSinceLastIntro(lastAt),
    campaignsAvgPct,
  };
}
