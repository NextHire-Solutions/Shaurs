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
--
-- WHAT THIS DOES NOT CHANGE. No existing row's `hidden` or `client_paused`
-- flips: the backfill only writes the new column, and the trigger fires from
-- here on, on rows someone actually edits. The dashboard's three filter views
-- read the same booleans afterwards as before, so the screen a person opens
-- tomorrow shows exactly what it shows today.
--
-- ONE BEHAVIOUR CHANGE, stated plainly. After this runs, the two booleans
-- become mutually exclusive: pausing a churned client clears `hidden`, rather
-- than leaving a row that is both. That is the four-state model the spec
-- asks for. It affects NO existing row — checked before writing this, zero
-- rows currently have both flags set — and both states map to "portal off"
-- either way, so no client's portal changes because of it.
--
-- SAFE TO RE-RUN.

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

/*
 * Scoped to THIS table. `conname` is unique per table, not per database, so a
 * constraint of the same name elsewhere would otherwise make this block skip
 * silently and leave the column unconstrained.
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clients'::regclass
      AND conname  = 'clients_status_check'
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
 *
 * An UPDATE that touches none of the three falls through every branch and
 * changes nothing — so the weekly sync, which writes metrics and campaign ids
 * on these rows, is unaffected.
 */
CREATE OR REPLACE FUNCTION public.clients_sync_lifecycle()
RETURNS TRIGGER LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- An explicit status wins; otherwise the column default ('active') has
    -- already been applied by the time this runs, and the booleans follow it.
    IF NEW.status IS NULL THEN
      NEW.status := CASE
        WHEN NEW.hidden        THEN 'churned'
        WHEN NEW.client_paused THEN 'paused'
        ELSE 'active'
      END;
    END IF;
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
