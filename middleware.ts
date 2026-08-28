// Password-gates every dashboard page. Redirects unauthenticated requests
// to /login, preserving the intended destination via ?next=.
//
// Auth model:
//   - Single shared password in DASHBOARD_PASSWORD env var.
//   - Session cookie value = HMAC-SHA256 of a fixed message keyed by the
//     current password (base64url). Deterministic per-password: rotating
//     the password invalidates every existing session automatically.
//   - Uses Web Crypto (works in both Edge and Node runtimes) so no
//     runtime override is needed.
//
// Public paths (no auth required):
//   - /login itself + /api/auth/* (obviously)
//   - Server-to-server API endpoints that carry their own tokens:
//     /api/clients/onboard (x-admin-token: ONBOARDING_TOKEN)
//     /api/clients/status  (x-admin-token: READ_ONLY_TOKEN)
//     /api/sync/run        (x-sync-secret: SYNC_SECRET, if set)
//
// Fail-open when DASHBOARD_PASSWORD is unset — matches how our other
// optional-token endpoints degrade (better to be reachable than to lock
// everyone out on a missing env var).

import { NextRequest, NextResponse } from 'next/server';

const AUTH_COOKIE = 'bs_auth';
const AUTH_MESSAGE = 'bs-dashboard-authed';

const PUBLIC_PATH_PREFIXES = [
  '/login',
  '/api/auth/',
  '/api/clients/onboard',
  '/api/clients/status',
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

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Static + public paths bypass auth.
  if (PUBLIC_PATH_PREFIXES.some((p) => pathname.startsWith(p))) return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return NextResponse.next(); // fail-open when unset

  const cookie = req.cookies.get(AUTH_COOKIE)?.value;
  if (cookie) {
    const expected = await expectedCookieValue(password);
    if (cookie === expected) return NextResponse.next();
  }

  // API routes: return 401 JSON so browser fetches from the dashboard
  // (Add/Edit/Delete Client, etc.) fail loudly instead of silently following
  // a redirect to /login. Page routes: redirect the browser to /login.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = '/login';
  loginUrl.searchParams.set('next', pathname === '/' ? '/' : pathname + (req.nextUrl.search || ''));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Skip Next.js static assets + Next-served images + favicons.
  matcher: ['/((?!_next/static|_next/image|favicon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$).*)'],
};
