// Reading the signed-in user inside server components.
//
// The middleware has already verified the SSO token; re-verifying here would be
// a second HMAC on every render for no extra safety, so it forwards the result
// as request headers and this reads them back.
//
// Safe because these headers are set by OUR middleware on the way in. Next
// strips inbound request headers of the same name before middleware runs, so a
// client cannot inject `x-bs-user` and impersonate someone.

import { headers } from 'next/headers';
import { ALL_TOOLS, type ToolId } from './bs-auth';

export interface CurrentUser {
  email: string;
  grants: ToolId[];
}

/** The signed-in user, or null when running under the legacy team password. */
export async function currentUser(): Promise<CurrentUser | null> {
  const h = await headers();
  const email = h.get('x-bs-user');
  if (!email) return null;

  const claimed = (h.get('x-bs-grants') ?? '').split(',').filter(Boolean);
  return {
    email,
    grants: ALL_TOOLS.filter((t) => claimed.includes(t)),
  };
}

/**
 * True when this app is rendered inside a Command Center pane, in which case it
 * must not draw its own logo/header — the workspace already provides one.
 */
export async function isEmbedded(): Promise<boolean> {
  const { cookies } = await import('next/headers');
  return (await cookies()).get('bs_embed')?.value === '1';
}
