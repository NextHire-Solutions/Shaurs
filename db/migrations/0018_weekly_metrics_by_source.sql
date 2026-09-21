-- Emails sent, stored per source instead of as one shared total.
--
-- WHAT WAS WRONG. `weekly_metrics.emails_sent` was written by two different
-- jobs. The Instantly job wrote its own subtotal over the column; the Bison job
-- then read that value back and wrote subtotal + its own. Correct only if the
-- two ran strictly alternately, which they do not:
--
--   · two Instantly runs in a row threw Bison's contribution away;
--   · two Bison runs in a row counted Bison twice;
--   · between the two jobs the column held the Instantly figure alone, so the
--     dashboard's This Week total passed through 0 on every sync cycle. That
--     is what people saw as "the number is off, it comes right if I refresh" —
--     they were seeing whichever job wrote last.
--
-- Measured on 17 September: 66,090 before a cycle, 0 during it, 38,717 after.
--
-- WHAT THIS DOES. Gives each source a column only its own job writes, and
-- leaves `emails_sent` as the total the dashboard already reads. Each job now
-- writes its own column plus the total computed from its new value and the
-- OTHER source's stored value. Neither can clobber the other and order stops
-- mattering, so the total is right after every individual write rather than
-- only at the end of a clean pair.
--
-- WHY NOT A GENERATED COLUMN. `emails_sent` would be the obvious candidate for
-- `GENERATED ALWAYS AS (instantly + bison)`, but it already holds data and two
-- deployed apps read it. Converting it means dropping and re-adding a column
-- that client-facing dashboards select, for a guarantee the two jobs can give
-- on their own now that neither writes the other's input.
--
-- THE TRANSITION. The new columns start at 0 while `emails_sent` keeps its
-- current value, so nothing changes on screen at migration time. The first run
-- of each job fills in its own column; after one full cycle — one Instantly run
-- and one Bison run — every total is derived from real per-source figures. A
-- single cycle in between may read low for clients that have both sources.
-- That is one sync interval, against a number that is currently wrong several
-- times an hour.
--
-- ROLLBACK
--   alter table weekly_metrics
--     drop column if exists emails_sent_instantly, drop column if exists replies_instantly,
--     drop column if exists emails_sent_bison,     drop column if exists replies_bison;
--   -- then redeploy the previous sync; `emails_sent` is untouched by this file.

begin;

alter table public.weekly_metrics
  add column if not exists emails_sent_instantly integer not null default 0,
  add column if not exists replies_instantly     integer not null default 0,
  add column if not exists emails_sent_bison     integer not null default 0,
  add column if not exists replies_bison         integer not null default 0;

comment on column public.weekly_metrics.emails_sent_instantly is
  'Emails sent that week via Instantly. Written ONLY by the Instantly sync.';
comment on column public.weekly_metrics.emails_sent_bison is
  'Emails sent that week via EmailBison. Written ONLY by the Bison sync.';
comment on column public.weekly_metrics.emails_sent is
  'Combined weekly total = emails_sent_instantly + emails_sent_bison. Each sync recomputes it from its own new figure plus the other source as stored.';

commit;
