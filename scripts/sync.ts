// Sync worker: pulls fresh data from Instantly + EmailBison + MasterInbox,
// upserts into Supabase. Backfills the last N weeks of weekly_metrics so the
// dashboard can navigate historical weeks without hitting the third-party APIs
// again.

import { getSupabase } from '../lib/supabase';
import {
  campaignSize,
  dailyAnalytics,
  listAnalytics,
  listCampaigns,
  mapStatus,
  progressPct,
} from '../lib/instantly';
import {
  bisonCampaignSize,
  bisonDailySent,
  bisonProgressPct,
  listBisonCampaigns,
  mapBisonStatus,
} from '../lib/bison';
import { addDays, getMondayOf, normalizeName, todayInET, weekKey } from '../lib/derive';
import { listCorofyIntros } from '../lib/corofy';
import { listCorofyPortals } from '../lib/portals';
import { autoMatchCampaignIds } from '../lib/matchCampaigns';
import { HISTORICAL_WEEKS } from '../lib/types';

interface SyncResult {
  instantly: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number };
  bison: { ok: boolean; error?: string; campaigns?: number; weeksBackfilled?: number; skipped?: boolean };
  corofy: {
    ok: boolean;
    error?: string;
    intros?: number;
    interested?: number;     // count of "Interested"-labeled rows fetched
    skipped?: boolean;
    unmatched?: string[];
    portalsMatched?: number; // # clients flipped to portal_active=true
  };
}


// Per-cron-run state for today's email rollup. runInstantly + runBison
// populate these per-campaign maps during their daily-data loops; runSync
// reads them after both finish and writes clients.emails_today.
let todayInstantlyByCampaign: Map<string, number> = new Map();
let todayBisonByCampaign: Map<string, number> = new Map();
let todayET = '';

export async function runSync(): Promise<SyncResult> {
  // Reset module-level today's-emails state for this run.
  todayInstantlyByCampaign = new Map();
  todayBisonByCampaign = new Map();
  todayET = todayInET();
  const result: SyncResult = {
    instantly: { ok: false },
    bison: { ok: false },
    corofy: { ok: false },
  };
  result.instantly = await runInstantly();
  result.bison = await runBison();
  result.corofy = await runCorofy();
  await updateClientsTodayEmails().catch((e) =>
    console.warn(`[today-emails] writeback failed: ${(e as Error).message}`),
  );
  return result;
}

async function updateClientsTodayEmails(): Promise<void> {
  const sb = getSupabase();
  const { data: clients } = await sb
    .from('clients')
    .select('id, instantly_campaign_ids, bison_campaign_ids');
  if (!clients) return;
  let written = 0;
  for (const c of clients as { id: string; instantly_campaign_ids: string[]; bison_campaign_ids: string[] }[]) {
    let total = 0;
    for (const cid of c.instantly_campaign_ids ?? []) total += todayInstantlyByCampaign.get(cid) ?? 0;
    for (const cid of c.bison_campaign_ids ?? []) total += todayBisonByCampaign.get(cid) ?? 0;
    const { error } = await sb
      .from('clients')
      .update({ emails_today: total, emails_today_date: todayET })
      .eq('id', c.id);
    if (!error) written++;
  }
  console.warn(`[today-emails] ${todayET}: wrote ${written}/${clients.length} clients`);
}

// All ISO Mondays for the visible window, oldest → newest.
function backfillWindow(): { mondayKeys: string[]; rangeStart: string; rangeEnd: string } {
  const today = new Date();
  const thisMonday = getMondayOf(today);
  const earliest = addDays(thisMonday, -7 * (HISTORICAL_WEEKS - 1));
  const mondayKeys: string[] = [];
  for (let i = 0; i < HISTORICAL_WEEKS; i++) {
    mondayKeys.push(weekKey(addDays(earliest, 7 * i)));
  }
  const rangeStart = weekKey(earliest);
  // End of current week: next Monday minus 1 day = Sunday.
  const rangeEnd = addDays(thisMonday, 6).toISOString().split('T')[0];
  return { mondayKeys, rangeStart, rangeEnd };
}

