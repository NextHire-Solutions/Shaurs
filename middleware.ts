// Gates every dashboard page.
//
// Two auth mechanisms, checked in this order:
//
//   1. BrokerStaffer SSO (bs_sso)  — the Command Center signs a short-lived
//      token carrying the person's email and the tools they may open. We verify
//      it offline with BS_SSO_SECRET and require the `clients` grant. This is
//      the real one: it identifies WHO is looking, not just that they know a
//      shared secret.
//
//   2. Shared team password (bs_auth) — the pre-SSO gate, kept as a fallback so
//      the app keeps working while SSO rolls out and so nobody is locked out if
//      the Command Center is down. Delete this branch once SSO is settled;
//      it grants access without identity, which is the thing SSO exists to fix.
//
// Public paths (no auth required):
//   - /login + /api/auth/*
//   - Server-to-server endpoints that carry their own tokens:
//     /api/clients/onboard (x-admin-token: ONBOARDING_TOKEN)
//     /api/clients/status  (x-admin-token: READ_ONLY_TOKEN)
//     /api/sync/run        (x-sync-secret: SYNC_SECRET, if set)
//
// Fail-open only when NEITHER mechanism is configured. The previous rule
// ("fail open when DASHBOARD_PASSWORD is unset") was reasonable when a missing
// env var meant "auth not set up yet"; with SSO deployed it would mean clearing
// one variable silently opens the whole dashboard to the internet. Now the app
// is open only if it has been given no way to authenticate anyone at all.

import { NextRequest, NextResponse } from 'next/server';
import { hasGrant, readSsoCookie, verifySso } from './lib/bs-auth';

const AUTH_COOKIE = 'bs_auth';
const AUTH_MESSAGE = 'bs-dashboard-authed';

/** The grant this app requires. */
const TOOL = 'clients' as const;

/** Set by the Command Center when it opens this app in a workspace pane. */
const EMBED_COOKIE = 'bs_embed';

const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/api/auth/',
  '/api/clients/onboard',
  '/api/clients/status',
  '/api/metrics/weekly',
  '/api/sync/run',
];

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
  // base64url encode without Buffer (Buffer isn't in Edge runtime).
  let s = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Embed mode is carried by a cookie, not the query string.
 *
 * `?embed=1` survives the first request and nothing after it — the moment the
 * user clicks anything, Next does a client-side navigation and the param is
 * gone. Threading it through every href is not realistic, so the first request
 * converts it to a cookie and everything downstream reads that.
 */
function applyEmbedCookie(req: NextRequest, res: NextResponse): NextResponse {
  const param = req.nextUrl.searchParams.get('embed');
  if (param === '1') {
    res.cookies.set(EMBED_COOKIE, '1', {
      httpOnly: false, // the client shell reads it too
      sameSite: 'lax',
      path: '/',
      secure: req.nextUrl.protocol === 'https:',
    });
  } else if (param === '0') {
    res.cookies.set(EMBED_COOKIE, '', { path: '/', maxAge: 0 });
  }
  return res;
}

function deny(req: NextRequest, reason: 'unauthorized' | 'forbidden') {
  const status = reason === 'forbidden' ? 403 : 401;

  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: reason }, { status });
  }

  // No access to THIS tool, but a valid identity: sending them to /login would
  // be a lie — signing in again changes nothing. Show why instead.
  if (reason === 'forbidden') {
    const url = req.nextUrl.clone();
    url.pathname = '/no-access';
    url.search = '';
    return NextResponse.rewrite(url);
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set(
    'next',
    req.nextUrl.pathname === '/' ? '/' : req.nextUrl.pathname + (req.nextUrl.search || ''),
  );
  return NextResponse.redirect(loginUrl);
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Static + public paths bypass auth.
  if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  // /api/clients — reachable by a machine holding READ_ONLY_TOKEN, but only to
  // READ. Master Inbox calls this server-to-server for each client's plan and
  // has no cookie; once DASHBOARD_PASSWORD was set it started getting 401s and
  // silently fell back to null plans.
  //
  // Narrow on purpose: this path is NOT added to PUBLIC_PATH_PREFIXES, because
  // that would wave POST/PATCH/DELETE through as well. GET only, correct token
  // only — and the route handler checks again, so this is a convenience, not
  // the security boundary.
  if (pathname === '/api/clients' && req.method === 'GET') {
    const expected = process.env.READ_ONLY_TOKEN;
    const supplied = req.headers.get('x-admin-token');
    if (expected && supplied && supplied === expected) return NextResponse.next();
  }

  const ssoSecret = process.env.BS_SSO_SECRET;
  const password = process.env.DASHBOARD_PASSWORD;

  // --- 1. SSO -------------------------------------------------------------
  if (ssoSecret) {
    const token = readSsoCookie(req.headers.get('cookie'));
    const session = await verifySso(ssoSecret, token);

    if (session) {
      if (!hasGrant(session, TOOL)) return deny(req, 'forbidden');

      const res = NextResponse.next();
      // Downstream server components read these instead of re-verifying.
      res.headers.set('x-bs-user', session.email);
      res.headers.set('x-bs-grants', session.grants.join(','));
      return applyEmbedCookie(req, res);
    }
    // No valid SSO token — fall through to the password gate rather than
    // rejecting, so the app stays reachable during the rollout.
  }

  // --- 2. Shared team password (legacy) -----------------------------------
  if (password) {
    const cookie = req.cookies.get(AUTH_COOKIE)?.value;
    if (cookie && cookie === (await expectedCookieValue(password))) {
      return applyEmbedCookie(req, NextResponse.next());
    }
    return deny(req, 'unauthorized');
  }

  // --- 3. Nothing configured ----------------------------------------------
  if (!ssoSecret) {
    // Genuinely unconfigured: behave as before so a fresh checkout runs.
    return applyEmbedCookie(req, NextResponse.next());
  }

  // SSO is configured but this request had no valid token, and there is no
  // password fallback. Fail closed.
  return deny(req, 'unauthorized');
}

export const config = {
  // Skip Next.js static assets + Next-served images + favicons.
  matcher: ['/((?!_next/static|_next/image|favicon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)'],
};
