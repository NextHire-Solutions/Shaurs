'use client';

import { useState } from 'react';

export default function LoginForm({ next, error: initialError }: { next: string; error: string | null }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, next }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? 'Invalid password');
        setSubmitting(false);
        return;
      }
      // Full navigation so SSR picks up the new cookie.
      window.location.href = next || '/';
    } catch {
      setError('Network error — try again');
      setSubmitting(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">BrokerStaffer</div>
        <div className="login-title">Client Health Dashboard</div>
        <div className="login-sub">Enter the team password to continue</div>
        <form onSubmit={onSubmit} className="login-form">
          <input
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="login-input"
            required
          />
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={submitting || !password} className="login-btn">
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
