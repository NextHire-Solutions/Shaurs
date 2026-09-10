-- Per-week replies (from Instantly daily analytics + Bison line-area-chart-stats).
-- Enables a real "This Week" reply count instead of a lifetime-only campaign.reply_count sum.
alter table weekly_metrics
  add column if not exists replies int not null default 0;
