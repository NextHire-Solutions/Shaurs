// Shown when someone has a valid BrokerStaffer sign-in but has not been granted
// Client Health. Deliberately NOT a redirect to /login: they are already signed
// in, so signing in again would change nothing and the loop would be baffling.
//
// Reached by a middleware rewrite, so the URL they typed stays in the address
// bar — which matters, because the useful next step is usually "send this link
// to whoever can grant me access".

import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'No access — BrokerStaffer' };

export default async function NoAccessPage() {
  const email = (await headers()).get('x-bs-user');

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">BrokerStaffer</div>
        <div className="login-title">No access to Client Health</div>
        <div className="login-sub">
          {email ? (
            <>
              You&apos;re signed in as <strong>{email}</strong>, but this tool
              hasn&apos;t been shared with you yet.
            </>
          ) : (
            <>Your account doesn&apos;t have access to this tool yet.</>
          )}
        </div>
        <p style={{ fontSize: 13, color: '#6B7280', marginTop: 16, lineHeight: 1.5 }}>
          Ask a workspace admin to switch Client Health on for your account in
          Team access.
        </p>
        <a
          href={process.env.NEXT_PUBLIC_COMMAND_CENTER_URL ?? '/'}
          className="login-btn"
          style={{ display: 'block', textAlign: 'center', marginTop: 18, textDecoration: 'none' }}
        >
          Back to the workspace
        </a>
      </div>
    </div>
  );
}
