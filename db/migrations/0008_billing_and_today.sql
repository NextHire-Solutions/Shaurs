-- Bi-Weekly View + Today's Emails.
--
-- billing_anchor_date / billing_interval — per-client billing schedule.
-- Anchor falls back to clients.start_date in the dashboard if null.
-- Interval defaults to 'biweekly' to match the most common pattern;
-- '28-days' and 'monthly' cover the outliers.
alter table clients
  add column if not exists billing_anchor_date date,
  add column if not exists billing_interval text not null default 'biweekly';

alter table clients drop constraint if exists clients_billing_interval_check;
alter table clients add constraint clients_billing_interval_check
  check (billing_interval in ('biweekly','28-days','monthly'));

-- emails_today — today's email count per client, refreshed every sync tick.
-- emails_today_date tells us which day the count is for; the dashboard shows
-- 0 if the stored date isn't today (America/New_York).
alter table clients
  add column if not exists emails_today int not null default 0,
  add column if not exists emails_today_date date;