// Decide the new status_changed_at value for a campaign. Returns undefined to
// mean "leave the existing DB value alone" (no field in the upsert payload).
//
//   1. Real transition observed (prev status differs from new) → now()
//   2. Status is paused/finished AND no stamp on file yet → seed from the
//      vendor's updated_at. Covers both "first time we see this campaign" AND
//      "existing row from before the migration added status_changed_at".
//   3. Otherwise → undefined (preserve current value).
function deriveStatusChangedAt(
  newStatus: 'running' | 'paused' | 'finished' | null,
  prevStatus: string | null | undefined,
  prevStatusChangedAt: string | null | undefined,
  apiUpdatedAt: string | null | undefined
): string | null | undefined {
  const prev = prevStatus ?? null;
  const next = newStatus ?? null;
  const isTransition = prevStatus !== undefined && prev !== next;
  if (isTransition) return new Date().toISOString();
  if ((next === 'paused' || next === 'finished') && !prevStatusChangedAt) {
    return apiUpdatedAt ?? new Date().toISOString();
  }
  return undefined;
}

async function runInstantly(): Promise<SyncResult['instantly']> {
  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'instantly' })
    .select('id')
    .single();

  try {
    const [campaigns, analytics] = await Promise.all([listCampaigns(), listAnalytics()]);
    const analyticsById = new Map(analytics.map((a) => [a.campaign_id, a]));

    // Load existing rows to detect status transitions.
    const { data: existingRows } = await sb
      .from('instantly_campaigns')
      .select('id, status, status_changed_at');
    const existingById = new Map<string, { status: string | null; status_changed_at: string | null }>(
      ((existingRows ?? []) as { id: string; status: string | null; status_changed_at: string | null }[]).map(
        (r) => [r.id, { status: r.status, status_changed_at: r.status_changed_at }]
      )
    );

    const campaignRows = campaigns.map((c) => {
      const a = analyticsById.get(c.id);
      const newStatus = mapStatus(c.status ?? a?.campaign_status);
      const prev = existingById.get(c.id);
      const stamp = deriveStatusChangedAt(
        newStatus,
        prev ? prev.status : undefined,
        prev?.status_changed_at,
        c.timestamp_updated
      );
      const base: {
        id: string;
        name: string;
        status: ReturnType<typeof mapStatus>;
        emails_sent_total: number;
        campaign_size: number;
        progress_pct: number;
        status_changed_at?: string | null;
      } = {
        id: c.id,
        name: c.name,
        status: newStatus,
        emails_sent_total: a?.emails_sent_count ?? 0,
        campaign_size: a ? campaignSize(a) : 0,
        progress_pct: a ? Number(progressPct(a).toFixed(2)) : 0,
      };
      // Only include status_changed_at in the upsert payload when we actually
      // want to write it (undefined means "leave existing value alone").
      if (stamp !== undefined) base.status_changed_at = stamp;
      return base;
    });
    if (campaignRows.length > 0) {
      const { error } = await sb.from('instantly_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // AUTO-RELINK every client to its matching campaigns on every sync.
    const namedCampaigns = campaigns.map((c) => ({ id: c.id, name: c.name }));
    const { data: clientsForRelink } = await sb
      .from('clients')
      .select('id, name, instantly_campaign_ids');
    if (clientsForRelink) {
      for (const c of clientsForRelink as { id: string; name: string; instantly_campaign_ids: string[] }[]) {
        const expected = autoMatchCampaignIds(c.name, namedCampaigns).sort();
        const current = [...(c.instantly_campaign_ids ?? [])].sort();
        const same = expected.length === current.length && expected.every((id, i) => id === current[i]);
        if (!same) {
          await sb.from('clients').update({ instantly_campaign_ids: expected }).eq('id', c.id);
        }
      }
    }

    const { mondayKeys, rangeStart, rangeEnd } = backfillWindow();

    const { data: clients } = await sb
      .from('clients')
      .select('id, instantly_campaign_ids');
    if (!clients) {
      await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
      return { ok: true, campaigns: campaignRows.length, weeksBackfilled: 0 };
    }

    // Collect all unique campaign ids referenced by clients.
    const linkedIds = new Set<string>();
    for (const c of clients as { instantly_campaign_ids: string[] }[]) {
      (c.instantly_campaign_ids ?? []).forEach((id) => linkedIds.add(id));
    }

    // campaignId -> weekKey -> sent
    const campaignWeekly = new Map<string, Map<string, number>>();
    for (const cid of linkedIds) {
      try {
        const days = await dailyAnalytics(cid, rangeStart, rangeEnd);
        const buckets = new Map<string, number>();
        for (const d of days) {
          if (!d.date) continue;
          const wk = weekKey(d.date);
          buckets.set(wk, (buckets.get(wk) ?? 0) + (d.sent ?? 0));
          // Capture today's-only count for the per-client "Today" rollup.
          if (d.date === todayET) {
            todayInstantlyByCampaign.set(
              cid,
              (todayInstantlyByCampaign.get(cid) ?? 0) + (d.sent ?? 0),
            );
          }
        }
        campaignWeekly.set(cid, buckets);
      } catch (err) {
        console.warn(`daily-analytics failed for ${cid}:`, (err as Error).message);
        campaignWeekly.set(cid, new Map());
      }
    }

    // For each client × each week, sum across linked Instantly campaigns and upsert.
    // NOTE: emails_sent here is the Instantly subtotal. runBison() ADDs to this
    // row in a second upsert (read-modify-write) so the final value is the
    // combined cross-source total.
    const upserts: { client_id: string; week_key: string; emails_sent: number }[] = [];
    for (const c of clients as { id: string; instantly_campaign_ids: string[] }[]) {
      for (const wk of mondayKeys) {
        let total = 0;
        for (const cid of c.instantly_campaign_ids ?? []) {
          total += campaignWeekly.get(cid)?.get(wk) ?? 0;
        }
        upserts.push({ client_id: c.id, week_key: wk, emails_sent: total });
      }
    }

    if (upserts.length > 0) {
      const { error } = await sb
        .from('weekly_metrics')
        .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }

    await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
    return { ok: true, campaigns: campaignRows.length, weeksBackfilled: mondayKeys.length };
  } catch (err) {
    const message = (err as Error).message;
    await sb
      .from('sync_runs')
      .update({ ok: false, error: message, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: false, error: message };
  }
}

async function runBison(): Promise<SyncResult['bison']> {
  if (!process.env.BISON_API_KEY) return { ok: true, skipped: true };

  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'bison' })
    .select('id')
    .single();

  try {
    const campaigns = await listBisonCampaigns();

    // Load existing rows to detect status transitions.
    const { data: existingRows } = await sb
      .from('bison_campaigns')
      .select('id, status, status_changed_at');
    const existingById = new Map<string, { status: string | null; status_changed_at: string | null }>(
      ((existingRows ?? []) as { id: string; status: string | null; status_changed_at: string | null }[]).map(
        (r) => [r.id, { status: r.status, status_changed_at: r.status_changed_at }]
      )
    );

    const campaignRows = campaigns.map((c) => {
      const newStatus = mapBisonStatus(c.status);
      const prev = existingById.get(c.uuid);
      const stamp = deriveStatusChangedAt(
        newStatus,
        prev ? prev.status : undefined,
        prev?.status_changed_at,
        c.updated_at
      );
      const base: {
        id: string;
        int_id: number;
        name: string;
        status: ReturnType<typeof mapBisonStatus>;
        emails_sent_total: number;
        campaign_size: number;
        progress_pct: number;
        status_changed_at?: string | null;
      } = {
        id: c.uuid,
        int_id: c.id, // Bison's integer id — needed for per-campaign endpoints
        name: c.name,
        status: newStatus,
        emails_sent_total: c.emails_sent ?? 0,
        campaign_size: bisonCampaignSize(c),
        progress_pct: Number(bisonProgressPct(c).toFixed(2)),
      };
      if (stamp !== undefined) base.status_changed_at = stamp;
      return base;
    });
    if (campaignRows.length > 0) {
      const { error } = await sb.from('bison_campaigns').upsert(campaignRows);
      if (error) throw new Error(error.message);
    }

    // Auto-relink Bison campaigns to clients using the same whole-name match.
    const namedCampaigns = campaigns.map((c) => ({ id: c.uuid, name: c.name }));
    const { data: clientsForRelink } = await sb
      .from('clients')
      .select('id, name, bison_campaign_ids');
    if (clientsForRelink) {
      for (const c of clientsForRelink as { id: string; name: string; bison_campaign_ids: string[] }[]) {
        const expected = autoMatchCampaignIds(c.name, namedCampaigns).sort();
        const current = [...(c.bison_campaign_ids ?? [])].sort();
        const same = expected.length === current.length && expected.every((id, i) => id === current[i]);
        if (!same) {
          await sb.from('clients').update({ bison_campaign_ids: expected }).eq('id', c.id);
        }
      }
    }

    const { mondayKeys, rangeStart, rangeEnd } = backfillWindow();

    const { data: clients } = await sb
      .from('clients')
      .select('id, bison_campaign_ids');
    if (!clients) {
      await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
      return { ok: true, campaigns: campaignRows.length, weeksBackfilled: 0 };
    }

    const linkedIds = new Set<string>();
    for (const c of clients as { bison_campaign_ids: string[] }[]) {
      (c.bison_campaign_ids ?? []).forEach((id) => linkedIds.add(id));
    }

    // uuid → integer id (from the list response); Bison's per-campaign
    // endpoints reject UUIDs, so we use the int id when calling them.
    const intIdByUuid = new Map<string, number>(campaigns.map((c) => [c.uuid, c.id]));

    const campaignWeekly = new Map<string, Map<string, number>>();
    for (const cid of linkedIds) {
      const intId = intIdByUuid.get(cid);
      if (intId === undefined) {
        console.warn(`bison int id missing for ${cid} — skipping per-day fetch`);
        continue;
      }
      try {
        const days = await bisonDailySent(intId, rangeStart, rangeEnd);
        const buckets = new Map<string, number>();
        for (const d of days) {
          if (!d.date) continue;
          const wk = weekKey(d.date);
          buckets.set(wk, (buckets.get(wk) ?? 0) + (d.sent ?? 0));
          if (d.date === todayET) {
            todayBisonByCampaign.set(
              cid,
              (todayBisonByCampaign.get(cid) ?? 0) + (d.sent ?? 0),
            );
          }
        }
        campaignWeekly.set(cid, buckets);
      } catch (err) {
        console.warn(`bison daily-sent failed for ${cid} (int_id=${intId}):`, (err as Error).message);
        campaignWeekly.set(cid, new Map());
      }
    }

    // Read existing weekly_metrics rows so we can ADD Bison sent on top of the
    // Instantly subtotal that runInstantly already wrote. Avoids the two
    // sources clobbering each other.
    const earliestKey = mondayKeys[0];
    const { data: existingMetrics } = await sb
      .from('weekly_metrics')
      .select('client_id, week_key, emails_sent')
      .gte('week_key', earliestKey);
    const existingByKey = new Map<string, number>();
    for (const m of (existingMetrics ?? []) as { client_id: string; week_key: string; emails_sent: number }[]) {
      existingByKey.set(`${m.client_id}|${m.week_key}`, m.emails_sent ?? 0);
    }

    const upserts: { client_id: string; week_key: string; emails_sent: number }[] = [];
    for (const c of clients as { id: string; bison_campaign_ids: string[] }[]) {
      for (const wk of mondayKeys) {
        let bisonTotal = 0;
        for (const cid of c.bison_campaign_ids ?? []) {
          bisonTotal += campaignWeekly.get(cid)?.get(wk) ?? 0;
        }
        if (bisonTotal === 0) continue; // nothing to add for this cell
        const prev = existingByKey.get(`${c.id}|${wk}`) ?? 0;
        upserts.push({ client_id: c.id, week_key: wk, emails_sent: prev + bisonTotal });
      }
    }

    if (upserts.length > 0) {
      const { error } = await sb
        .from('weekly_metrics')
        .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
      if (error) throw new Error(error.message);
    }

    await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
    return { ok: true, campaigns: campaignRows.length, weeksBackfilled: mondayKeys.length };
  } catch (err) {
    const message = (err as Error).message;
    await sb
      .from('sync_runs')
      .update({ ok: false, error: message, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: false, error: message };
  }
}

async function runCorofy(): Promise<SyncResult['corofy']> {
  if (!process.env.COROFY_ADMIN_TOKEN || !process.env.COROFY_BASE_URL) {
    return { ok: true, skipped: true };
  }

  const sb = getSupabase();
  const { data: run } = await sb
    .from('sync_runs')
    .insert({ source: 'corofy' })
    .select('id')
    .single();

  try {
    const intros = await listCorofyIntros();
    const { mondayKeys } = backfillWindow();
    const validWeekSet = new Set(mondayKeys);


    // Bucket by (normalized client_name, week_key). Normalization collapses
    // punctuation/whitespace drift so "C21 Results - Elite Team" (Corofy) maps
    // to "C21 Results Elite Team" (our clients.name).
    const byNameWeek = new Map<string, { count: number; latest: number }>();
    const allTimeLatestByName = new Map<string, number>();
    const seenOriginalByNormalized = new Map<string, string>();

    for (const i of intros) {
      const t = new Date(i.assigned_at).getTime();
      if (!Number.isFinite(t)) continue;
      const normKey = normalizeName(i.client_name);
      if (!seenOriginalByNormalized.has(normKey)) {
        seenOriginalByNormalized.set(normKey, i.client_name);
      }
      if ((allTimeLatestByName.get(normKey) ?? 0) < t) allTimeLatestByName.set(normKey, t);

      const wk = weekKey(new Date(t));
      if (!validWeekSet.has(wk)) continue;
      const k = `${normKey}|${wk}`;
      const cur = byNameWeek.get(k) ?? { count: 0, latest: 0 };
      cur.count++;
      if (t > cur.latest) cur.latest = t;
      byNameWeek.set(k, cur);
    }

    const { data: clients } = await sb.from('clients').select('id, name');
    const matchedNormalized = new Set<string>();
    if (clients) {
      const upserts: {
        client_id: string;
        week_key: string;
        intros_corofy: number;
        last_corofy_intro_at: string | null;
      }[] = [];
      for (const c of clients as { id: string; name: string }[]) {
        const normKey = normalizeName(c.name);
        if (seenOriginalByNormalized.has(normKey)) matchedNormalized.add(normKey);
        const allTime = allTimeLatestByName.get(normKey) ?? 0;
        for (const wk of mondayKeys) {
          const stats = byNameWeek.get(`${normKey}|${wk}`);
          const count = stats?.count ?? 0;
          const latest = stats?.latest ?? 0;
          const ts = latest > 0 ? latest : allTime;
          // Always emit so weeks with no current intros are reset to 0 (otherwise
          // a deletion on the Corofy side would never clear our cached count).
          upserts.push({
            client_id: c.id,
            week_key: wk,
            intros_corofy: count,
            last_corofy_intro_at: ts > 0 ? new Date(ts).toISOString() : null,
          });
        }
      }
      if (upserts.length > 0) {
        const { error } = await sb
          .from('weekly_metrics')
          .upsert(upserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
        if (error) throw new Error(error.message);
      }
    }

    // Surface ORIGINAL Corofy names (not normalized) so the warning is human-readable.
    const unmatched = [...seenOriginalByNormalized.entries()]
      .filter(([norm]) => !matchedNormalized.has(norm))
      .map(([, original]) => original);
    if (unmatched.length > 0) {
      console.warn(
        `[corofy] ${unmatched.length} client name(s) from Corofy did not match any clients.name: ${unmatched.join(', ')}`
      );
    }

    // Now do the same thing for the "Interested" label and write
    // interested_corofy / last_interested_at on the same weekly_metrics rows.
    // Failures here are non-fatal: log and continue (Introduction data already
    // written; portal sync still runs).
    let interestedTotal = 0;
    try {
      const interestedRows = await listCorofyIntros('Interested');
      interestedTotal = interestedRows.length;
      const byNameWeekI = new Map<string, { count: number; latest: number }>();
      const allTimeLatestI = new Map<string, number>();
      for (const i of interestedRows) {
        const t = new Date(i.assigned_at).getTime();
        if (!Number.isFinite(t)) continue;
        const normKey = normalizeName(i.client_name);
        if ((allTimeLatestI.get(normKey) ?? 0) < t) allTimeLatestI.set(normKey, t);
        const wk = weekKey(new Date(t));
        if (!validWeekSet.has(wk)) continue;
        const k = `${normKey}|${wk}`;
        const cur = byNameWeekI.get(k) ?? { count: 0, latest: 0 };
        cur.count++;
        if (t > cur.latest) cur.latest = t;
        byNameWeekI.set(k, cur);
      }
      if (clients) {
        const interestedUpserts: {
          client_id: string;
          week_key: string;
          interested_corofy: number;
          last_interested_at: string | null;
        }[] = [];
        for (const c of clients as { id: string; name: string }[]) {
          const normKey = normalizeName(c.name);
          const allTime = allTimeLatestI.get(normKey) ?? 0;
          for (const wk of mondayKeys) {
            const stats = byNameWeekI.get(`${normKey}|${wk}`);
            const count = stats?.count ?? 0;
            const latest = stats?.latest ?? 0;
            const ts = latest > 0 ? latest : allTime;
            interestedUpserts.push({
              client_id: c.id,
              week_key: wk,
              interested_corofy: count,
              last_interested_at: ts > 0 ? new Date(ts).toISOString() : null,
            });
          }
        }
        if (interestedUpserts.length > 0) {
          const { error } = await sb
            .from('weekly_metrics')
            .upsert(interestedUpserts, { onConflict: 'client_id,week_key', ignoreDuplicates: false });
          if (error) console.warn(`[corofy] interested upsert failed: ${error.message}`);
        }
      }
      console.warn(`[corofy] Interested rows bucketed: ${interestedTotal}`);
    } catch (e) {
      console.warn(`[corofy] Interested fetch failed: ${(e as Error).message}`);
    }

    // Piggyback portal sync on the same cron tick. Corofy's /api/clients/portals
    // is only reachable from sync-worker's Railway edge (the web service gets
    // 307 → /login), so we fetch + persist here. Failures are non-fatal: we
    // log and keep the existing portal_active values.
    let portalsMatched = 0;
    try {
      const portals = await listCorofyPortals();
      if (portals.length > 0) {
        const activeNames = new Set<string>();
        for (const p of portals) {
          if (p.portal_enabled) {
            activeNames.add(normalizeName(p.name));
            for (const a of p.aliases ?? []) activeNames.add(normalizeName(a));
          }
        }
        const { data: allClients } = await sb.from('clients').select('id, name');
        const now = new Date().toISOString();
        // Use .update() per row instead of .upsert() — Supabase upsert validates
        // each row as a candidate INSERT, which trips clients.name NOT NULL even
        // though every id we have here exists. .update().eq('id', ...) skips
        // the INSERT path entirely.
        let updateErrors = 0;
        for (const c of (allClients ?? []) as { id: string; name: string }[]) {
          const active = activeNames.has(normalizeName(c.name));
          if (active) portalsMatched++;
          const { error } = await sb
            .from('clients')
            .update({ portal_active: active, portal_synced_at: now })
            .eq('id', c.id);
          if (error) {
            updateErrors++;
            if (updateErrors <= 3) {
              console.warn(`[corofy] portal update failed for ${c.name}: ${error.message}`);
            }
          }
        }
        if (updateErrors > 3) {
          console.warn(`[corofy] ...${updateErrors - 3} more portal update errors suppressed`);
        }
        console.warn(`[corofy] portals synced: ${portalsMatched}/${(allClients ?? []).length} clients active (${updateErrors} write errors)`);
      } else {
        console.warn('[corofy] portals fetch returned empty — leaving portal_active values unchanged');
      }
    } catch (e) {
      console.warn(`[corofy] portals sync failed: ${(e as Error).message}`);
    }

    await sb.from('sync_runs').update({ ok: true, finished_at: new Date().toISOString() }).eq('id', run?.id);
    return {
      ok: true,
      intros: intros.length,
      interested: interestedTotal,
      unmatched: unmatched.length > 0 ? unmatched : undefined,
      portalsMatched,
    };
  } catch (err) {
    const message = (err as Error).message;
    await sb
      .from('sync_runs')
      .update({ ok: false, error: message, finished_at: new Date().toISOString() })
      .eq('id', run?.id);
    return { ok: false, error: message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSync()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      // Exit 1 only if EVERY source failed — a single transient hiccup
      // shouldn't crash the cron (the other sources already wrote their
      // data, and the failing one will retry on the next 15-min tick).
      // The JSON output above is the source of truth for diagnostics.
      const anyOk = r.instantly.ok || r.bison.ok || r.corofy.ok;
      if (!anyOk) console.error('All sync sources failed.');
      process.exit(anyOk ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
