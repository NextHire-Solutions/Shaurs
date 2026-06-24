-- Per-campaign reply + positive-reply counts. Refreshed by sync-worker
-- on each cron tick. Used by the Campaigns popup row to render Reply
-- Rate and Positive Reply Rate.
--   Reply Rate    = reply_count / emails_sent_total
--   Positive Rate = interested_count / reply_count
-- reply_count comes from Instantly's analytics (reply_count_unique) or
-- Bison's campaign list (unique_replies). interested_count comes from
-- Corofy's /api/clients/intros?label=Interested grouped by campaign_id.

alter table instantly_campaigns
  add column if not exists reply_count int not null default 0,
  add column if not exists interested_count int not null default 0;

alter table bison_campaigns
  add column if not exists reply_count int not null default 0,
  add column if not exists interested_count int not null default 0;
