'use client';

import { useState } from 'react';

import { DESK_CALLBACK_PATH } from '../../lib/auth-callback';
import { deskAuthErrorMessage } from '../../lib/auth-search';
import type { DeskAuthMethods } from '../../lib/auth-methods';
import type { OAuthProviderId } from '../../lib/auth-public';
import { createBrowserSupabase } from '../../lib/supabase-browser';

function callbackUrl(): string {
  return `${window.location.origin}${DESK_CALLBACK_PATH}`;
}

function providerLabel(id: OAuthProviderId): string {
  if (id === 'github') return 'GitHub';
  if (id === 'google') return 'Google';
  if (id === 'azure') return 'Microsoft';
  if (id === 'apple') return 'Apple';
  if (id === 'gitlab') return 'GitLab';
  return 'Bitbucket';
}

export function SignInScreen({
  denied,
  methods,
  authError,
  loopbackHint,
}: {
  denied: boolean;
  methods: DeskAuthMethods;
  authError: string | null;
  loopbackHint: boolean;
}) {
  const [error, setError] = useState<string | null>(() => deskAuthErrorMessage(denied, authError));
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function oauth(provider: OAuthProviderId) {
    setBusy(provider);
    setError(null);
    const supabase = createBrowserSupabase();
    const { data, error: signInError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: callbackUrl(), skipBrowserRedirect: true },
    });
    if (signInError) {
      setError(signInError.message);
      setBusy(null);
      return;
    }
    if (data.url) window.location.assign(data.url);
    setBusy(null);
  }

  async function passkey() {
    setBusy('passkey');
    setError(null);
    const supabase = createBrowserSupabase();
    const { error: signInError } = await supabase.auth.signInWithPasskey();
    if (signInError) {
      setError(signInError.message);
      setBusy(null);
      return;
    }
    window.location.assign('/');
  }

  async function emailLink() {
    setBusy('email');
    setError(null);
    setSent(false);
    const supabase = createBrowserSupabase();
    const { error: signInError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: callbackUrl() },
    });
    if (signInError) {
      setError(signInError.message);
      setBusy(null);
      return;
    }
    setSent(true);
    setBusy(null);
  }

  return (
    <main className="term-gate">
      <header className="term-top">
        <span className="term-brand">QNMO</span>
        <span className="term-live">desk locked</span>
      </header>
      <section className="term-gate-card">
        <b>QUANTANAMO</b>
        <h1>Operator sign-in</h1>
        <p>
          Authenticate to read the live ledger. The publishable key stays in the browser; the secret
          key never does.
        </p>
        {error && (
          <p className="term-gate-error" role="alert">
            {error}
          </p>
        )}
        {methods.passkeys && loopbackHint && (
          <p className="term-gate-note">
            Passkeys need WebAuthn RP ID <code>localhost</code>. Open{' '}
            <a href="http://localhost:5173">http://localhost:5173</a> instead of 127.0.0.1.
          </p>
        )}
        {methods.passkeys && (
          <button type="button" className="term-gate-primary" disabled={busy !== null} onClick={() => void passkey()}>
            {busy === 'passkey' ? 'Waiting on authenticator…' : 'Passkey'}
          </button>
        )}
        {methods.email && (
          <>
            <div className="term-gate-split">Email link</div>
            <form
              className="term-gate-email"
              suppressHydrationWarning
              onSubmit={(event) => {
                event.preventDefault();
                void emailLink();
              }}
            >
              <input
                type="email"
                name="email"
                autoComplete="username"
                placeholder="operator@…"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              <button type="submit" className="term-gate-secondary" disabled={busy !== null || email.trim() === ''}>
                {busy === 'email' ? 'Sending…' : 'Send magic link'}
              </button>
            </form>
            {sent && (
              <p className="term-gate-note">
                Check your inbox. Open the link so it returns here — <code>localhost</code> and{' '}
                <code>127.0.0.1</code> do not share the PKCE cookie.
              </p>
            )}
          </>
        )}
        {methods.oauth.length > 0 && (
          <>
            <div className="term-gate-split">OAuth</div>
            {methods.oauth.map((provider) => (
              <button
                key={provider}
                type="button"
                className="term-gate-secondary"
                disabled={busy !== null}
                onClick={() => void oauth(provider)}
              >
                {busy === provider ? `Redirecting to ${providerLabel(provider)}…` : `Continue with ${providerLabel(provider)}`}
              </button>
            ))}
          </>
        )}
        {methods.oauth.length === 0 && (
          <p className="term-gate-note">
            No social OAuth providers are enabled on this project yet. Use email once, then{' '}
            <code>Passkey+</code> in the header. To add GitHub/Google: Authentication → Providers, then
            this screen picks them up automatically.
          </p>
        )}
        <p className="term-gate-note">
          First confirmed sign-in claims the operator desk. Later accounts need a row in{' '}
          <code>ledger_operators</code>.
        </p>
      </section>
    </main>
  );
}
