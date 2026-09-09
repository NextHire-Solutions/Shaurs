-- Monthly intros target + monthly progress counter.
--
-- monthly_target: per-client goal for a single "monthly cycle", defined as
-- calendar-month steps from the client's billing anchor (falls back to start
-- date). Editable via the Add/Edit Client modal. 0 means "no monthly goal
-- set" and the Weekly view renders "—" for that client.
--
-- intros_this_month: populated by the sync worker each 15-min tick using
-- per-lead assigned_at timestamps from Corofy's Introduction feed. Independent
-- of billing_interval so it works for every client, not just monthly-billed
-- ones.
alter table clients
  add column if not exists monthly_target int not null default 0,
  add column if not exists intros_this_month int not null default 0;
