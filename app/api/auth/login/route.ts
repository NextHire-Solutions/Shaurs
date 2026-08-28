// Password login for the dashboard. Validates against DASHBOARD_PASSWORD env,
// sets an httpOnly session cookie whose value is deterministically derived
// from the password (so rotating the password invalidates every session).
// Mirrors the auth logic in middleware.ts so cookies stay compatible.

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AUTH_COOKIE = 'bs_auth';
const AUTH_MESSAGE = 'bs-dashboard-authed';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

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

// Constant-time-ish string compare — mitigates trivial timing side-channels.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const secret = process.env.DASHBOARD_PASSWORD;
  if (!secret) return NextResponse.json({ error: 'server misconfigured' }, { status: 500 });

  let body: { password?: unknown };
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const submitted = typeof body.password === 'string' ? body.password : '';
  if (!safeEqual(submitted, secret)) {
    return NextResponse.json({ error: 'Invalid password' }, { status: 401 });
  }

  const cookieValue = await expectedCookieValue(secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: AUTH_COOKIE,
    value: cookieValue,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}
