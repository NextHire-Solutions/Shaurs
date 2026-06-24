// Typed client for Instantly API v2.
// Docs: https://developer.instantly.ai/api/v2
//
// Auth: `Authorization: Bearer <INSTANTLY_API_KEY>`
// Base: https://api.instantly.ai
//
// Endpoints used (verified against the live API):
//   GET /api/v2/campaigns                              — list campaigns (paginated via next_starting_after)
//   GET /api/v2/campaigns/analytics                    — array of per-campaign cumulative metrics
//   GET /api/v2/campaigns/analytics/daily              — per-day metrics for one campaign
//
// Status codes observed in /campaigns: 1=active/draft, 2=paused, 3=finished.

const BASE = 'https://api.instantly.ai';

function key(): string {
  const k = process.env.INSTANTLY_API_KEY;
  if (!k) throw new Error('INSTANTLY_API_KEY is not set');
  return k;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${key()}`,
      'Content-Type': 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Instantly ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface InstantlyCampaignSummary {
  id: string;
  name: string;
  status?: number; // 1 active, 2 paused, 3 finished
  timestamp_created?: string;
  timestamp_updated?: string;
}

export interface InstantlyAnalyticsItem {
  campaign_id: string;
  campaign_name: string;
  campaign_status: number;
  leads_count: number;
  contacted_count: number;
  emails_sent_count: number;
  new_leads_contacted_count: number;
  reply_count: number;          // total replies (includes auto-replies)
  reply_count_unique?: number;  // unique replies (one per lead) — preferred for reply-rate math
  bounced_count: number;
  completed_count: number;
  total_opportunities: number;
  total_opportunity_value: number;
}

export interface InstantlyDailyItem {
  date: string; // YYYY-MM-DD
  sent: number;
  contacted: number;
  new_leads_contacted: number;
  opened: number;
  replies: number;
  clicks: number;
  opportunities: number;
}

export async function listCampaigns(): Promise<InstantlyCampaignSummary[]> {
  const all: InstantlyCampaignSummary[] = [];
  let starting_after: string | undefined;
  // Cap at ~10 pages to avoid runaway loops; tighten/relax once we know real volume.
  for (let page = 0; page < 20; page++) {
    const data = await get<{ items: InstantlyCampaignSummary[]; next_starting_after?: string }>(
      '/api/v2/campaigns',
      { limit: 100, starting_after }
    );
    all.push(...(data.items ?? []));
    if (!data.next_starting_after) break;
    starting_after = data.next_starting_after;
  }
  return all;
}

export async function listAnalytics(): Promise<InstantlyAnalyticsItem[]> {
  return get<InstantlyAnalyticsItem[]>('/api/v2/campaigns/analytics');
}

export async function dailyAnalytics(
  campaignId: string,
  startDate: string,
  endDate: string
): Promise<InstantlyDailyItem[]> {
  return get<InstantlyDailyItem[]>('/api/v2/campaigns/analytics/daily', {
    campaign_id: campaignId,
    start_date: startDate,
    end_date: endDate,
  });
}

export function mapStatus(raw: number | string | undefined | null): 'running' | 'paused' | 'finished' | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s.includes('active') || s.includes('running')) return 'running';
    if (s.includes('paus')) return 'paused';
    if (s.includes('finish') || s.includes('complete')) return 'finished';
    return null;
  }
  switch (raw) {
    case 1: return 'running';
    case 2: return 'paused';
    case 3: return 'finished';
    default: return null;
  }
}

// leads_count IS the total leads in the campaign — completed_count is a
// subset, not a separate bucket to add. Verified against a finished campaign
// (Keyes-Florida-West): leads=199, completed=183, bounced=16 → 199 = 183 + 16
// exactly. So progress = completed / leads matches Instantly's own UI %.
export function progressPct(a: InstantlyAnalyticsItem): number {
  const total = a.leads_count ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, ((a.completed_count ?? 0) / total) * 100);
}

export function campaignSize(a: InstantlyAnalyticsItem): number {
  return a.leads_count ?? 0;
}
