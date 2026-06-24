-- Per-week count of leads labeled "Interested" in Corofy. Mirrors the
-- existing intros_corofy / last_corofy_intro_at pair which holds the
-- "Introduction" label counts. The sync worker pulls both labels from
-- Corofy's /api/clients/intros endpoint and writes them side-by-side
-- into weekly_metrics.

alter table weekly_metrics
  add column if not exists interested_corofy int not null default 0,
  add column if not exists last_interested_at timestamptz;
