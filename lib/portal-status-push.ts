// Tell MasterInbox that a client's status changed, so portals follow within
// seconds instead of waiting for the next scheduled reconcile.
//
// MasterInbox owns the decision (active -> portal ON, paused/churned -> OFF)
// and its endpoint is a FULL, IDEMPOTENT reconcile: this module never says
// what changed, only that something did. That is deliberate — a missed push
// is then never a lost update, only a late one, and the scheduled run still
// self-corrects.
//
// Rules this module keeps, because portals are live and client-facing:
//   * never throws, never blocks — a dashboard save must succeed even when
//     MasterInbox is down. Every failure is a warning in the log, nothing more.
//   * silent no-op while either env var is unset, so local dev and the period
//     before the Railway variables are set behave exactly as they do today.
//   * aborts after PUSH_TIMEOUT_MS, so a hung MasterInbox cannot pin a
//     request open.
//   * coalesces bursts — hiding four clients in a row fires one reconcile,
//     not four, since any one of them reconciles the whole roster anyway.

export type ClientStatus = 'active' | 'paused' | 'churned';

/**
 * The 3-way status the rest of the platform sees, derived from this
 * dashboard's two booleans.
 *
 * `hidden` wins when both are set, matching how the dashboard prioritises its
 * Hidden filter. This is the single definition — /api/clients/status returns
 * it and the push compares it; two copies would eventually disagree and the
 * bug would show up as a portal that never switches.
 */
export function effectiveStatus(c: {
  hidden?: boolean | null;
  client_paused?: boolean | null;
}): ClientStatus {
  if (c.hidden) return 'churned';
  if (c.client_paused) return 'paused';
  return 'active';
}

const PUSH_TIMEOUT_MS = 10_000;
const COALESCE_MS = 1_500;

let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingReasons = new Set<string>();

/**
 * Append apply=1 without assuming anything about the configured URL — it may
 * already carry a query string, or already carry apply. Returns null for a
 * URL that doesn't parse, so a typo in Railway is a logged no-op rather than
 * a thrown error inside a client save.
 */
function reconcileUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    u.searchParams.set('apply', '1');
    return u.toString();
  } catch {
    return null;
  }
}

async function fire(url: string, token: string, reasons: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      // Header rather than ?token= so the secret stays out of access logs.
      headers: { 'x-cron-token': token },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[portal-status-push] reconcile returned ${res.status} (${reasons})`);
      return;
    }
    const body = (await res.json().catch(() => null)) as
      | { changes?: unknown[]; matched?: number; reason?: string }
      | null;
    if (body?.reason) {
      // MasterInbox skipped on purpose (feed down, feed empty). Its fail-safe
      // rules, not an error here — but worth seeing in the log.
      console.warn(`[portal-status-push] reconcile skipped: ${body.reason} (${reasons})`);
      return;
    }
    console.log(
      `[portal-status-push] reconciled ${body?.matched ?? '?'} clients, ` +
        `${body?.changes?.length ?? 0} portal(s) flipped (${reasons})`,
    );
  } catch (err) {
    const why = err instanceof Error && err.name === 'AbortError' ? 'timed out' : String(err);
    console.warn(`[portal-status-push] push failed, reconcile will catch up: ${why}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fire-and-forget. Call AFTER the write has succeeded, never before: a push
 * that races ahead of the commit would make MasterInbox read the old status.
 *
 * `reason` is for the log only — the reconcile is roster-wide regardless.
 */
export function pushPortalStatus(reason: string): void {
  const rawUrl = process.env.PORTAL_STATUS_SYNC_URL;
  const token = process.env.PORTAL_STATUS_SYNC_TOKEN;
  if (!rawUrl || !token) return; // not configured yet — stay exactly as before

  const url = reconcileUrl(rawUrl);
  if (!url) {
    console.warn('[portal-status-push] PORTAL_STATUS_SYNC_URL is not a valid URL — skipping');
    return;
  }

  pendingReasons.add(reason);
  if (pendingTimer) return; // already scheduled; this reason rides along

  pendingTimer = setTimeout(() => {
    const reasons = [...pendingReasons].join('; ');
    pendingTimer = null;
    pendingReasons = new Set();
    void fire(url, token, reasons);
  }, COALESCE_MS);

  // A pending push must never be the reason the process stays alive.
  (pendingTimer as unknown as { unref?: () => void }).unref?.();
}
