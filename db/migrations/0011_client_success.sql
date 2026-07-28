-- Client Success tab.
--
-- weekly_metrics: mirrors intros_corofy / interested_corofy pattern for the
-- "Hired" label. Same bucketing rule (Monday-anchored per client_id).
-- The Hired label may not exist on Corofy yet when this migration lands —
-- the sync-worker call is non-fatal, so the columns stay 0/null until
-- Corofy exposes it.
alter table weekly_metrics
  add column if not exists hired_corofy int not null default 0,
  add column if not exists last_hired_at timestamptz;

-- clients: operational fields for Client Success.
--   time_zone: IANA string (e.g. 'America/New_York'); nullable; edited via modal.
--   dnc_count / agents_count: mirrored from Corofy /api/clients/portals
--     counts.dnc / counts.agents on every sync tick — read-only in the UI.
alter table clients
  add column if not exists time_zone text,
  add column if not exists dnc_count int not null default 0,
  add column if not exists agents_count int not null default 0;
