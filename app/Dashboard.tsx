'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addDays,
  biweeklyIntros,
  clientScore,
  daysUntil,
  derive,
  formatWeek,
  getMondayOf,
  isCurrentWeek,
  lastBillingDate,
  nextBillingDate,
  todayInET,
  weekKey,
} from '@/lib/derive';
import { autoMatchCampaignIds } from '@/lib/matchCampaigns';
import {
  BILLING_INTERVAL_LABEL,
  BIWEEKLY_TARGET,
  PLAN_BADGE_CLASS,
  PLAN_DEFAULT_TARGET,
  PLAN_LABEL,
  TIME_ZONES,
  TZ_SHORT_BY_VALUE,
  type BillingInterval,
  type BisonCampaign,
  type CampaignSource,
  type DashboardClient,
  type InstantlyCampaign,
  type Plan,
} from '@/lib/types';

type Filter = 'all' | 'risk' | 'ok' | 'done' | 'active' | 'paused' | 'inactive' | 'client-paused' | 'hidden';

type PlanFilter = 'all' | 'minimum' | 'production' | 'partner';
type TzFilter = 'all' | string; // 'all' or an IANA value from TIME_ZONES
type BillingWindowFilter = 'all' | '7' | '14' | '30'; // any / within 7d / 14d / 30d

type SortCol = 'campaigns' | 'leftWeek' | 'lastIntro' | 'emails' | 'today' | 'progress' | 'intros' | 'interested' | 'conv' | 'converted' | 'convRate' | 'tz' | 'monthly' | 'billing' | 'billingDays' | 'lastBilling';
type SortBy = null | { col: SortCol; dir: 'desc' | 'asc' };

// Funnel-based conversion helpers. Both Corofy labels are mutually exclusive
// at any moment (a lead leaves Interested when it becomes Introduction), so:
//   convertedAllTime    = sum of intros_corofy across all weeks    (already converted)
//   interestedAllTime   = sum of interested_corofy across all weeks (still in pipeline)
//   convRate            = converted / (converted + interested) * 100, 0–100%
function convertedAllTime(c: DashboardClient): number {
  return Object.values(c.metricsByWeek).reduce((s, m) => s + (m.intros_corofy ?? 0), 0);
}
function interestedAllTime(c: DashboardClient): number {
  return Object.values(c.metricsByWeek).reduce((s, m) => s + (m.interested_corofy ?? 0), 0);
}
function convRateFor(c: DashboardClient): number | null {
  const intros = convertedAllTime(c);
  const interested = interestedAllTime(c);
  const total = intros + interested;
  return total > 0 ? (intros / total) * 100 : null;
}

type DatePreset = 'last7' | 'last30' | 'ytd' | 'custom' | null;

interface Props {
  initialClients: DashboardClient[];
  allInstantlyCampaigns: InstantlyCampaign[];
  allBisonCampaigns: BisonCampaign[];
  dataSource?: 'supabase' | 'seed';
}

// Used only for popup rendering — annotates which source a campaign came from
// so we can show a chip and key React lists across the union without collisions.
interface PopupCampaign {
  id: string;
  name: string;
  status: 'running' | 'paused' | 'finished' | null;
  emails_sent_total: number;
  campaign_size: number;
  progress_pct: number;
  status_changed_at?: string | null;
  source: CampaignSource;
  reply_count: number;
  interested_count: number;
}

interface ModalState {
  open: boolean;
  editingId: string | null;
  name: string;
  plan: Plan;
  startDate: string;
  weeklyTarget: number;
  monthlyTarget: number;
  billingAnchorDate: string;
  billingInterval: BillingInterval;
  // Free-text string while editing — parsed to int on save. Empty string
  // is allowed (the Custom option just won't compute a next billing date).
  billingIntervalDays: string;
  // IANA time-zone string from TIME_ZONES, or '' for none-selected.
  timeZone: string;
}

const emptyModal: ModalState = {
  open: false,
  editingId: null,
  name: '',
  plan: 'production',
  startDate: '',
  weeklyTarget: PLAN_DEFAULT_TARGET.production,
  monthlyTarget: 0,
  billingAnchorDate: '',
  billingInterval: 'biweekly',
  billingIntervalDays: '',
  timeZone: '',
};

