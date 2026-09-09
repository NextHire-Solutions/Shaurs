-- Mirror Corofy's per-portal deep-link URL so the dashboard can render a
-- link-out icon next to each client's name. Populated by the sync worker
-- on every 15-min tick from listCorofyPortals().portal_url.
alter table clients
  add column if not exists portal_url text;
