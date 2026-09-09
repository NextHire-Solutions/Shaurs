// Route-level authorisation.
//
// The middleware already gates every page and API path, so why check again?
// Because /api/clients has to be reachable by two very different callers:
//
//   the browser          — carries the bs_auth cookie (or bs_sso once SSO lands)
//   Master Inbox         — carries x-admin-token, and has no cookie at all
//
// Making the middleware wave the whole path through would open POST/PATCH/DELETE
// to anyone, since the handler currently checks nothing. So the middleware lets
// the path through only for a token-bearing GET, and the handler below decides
// what each caller may actually do.
//
// This also removes a real dependency on middleware behaviour: if
// PUBLIC_PATH_PREFIXES is edited later, these routes stay safe on their own.

import type { NextRequest } from 'next/server';
import { hasGrant, readSsoCookie, verifySso } from './bs-auth';

const AUTH_COOKIE = 'bs_auth';
const AUTH_MESSAGE = 'bs-dashboard-authed';

/** Constant-time compare — `===` leaks how much of a guess was correct. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The cookie value the password login produces. Mirrors middleware.ts. */
async function expectedCookieValue(password: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(AUTH_MESSAGE));
  let s = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A person, signed in either way. May read and write. */
export async function isSignedIn(req: NextRequest): Promise<boolean> {
  const ssoSecret = process.env.BS_SSO_SECRET;
  if (ssoSecret) {
    const session = await verifySso(ssoSecret, readSsoCookie(req.headers.get('cookie')));
    if (session && hasGrant(session, 'clients')) return true;
  }

  const password = process.env.DASHBOARD_PASSWORD;
  if (password) {
    const cookie = req.cookies.get(AUTH_COOKIE)?.value;
    if (cookie && safeEqual(cookie, await expectedCookieValue(password))) return true;
  }

  return false;
}

/**
 * A machine holding READ_ONLY_TOKEN. May read, never write.
 *
 * Deliberately fails closed when the variable is unset, matching
 * /api/clients/status. The alternative — treating "unset" as "allow" — would
 * mean one missing variable silently opens the client list to the internet.
 */
export async function isReadOnlyMachine(req: NextRequest): Promise<boolean> {
  const expected = process.env.READ_ONLY_TOKEN;
  if (!expected) return false;

  const supplied = req.headers.get('x-admin-token');
  return !!supplied && safeEqual(supplied, expected);
}

/**
 * Guard for a read.
 *
 * Returns null when the caller may proceed, or the response to send back.
 * A helper rather than a boolean so every route refuses in the same shape —
 * JSON, never an HTML redirect, because every caller here is a fetch().
 */
export async function requireRead(req: NextRequest) {
  if (await isSignedIn(req)) return null;
  if (await isReadOnlyMachine(req)) return null;
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

/** Guard for a write. The read-only token is deliberately NOT accepted. */
export async function requireWrite(req: NextRequest) {
  if (await isSignedIn(req)) return null;

  // Distinguish "you are a reader" from "you are nobody": a 403 tells an
  // integration its token is valid but insufficient, which is a far shorter
  // debugging path than a blanket 401.
  if (await isReadOnlyMachine(req)) {
    return Response.json(
      { error: 'forbidden', detail: 'READ_ONLY_TOKEN cannot modify clients' },
      { status: 403 },
    );
  }

  return Response.json({ error: 'unauthorized' }, { status: 401 });
}
