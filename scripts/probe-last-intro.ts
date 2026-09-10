// Audit: for every active client, compare
//   - Corofy Introduction feed's max assigned_at
//   - Our DB's max(last_corofy_intro_at) across weekly_metrics
// Report mismatches (Corofy newer than DB = we're behind).

import { getSupabase } from '../lib/supabase';
import { listCorofyIntros } from '../lib/corofy';
import { normalizeName } from '../lib/derive';

const CLIENT_NAME_ALIASES: Record<string, string[]> = {
  'Properties & Estates': ['Properties & Estates Florida'],
};

async function main() {
  const sb = getSupabase();
  const { data: clients } = await sb
    .from('clients')
    .select('id, name, hidden, client_paused')
    .eq('hidden', false)
    .eq('client_paused', false);
  const intros = await listCorofyIntros('Introduction');

  const overrideNorm = new Map<string, string>();
  for (const [primary, aliases] of Object.entries(CLIENT_NAME_ALIASES)) {
    const p = normalizeName(primary);
    for (const a of aliases) overrideNorm.set(normalizeName(a), p);
  }
  const maxCorofyByNorm = new Map<string, number>();
  for (const r of intros) {
    const raw = normalizeName(r.client_name);
    const k = overrideNorm.get(raw) ?? raw;
    const t = new Date(r.assigned_at).getTime();
    if (!Number.isFinite(t)) continue;
    const prev = maxCorofyByNorm.get(k) ?? 0;
    if (t > prev) maxCorofyByNorm.set(k, t);
  }

  const rows: { name: string; cfy: string; db: string; delta: number }[] = [];
  for (const c of clients ?? []) {
    const norm = normalizeName(c.name);
    const cfyMs = maxCorofyByNorm.get(norm) ?? 0;
    const { data: m } = await sb
      .from('weekly_metrics')
      .select('last_corofy_intro_at')
      .eq('client_id', c.id)
      .not('last_corofy_intro_at', 'is', null)
      .order('last_corofy_intro_at', { ascending: false })
      .limit(1);
    const dbIso = m && m[0]?.last_corofy_intro_at ? String(m[0].last_corofy_intro_at) : '';
    const dbMs = dbIso ? new Date(dbIso).getTime() : 0;
    const delta = (cfyMs - dbMs) / 3600_000; // hours difference
    rows.push({
      name: c.name,
      cfy: cfyMs > 0 ? new Date(cfyMs).toISOString().slice(0, 19) : '',
      db: dbMs > 0 ? new Date(dbMs).toISOString().slice(0, 19) : '',
      delta,
    });
  }
  rows.sort((a, b) => b.delta - a.delta);

  const stale = rows.filter((r) => r.delta > 0.01);
  console.log(`=== Clients where Corofy has NEWER last-intro than our DB ===`);
  console.log(`Total: ${stale.length} / ${rows.length}\n`);
  console.log(`${'Client'.padEnd(38)}  ${'Corofy latest'.padEnd(20)}  ${'DB latest'.padEnd(20)}  Δh`);
  for (const r of stale) {
    console.log(`${r.name.padEnd(38)}  ${r.cfy.padEnd(20)}  ${r.db.padEnd(20)}  ${r.delta.toFixed(1)}`);
  }
  console.log(`\n=== Top 10 by MOST-RECENT DB last_corofy_intro_at (sanity) ===`);
  const sorted = [...rows].sort((a, b) => (b.db > a.db ? 1 : b.db < a.db ? -1 : 0));
  for (const r of sorted.slice(0, 10)) {
    console.log(`  ${r.name.padEnd(38)}  db=${r.db}   cfy=${r.cfy}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
