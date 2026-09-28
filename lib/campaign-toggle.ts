// Play/Pause every campaign for one client, from the Weekly table.
//
// Campaigns only: a client's status, portal and billing are never touched
// here — that is the separate Paused / Churned lifecycle.
//
// PAUSE acts on every linked campaign that can currently send, and records
// exactly which ones it paused on the client row (toggle_paused_campaigns).
// PLAY resumes only that recorded set. A finished campaign, or one somebody
// paused by hand, is never restarted by this button. That matters because on
// Bison "resume" is not an undo: it queues the campaign to email its
// remaining leads.
//
// Statuses are read LIVE from Instantly and Bison at plan time, not from the
// 15-minute cache, and each campaign reports its own outcome — a fan-out can
// half-succeed, and "5 of 6 paused, 1 failed: <reason>" is the honest answer.

import { getSupabase } from './supabase';
import { activateCampaign, getCampaignStatus, pauseCampaign } from './instantly';
import {
  getBisonCampaignStatus,
  pauseBisonCampaign,
  resumeBisonCampaign,
} from './bison';
import type { ToggledCampaign } from './types';

export type ToggleAction = 'pause' | 'resume';

export interface PlannedCampaign {
  platform: 'instantly' | 'bison';
  id: string;
  int_id: number | null;
  name: string;
  /** Live status word, e.g. "active", "paused", "completed". */
  status: string;
}

export interface TogglePlan {
  clientId: string;
  clientName: string;
  action: ToggleAction;
  willChange: PlannedCampaign[];
  skipped: { campaign: PlannedCampaign; reason: string }[];
}

export interface ToggleOutcome {
  campaign: PlannedCampaign;
  ok: boolean;
  error?: string;
}

