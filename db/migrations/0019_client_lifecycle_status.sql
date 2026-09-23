-- 0019 — the client lifecycle status, as the architecture spec defines it.
--
-- This dashboard has carried lifecycle state as two independent booleans:
-- `hidden` (used to mean churned) and `client_paused`. Two booleans cannot
-- express four states without ambiguity — both true is undefined — and the
-- spec asks for one vocabulary everywhere: onboarding, active, paused,
-- churned.
--
-- THE BOOLEANS ARE KEPT AND KEPT IN STEP. Dashboard.tsx, loadDashboard.ts and
-- scripts/sync.ts all read `hidden` today, and a migration that removes a
-- column live code reads is a deploy-ordering problem for no gain. The trigger
-- below makes them a view of `status`, so existing readers keep working and
-- cannot disagree with the new column.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS status TEXT;

/*
 * Backfill from the booleans this tool already maintains, because they are
 * the honest local signal — they were set by a person here, not inferred.
 *
 * `hidden` wins over `client_paused` when both are set: hidden has meant
 * "gone" and paused has meant "temporarily stopped", and a row marked both
 * is more safely read as the stronger of the two. Churning a paused client
 * is recoverable; showing a churned client as merely paused invites someone
 * to resume billing them.
 */
UPDATE public.clients
   SET status = CASE
     WHEN hidden        THEN 'churned'
     WHEN client_paused THEN 'paused'
     ELSE 'active'
   END
 WHERE status IS NULL;

ALTER TABLE public.clients
  ALTER COLUMN status SET DEFAULT 'active',
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_status_check'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_status_check
      CHECK (status IN ('onboarding', 'active', 'paused', 'churned'));
  END IF;
END $$;

COMMENT ON COLUMN public.clients.status IS
  'onboarding | active | paused | churned — the platform-wide client lifecycle. '
  'Mastered in os_clients; hidden and client_paused are mirrors of it.';

/*
 * Keep the booleans a view of `status`, in BOTH directions, so neither an old
 * caller nor a new one can leave the other stale:
 *   set status  -> hidden and client_paused follow,
 *   set hidden  -> status becomes churned, or active when cleared,
 *   set paused  -> status becomes paused, or active when cleared.
 *
 * Only 'active' is unambiguous when a boolean is cleared, so that is what
 * clearing one means. A person can then correct it to onboarding if that is
 * what they meant.
 */
CREATE OR REPLACE FUNCTION public.clients_sync_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.hidden        := (NEW.status = 'churned');
    NEW.client_paused := (NEW.status = 'paused');
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.hidden        := (NEW.status = 'churned');
    NEW.client_paused := (NEW.status = 'paused');
  ELSIF NEW.hidden IS DISTINCT FROM OLD.hidden THEN
    NEW.status        := CASE WHEN NEW.hidden THEN 'churned' ELSE 'active' END;
    NEW.client_paused := (NEW.status = 'paused');
  ELSIF NEW.client_paused IS DISTINCT FROM OLD.client_paused THEN
    NEW.status := CASE WHEN NEW.client_paused THEN 'paused' ELSE 'active' END;
    NEW.hidden := (NEW.status = 'churned');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS clients_sync_lifecycle ON public.clients;
CREATE TRIGGER clients_sync_lifecycle
  BEFORE INSERT OR UPDATE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.clients_sync_lifecycle();

CREATE INDEX IF NOT EXISTS clients_status_idx ON public.clients (status);

COMMIT;
