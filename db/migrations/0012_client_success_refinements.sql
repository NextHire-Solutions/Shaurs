-- Client Success refinements + Bi-Weekly upgrades.
--
-- Three new client-level columns, all populated by the sync worker on each
-- 15-min tick. All non-destructive additive defaults; existing rows read
-- 0 / null immediately.
alter table clients
  -- Mirror of Corofy portals.last_lead_activity_at (bumped on lead stage
  -- change or note addition). Null until Corofy exposes the field OR the
  -- portal has never had lead activity.
  add column if not exists last_lead_activity_at timestamptz,

  -- Introduction-feed count: leads where updated_at ≈ assigned_at (within a
  -- 2s tolerance). Represents leads that entered the Introduction stage and
  -- have never been touched since.
  add column if not exists stagnant_intros_count int not null default 0,

  -- Introduction-feed count: rows with assigned_at >= client's last billing
  -- day. Used by the Bi-Weekly view's Introductions column so the number
  -- resets with each client's billing cycle rather than the calendar Monday.
  add column if not exists intros_since_last_billing int not null default 0;
