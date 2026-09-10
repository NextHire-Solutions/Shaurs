-- All-time Corofy label counts per client, so the Funnel Lifetime cards are
-- not clipped by the 26-week weekly_metrics backfill window.
alter table clients
  add column if not exists total_intros_corofy int not null default 0,
  add column if not exists total_interested_corofy int not null default 0;