const INSTANTLY_WORD: Record<number, string> = { 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed' };
/** States in which a Bison campaign can send (mirrors Analytics' canApply("pause")). */
const BISON_SENDING = new Set(['active', 'queued', 'launching']);

interface ClientRow {
  id: string;
  name: string;
  instantly_campaign_ids: string[] | null;
  bison_campaign_ids: string[] | null;
  toggle_paused_campaigns: ToggledCampaign[] | null;
}

async function loadClient(clientId: string): Promise<ClientRow> {
  const { data, error } = await getSupabase()
    .from('clients')
    .select('id, name, instantly_campaign_ids, bison_campaign_ids, toggle_paused_campaigns')
    .eq('id', clientId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('client not found');
  return data as ClientRow;
}

async function liveStatus(c: Omit<PlannedCampaign, 'status'>): Promise<string> {
  try {
    if (c.platform === 'instantly') {
      const n = await getCampaignStatus(c.id);
      return n === null ? 'unknown' : INSTANTLY_WORD[n] ?? `status ${n}`;
    }
    if (c.int_id == null) return 'unknown';
    return (await getBisonCampaignStatus(c.int_id)) ?? 'unknown';
  } catch (err) {
    const msg = (err as Error).message;
    return / 404/.test(msg) ? 'deleted' : 'unreachable';
  }
}

const isSending = (c: PlannedCampaign) =>
  c.platform === 'instantly' ? c.status === 'active' : BISON_SENDING.has(c.status);

export async function planToggle(clientId: string, action: ToggleAction): Promise<TogglePlan> {
  const client = await loadClient(clientId);
  const sb = getSupabase();

  let candidates: Omit<PlannedCampaign, 'status'>[];
  if (action === 'pause') {
    const instIds = client.instantly_campaign_ids ?? [];
    const bisonIds = client.bison_campaign_ids ?? [];
    const [inst, bison] = await Promise.all([
      instIds.length
        ? sb.from('instantly_campaigns').select('id, name').in('id', instIds)
        : Promise.resolve({ data: [], error: null }),
      bisonIds.length
        ? sb.from('bison_campaigns').select('id, int_id, name').in('id', bisonIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (inst.error) throw new Error(inst.error.message);
    if (bison.error) throw new Error(bison.error.message);
    candidates = [
      ...((inst.data ?? []) as { id: string; name: string }[]).map((c) => ({
        platform: 'instantly' as const, id: c.id, int_id: null, name: c.name,
      })),
      ...((bison.data ?? []) as { id: string; int_id: number | null; name: string }[]).map((c) => ({
        platform: 'bison' as const, id: c.id, int_id: c.int_id, name: c.name,
      })),
    ];
  } else {
    candidates = (client.toggle_paused_campaigns ?? []).map((c) => ({
      platform: c.platform, id: c.id, int_id: c.int_id ?? null, name: c.name,
    }));
  }

  const withStatus: PlannedCampaign[] = await Promise.all(
    candidates.map(async (c) => ({ ...c, status: await liveStatus(c) })),
  );

  const willChange: PlannedCampaign[] = [];
  const skipped: TogglePlan['skipped'] = [];
  for (const c of withStatus) {
    if (action === 'pause') {
      if (isSending(c)) willChange.push(c);
      else
        skipped.push({
          campaign: c,
          reason:
            c.status === 'paused' ? 'already paused'
            : c.status === 'completed' ? 'finished — nothing left to send'
            : c.status === 'draft' ? 'draft — has never sent'
            : c.status === 'deleted' ? 'no longer exists on the platform'
            : c.status === 'unreachable' ? 'platform could not be reached'
            : `status "${c.status}" cannot be paused`,
        });
    } else if (c.status === 'paused') {
      willChange.push(c);
    } else {
      skipped.push({
        campaign: c,
        reason:
          isSending(c) ? 'already running'
          : c.status === 'completed' ? 'finished since it was paused'
          : c.status === 'deleted' ? 'no longer exists on the platform'
          : c.status === 'unreachable' ? 'platform could not be reached'
          : `status "${c.status}" — not resumed`,
      });
    }
  }
  return { clientId, clientName: client.name, action, willChange, skipped };
}

async function applyOne(action: ToggleAction, c: PlannedCampaign): Promise<ToggleOutcome> {
  try {
    if (c.platform === 'instantly') {
      await (action === 'pause' ? pauseCampaign(c.id) : activateCampaign(c.id));
    } else {
      if (c.int_id == null) throw new Error('Bison integer id unknown — run a sync first');
      await (action === 'pause' ? pauseBisonCampaign(c.int_id) : resumeBisonCampaign(c.int_id));
    }
    return { campaign: c, ok: true };
  } catch (err) {
    return { campaign: c, ok: false, error: (err as Error).message };
  }
}

export interface ToggleResult {
  plan: TogglePlan;
  outcomes: ToggleOutcome[];
  /** Campaigns the toggle is still holding paused after this run. */
  heldPaused: number;
}

/**
 * Re-plans from live statuses (never trusts a preview the browser held for a
 * while), applies, records what the toggle now holds paused, refreshes the
 * local campaign cache for the rows it changed, and logs the attempt.
 */
export async function applyToggle(
  clientId: string,
  action: ToggleAction,
  actor: string | null,
): Promise<ToggleResult> {
  const plan = await planToggle(clientId, action);
  const outcomes = await Promise.all(plan.willChange.map((c) => applyOne(action, c)));
  const sb = getSupabase();
  const now = new Date().toISOString();

  const client = await loadClient(clientId);
  const key = (c: { platform: string; id: string }) => `${c.platform}:${c.id}`;
  const held = new Map((client.toggle_paused_campaigns ?? []).map((c) => [key(c), c]));
  if (action === 'pause') {
    for (const o of outcomes) {
      if (!o.ok) continue;
      held.set(key(o.campaign), {
        platform: o.campaign.platform,
        id: o.campaign.id,
        int_id: o.campaign.int_id,
        name: o.campaign.name,
        paused_at: now,
      });
    }
  } else {
    for (const o of outcomes) if (o.ok) held.delete(key(o.campaign));
    // Running, finished or deleted since the toggle paused them: there is
    // nothing left for Play to do, so stop holding them. "Unreachable" stays.
    for (const s of plan.skipped) {
      if (s.campaign.status !== 'unreachable') held.delete(key(s.campaign));
    }
  }
  const heldList = [...held.values()];
  const { error: holdErr } = await sb
    .from('clients')
    .update({ toggle_paused_campaigns: heldList })
    .eq('id', clientId);
  if (holdErr) console.warn(`[campaign-toggle] could not record held campaigns: ${holdErr.message}`);

  // Reflect the change now instead of after the next 15-minute sync.
  const newStatus = action === 'pause' ? 'paused' : 'running';
  for (const o of outcomes) {
    if (!o.ok) continue;
    const table = o.campaign.platform === 'instantly' ? 'instantly_campaigns' : 'bison_campaigns';
    await sb.from(table).update({ status: newStatus, status_changed_at: now }).eq('id', o.campaign.id);
  }

  const { error: logErr } = await sb.from('campaign_toggle_log').insert({
    client_id: clientId,
    client_name: plan.clientName,
    action,
    actor,
    results: {
      changed: outcomes.map((o) => ({
        platform: o.campaign.platform, id: o.campaign.id, name: o.campaign.name,
        ok: o.ok, error: o.error ?? null,
      })),
      skipped: plan.skipped.map((s) => ({
        platform: s.campaign.platform, id: s.campaign.id, name: s.campaign.name, reason: s.reason,
      })),
    },
  });
  if (logErr) console.warn(`[campaign-toggle] log insert failed: ${logErr.message}`);

  return { plan, outcomes, heldPaused: heldList.length };
}
