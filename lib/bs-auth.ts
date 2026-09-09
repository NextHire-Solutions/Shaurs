/* ---------------------------------------------------------------------------
 * GENERATED FILE — DO NOT EDIT HERE.
 *
 * Source of truth: packages/bs-auth/index.ts in the BrokerStaffer-SSO workspace.
 * Regenerate with: node packages/bs-auth/sync.mjs
 *
 * Edit the source and re-sync; edits made here are overwritten and, worse, make
 * this app verify tokens differently from every other app.
 *
 * bs-auth@d235656d0c74
 * ------------------------------------------------------------------------- */

/*
 * bs-auth — the shared single-sign-on token.
 *
 * ONE source of truth. This file is copied verbatim into each app as
 * `lib/bs-auth.ts` by `packages/bs-auth/sync.mjs`. Four copies of ~200 lines is
 * a deliberate choice over publishing a package: the apps deploy independently
 * from separate repos, and a private registry (or four git submodules) would be
 * more machinery than this earns. The sync script + a checksum test keep the
 * copies honest.
 *
 * ---------------------------------------------------------------------------
 * WHO ISSUES, WHO VERIFIES
 *
 *   Command Center  →  mints  bs_sso  (needs AUTH_SECRET + the grants DB)
 *   Every other app →  verifies bs_sso  (needs only BS_SSO_SECRET)
 *
 * Apps verify OFFLINE. No network call, no database lookup on the hot path —
 * a permission check is one HMAC, microseconds. That is what makes putting a
 * grant check in front of every request affordable.
 *
 * ---------------------------------------------------------------------------
 * TOKEN FORMAT
 *
 *   base64url(JSON.stringify(payload)) + "." + hex(HMAC-SHA256(secret, body))
 *
 * Two parts, not three. The earlier Analytics scheme kept `expiresAt` outside
 * the payload so it could be read without decoding; that saves nothing real and
 * invites checking expiry before verifying the signature, which is exactly
 * backwards. Here the signature is checked FIRST and nothing inside the payload
 * is trusted until it passes.
 *
 * Deliberately not a JWT: no `alg` field, so there is no algorithm-confusion
 * attack surface and no dependency. The one algorithm is HMAC-SHA256.
 *
 * ---------------------------------------------------------------------------
 * REVOCATION
 *
 * Tokens are short-lived (30 min) and silently refreshed by the Command Center,
 * which re-reads grants from the database on every refresh. So removing a grant
 * takes effect within 30 minutes with no coordination between apps.
 *
 * For instant revocation, bump `app_users.token_version`; the refresh endpoint
 * then refuses to reissue. Apps do not check `ver` — they cannot, they have no
 * database. It rides along so the issuer can reject a stale refresh.
 *
 * Runs identically in the Edge runtime and in Node: Web Crypto only.
 */

/** Tools a grant can be issued for. Keep in sync with the Command Center registry. */
export type ToolId = "inbox" | "clients" | "analytics" | "search";

export const ALL_TOOLS: readonly ToolId[] = ["inbox", "clients", "analytics", "search"];

export interface SsoSession {
  /** Lower-cased email. The stable identity across all apps. */
  email: string;
  /** Tools this person may open. */
  grants: ToolId[];
  /** Issuer's token version for this user; bumped to invalidate live sessions. */
  ver: number;
  /** Unix milliseconds. */
  exp: number;
  /** Unix milliseconds. Issued-at, for logging and staleness debugging. */
  iat: number;
}

export const SSO_COOKIE = "bs_sso";

/** 30 minutes. Short on purpose — this is the revocation window. */
export const SSO_TTL_MS = 30 * 60 * 1000;

/**
 * Accept a token up to 60s past expiry.
 *
 * Not laziness: Railway containers, the browser and Supabase do not share a
 * clock, and a user whose machine is 20s fast would otherwise get a hard 401
 * mid-request with no way to self-diagnose. 60s is far below the 30-minute TTL,
 * so it does not meaningfully widen the revocation window.
 */
const CLOCK_SKEW_MS = 60 * 1000;

// --- encoding ---------------------------------------------------------------

const encoder = new TextEncoder();

