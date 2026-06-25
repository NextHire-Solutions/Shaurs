-- Custom billing interval — N-day cycles other than 14 / 28 / calendar-month.
--
-- billing_interval gets a new allowed value 'custom'; billing_interval_days
-- carries the N. The pair is only meaningful together: when interval='custom'
-- we expect billing_interval_days IS NOT NULL; for the other three values it
-- is ignored (kept NULL in practice).
alter table clients
  add column if not exists billing_interval_days int;

alter table clients drop constraint if exists clients_billing_interval_check;
alter table clients add constraint clients_billing_interval_check
  check (billing_interval in ('biweekly','28-days','monthly','custom'));