// User-local "today" as YYYY-MM-DD. new Date().toISOString() returns UTC,
// which can be yesterday for IST users in the early morning — show local
// calendar date instead.
function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function Dashboard({ initialClients, allInstantlyCampaigns, allBisonCampaigns, dataSource }: Props) {
  const router = useRouter();
  const [clients, setClients] = useState<DashboardClient[]>(initialClients);
  const [currentMonday, setCurrentMonday] = useState<Date>(() => getMondayOf(new Date()));
  const [filter, setFilter] = useState<Filter>('all');
  const [planFilter, setPlanFilter] = useState<PlanFilter>('all');
  const [tzFilter, setTzFilter] = useState<TzFilter>('all');
  const [billingWindowFilter, setBillingWindowFilter] = useState<BillingWindowFilter>('all');
  // Unified sort state. null = default order (server-provided name asc).
  // { col, dir: 'desc' } = 1st click; { col, dir: 'asc' } = 2nd click; null = 3rd.
  const [sortBy, setSortBy] = useState<SortBy>(null);
  const [dateRange, setDateRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [datePreset, setDatePreset] = useState<DatePreset>(null);
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [search, setSearch] = useState('');
  /*
   * The view is seeded from `?view=` so each of the three has an address.
   *
   * The workspace rail lists Weekly, Bi-Weekly and Client Success as separate
   * destinations, and a rail item needs somewhere to point. Without this they
   * all land on Weekly and two of the three look broken.
   *
   * Read from window.location rather than useSearchParams(): that hook opts the
   * whole route into client-side rendering and needs a Suspense boundary above
   * it, which is a lot of machinery for one initial value. A lazy initialiser
   * runs once, on the client, after hydration — and the toggle below remains
   * the way you switch, so this only decides where you arrive.
   */
  const [view, setView] = useState<'weekly' | 'biweekly' | 'success'>(() => {
    if (typeof window === 'undefined') return 'weekly';
    const requested = new URLSearchParams(window.location.search).get('view');
    return requested === 'biweekly' || requested === 'success' ? requested : 'weekly';
  });
  const [campaignSelections, setCampaignSelections] = useState<Record<string, string>>({});
  const [campaignsPopupClientId, setCampaignsPopupClientId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(emptyModal);
  const [refreshing, setRefreshing] = useState(false);

  // When the server re-fetches the dashboard (e.g. after router.refresh()),
  // re-prime the local clients state from the new server props. Without this,
  // local edits via the modal would be overwritten too eagerly, but with this
  // any external change (new sync, manual SQL change) is reflected.
  useEffect(() => {
    setClients(initialClients);
  }, [initialClients]);

  // Set initial start date for the modal once on mount.
  useEffect(() => {
    setModal((m) => ({ ...m, startDate: todayLocalISO() }));
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const key = weekKey(currentMonday);
  const isCurrent = isCurrentWeek(key);

  const visible = useMemo(() => {
    // Default-exclude logic: hidden and client_paused clients only show under
    // their respective filter tabs. Every other filter implicitly hides both.
    let list = clients.filter((c) => {
      if (filter === 'hidden') return c.hidden;
      if (filter === 'client-paused') return c.client_paused;
      return !c.hidden && !c.client_paused;
    });
    list = list.filter((c) => {
      const d = derive(c, key);
      const allCampaigns = [...c.campaigns, ...c.bisonCampaigns];
      const hasRunning = allCampaigns.some((x) => x.status === 'running');
      const hasLaunched = allCampaigns.some(
        (x) => x.status === 'paused' || x.status === 'finished'
      );
      switch (filter) {
        case 'all':
        case 'hidden':
        case 'client-paused':
          return true;
        case 'risk':
          return d.status === 'risk';
        case 'ok':
          return d.status === 'ok';
        case 'done':
          return d.metTarget;
        case 'active':
          return hasRunning;
        case 'paused':
          // Campaign was launched but isn't running now — matches the
          // "Campaign Paused" badge in the row.
          return !hasRunning && hasLaunched;
        case 'inactive':
          // No campaign ever launched — matches the "Not Active" badge.
          return !hasRunning && !hasLaunched;
        default:
          return true;
      }
    });
    // Free-text search by client name (case-insensitive substring).
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
    // Plan filter (orthogonal to the other filter pills).
    if (planFilter !== 'all') {
      list = list.filter((c) => c.plan === planFilter);
    }
    if (tzFilter !== 'all') {
      list = list.filter((c) => c.time_zone === tzFilter);
    }
    if (billingWindowFilter !== 'all') {
      const days = parseInt(billingWindowFilter, 10);
      const now = new Date();
      list = list.filter((c) => {
        const bd = nextBillingDate(
          c.billing_anchor_date ?? c.start_date,
          c.billing_interval,
          now,
          c.billing_interval_days,
        );
        if (!bd) return false;
        const du = daysUntil(bd, now);
        return du >= 0 && du <= days;
      });
    }
    // Date-range filter (applied after subset filtering, before sorts).
    if (dateRange.from || dateRange.to) {
      list = list.filter((c) => {
        if (!c.start_date) return false;
        if (dateRange.from && c.start_date < dateRange.from) return false;
        if (dateRange.to && c.start_date > dateRange.to) return false;
        return true;
      });
    }
    if (sortBy?.col === 'leftWeek') {
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (derive(b, key).leftThisWeek - derive(a, key).leftThisWeek));
    } else if (sortBy?.col === 'campaigns') {
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      const score = (c: DashboardClient) => {
        const all = [...c.campaigns, ...c.bisonCampaigns];
        const active = all.filter((x) => x.status === 'running').length;
        return { active, total: all.length };
      };
      list = [...list].sort((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sb.active !== sa.active) return mul * (sb.active - sa.active);
        if (sb.total !== sa.total) return mul * (sb.total - sa.total);
        return a.name.localeCompare(b.name);
      });
    } else if (sortBy?.col === 'lastIntro') {
      // Clients with no intro always sink to the bottom regardless of direction.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => {
        const ai = a.metricsByWeek[key]?.last_corofy_intro_at;
        const bi = b.metricsByWeek[key]?.last_corofy_intro_at;
        const at = ai ? new Date(ai).getTime() : 0;
        const bt = bi ? new Date(bi).getTime() : 0;
        if (at === 0 && bt === 0) return a.name.localeCompare(b.name);
        if (at === 0) return 1;
        if (bt === 0) return -1;
        return mul * (bt - at);
      });
    } else if (sortBy?.col === 'emails') {
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (derive(b, key).emails - derive(a, key).emails));
    } else if (sortBy?.col === 'today') {
      // Today's emails column — only counts the value if emails_today_date is today (EST).
      const todayET = todayInET();
      const todayVal = (c: DashboardClient) =>
        c.emails_today_date === todayET ? c.emails_today : 0;
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (todayVal(b) - todayVal(a)));
    } else if (sortBy?.col === 'progress') {
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (derive(b, key).campaignsAvgPct - derive(a, key).campaignsAvgPct));
    } else if (sortBy?.col === 'intros') {
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (derive(b, key).intros - derive(a, key).intros));
    } else if (sortBy?.col === 'interested') {
      // All-time across the loaded HISTORICAL_WEEKS window — matches the cell display.
      const sumInterested = (c: DashboardClient) =>
        Object.values(c.metricsByWeek).reduce((s, m) => s + (m.interested_corofy ?? 0), 0);
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (sumInterested(b) - sumInterested(a)));
    } else if (sortBy?.col === 'converted') {
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => mul * (convertedAllTime(b) - convertedAllTime(a)));
    } else if (sortBy?.col === 'convRate') {
      // Clients with no funnel (intros + interested == 0) sink to bottom in both directions.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => {
        const ra = convRateFor(a);
        const rb = convRateFor(b);
        if (ra === null && rb === null) return a.name.localeCompare(b.name);
        if (ra === null) return 1;
        if (rb === null) return -1;
        return mul * (rb - ra);
      });
    } else if (sortBy?.col === 'tz') {
      // Empty time_zone rows sink to the bottom regardless of direction.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => {
        const at = a.time_zone ?? '';
        const bt = b.time_zone ?? '';
        if (!at && !bt) return a.name.localeCompare(b.name);
        if (!at) return 1;
        if (!bt) return -1;
        return -mul * at.localeCompare(bt);
      });
    } else if (sortBy?.col === 'monthly') {
      // Sort by intros_this_month; clients with monthly_target=0 (unset) sink to bottom.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => {
        if (a.monthly_target === 0 && b.monthly_target === 0) return a.name.localeCompare(b.name);
        if (a.monthly_target === 0) return 1;
        if (b.monthly_target === 0) return -1;
        return mul * (b.intros_this_month - a.intros_this_month);
      });
    } else if (sortBy?.col === 'lastBilling') {
      // Sort by MOST RECENT billing date on or before today. Null (anchor
      // never reached) sinks to bottom.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      const now = new Date();
      const prev = (c: DashboardClient) => lastBillingDate(
        c.billing_anchor_date ?? c.start_date,
        c.billing_interval,
        now,
        c.billing_interval_days,
      );
      list = [...list].sort((a, b) => {
        const pa = prev(a);
        const pb = prev(b);
        if (!pa && !pb) return a.name.localeCompare(b.name);
        if (!pa) return 1;
        if (!pb) return -1;
        return mul * (pb.getTime() - pa.getTime());
      });
    } else if (sortBy?.col === 'billing') {
      // Sort by NEXT billing date. Clients with no anchor + no start_date can't
      // compute a billing date and always sink to the bottom.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      const next = (c: DashboardClient) => nextBillingDate(
        c.billing_anchor_date ?? c.start_date,
        c.billing_interval,
        new Date(),
        c.billing_interval_days,
      );
      list = [...list].sort((a, b) => {
        const na = next(a);
        const nb = next(b);
        if (!na && !nb) return a.name.localeCompare(b.name);
        if (!na) return 1;
        if (!nb) return -1;
        return mul * (nb.getTime() - na.getTime());
      });
    } else if (sortBy?.col === 'billingDays') {
      // Sort by days-until-next-billing (fewer = more urgent). Same null-sink
      // behavior as the 'billing' branch above.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      const now = new Date();
      const days = (c: DashboardClient) => {
        const b = nextBillingDate(
          c.billing_anchor_date ?? c.start_date,
          c.billing_interval,
          now,
          c.billing_interval_days,
        );
        return b ? daysUntil(b, now) : null;
      };
      list = [...list].sort((a, b) => {
        const da = days(a);
        const db = days(b);
        if (da === null && db === null) return a.name.localeCompare(b.name);
        if (da === null) return 1;
        if (db === null) return -1;
        return mul * (db - da);
      });
    } else if (sortBy?.col === 'conv') {
      // Null convPct (client with no emails this week) always sinks to the bottom.
      const mul = sortBy.dir === 'desc' ? 1 : -1;
      list = [...list].sort((a, b) => {
        const ap = derive(a, key).convPct;
        const bp = derive(b, key).convPct;
        if (ap === null && bp === null) return a.name.localeCompare(b.name);
        if (ap === null) return 1;
        if (bp === null) return -1;
        return mul * (bp - ap);
      });
    }
    return list;
  }, [clients, filter, planFilter, tzFilter, billingWindowFilter, sortBy, dateRange, search, key]);

  // 1st click = desc (highest first), 2nd = asc, 3rd = reset.
  function cycleSort(col: SortCol) {
    setSortBy((cur) => {
      if (!cur || cur.col !== col) return { col, dir: 'desc' };
      if (cur.dir === 'desc') return { col, dir: 'asc' };
      return null;
    });
  }
  function sortIcon(col: SortCol): string {
    if (sortBy?.col !== col) return '↕';
    return sortBy.dir === 'desc' ? '↓' : '↑';
  }

  function applyDatePreset(p: 'last7' | 'last30' | 'ytd') {
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    let from: string;
    if (p === 'last7') {
      from = iso(addDays(today, -6));
    } else if (p === 'last30') {
      from = iso(addDays(today, -29));
    } else {
      from = `${today.getUTCFullYear()}-01-01`;
    }
    setDateRange({ from, to: iso(today) });
    setDatePreset(p);
  }

  const PRESET_LABEL: Record<Exclude<DatePreset, null>, string> = {
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    ytd: 'Year to date',
    custom: `${dateRange.from ?? '…'} → ${dateRange.to ?? '…'}`,
  };

  const summary = useMemo(() => {
    // Counters exclude hidden + client_paused clients — those are off-roster
    // for the day-to-day. clientPaused gets its own counter so we can show
    // it on its dedicated card.
    let total = 0;
    let risk = 0;
    let ok = 0;
    let done = 0;
    let intros = 0;
    let emails = 0;
    let target = 0;
    let clientPaused = 0;
    const plans = { minimum: 0, production: 0, partner: 0 };
    let convNum = 0;
    let convDen = 0;
    // Funnel totals (Interested → Introduction). All-time across HISTORICAL_WEEKS.
    let convertedTotal = 0;
    let interestedTotal = 0;
    // Monthly aggregates (per-client current monthly cycle).
    let monthlyIntros = 0;
    let monthlyTarget = 0;
    // Campaign-level aggregates powering Reply Rate + Positive Reply Rate.
    let campaignReplies = 0;      // sum of reply_count across every campaign
    let campaignInterested = 0;   // sum of interested_count
    let campaignEmailsSent = 0;   // sum of emails_sent_total (Instantly + Bison)
    clients.forEach((c) => {
      if (c.hidden) return;
      if (c.client_paused) {
        clientPaused++;
        return;
      }
      total++;
      target += c.weekly_target;
      plans[c.plan]++;
      const d = derive(c, key);
      if (d.status === 'risk') risk++;
      if (d.status === 'ok') ok++;
      if (d.metTarget) done++;
      intros += d.intros;
      emails += d.emails;
      if (d.emails > 0) {
        convNum += d.intros;
        convDen += d.emails;
      }
      for (const m of Object.values(c.metricsByWeek)) {
        convertedTotal += m.intros_corofy ?? 0;
        interestedTotal += m.interested_corofy ?? 0;
      }
      monthlyIntros += c.intros_this_month ?? 0;
      monthlyTarget += c.monthly_target ?? 0;
      for (const camp of [...c.campaigns, ...c.bisonCampaigns]) {
        campaignReplies += camp.reply_count ?? 0;
        campaignInterested += camp.interested_count ?? 0;
        campaignEmailsSent += camp.emails_sent_total ?? 0;
      }
    });
    const totalFunnel = convertedTotal + interestedTotal;
    const completionPct = target > 0 ? Math.round((intros / target) * 100) : 0;
    const monthlyCompletionPct = monthlyTarget > 0 ? Math.round((monthlyIntros / monthlyTarget) * 100) : 0;
    const replyRatePct = campaignEmailsSent > 0 ? ((campaignReplies / campaignEmailsSent) * 100).toFixed(1) + '%' : '—';
    const positiveReplyPct = campaignReplies > 0 ? ((campaignInterested / campaignReplies) * 100).toFixed(1) + '%' : '—';
    // Lifetime Avg Conv. — matches the Funnel row's all-lifetime cadence.
    // convertedTotal is the 26-week intros sum (functionally lifetime for
    // this dashboard); campaignEmailsSent is the true lifetime email count.
    const lifetimeConvPer1k = campaignEmailsSent > 0 ? ((convertedTotal / campaignEmailsSent) * 1000).toFixed(1) + '%' : '—';
    return {
      total,
      risk,
      ok,
      done,
      intros,
      emails,
      target,
      clientPaused,
      plans,
      completionPct,
      monthlyIntros,
      monthlyTarget,
      monthlyCompletionPct,
      replyRatePct,
      positiveReplyPct,
      lifetimeConvPer1k,
      campaignEmailsSent,
      conv: convDen > 0 ? ((convNum / convDen) * 1000).toFixed(1) + '%' : '—',
      // Raw avg (per-1k units, matches the displayed number) for row color logic.
      convAvg: convDen > 0 ? (convNum / convDen) * 1000 : 0,
      convertedTotal,
      convRatePct:
        totalFunnel > 0
          ? ((convertedTotal / totalFunnel) * 100).toFixed(1) + '%'
          : '—',
    };
  }, [clients, key]);

  function changeWeek(dir: -1 | 1) {
    setCurrentMonday((d) => addDays(d, dir * 7));
  }
  function goToToday() {
    setCurrentMonday(getMondayOf(new Date()));
  }

  function openAddModal() {
    setModal({
      ...emptyModal,
      open: true,
      startDate: todayLocalISO(),
    });
  }

  function openEditModal(c: DashboardClient) {
    setModal({
      open: true,
      editingId: c.id,
      name: c.name,
      plan: c.plan,
      startDate: c.start_date ?? '',
      weeklyTarget: c.weekly_target,
      monthlyTarget: c.monthly_target ?? 0,
      billingAnchorDate: c.billing_anchor_date ?? '',
      billingInterval: c.billing_interval ?? 'biweekly',
      billingIntervalDays: c.billing_interval_days != null ? String(c.billing_interval_days) : '',
      timeZone: c.time_zone ?? '',
    });
  }

  function closeModal() {
    setModal((m) => ({ ...m, open: false, editingId: null }));
  }

  async function saveClient() {
    const name = modal.name.trim();
    if (!name) return;
    // Auto-link any Instantly OR Bison campaign whose name contains this
    // client name (whole-name match + MANUAL_LINKS overrides). Same rule as
    // the seed script + auto-relink step in the sync worker.
    const linkedIds = autoMatchCampaignIds(name, allInstantlyCampaigns);
    const linkedBisonIds = autoMatchCampaignIds(name, allBisonCampaigns);
    // Custom interval only — parse the typed days field into an int. Any
    // non-positive / non-numeric value falls back to null (server treats as
    // "no custom cadence set yet", and the billing-date helper returns null).
    let billingIntervalDays: number | null = null;
    if (modal.billingInterval === 'custom') {
      const parsed = parseInt(modal.billingIntervalDays, 10);
      if (Number.isFinite(parsed) && parsed > 0) billingIntervalDays = parsed;
    }
    const payload = {
      name,
      plan: modal.plan,
      weekly_target: modal.weeklyTarget,
      monthly_target: modal.monthlyTarget,
      start_date: modal.startDate || null,
      instantly_campaign_ids: linkedIds,
      bison_campaign_ids: linkedBisonIds,
      billing_anchor_date: modal.billingAnchorDate || null,
      billing_interval: modal.billingInterval,
      billing_interval_days: billingIntervalDays,
      time_zone: modal.timeZone || null,
    };
    try {
      if (modal.editingId) {
        const res = await fetch('/api/clients', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: modal.editingId, ...payload }),
        });
        if (!res.ok) throw new Error(await res.text());
        setClients((list) =>
          list.map((c) => (c.id === modal.editingId ? { ...c, ...payload } : c))
        );
        setToast('Client updated');
      } else {
        const res = await fetch('/api/clients', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(await res.text());
        const { client } = (await res.json()) as { client: { id: string } };
        setClients((list) => [
          ...list,
          {
            ...payload,
            id: client.id,
            campaign_size: 0,
            hidden: false,
            client_paused: false,
            portal_active: false,
            emails_today: 0,
            emails_today_date: null,
            portal_synced_at: null,
            dnc_count: 0,
            agents_count: 0,
            last_lead_activity_at: null,
            stagnant_intros_count: 0,
            intros_since_last_billing: 0,
            monthly_target: modal.monthlyTarget,
            intros_this_month: 0,
            portal_url: null,
            campaigns: [],
            bisonCampaigns: [],
            metricsByWeek: {},
            portalActive: false,
          },
        ]);
        setToast('Client added');
      }
      closeModal();
      // Pull fresh server state so the row reflects newly-linked campaigns
      // and any metrics that already exist in Supabase.
      router.refresh();
    } catch (err) {
      setToast(`Save failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function deleteClient(id: string) {
    const client = clients.find((c) => c.id === id);
    const linkedCount =
      (client?.instantly_campaign_ids.length ?? 0) + (client?.bison_campaign_ids.length ?? 0);
    const detail = linkedCount > 0
      ? `Removing this client will also delete their weekly metrics and ${linkedCount} linked campaign cache row${linkedCount === 1 ? '' : 's'} (campaigns linked to no other client). Continue?`
      : `Remove this client? Their weekly metrics will also be deleted from Supabase.`;
    if (!confirm(detail)) return;
    try {
      const res = await fetch(`/api/clients?id=${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      const result = (await res.json()) as { ok: boolean; orphansRemoved?: number };
      setClients((list) => list.filter((c) => c.id !== id));
      const removedParts = ['client', 'weekly metrics'];
      if (result.orphansRemoved && result.orphansRemoved > 0) {
        removedParts.push(`${result.orphansRemoved} orphan campaign${result.orphansRemoved === 1 ? '' : 's'}`);
      }
      setToast(`Removed: ${removedParts.join(' + ')}`);
      router.refresh();
    } catch (err) {
      setToast(`Delete failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function toggleHidden(id: string, hidden: boolean) {
    // Optimistic update; PATCH; roll back on failure.
    setClients((list) => list.map((c) => (c.id === id ? { ...c, hidden } : c)));
    try {
      const res = await fetch('/api/clients', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, hidden }),
      });
      if (!res.ok) throw new Error(await res.text());
      setToast(hidden ? 'Client hidden · click Hidden tab to recover' : 'Client unhidden');
    } catch (err) {
      setClients((list) => list.map((c) => (c.id === id ? { ...c, hidden: !hidden } : c)));
      setToast(`Failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function toggleClientPaused(id: string, client_paused: boolean) {
    setClients((list) => list.map((c) => (c.id === id ? { ...c, client_paused } : c)));
    try {
      const res = await fetch('/api/clients', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, client_paused }),
      });
      if (!res.ok) throw new Error(await res.text());
      setToast(client_paused
        ? 'Client paused · click Client Paused tab to recover'
        : 'Client resumed');
    } catch (err) {
      setClients((list) => list.map((c) => (c.id === id ? { ...c, client_paused: !client_paused } : c)));
      setToast(`Failed: ${(err as Error).message.slice(0, 80)}`);
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const res = await fetch('/api/sync/run', { method: 'POST' });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      const data = (await res.json()) as {
        ok: boolean;
        result?: {
          instantly?: { campaigns?: number };
          corofy?: { intros?: number; skipped?: boolean };
        };
      };
      // Re-fetch the server component so newly synced data shows up immediately.
      router.refresh();
      const r = data.result ?? {};
      const parts: string[] = [];
      if (r.instantly?.campaigns !== undefined) parts.push(`${r.instantly.campaigns} campaigns`);
      if (r.corofy?.skipped) parts.push('Corofy skipped');
      else if (r.corofy?.intros !== undefined) parts.push(`${r.corofy.intros} intros`);
      setToast(`Synced · ${parts.join(' · ')}`);
    } catch (err) {
      setToast(`Sync error: ${(err as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  // Preview the campaigns that will be auto-linked when saving. Updates live
  // as the user types so they can see what will happen.
  const previewLinkedCount = useMemo(() => {
    const i = autoMatchCampaignIds(modal.name, allInstantlyCampaigns).length;
    const b = autoMatchCampaignIds(modal.name, allBisonCampaigns).length;
    return i + b;
  }, [modal.name, allInstantlyCampaigns, allBisonCampaigns]);

  return (
    <>
      <header>
        <div className="logo">
          <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="48" height="48" rx="10" fill="#E3F0FF" />
            <path d="M24 10L10 22H14V38H22V30H26V38H34V22H38L24 10Z" fill="#1565C0" />
          </svg>
          <div className="logo-text">BROKER<br />STAFFER</div>
        </div>
        <div className="header-right">
          <div className="week-nav">
            <button className="week-nav-btn" onClick={() => changeWeek(-1)}>←</button>
            <div className={'week-nav-label' + (isCurrent ? ' is-current' : '')}>
              {isCurrent ? 'This Week' : formatWeek(currentMonday)}
            </div>
            <button
              className="week-nav-btn"
              onClick={() => changeWeek(1)}
              disabled={weekKey(addDays(currentMonday, 7)) > weekKey(new Date())}
            >
              →
            </button>
          </div>
          {!isCurrent && (
            <button className="btn-today" onClick={goToToday}>Today</button>
          )}
          <button className="btn-refresh" onClick={refresh} disabled={refreshing} title="Trigger sync now">
            {refreshing ? '…' : '↻'}
          </button>
          <button className="btn-add" onClick={openAddModal}>+ Add Client</button>
          <button
            className="btn-logout"
            title="Sign out"
            onClick={async () => {
              await fetch('/api/auth/logout', { method: 'POST' });
              window.location.href = '/login';
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main>
        {!isCurrent && (
          <div className="past-week-banner show">📅 Viewing a past week — data is read-only.</div>
        )}

        <div className="summary-groups">
          <div className="summary-group">
            <div className="summary-group-label">Status</div>
            <div className="summary-group-row">
              <SummaryCard label="Clients" cls="n-total" num={summary.total} sub="active" />
              <SummaryCard label="At Risk" cls="n-risk" num={summary.risk} sub="below half target" />
              <SummaryCard label="On Track" cls="n-ok" num={summary.ok} sub="meeting target this week" />
              <SummaryCard label="Done" cls="n-done" num={summary.done} sub="met weekly target" />
              <SummaryCard label="Client Paused" cls="n-cpaused" num={summary.clientPaused} sub="manually paused" />
              <SummaryCard
                label="By Plan"
                cls="n-plan"
                num={`${summary.plans.minimum} · ${summary.plans.production} · ${summary.plans.partner}`}
                sub="min · prod · partner"
              />
            </div>
          </div>

          <div className="summary-group">
            <div className="summary-group-label">Performance</div>
            <div className="summary-group-row">
              <SummaryCard label="Weekly Intros Sent" cls="n-intros" num={summary.intros} sub="across all clients" />
              <SummaryCard label="Weekly Target" cls="n-target" num={summary.target} sub="intros / week" />
              <SummaryCard label="Weekly Completion" cls="n-completion" num={`${summary.completionPct}%`} sub="intros vs weekly target" />
              <SummaryCard label="Monthly Intros Sent" cls="n-intros" num={summary.monthlyIntros} sub="this monthly cycle" />
              <SummaryCard label="Monthly Target" cls="n-target" num={summary.monthlyTarget} sub="intros / month" />
              <SummaryCard label="Monthly Completion" cls="n-completion" num={`${summary.monthlyCompletionPct}%`} sub="intros vs monthly target" />
            </div>
          </div>

          <div className="summary-group">
            <div className="summary-group-label">Funnel</div>
            <div className="summary-group-row">
              <SummaryCard label="Emails Sent" cls="n-emails" num={summary.campaignEmailsSent.toLocaleString()} sub="lifetime, all campaigns" />
              <SummaryCard label="Reply Rate" cls="n-conv" num={summary.replyRatePct} sub="lifetime, replies / emails" />
              <SummaryCard label="Positive Reply" cls="n-conv" num={summary.positiveReplyPct} sub="lifetime, interested / replies" />
              <SummaryCard label="Avg Conv." cls="n-conv" num={summary.lifetimeConvPer1k} sub="lifetime, 1k emails → intro" />
              <SummaryCard label="Converted" cls="n-converted" num={summary.convertedTotal} sub="lifetime, interested → intro" />
              <SummaryCard label="Int → Intro" cls="n-conv-rate" num={summary.convRatePct} sub="lifetime, of total funnel" />
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <div className="table-header">
            <div>
              <div className="table-title">Client Health</div>
              <div className="table-subtitle">
                {isCurrent ? 'Live data from Instantly · Bison · MasterInbox' : `Week of ${formatWeek(currentMonday)}`}
              </div>
              <div className="view-toggle">
                <span className="view-toggle-label">View as:</span>
                <button className={view === 'weekly' ? 'active' : ''} onClick={() => setView('weekly')}>Weekly</button>
                <button className={view === 'biweekly' ? 'active' : ''} onClick={() => setView('biweekly')}>Bi-Weekly</button>
                <button className={view === 'success' ? 'active' : ''} onClick={() => setView('success')}>Client Success</button>
              </div>
            </div>
            <div className="filter-pills">
              <input
                type="search"
                className="client-search"
                placeholder="Search clients…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button className={'fpill' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>All</button>
              <button className={'fpill f-risk' + (filter === 'risk' ? ' active' : '')} onClick={() => setFilter('risk')}>At Risk</button>
              <button className={'fpill f-ok' + (filter === 'ok' ? ' active' : '')} onClick={() => setFilter('ok')}>On Track</button>
              <button className={'fpill f-ok' + (filter === 'done' ? ' active' : '')} onClick={() => setFilter('done')} title="Clients who reached their weekly intro target">Done</button>
              <button className={'fpill' + (filter === 'active' ? ' active' : '')} onClick={() => setFilter('active')} title="Clients with at least one running campaign">Active</button>
              <button className={'fpill' + (filter === 'paused' ? ' active' : '')} onClick={() => setFilter('paused')} title="Clients whose campaigns are paused or finished (no running)">Campaign Paused</button>
              <button className={'fpill' + (filter === 'inactive' ? ' active' : '')} onClick={() => setFilter('inactive')} title="Clients with no campaign launched yet">Inactive</button>
              <button className={'fpill' + (filter === 'client-paused' ? ' active' : '')} onClick={() => setFilter('client-paused')} title="Clients you've manually paused">Client Paused</button>
              <button className={'fpill' + (filter === 'hidden' ? ' active' : '')} onClick={() => setFilter('hidden')} title="Only churned clients">Clients Churned</button>
              <select
                className={'plan-select' + (planFilter !== 'all' ? ' active' : '')}
                value={planFilter}
                onChange={(e) => setPlanFilter(e.target.value as PlanFilter)}
                title="Filter by plan"
              >
                <option value="all">All Plans</option>
                <option value="minimum">Minimum</option>
                <option value="production">Production</option>
                <option value="partner">Partner</option>
              </select>
              <select
                className={'plan-select' + (tzFilter !== 'all' ? ' active' : '')}
                value={tzFilter}
                onChange={(e) => setTzFilter(e.target.value as TzFilter)}
                title="Filter by time zone"
              >
                <option value="all">All Time Zones</option>
                {TIME_ZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>{tz.short}</option>
                ))}
              </select>
              <select
                className={'plan-select' + (billingWindowFilter !== 'all' ? ' active' : '')}
                value={billingWindowFilter}
                onChange={(e) => setBillingWindowFilter(e.target.value as BillingWindowFilter)}
                title="Filter by next billing date"
              >
                <option value="all">Any Billing</option>
                <option value="7">Next 7 days</option>
                <option value="14">Next 14 days</option>
                <option value="30">Next 30 days</option>
              </select>
              <div style={{ position: 'relative' }}>
                <button
                  className={'fpill date-pill' + (datePreset ? ' active' : '')}
                  onClick={() => setDatePopoverOpen((v) => !v)}
                  title="Filter by client start date"
                >
                  📅 {datePreset ? PRESET_LABEL[datePreset] : 'Date'}
                </button>
                {datePopoverOpen && (
                  <div className="date-popover">
                    <div className="date-presets">
                      <button
                        className={'preset-btn' + (datePreset === 'last7' ? ' active' : '')}
                        onClick={() => applyDatePreset('last7')}
                      >Last 7 Days</button>
                      <button
                        className={'preset-btn' + (datePreset === 'last30' ? ' active' : '')}
                        onClick={() => applyDatePreset('last30')}
                      >Last 30 Days</button>
                      <button
                        className={'preset-btn' + (datePreset === 'ytd' ? ' active' : '')}
                        onClick={() => applyDatePreset('ytd')}
                      >Year to Date</button>
                    </div>
                    <div className="date-popover-divider" />
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>From
                      <input
                        type="date"
                        value={dateRange.from ?? ''}
                        onChange={(e) => {
                          setDateRange((r) => ({ ...r, from: e.target.value || null }));
                          setDatePreset(e.target.value ? 'custom' : null);
                        }}
                      />
                    </label>
                    <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)' }}>To
                      <input
                        type="date"
                        value={dateRange.to ?? ''}
                        onChange={(e) => {
                          setDateRange((r) => ({ ...r, to: e.target.value || null }));
                          setDatePreset(e.target.value ? 'custom' : null);
                        }}
                      />
                    </label>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button
                        className="btn-secondary"
                        style={{ flex: 1, padding: '6px 10px', fontSize: 12 }}
                        onClick={() => {
                          setDateRange({ from: null, to: null });
                          setDatePreset(null);
                          setDatePopoverOpen(false);
                        }}
                      >Clear</button>
                      <button
                        className="btn-primary"
                        style={{ flex: 1, padding: '6px 10px', fontSize: 12 }}
                        onClick={() => setDatePopoverOpen(false)}
                      >Done</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="table-scroll">
            {visible.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📋</div>
                <h3>No clients yet</h3>
                <p>Add your first client to start tracking.</p>
                <button className="btn-add" onClick={openAddModal}>+ Add Client</button>
              </div>
            ) : view === 'biweekly' ? (
              <BiWeeklyTable clients={visible} onEditClient={openEditModal} />
            ) : view === 'success' ? (
              <ClientSuccessTable clients={visible} onEditClient={openEditModal} />
            ) : (
              <table>
                <thead>
                  <tr>
                    <th
                      className={'sortable' + (sortBy?.col === 'campaigns' ? ' sorted' : '')}
                      onClick={() => cycleSort('campaigns')}
                      title="Sort by # of active campaigns — click to cycle desc / asc / reset"
                    >
                      Client <em className="sort-icon">{sortIcon('campaigns')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'tz' ? ' sorted' : '')}
                      onClick={() => cycleSort('tz')}
                      title="Sort by time zone — click to cycle desc / asc / reset"
                    >
                      Time Zone <em className="sort-icon">{sortIcon('tz')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'monthly' ? ' sorted' : '')}
                      onClick={() => cycleSort('monthly')}
                      title="Intros this monthly cycle (starts on the billing anchor day-of-month). — for clients with no monthly target set."
                    >
                      Monthly <em className="sort-icon">{sortIcon('monthly')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'lastIntro' ? ' sorted' : '')}
                      onClick={() => cycleSort('lastIntro')}
                      title="Sort by last intro time — click to cycle desc / asc / reset"
                    >
                      Last Intro <em className="sort-icon">{sortIcon('lastIntro')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'lastBilling' ? ' sorted' : '')}
                      onClick={() => cycleSort('lastBilling')}
                      title="Sort by last (most recent) billing date — click to cycle desc / asc / reset"
                    >
                      Last Billing <em className="sort-icon">{sortIcon('lastBilling')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'billing' ? ' sorted' : '')}
                      onClick={() => cycleSort('billing')}
                      title="Sort by next billing date — click to cycle desc / asc / reset"
                    >
                      Next Billing <em className="sort-icon">{sortIcon('billing')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'billingDays' ? ' sorted' : '')}
                      onClick={() => cycleSort('billingDays')}
                      title="Sort by days until next billing — click to cycle desc / asc / reset"
                    >
                      Days Until Billing <em className="sort-icon">{sortIcon('billingDays')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'today' ? ' sorted' : '')}
                      onClick={() => cycleSort('today')}
                      title="Sort by emails sent today (EST) — click to cycle desc / asc / reset"
                    >
                      Daily Emails Sent <em className="sort-icon">{sortIcon('today')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'intros' ? ' sorted' : '')}
                      onClick={() => cycleSort('intros')}
                      title="Sort by intros this week — click to cycle desc / asc / reset"
                    >
                      Intros This Week <em className="sort-icon">{sortIcon('intros')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'conv' ? ' sorted' : '')}
                      onClick={() => cycleSort('conv')}
                      title="Sort by conversion rate — click to cycle desc / asc / reset"
                    >
                      Conv. Rate <em className="sort-icon">{sortIcon('conv')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'leftWeek' ? ' sorted' : '')}
                      onClick={() => cycleSort('leftWeek')}
                      title="Sort by intros left this week — click to cycle desc / asc / reset"
                    >
                      Left This Week <em className="sort-icon">{sortIcon('leftWeek')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'progress' ? ' sorted' : '')}
                      onClick={() => cycleSort('progress')}
                      title="Sort by average campaign progress — click to cycle desc / asc / reset"
                    >
                      Campaign Progress <em className="sort-icon">{sortIcon('progress')}</em>
                    </th>
                    <th>Status</th>
                    <th
                      className={'sortable' + (sortBy?.col === 'interested' ? ' sorted' : '')}
                      onClick={() => cycleSort('interested')}
                      title="Sort by all-time Interested count — click to cycle desc / asc / reset"
                    >
                      Interested <em className="sort-icon">{sortIcon('interested')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'converted' ? ' sorted' : '')}
                      onClick={() => cycleSort('converted')}
                      title="Sort by Interested → Intro converted count — click to cycle desc / asc / reset"
                    >
                      Converted <em className="sort-icon">{sortIcon('converted')}</em>
                    </th>
                    <th
                      className={'sortable' + (sortBy?.col === 'convRate' ? ' sorted' : '')}
                      onClick={() => cycleSort('convRate')}
                      title="Sort by Interested → Intro conversion rate — click to cycle desc / asc / reset"
                    >
                      Int → Intro <em className="sort-icon">{sortIcon('convRate')}</em>
                    </th>
                    <th>Plan</th>
                    <th>Portal</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((c) => (
                    <ClientRow
                      key={c.id}
                      client={c}
                      weekKey={key}
                      campaignSelection={campaignSelections[c.id] ?? '__avg__'}
                      convAvg={summary.convAvg}
                      onCampaignChange={(camp) =>
                        setCampaignSelections((prev) => ({ ...prev, [c.id]: camp }))
                      }
                      onShowCampaigns={() => setCampaignsPopupClientId(c.id)}
                      onEdit={() => openEditModal(c)}
                      onDelete={() => deleteClient(c.id)}
                      onToggleHidden={(h) => toggleHidden(c.id, h)}
                      onToggleClientPaused={(p) => toggleClientPaused(c.id, p)}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </main>

      <div
        className={'modal-overlay' + (modal.open ? ' open' : '')}
        onClick={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}
      >
        <div className="modal">
          <h2>{modal.editingId ? 'Edit Client' : 'Add Client'}</h2>
          <p>{modal.editingId ? "Update this client's details." : "Enter the client's details to start tracking."}</p>

          <div className="form-group">
            <label>Client / Brokerage Name</label>
            <input
              type="text"
              value={modal.name}
              placeholder="e.g. Premier Metro Realty"
              onChange={(e) => setModal((m) => ({ ...m, name: e.target.value }))}
            />
            <div className="form-help">
              {modal.name.trim() === ''
                ? 'Instantly + Bison campaigns whose name contains this client name are auto-linked on save.'
                : previewLinkedCount === 0
                  ? `No campaign contains "${modal.name.trim()}" — this client will be saved without any linked campaigns.`
                  : `Will auto-link ${previewLinkedCount} matching campaign${previewLinkedCount === 1 ? '' : 's'}.`}
            </div>
          </div>

          <div className="form-group">
            <label>Plan</label>
            <select
              value={modal.plan}
              onChange={(e) => {
                const plan = e.target.value as Plan;
                setModal((m) => ({
                  ...m,
                  plan,
                  // Bump target to plan default only if user hasn't customized away from another plan default.
                  weeklyTarget:
                    Object.values(PLAN_DEFAULT_TARGET).includes(m.weeklyTarget)
                      ? PLAN_DEFAULT_TARGET[plan]
                      : m.weeklyTarget,
                }));
              }}
            >
              <option value="minimum">Minimum — 1 intro/week</option>
              <option value="production">Production — 3 intros/week</option>
              <option value="partner">Partner — 6 intros/week</option>
            </select>
          </div>

          <div className="form-group">
            <label>Weekly Intros Target</label>
            <input
              type="number"
              min={0}
              value={modal.weeklyTarget}
              onChange={(e) =>
                setModal((m) => ({ ...m, weeklyTarget: parseInt(e.target.value || '0', 10) }))
              }
            />
            <div className="form-help">Drives the At Risk / On Track status. Defaults to plan tier (1/3/6) but you can override.</div>
          </div>

          <div className="form-group">
            <label>Monthly Intros Target</label>
            <input
              type="number"
              min={0}
              value={modal.monthlyTarget}
              onChange={(e) =>
                setModal((m) => ({ ...m, monthlyTarget: parseInt(e.target.value || '0', 10) }))
              }
            />
            <div className="form-help">Progress resets on the client&apos;s billing anchor day each calendar month. 0 hides the column.</div>
          </div>

          <div className="form-group">
            <label>Start Date</label>
            <input
              type="date"
              value={modal.startDate}
              onChange={(e) => setModal((m) => ({ ...m, startDate: e.target.value }))}
            />
          </div>

          <div className="form-group">
            <label>Billing Anchor Date</label>
            <input
              type="date"
              value={modal.billingAnchorDate}
              onChange={(e) => setModal((m) => ({ ...m, billingAnchorDate: e.target.value }))}
            />
            <div className="form-help">A known billing date. Empty falls back to Start Date.</div>
          </div>

          <div className="form-group">
            <label>Billing Interval</label>
            <select
              value={modal.billingInterval}
              onChange={(e) => setModal((m) => ({ ...m, billingInterval: e.target.value as BillingInterval }))}
            >
              <option value="biweekly">{BILLING_INTERVAL_LABEL.biweekly}</option>
              <option value="28-days">{BILLING_INTERVAL_LABEL['28-days']}</option>
              <option value="monthly">{BILLING_INTERVAL_LABEL.monthly}</option>
              <option value="custom">{BILLING_INTERVAL_LABEL.custom}</option>
            </select>
            {modal.billingInterval === 'custom' && (
              <div className="custom-days-row">
                <span>Every</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  placeholder="e.g. 21"
                  className="custom-days-input"
                  value={modal.billingIntervalDays}
                  onChange={(e) => setModal((m) => ({ ...m, billingIntervalDays: e.target.value }))}
                />
                <span>days</span>
              </div>
            )}
          </div>

          <div className="form-group">
            <label>Time Zone</label>
            <select
              value={modal.timeZone}
              onChange={(e) => setModal((m) => ({ ...m, timeZone: e.target.value }))}
            >
              <option value="">— None —</option>
              {TIME_ZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
            <div className="form-help">Shown as a short code (ET, PT, …) in the Client Success view.</div>
          </div>


          <div className="modal-actions">
            <button className="btn-secondary" onClick={closeModal}>Cancel</button>
            <button className="btn-primary" onClick={saveClient}>
              {modal.editingId ? 'Save Changes' : 'Add Client'}
            </button>
          </div>
        </div>
      </div>

      {campaignsPopupClientId && (() => {
        const c = clients.find((x) => x.id === campaignsPopupClientId);
        if (!c) return null;
        return (
          <CampaignsPopup
            client={c}
            onClose={() => setCampaignsPopupClientId(null)}
          />
        );
      })()}

      <div className={'toast' + (toast ? ' show' : '')}>{toast ?? ''}</div>
    </>
  );
}

function CampaignGroup({
  label,
  count,
  campaigns,
}: {
  label: string | null;
  count: number;
  campaigns: PopupCampaign[];
}) {
  return (
    <div className="camps-popup-group">
      {label && (
        <div className="camps-popup-group-header">
          <span className="camps-popup-group-label">{label}</span>
          <span className="camps-popup-group-count">{count}</span>
        </div>
      )}
      {campaigns.map((c) => (
        <CampaignRow key={`${c.source}:${c.id}`} c={c} />
      ))}
    </div>
  );
}

function CampaignRow({ c }: { c: PopupCampaign }) {
  const pct = Math.min(100, Math.max(0, Number(c.progress_pct ?? 0)));
  const sent = c.emails_sent_total?.toLocaleString() ?? '0';
  const total = c.campaign_size ?? 0;
  const completed = Math.round(total * (pct / 100));
  const rowCls =
    c.status === 'running'
      ? 'is-running'
      : c.status === 'paused'
        ? 'is-paused'
        : c.status === 'finished'
          ? 'is-finished'
          : 'is-draft';
  const statusLabel =
    c.status === 'paused'
      ? 'Campaign Paused'
      : c.status === 'finished'
        ? 'Finished'
        : c.status === 'running'
          ? 'Running'
          : 'Draft';
  return (
    <div className={`camps-popup-row ${rowCls}`}>
      <div className="camp-row-head">
        <div className="camp-info-name">{c.name}</div>
        <div className="camp-pct">{Math.round(pct)}%</div>
      </div>
      <div className="camp-mini-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="camp-row-foot">
        <span className="camp-row-stats">
          <strong>{completed.toLocaleString()}</strong> / {total.toLocaleString()} leads
          <span className="camp-row-sep">·</span>
          <strong>{sent}</strong> emails sent
        </span>
        <span className="camp-status-chip">
          <span className="chip-dot" />
          <span className="chip-label">{statusLabel}</span>
        </span>
      </div>
      {(() => {
        const sentNum = c.emails_sent_total ?? 0;
        const replyNum = c.reply_count ?? 0;
        const interestedNum = c.interested_count ?? 0;
        const replyPct = sentNum > 0 ? (replyNum / sentNum) * 100 : null;
        const posPct = replyNum > 0 ? (interestedNum / replyNum) * 100 : null;
        return (
          <div className="camp-row-rates">
            <span className="camp-rate">
              <span className="camp-rate-label">Reply</span>
              <span className="camp-rate-val">
                {replyPct === null
                  ? '—'
                  : `${replyPct.toFixed(1)}% (${replyNum.toLocaleString()})`}
              </span>
            </span>
            <span className="camp-rate">
              <span className="camp-rate-label">Positive</span>
              <span className="camp-rate-val">
                {posPct === null
                  ? '—'
                  : `${posPct.toFixed(1)}% (${interestedNum.toLocaleString()})`}
              </span>
            </span>
          </div>
        );
      })()}
    </div>
  );
}

function CampaignsPopup({
  client,
  onClose,
}: {
  client: DashboardClient;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Surface ALL linked campaigns across both sources. Group by vendor so the
  // popup reads as two clean lists (Instantly first, then Bison) instead of an
  // interleaved one. Within each group, sort by status: running → paused →
  // finished, then most-recent transition first.
  const statusRank = (s: PopupCampaign['status']): number =>
    s === 'running' ? 0 : s === 'paused' ? 1 : s === 'finished' ? 2 : 3;
  const sortGroup = (group: PopupCampaign[]) =>
    [...group].sort((a, b) => {
      const r = statusRank(a.status) - statusRank(b.status);
      if (r !== 0) return r;
      const at = a.status_changed_at ? Date.parse(a.status_changed_at) : 0;
      const bt = b.status_changed_at ? Date.parse(b.status_changed_at) : 0;
      return bt - at;
    });
  const instantlyGroup = sortGroup(
    client.campaigns.map((c) => ({ ...c, source: 'instantly' as const }))
  );
  const bisonGroup = sortGroup(
    client.bisonCampaigns.map((c) => ({ ...c, source: 'bison' as const }))
  );
  const all: PopupCampaign[] = [...instantlyGroup, ...bisonGroup];

  // Only render section headers when BOTH sources have campaigns. If only one
  // is linked, the headers would be visual noise.
  const showHeaders = instantlyGroup.length > 0 && bisonGroup.length > 0;

  const running = all.filter((c) => c.status === 'running');
  const totalSent = running.reduce((a, b) => a + b.emails_sent_total, 0);
  const summary =
    running.length === 0
      ? 'No active campaigns'
      : `${totalSent.toLocaleString()} emails sent`;

  return (
    <div
      className="modal-overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal camps-popup">
        <div className="camps-popup-header">
          <div className="camps-popup-title">{client.name}</div>
          <div className="camps-popup-sub">
            {running.length} active {running.length === 1 ? 'campaign' : 'campaigns'}
            {running.length > 0 ? ` · ${summary}` : ''}
            {all.length > running.length && ` · ${all.length - running.length} paused / finished`}
          </div>
          {all.length > 0 && (
            <div className="camps-popup-note">
              Email counts include every sequence step + subsequences. Matches each vendor&apos;s campaign total, not its Step Analytics view.
            </div>
          )}
        </div>
        <div className="camps-popup-body">
          {all.length === 0 ? (
            <div className="empty-state" style={{ padding: '40px 20px' }}>
              <div className="empty-icon">⏸</div>
              <h3>No campaigns linked</h3>
              <p>This client has no linked campaigns yet.</p>
            </div>
          ) : (
            <>
              {instantlyGroup.length > 0 && (
                <CampaignGroup
                  label={showHeaders ? 'Instantly' : null}
                  count={instantlyGroup.length}
                  campaigns={instantlyGroup}
                />
              )}
              {bisonGroup.length > 0 && (
                <CampaignGroup
                  label={showHeaders ? 'Bison' : null}
                  count={bisonGroup.length}
                  campaigns={bisonGroup}
                />
              )}
            </>
          )}
        </div>
        <div className="camps-popup-footer">
          <button className="btn-secondary" onClick={onClose} style={{ flex: 'none', padding: '8px 18px' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

type BwSortCol = 'name' | 'tz' | 'billing' | 'days' | 'intros' | 'leftCycle';
type BwSortBy = null | { col: BwSortCol; dir: 'desc' | 'asc' };

function BiWeeklyTable({
  clients,
  onEditClient,
}: {
  clients: DashboardClient[];
  onEditClient: (c: DashboardClient) => void;
}) {
  const today = new Date();
  const fmtBilling = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const [sortBy, setSortBy] = useState<BwSortBy>(null);
  // 1st click → desc; 2nd → asc; 3rd → reset (default order).
  function cycleSort(col: BwSortCol) {
    setSortBy((cur) => {
      if (!cur || cur.col !== col) return { col, dir: 'desc' };
      if (cur.dir === 'desc') return { col, dir: 'asc' };
      return null;
    });
  }
  function sortIcon(col: BwSortCol): string {
    if (sortBy?.col !== col) return '↕';
    return sortBy.dir === 'desc' ? '↓' : '↑';
  }
  const rows = clients.map((c) => {
    const anchor = c.billing_anchor_date ?? c.start_date;
    const billing = nextBillingDate(anchor, c.billing_interval, today, c.billing_interval_days);
    const days = billing ? daysUntil(billing, today) : null;
    // "Introductions since last billing" — precomputed by the sync worker
    // using each intro's assigned_at + the client's billing anchor. Preserves
    // per-billing-cycle semantics that biweeklyIntros() can't offer.
    const intros = c.intros_since_last_billing;
    // Cycle target proportional to the billing interval — a monthly client's
    // "target" for one cycle is ~4 weeks of their weekly target, not just
    // the fixed biweekly number.
    const cycleDays = c.billing_interval === 'biweekly' ? 14
                    : c.billing_interval === '28-days' ? 28
                    : c.billing_interval === 'monthly' ? 30
                    : c.billing_interval === 'custom' ? (c.billing_interval_days ?? 14)
                    : 14;
    const target = Math.max(1, Math.round((c.weekly_target * cycleDays) / 7));
    // "Introductions Left This Cycle" — cycleTarget minus intros-since-last-
    // billing. Parallels the Introductions column (which uses the same
    // cycle definition) so a single glance tells you where in the cycle
    // the client stands.
    const leftCycle = Math.max(0, target - intros);
    const tzShort = c.time_zone ? (TZ_SHORT_BY_VALUE[c.time_zone] ?? c.time_zone) : null;
    return { c, billing, days, intros, target, leftCycle, tzShort };
  });
  type Row = (typeof rows)[number];
  const defaultCmp = (a: Row, b: Row) => {
    if (a.days === null && b.days === null) return a.c.name.localeCompare(b.c.name);
    if (a.days === null) return 1;
    if (b.days === null) return -1;
    return a.days - b.days;
  };
  let sorted: Row[];
  if (!sortBy) {
    sorted = [...rows].sort(defaultCmp);
  } else {
    const mul = sortBy.dir === 'desc' ? 1 : -1;
    sorted = [...rows].sort((a, b) => {
      switch (sortBy.col) {
        case 'name':
          // localeCompare is naturally asc — multiply by -mul so desc means Z→A.
          return -mul * a.c.name.localeCompare(b.c.name);
        case 'billing':
          if (!a.billing && !b.billing) return a.c.name.localeCompare(b.c.name);
          if (!a.billing) return 1;
          if (!b.billing) return -1;
          return mul * (b.billing.getTime() - a.billing.getTime());
        case 'days':
          if (a.days === null && b.days === null) return a.c.name.localeCompare(b.c.name);
          if (a.days === null) return 1;
          if (b.days === null) return -1;
          return mul * (b.days - a.days);
        case 'intros':
          return mul * (b.intros - a.intros);
        case 'leftCycle':
          return mul * (b.leftCycle - a.leftCycle);
        case 'tz': {
          const av = a.tzShort ?? '';
          const bv = b.tzShort ?? '';
          if (!av && !bv) return a.c.name.localeCompare(b.c.name);
          if (!av) return 1;
          if (!bv) return -1;
          return -mul * av.localeCompare(bv);
        }
        default:
          return 0;
      }
    });
  }
  return (
    <table>
      <thead>
        <tr>
          <th
            className={'sortable' + (sortBy?.col === 'name' ? ' sorted' : '')}
            onClick={() => cycleSort('name')}
            title="Sort by client name — click to cycle desc / asc / reset"
          >
            Client <em className="sort-icon">{sortIcon('name')}</em>
          </th>
          <th
            className={'sortable' + (sortBy?.col === 'tz' ? ' sorted' : '')}
            onClick={() => cycleSort('tz')}
            title="Sort by time zone — click to cycle desc / asc / reset"
          >
            Time Zone <em className="sort-icon">{sortIcon('tz')}</em>
          </th>
          <th
            className={'sortable' + (sortBy?.col === 'billing' ? ' sorted' : '')}
            onClick={() => cycleSort('billing')}
            title="Sort by next billing date — click to cycle desc / asc / reset"
          >
            Billing Date <em className="sort-icon">{sortIcon('billing')}</em>
          </th>
          <th
            className={'sortable' + (sortBy?.col === 'days' ? ' sorted' : '')}
            onClick={() => cycleSort('days')}
            title="Sort by days until billing — click to cycle desc / asc / reset"
          >
            Days Until Billing <em className="sort-icon">{sortIcon('days')}</em>
          </th>
          <th
            className={'sortable' + (sortBy?.col === 'intros' ? ' sorted' : '')}
            onClick={() => cycleSort('intros')}
            title="Introductions since the client's last billing day — click to cycle desc / asc / reset"
          >
            Introductions <em className="sort-icon">{sortIcon('intros')}</em>
          </th>
          <th
            className={'sortable' + (sortBy?.col === 'leftCycle' ? ' sorted' : '')}
            onClick={() => cycleSort('leftCycle')}
            title="Introductions left in the current billing cycle — click to cycle desc / asc / reset"
          >
            Left This Cycle <em className="sort-icon">{sortIcon('leftCycle')}</em>
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(({ c, billing, days, intros, target, leftCycle, tzShort }) => {
          const introsCls =
            intros >= target ? 'bw-done' : intros >= Math.ceil(target / 2) ? 'bw-mid' : 'bw-short';
          const leftCls = leftCycle === 0 ? 'bw-done' : 'bw-short';
          return (
            <tr key={c.id}>
              <td className="client-cell">
                <div className="client-name">{c.name}</div>
              </td>
              <td>
                {tzShort
                  ? <span className="cs-tz">{tzShort}</span>
                  : (
                    <button className="set-date-link" onClick={() => onEditClient(c)}>Set</button>
                  )}
              </td>
              <td>
                {billing
                  ? fmtBilling(billing)
                  : (
                    <button className="set-date-link" onClick={() => onEditClient(c)}>
                      Set billing date
                    </button>
                  )}
              </td>
              <td>
                {days === null
                  ? '—'
                  : (
                    <span className={days <= 3 ? 'days-urgent' : ''}>
                      {days} day{days === 1 ? '' : 's'}
                    </span>
                  )}
              </td>
              <td>
                <span className={introsCls}>{intros}/{target}</span>
              </td>
              <td>
                <span className={leftCls}>
                  {leftCycle === 0 ? 'Done' : `${leftCycle} left`}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Client Success tab — health / relationship view. Independent of the
// Weekly / Bi-Weekly throughput lens.
//
// Columns:
//   Client | Plan | Time Zone | Launch Date | Portal Updated
//   | Stagnant Intros | Hired | Last Hire | DNC | Agents
//
// Data sources:
//   - Portal Updated = clients.last_lead_activity_at (mirror of Corofy's
//     portals.last_lead_activity_at, bumped on stage change or note addition).
//   - Stagnant Intros = clients.stagnant_intros_count (Introduction-feed rows
//     where updated_at ≈ assigned_at — i.e. never touched since entering).
//   - Hired / Last Hire come from weekly_metrics hired_corofy/last_hired_at.

type CsSortCol =
  | 'name' | 'plan' | 'score' | 'tz' | 'launch' | 'portal' | 'stage'
  | 'hired' | 'lastHire' | 'dnc' | 'agents';

// Score column color threshold — kept close to the score column render so the
// three cutoffs live in one place if the team wants to retune later.
function scoreClass(s: number): 'cs-score-good' | 'cs-score-mid' | 'cs-score-low' {
  if (s >= 8) return 'cs-score-good';
  if (s >= 5) return 'cs-score-mid';
  return 'cs-score-low';
}
type CsSortBy = null | { col: CsSortCol; dir: 'desc' | 'asc' };

// "5 min ago" / "2h ago" / "3d ago" / "—" — used for both portal_synced_at
// and last_hired_at cells so cadence reads consistently across the row.
function humanizeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'Yesterday';
  if (d < 30) return `${d}d ago`;
  const months = Math.floor(d / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function fmtISODateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function ClientSuccessTable({
  clients,
  onEditClient,
}: {
  clients: DashboardClient[];
  onEditClient: (c: DashboardClient) => void;
}) {
  const now = Date.now();
  const [sortBy, setSortBy] = useState<CsSortBy>(null);
  function cycleSort(col: CsSortCol) {
    setSortBy((cur) => {
      if (!cur || cur.col !== col) return { col, dir: 'desc' };
      if (cur.dir === 'desc') return { col, dir: 'asc' };
      return null;
    });
  }
  function sortIcon(col: CsSortCol): string {
    if (sortBy?.col !== col) return '↕';
    return sortBy.dir === 'desc' ? '↓' : '↑';
  }

  const nowDate = new Date(now);
  const rows = clients.map((c) => {
    // Newest last_hired_at + sum hired across weekly_metrics.
    let lastHireMs = 0;
    let hiredTotal = 0;
    for (const m of Object.values(c.metricsByWeek)) {
      if (m.last_hired_at) {
        const t = new Date(m.last_hired_at).getTime();
        if (Number.isFinite(t) && t > lastHireMs) lastHireMs = t;
      }
      hiredTotal += m.hired_corofy ?? 0;
    }
    const scoreInfo = clientScore(c.metricsByWeek, c.weekly_target, nowDate);
    return {
      c,
      hiredTotal,
      lastHireAt: lastHireMs > 0 ? new Date(lastHireMs).toISOString() : null,
      score: scoreInfo.score,
    };
  });
  type Row = (typeof rows)[number];
  const defaultCmp = (a: Row, b: Row) => a.c.name.localeCompare(b.c.name);
  let sorted: Row[];
  if (!sortBy) {
    sorted = [...rows].sort(defaultCmp);
  } else {
    const mul = sortBy.dir === 'desc' ? 1 : -1;
    // Returns 0 when both sides are missing so the `|| nameCmp` fallback fires.
    const strCmp = (av: string | null | undefined, bv: string | null | undefined) => {
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return -mul * av.localeCompare(bv);
    };
    const numCmp = (av: number, bv: number) => mul * (bv - av);
    const dateCmp = (av: string | null | undefined, bv: string | null | undefined) => {
      const at = av ? new Date(av).getTime() : 0;
      const bt = bv ? new Date(bv).getTime() : 0;
      if (at === 0 && bt === 0) return 0;
      if (at === 0) return 1;
      if (bt === 0) return -1;
      return mul * (bt - at);
    };
    sorted = [...rows].sort((a, b) => {
      switch (sortBy.col) {
        case 'name':    return -mul * a.c.name.localeCompare(b.c.name);
        case 'plan':    return -mul * a.c.plan.localeCompare(b.c.plan);
        case 'score':   {
          // Null scores (new clients) sink to bottom regardless of direction.
          if (a.score === null && b.score === null) return a.c.name.localeCompare(b.c.name);
          if (a.score === null) return 1;
          if (b.score === null) return -1;
          return mul * (b.score - a.score) || a.c.name.localeCompare(b.c.name);
        }
        case 'tz':      return strCmp(a.c.time_zone, b.c.time_zone) || a.c.name.localeCompare(b.c.name);
        case 'launch':  return dateCmp(a.c.start_date, b.c.start_date) || a.c.name.localeCompare(b.c.name);
        case 'portal':  return dateCmp(a.c.last_lead_activity_at, b.c.last_lead_activity_at) || a.c.name.localeCompare(b.c.name);
        case 'stage':   return numCmp(a.c.stagnant_intros_count, b.c.stagnant_intros_count) || a.c.name.localeCompare(b.c.name);
        case 'hired':    return numCmp(a.hiredTotal, b.hiredTotal) || a.c.name.localeCompare(b.c.name);
        case 'lastHire': return dateCmp(a.lastHireAt, b.lastHireAt) || a.c.name.localeCompare(b.c.name);
        case 'dnc':      return numCmp(a.c.dnc_count, b.c.dnc_count) || a.c.name.localeCompare(b.c.name);
        case 'agents':   return numCmp(a.c.agents_count, b.c.agents_count) || a.c.name.localeCompare(b.c.name);
        default: return 0;
      }
    });
  }

  return (
    <table className="cs-table">
      <thead>
        <tr>
          <th className={'sortable' + (sortBy?.col === 'name' ? ' sorted' : '')} onClick={() => cycleSort('name')}>
            Client <em className="sort-icon">{sortIcon('name')}</em>
          </th>
          <th className={'sortable' + (sortBy?.col === 'plan' ? ' sorted' : '')} onClick={() => cycleSort('plan')}>
            Plan <em className="sort-icon">{sortIcon('plan')}</em>
          </th>
          <th
            className={'sortable cs-num' + (sortBy?.col === 'score' ? ' sorted' : '')}
            onClick={() => cycleSort('score')}
            title="0–10 rating over the last 8 weeks. Higher = hits weekly target more consistently and with more headroom."
          >
            Score <em className="sort-icon">{sortIcon('score')}</em>
          </th>
          <th className={'sortable' + (sortBy?.col === 'tz' ? ' sorted' : '')} onClick={() => cycleSort('tz')}>
            Time Zone <em className="sort-icon">{sortIcon('tz')}</em>
          </th>
          <th className={'sortable' + (sortBy?.col === 'launch' ? ' sorted' : '')} onClick={() => cycleSort('launch')}>
            Launch Date <em className="sort-icon">{sortIcon('launch')}</em>
          </th>
          <th
            className={'sortable' + (sortBy?.col === 'portal' ? ' sorted' : '')}
            onClick={() => cycleSort('portal')}
            title="Last time any lead in this client's portal was touched (stage change or note added)"
          >
            Portal Updated <em className="sort-icon">{sortIcon('portal')}</em>
          </th>
          <th
            className={'sortable cs-num' + (sortBy?.col === 'stage' ? ' sorted' : '')}
            onClick={() => cycleSort('stage')}
            title="Leads in the Introduction stage that have never been updated since entering"
          >
            Stagnant Intros <em className="sort-icon">{sortIcon('stage')}</em>
          </th>
          <th className={'sortable cs-num' + (sortBy?.col === 'hired' ? ' sorted' : '')} onClick={() => cycleSort('hired')}>
            Hired <em className="sort-icon">{sortIcon('hired')}</em>
          </th>
          <th className={'sortable' + (sortBy?.col === 'lastHire' ? ' sorted' : '')} onClick={() => cycleSort('lastHire')}>
            Last Hire <em className="sort-icon">{sortIcon('lastHire')}</em>
          </th>
          <th className={'sortable cs-num' + (sortBy?.col === 'dnc' ? ' sorted' : '')} onClick={() => cycleSort('dnc')}>
            DNC <em className="sort-icon">{sortIcon('dnc')}</em>
          </th>
          <th className={'sortable cs-num' + (sortBy?.col === 'agents' ? ' sorted' : '')} onClick={() => cycleSort('agents')}>
            Agents <em className="sort-icon">{sortIcon('agents')}</em>
          </th>
        </tr>
      </thead>
      <tbody>
        {sorted.map(({ c, hiredTotal, lastHireAt, score }) => {
          const tzShort = c.time_zone ? (TZ_SHORT_BY_VALUE[c.time_zone] ?? c.time_zone) : null;
          return (
            <tr key={c.id}>
              <td className="client-cell">
                <div className="client-name">{c.name}</div>
              </td>
              <td>
                <span className={`plan-badge ${PLAN_BADGE_CLASS[c.plan]}`}>{PLAN_LABEL[c.plan]}</span>
              </td>
              <td className="cs-num">
                {score === null
                  ? <span className="cs-none">—</span>
                  : <span className={`cs-score ${scoreClass(score)}`}>{score.toFixed(1)}</span>}
              </td>
              <td>
                {tzShort
                  ? <span className="cs-tz">{tzShort}</span>
                  : (
                    <button className="set-date-link" onClick={() => onEditClient(c)}>Set</button>
                  )}
              </td>
              <td>
                {c.start_date
                  ? <span className="cs-date">{fmtISODateShort(c.start_date)}</span>
                  : (
                    <button className="set-date-link" onClick={() => onEditClient(c)}>Set date</button>
                  )}
              </td>
              <td>
                <span className={c.last_lead_activity_at ? 'cs-muted' : 'cs-none'}>
                  {humanizeAgo(c.last_lead_activity_at, now)}
                </span>
              </td>
              <td className="cs-num">
                {c.stagnant_intros_count > 0
                  ? <span className="cs-count">{c.stagnant_intros_count}</span>
                  : <span className="cs-none">—</span>}
              </td>
              <td className="cs-num">
                {hiredTotal > 0
                  ? <span className="cs-count">{hiredTotal}</span>
                  : <span className="cs-none">—</span>}
              </td>
              <td>
                <span className={lastHireAt ? 'cs-muted' : 'cs-none'}>
                  {humanizeAgo(lastHireAt, now)}
                </span>
              </td>
              <td className="cs-num">
                {c.dnc_count > 0
                  ? <span className="cs-count">{c.dnc_count.toLocaleString()}</span>
                  : <span className="cs-none">—</span>}
              </td>
              <td className="cs-num">
                {c.agents_count > 0
                  ? <span className="cs-count">{c.agents_count.toLocaleString()}</span>
                  : <span className="cs-none">—</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SummaryCard({
  label,
  cls,
  num,
  sub,
}: {
  label: string;
  cls: string;
  num: number | string;
  sub: string;
}) {
  return (
    <div className="summary-card">
      <div className="summary-label">{label}</div>
      <div className={`summary-num ${cls}`}>{num}</div>
      <div className="summary-sub">{sub}</div>
    </div>
  );
}

// Avg-based color rule for the per-row Conv. Rate cell.
// > 3 = green, 1-3 AND ≥ avg = orange, everything else = red.
function convClassFor(pct: number | null, avg: number): 'good' | 'mid' | 'low' | 'none' {
  if (pct === null) return 'none';
  if (pct > 3) return 'good';
  if (pct >= 1 && pct >= avg) return 'mid';
  return 'low';
}

function ClientRow({
  client,
  weekKey: wk,
  campaignSelection,
  convAvg,
  onCampaignChange,
  onShowCampaigns,
  onEdit,
  onDelete,
  onToggleHidden,
  onToggleClientPaused,
}: {
  client: DashboardClient;
  weekKey: string;
  campaignSelection: string;
  convAvg: number;
  onCampaignChange: (id: string) => void;
  onShowCampaigns: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleClientPaused: (paused: boolean) => void;
  onToggleHidden: (hidden: boolean) => void;
}) {
  const d = derive(client, wk);
  // Per spec, the dashboard only reflects ACTIVE (running) campaigns:
  // count, dropdown options, and the "all campaigns (avg)" rollup all
  // exclude paused/finished campaigns. Union across Instantly + Bison sources.
  const activeCampaigns: (InstantlyCampaign | BisonCampaign)[] = [
    ...client.campaigns.filter((c) => c.status === 'running'),
    ...client.bisonCampaigns.filter((c) => c.status === 'running'),
  ];

  // today's emails (EST). Treat the stored value as 0 if the date doesn't
  // match today's EST date — guards against showing yesterday's number after
  // midnight rollover but before the next sync tick.
  const todayET = todayInET();
  const todayEmails = client.emails_today_date === todayET ? client.emails_today : 0;
  const todayCell = todayEmails > 0 ? (
    <span className="api-num">{todayEmails.toLocaleString()}</span>
  ) : (
    <span className="api-none">—</span>
  );

  // intros cell — read-only number from MasterInbox
  const introClass = client.weekly_target === 0 ? '' : d.metTarget ? 'ok' : 'risk';
  const introsCell = (
    <input
      type="number"
      readOnly
      className={`metric-input ${introClass}`}
      value={d.intros}
    />
  );

  // monthly progress — X / Y where X = intros_this_month, Y = monthly_target.
  // Rendered as an X/Y pill with the same tier coloring the Bi-Weekly view uses
  // (green when at or above target, orange at ≥ half, red below half). Missing
  // target (0) renders as a muted em-dash so unset clients don't clutter the row.
  const monthlyCell = client.monthly_target === 0 ? (
    <span className="api-none">—</span>
  ) : (
    <span className={
      client.intros_this_month >= client.monthly_target ? 'bw-done'
      : client.intros_this_month >= Math.ceil(client.monthly_target / 2) ? 'bw-mid'
      : 'bw-short'
    }>
      {client.intros_this_month}/{client.monthly_target}
    </span>
  );

  // Time-zone short code for the Weekly view — reuses TZ_SHORT_BY_VALUE
  // (already used by the Bi-Weekly view + Client Success tab).
  const tzShortWeekly = client.time_zone ? (TZ_SHORT_BY_VALUE[client.time_zone] ?? client.time_zone) : null;

  // Next + last billing date — same computations the Bi-Weekly view uses.
  // When no anchor + no start_date the date can't be derived; renders a
  // "Set" button that opens the Edit modal so it can be filled in one click.
  const fmtMDY = (d: Date) =>
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
  const now_ = new Date();
  const anchor_ = client.billing_anchor_date ?? client.start_date;
  const lastBillingD = lastBillingDate(anchor_, client.billing_interval, now_, client.billing_interval_days);
  const billingDate = nextBillingDate(anchor_, client.billing_interval, now_, client.billing_interval_days);
  const lastBillingCell = lastBillingD ? (
    <span className="cs-date">{fmtMDY(lastBillingD)}</span>
  ) : (
    <span className="api-none">—</span>
  );
  const billingCell = billingDate ? (
    <span className="cs-date">{fmtMDY(billingDate)}</span>
  ) : (
    <button className="set-date-link" onClick={onEdit}>Set billing date</button>
  );

  // Days until next billing — same math the Bi-Weekly view uses. Urgent
  // (≤ 3 days) gets the red days-urgent style; further out is plain.
  const billingDays = billingDate ? daysUntil(billingDate, new Date()) : null;
  const billingDaysCell = billingDays === null ? (
    <span className="api-none">—</span>
  ) : (
    <span className={billingDays <= 3 ? 'days-urgent' : ''}>
      {billingDays} day{billingDays === 1 ? '' : 's'}
    </span>
  );

  // interested cell — all-time count across every weekly_metrics row this
  // client has (sums interested_corofy across the loaded HISTORICAL_WEEKS window).
  const interestedAllTime = Object.values(client.metricsByWeek).reduce(
    (sum, m) => sum + (m.interested_corofy ?? 0),
    0,
  );
  const interestedCell = (
    <input
      type="number"
      readOnly
      className="metric-input"
      value={interestedAllTime}
    />
  );

  // Funnel: converted = sum of intros_corofy (every intro was previously interested
  // — labels are mutually exclusive on Corofy's side). Rate = converted / (converted
  // + still-interested). Null when no funnel has been entered yet.
  const convertedCount = Object.values(client.metricsByWeek).reduce(
    (sum, m) => sum + (m.intros_corofy ?? 0),
    0,
  );
  const totalFunnel = convertedCount + interestedAllTime;
  const convRatePct = totalFunnel > 0 ? (convertedCount / totalFunnel) * 100 : null;
  const convertedCell = (
    <input type="number" readOnly className="metric-input" value={convertedCount} />
  );
  const convRateCell =
    convRatePct === null ? (
      <span className="api-none">—</span>
    ) : (
      <span className="api-num">{convRatePct.toFixed(1)}%</span>
    );

  // conv cell — intros per 1k emails, colored against the dashboard avg
  const convCls = convClassFor(d.convPct, convAvg);
  const convCell =
    d.convPct === null ? (
      <span className="conv-rate conv-none">—</span>
    ) : (
      <span className={`conv-rate conv-${convCls}`}>{d.convPct.toFixed(1)}%</span>
    );

  // left cell — gray "0" once the weekly target is met
  const leftCell =
    client.weekly_target === 0 ? (
      <span className="left-none">—</span>
    ) : d.metTarget ? (
      <span className="left-zero">0</span>
    ) : (
      <span className="left-pill left-short">{d.leftThisWeek} left</span>
    );

  // status badge — Done supersedes On Track when target is met
  const statusCell =
    d.status === 'pending' ? (
      <span className="status-badge s-pending"><span className="status-dot" />Pending</span>
    ) : d.status === 'risk' ? (
      <span className="status-badge s-risk"><span className="status-dot" />At Risk</span>
    ) : d.status === 'done' ? (
      <span className="status-badge s-done"><span className="status-dot" />Done</span>
    ) : (
      <span className="status-badge s-ok"><span className="status-dot" />On Track</span>
    );

  // campaign cell — dropdown selector + bar (active campaigns only)
  let campaignCell: React.ReactNode;
  if (activeCampaigns.length === 0) {
    campaignCell = <span className="api-none">—</span>;
  } else {
    const selected =
      campaignSelection === '__avg__'
        ? null
        : activeCampaigns.find((c) => c.id === campaignSelection) ?? null;

    const sent = selected
      ? selected.emails_sent_total
      : activeCampaigns.reduce((a, b) => a + b.emails_sent_total, 0);

    // X / Y in the cell = completed leads / total leads. campaign_size is the
    // total (leads_count from Instantly); completed is back-computed from the
    // stored progress_pct. Two-decimal precision in DB keeps this exact.
    const totalLeads = selected
      ? selected.campaign_size
      : activeCampaigns.reduce((a, b) => a + b.campaign_size, 0);
    const completedLeads = selected
      ? Math.round(selected.campaign_size * (selected.progress_pct / 100))
      : activeCampaigns.reduce(
          (a, b) => a + Math.round(b.campaign_size * (b.progress_pct / 100)),
          0,
        );
    // Weighted % across multiple campaigns — sum-of-completed / sum-of-leads,
    // not the simple average of per-campaign rates (which would over-weight
    // small campaigns).
    const pct = selected
      ? selected.progress_pct
      : totalLeads > 0
        ? (completedLeads / totalLeads) * 100
        : 0;

    campaignCell = (
      <div className="monthly-cell">
        {activeCampaigns.length > 1 && (
          <select
            className="campaign-select"
            value={campaignSelection}
            onChange={(e) => onCampaignChange(e.target.value)}
          >
            <option value="__avg__">All active (avg)</option>
            {activeCampaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        <div className="monthly-label">
          <span className="monthly-count">
            {completedLeads.toLocaleString()} / {totalLeads.toLocaleString()}
          </span>
          <span className="monthly-pct">{Math.round(pct)}%</span>
        </div>
        <div className="progress-track">
          <div className="progress-fill pf-active" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        <div className="campaign-tag ct-active">
          <span className="ct-dot" />
          {sent.toLocaleString()} sent · Running
        </div>
      </div>
    );
  }

  // last intro cell
  // 2-bucket coloring: 0-5 days = green, > 5 = orange.
  let lastIntroCell: React.ReactNode;
  if (d.daysSince === null) {
    lastIntroCell = <span className="last-intro li-none">No data</span>;
  } else if (d.daysSince === 0) {
    lastIntroCell = <span className="last-intro li-fresh">Today</span>;
  } else if (d.daysSince === 1) {
    lastIntroCell = <span className="last-intro li-fresh">Yesterday</span>;
  } else if (d.daysSince <= 5) {
    lastIntroCell = <span className="last-intro li-fresh">{d.daysSince}d ago</span>;
  } else {
    lastIntroCell = <span className="last-intro li-stale-orange">{d.daysSince}d ago</span>;
  }

  // Per spec, the dashboard only counts ACTIVE campaigns under each client.
  const campsCount = activeCampaigns.length;
  // When no campaign is running, split the empty-state label by whether any
  // campaign was ever launched. Paused or finished → "Campaign Paused".
  // Only draft / nothing linked → "Not Active".
  const hasLaunched =
    client.campaigns.some((c) => c.status === 'paused' || c.status === 'finished') ||
    client.bisonCampaigns.some((c) => c.status === 'paused' || c.status === 'finished');
  const campsLabel =
    campsCount > 0
      ? campsCount === 1
        ? '1 active campaign'
        : `${campsCount} active campaigns`
      : hasLaunched
        ? 'Campaign Paused'
        : 'Not Active';

  const since = client.start_date
    ? new Date(client.start_date).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  const rowCls = client.hidden ? 'is-hidden' : client.client_paused ? 'is-client-paused' : '';
  return (
    <tr className={rowCls}>
      <td className="client-cell">
        <div className="client-name">
          {client.name}
          {client.portal_url && (
            <a
              className="portal-link"
              href={client.portal_url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open client portal in Corofy"
              onClick={(e) => e.stopPropagation()}
            >↗</a>
          )}
          {client.hidden && <span className="hidden-badge">Churned</span>}
          {!client.hidden && client.client_paused && (
            <span className="client-paused-badge">Client Paused</span>
          )}
        </div>
        {since && <div className="client-since">Since {since}</div>}
        <div
          className={
            'client-meta'
            + (campsCount === 0 ? ' is-empty' : '')
            + (campsCount === 0 ? (hasLaunched ? ' is-paused-camp' : ' is-not-launched') : '')
          }
          onClick={campsCount > 0 ? onShowCampaigns : undefined}
          role={campsCount > 0 ? 'button' : undefined}
          aria-label={
            campsCount > 0
              ? `View ${campsCount} active campaign${campsCount === 1 ? '' : 's'}`
              : campsLabel
          }
        >
          {campsCount > 0 && <span className="client-meta-dot" />}
          <span>{campsLabel}</span>
          {campsCount > 0 && <span className="client-meta-arrow">›</span>}
        </div>
      </td>
      <td>
        {tzShortWeekly
          ? <span className="cs-tz">{tzShortWeekly}</span>
          : <span className="api-none">—</span>}
      </td>
      <td>{monthlyCell}</td>
      <td>{lastIntroCell}</td>
      <td>{lastBillingCell}</td>
      <td>{billingCell}</td>
      <td>{billingDaysCell}</td>
      <td>{todayCell}</td>
      <td>{introsCell}</td>
      <td>{convCell}</td>
      <td>{leftCell}</td>
      <td>{campaignCell}</td>
      <td>{statusCell}</td>
      <td>{interestedCell}</td>
      <td>{convertedCell}</td>
      <td>{convRateCell}</td>
      <td><span className={`plan-badge ${PLAN_BADGE_CLASS[client.plan]}`}>{PLAN_LABEL[client.plan]}</span></td>
      <td>
        {client.portalActive
          ? <span className="portal-ok" title="Portal active in Corofy / MasterInbox">✓</span>
          : <span className="portal-none" title="Not in Corofy portals (or portal disabled)">—</span>}
      </td>
      <td>
        <div className="actions">
          <button className="btn-icon" title="Edit" onClick={onEdit}>✏️</button>
          <button
            className="btn-icon"
            title={client.client_paused ? 'Resume client' : 'Pause client'}
            onClick={() => onToggleClientPaused(!client.client_paused)}
          >
            {client.client_paused ? '▶' : '⏸'}
          </button>
          <button
            className="btn-icon"
            title={client.hidden ? 'Unhide client' : 'Hide client'}
            onClick={() => onToggleHidden(!client.hidden)}
          >
            {client.hidden ? '👁' : '🙈'}
          </button>
          <button className="btn-icon del" title="Remove" onClick={onDelete}>🗑</button>
        </div>
      </td>
    </tr>
  );
}