function base64UrlEncode(input: string): string {
  const bytes = encoder.encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison. `a === b` short-circuits on the first differing
 * byte, which leaks how much of a forged signature was correct.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

// --- mint (Command Center only) ---------------------------------------------

export interface MintInput {
  email: string;
  grants: ToolId[];
  ver: number;
  ttlMs?: number;
  now?: number;
}

export async function mintSso(secret: string, input: MintInput): Promise<string> {
  if (!secret) throw new Error("mintSso: secret is required");

  const now = input.now ?? Date.now();
  const payload: SsoSession = {
    email: input.email.trim().toLowerCase(),
    // Normalise: drop unknown tools and duplicates so a typo in the database
    // can never widen access, and so the token is byte-stable for a given set.
    grants: ALL_TOOLS.filter((t) => input.grants.includes(t)),
    ver: input.ver,
    iat: now,
    exp: now + (input.ttlMs ?? SSO_TTL_MS),
  };

  const body = base64UrlEncode(JSON.stringify(payload));
  return `${body}.${await hmacHex(secret, body)}`;
}

// --- verify (every app) ------------------------------------------------------

/** Why a token was rejected. Surfaced in logs, never to the browser. */
export type SsoFailure =
  | "missing"
  | "malformed"
  | "bad-signature"
  | "expired"
  | "bad-payload";

export type SsoResult =
  | { ok: true; session: SsoSession }
  | { ok: false; reason: SsoFailure };

/**
 * Verifies a token. Signature first, payload second — nothing inside the
 * payload is trusted until the HMAC checks out.
 */
export async function verifySsoDetailed(
  secret: string,
  token: string | undefined | null,
  now = Date.now(),
): Promise<SsoResult> {
  if (!secret) return { ok: false, reason: "missing" };
  if (!token) return { ok: false, reason: "missing" };

  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: "malformed" };

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!safeEqual(signature, await hmacHex(secret, body))) {
    return { ok: false, reason: "bad-signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(body));
  } catch {
    return { ok: false, reason: "bad-payload" };
  }

  const session = normalise(parsed);
  if (!session) return { ok: false, reason: "bad-payload" };

  if (session.exp + CLOCK_SKEW_MS <= now) return { ok: false, reason: "expired" };

  return { ok: true, session };
}

/** The common case: a session, or null. */
export async function verifySso(
  secret: string,
  token: string | undefined | null,
  now = Date.now(),
): Promise<SsoSession | null> {
  const result = await verifySsoDetailed(secret, token, now);
  return result.ok ? result.session : null;
}

/**
 * Shape-checks a decoded payload.
 *
 * A signed token could still carry a payload from an older or newer issuer, so
 * every field is validated rather than cast. `grants` is intersected with
 * ALL_TOOLS, so an unrecognised tool name grants nothing.
 */
function normalise(value: unknown): SsoSession | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;

  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  if (!email) return null;

  const exp = typeof raw.exp === "number" && Number.isFinite(raw.exp) ? raw.exp : null;
  if (exp === null) return null;

  const iat = typeof raw.iat === "number" && Number.isFinite(raw.iat) ? raw.iat : 0;
  const ver = typeof raw.ver === "number" && Number.isFinite(raw.ver) ? raw.ver : 0;

  const claimed = Array.isArray(raw.grants) ? raw.grants : [];
  const grants = ALL_TOOLS.filter((t) => claimed.includes(t));

  return { email, grants, ver, exp, iat };
}

// --- authorisation -----------------------------------------------------------

/** True when the session may open `tool`. The only authorisation primitive. */
export function hasGrant(session: SsoSession | null, tool: ToolId): boolean {
  return !!session && session.grants.includes(tool);
}

/** Milliseconds until expiry; negative once expired. For refresh scheduling. */
export function msUntilExpiry(session: SsoSession, now = Date.now()): number {
  return session.exp - now;
}

/**
 * True when the token is over halfway through its life and should be refreshed.
 *
 * Refreshing at the halfway point rather than near expiry means a failed
 * refresh has a full half-TTL to retry before the user is logged out.
 */
export function shouldRefresh(session: SsoSession, now = Date.now()): boolean {
  const lifetime = session.exp - session.iat;
  if (lifetime <= 0) return true;
  return now - session.iat > lifetime / 2;
}

// --- cookie ------------------------------------------------------------------

export interface CookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: "/";
  domain?: string;
  maxAge: number;
}

/**
 * Cookie attributes for the SSO session.
 *
 * `sameSite: "lax"` with a parent-domain `domain` is correct and sufficient
 * BECAUSE every app is a subdomain of one apex — an embedded pane on
 * clients.brokerstaffer.com inside home.brokerstaffer.com is same-site, so the
 * cookie is first-party. Do not "fix" this to SameSite=None: that would make it
 * a third-party cookie, which Safari blocks by default and Chrome is phasing
 * out, and would trade a working design for a fragile one.
 *
 * `domain` is omitted in local development (localhost has no shared apex), which
 * is why it is a parameter rather than a constant.
 */
export function ssoCookieOptions(opts: {
  secure: boolean;
  domain?: string;
  ttlMs?: number;
}): CookieOptions {
  return {
    httpOnly: true,
    secure: opts.secure,
    sameSite: "lax",
    path: "/",
    ...(opts.domain ? { domain: opts.domain } : {}),
    maxAge: Math.floor((opts.ttlMs ?? SSO_TTL_MS) / 1000),
  };
}

/**
 * Reads the token out of a raw Cookie header.
 *
 * Every app needs this in middleware, where framework cookie helpers differ
 * (Next's NextRequest vs Express's req.cookies vs a bare header). Parsing the
 * header directly is the one thing that works everywhere.
 */
export function readSsoCookie(cookieHeader: string | null | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SSO_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}
