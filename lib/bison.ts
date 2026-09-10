// Typed client for EmailBison API.
// Docs: spec at /Users/sankalpdutt/Desktop/Code/Corofy/api-1 (8).json
//
// Auth: `Authorization: Bearer <BISON_API_KEY>` (full token incl. the `22|` prefix)
// Base: env BISON_BASE_URL (e.g., https://send.brokerstaffer.com)
//
// Endpoints used:
//   GET /api/campaigns                                        — list campaigns (page-based)
//   GET /api/campaigns/{campaign_id}/line-area-chart-stats    — daily per-event series
//
// Status values seen in the spec: Active / Paused / Completed / Stopped / Draft /
// Launching / Queued / Failed / Archived / "pending deletion" / Deleted. Mapped to
// our internal 'running' | 'paused' | 'finished' | null discriminator.
//
// Identifier choice: we key bison_campaigns by `uuid` (string), mirroring the
// Instantly pattern where ids are uuids. The list endpoint returns both `id` (int)
// and `uuid`. If MasterInbox turns out to report Bison campaign refs by int id,
// switch this to use `id` instead.

const BASE = (process.env.BISON_BASE_URL ?? 'https://send.brokerstaffer.com').replace(/\/$/, '');

function key(): string {
  const k = process.env.BISON_API_KEY;
  if (!k) throw new Error('BISON_API_KEY is not set');
  return k;
}

async function get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  // Retry on transient network errors (TypeError: fetch failed) up to 3 times
  // with exponential backoff. HTTP errors (non-2xx) are NOT retried — those
  // are real responses from Bison and should bubble up immediately.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${key()}`,
          Accept: 'application/json',
        },
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Bison ${path} ${res.status}: ${body.slice(0, 200)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
      // Only retry on network errors; pass HTTP errors through.
      if (err instanceof Error && err.message.startsWith('Bison ')) throw err;
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface BisonCampaignSummary {
  id: number;
  uuid: string;
  name: string;
  status?: string;
  emails_sent?: number;
  total_leads?: number;
  total_leads_contacted?: number;
  replied?: number;          // total replies
  unique_replies?: number;   // unique replies (one per lead) — preferred for reply-rate math
  interested?: number;
  completion_percentage?: number;
  created_at?: string;
  updated_at?: string;
}

interface BisonCampaignsPage {
  data: BisonCampaignSummary[];
  meta?: { current_page: number; last_page: number };
  links?: { next: string | null };
}

interface BisonChartSeries {
  label: string;
  dates: [string, number][]; // [['YYYY-MM-DD', count], ...]
}
interface BisonChartResp {
  data: BisonChartSeries[];
}

export async function listBisonCampaigns(): Promise<BisonCampaignSummary[]> {
  const all: BisonCampaignSummary[] = [];
  // Cap at 50 pages defensively.
  for (let page = 1; page <= 50; page++) {
    const resp = await get<BisonCampaignsPage>('/api/campaigns', { page });
    all.push(...(resp.data ?? []));
    const last = resp.meta?.last_page;
    if (!last || page >= last) break;
  }
  return all;
}

// IMPORTANT: Bison's per-campaign endpoints (line-area-chart-stats, /campaigns/{id},
// /sequence-steps, /stats) accept the INTEGER id only — passing the UUID 404s
// silently. The list endpoint returns both `id` (int) and `uuid` (string); use
// `id` here.
// Fetch both Sent and Replied series in one line-area-chart-stats call.
export async function bisonDailyStats(
  intCampaignId: number,
  startDate: string,
  endDate: string
): Promise<{ date: string; sent: number; replied: number }[]> {
  const resp = await get<BisonChartResp>(`/api/campaigns/${intCampaignId}/line-area-chart-stats`, {
    start_date: startDate,
    end_date: endDate,
  });
  const sent = (resp.data ?? []).find((s) => s.label === 'Sent');
  const replied = (resp.data ?? []).find((s) => s.label === 'Replied');
  const byDate = new Map<string, { sent: number; replied: number }>();
  for (const [d, n] of sent?.dates ?? []) {
    byDate.set(d, { sent: Number(n) || 0, replied: 0 });
  }
  for (const [d, n] of replied?.dates ?? []) {
    const cur = byDate.get(d) ?? { sent: 0, replied: 0 };
    cur.replied = Number(n) || 0;
    byDate.set(d, cur);
  }
  return [...byDate.entries()].map(([date, v]) => ({ date, ...v }));
}

export function mapBisonStatus(raw: string | undefined | null): 'running' | 'paused' | 'finished' | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (s === 'active' || s === 'running' || s === 'launching') return 'running';
  if (s === 'paused') return 'paused';
  if (s === 'completed' || s === 'stopped' || s === 'finished') return 'finished';
  return null;
}

// Mirrors Instantly's progress formula: completed / total_leads.
// Bison reports total_leads (campaign size) and exposes completion_percentage
// directly — prefer that when present, else derive from contacted/total.
export function bisonProgressPct(c: BisonCampaignSummary): number {
  if (typeof c.completion_percentage === 'number') {
    return Math.min(100, Math.max(0, c.completion_percentage));
  }
  const total = c.total_leads ?? 0;
  if (total <= 0) return 0;
  return Math.min(100, ((c.total_leads_contacted ?? 0) / total) * 100);
}

export function bisonCampaignSize(c: BisonCampaignSummary): number {
  return c.total_leads ?? 0;
}
