-- 0020 — raw intro dates for billing-cycle math, and the campaign Play/Pause toggle.
--
-- INTRO DATES. Intros due / delivered / carried forward and the 28-day period
-- are counted per BILLING CYCLE, and billing dates do not fall on Mondays, so
-- the weekly_metrics buckets cannot answer them. The sync worker already reads
-- every Corofy "Introduction" row (with assigned_at) on each tick; this keeps
-- those dates on the client row so the dashboard can do the cycle math itself.
-- A change to a client's target or billing anchor then shows immediately
-- instead of after the next sync. One array per client, rewritten whole by the
-- sync in a single UPDATE, so a reader never sees a half-written list.
--
-- CAMPAIGN TOGGLE. Play resumes only the campaigns this toggle paused — never
-- a finished campaign, and never one somebody paused by hand — so the paused
-- set is recorded here. Every Pause/Play attempt is logged with its
-- per-campaign results, because a half-successful fan-out is exactly what
-- someone will come looking for.
--
-- Nothing here changes an existing value. SAFE TO RE-RUN.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS intro_dates timestamptz[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS toggle_paused_campaigns jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.clients.intro_dates IS
  'assigned_at of every Corofy "Introduction" row for this client. Rewritten by the sync worker each tick; drives billing-cycle math.';
COMMENT ON COLUMN public.clients.toggle_paused_campaigns IS
  'Campaigns the dashboard Play/Pause toggle paused: [{platform, id, int_id, name, paused_at}]. Play resumes exactly these.';

CREATE TABLE IF NOT EXISTS public.campaign_toggle_log (
  id          bigserial PRIMARY KEY,
  client_id   uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  client_name text NOT NULL,
  action      text NOT NULL CHECK (action IN ('pause', 'resume')),
  actor       text,
  results     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS campaign_toggle_log_client_idx
  ON public.campaign_toggle_log (client_id, created_at DESC);

COMMIT;
