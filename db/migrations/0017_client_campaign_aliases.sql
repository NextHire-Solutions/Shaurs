-- Per-client aliases: extra strings that should also match a campaign name
-- during auto-linking. Lets ops fix naming drift ("Spotlight + Triangle …"
-- vs client "Spotlight - A Compass Team") without a code deploy.
alter table clients
  add column if not exists campaign_aliases text[] not null default '{}';
