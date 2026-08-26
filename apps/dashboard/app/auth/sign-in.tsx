'use client';

import { useEffect, useState } from 'react';

import { oauthProviderIdsFromEnv, type OAuthProviderId } from '../../lib/auth-public';
import { createBrowserSupabase } from '../../lib/supabase-browser';

function providerLabel(id: OAuthProviderId): string {
  if (id === 'github') return 'GitHub';
  if (id === 'google') return 'Google';
  if (id === 'azure') return 'Microsoft';
  if (id === 'apple') return 'Apple';
  if (id === 'gitlab') return 'GitLab';
  return 'Bitbucket';
}

export function SignInScreen({ denied }: { denied: boolean }) {
  const [error, setError] = useState<string | null>(denied ? 'This account is not on the operator allowlist.' : null);
  const [busy, setBusy] = useState<string | null>(null);
  const providers = oauthProviderIdsFromEnv();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (authError) setError(authError);
  }, []);

  async function oauth(provider: OAuthProviderId) {
    setBusy(provider);
    setError(null);
    const supabase = createBrowserSupabase();
    const redirectTo = `${window.location.origin}/auth/callback`;
    const { data, error: signInError } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo, skipBrowserRedirect: true },
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

  return (
    <main className="term-gate">
      <header className="term-top">
        <span className="term-brand">QNMO</span>
        <span className="term-live">desk locked</span>
      </header>
      <section className="term-gate-card">
        <b>QUANTANAMO</b>
        <h1>Operator sign-in</h1>
        <p>Authenticate to read the live ledger. Passkeys and OAuth use your Supabase Auth project. The secret key never leaves the server.</p>
        {error && <p className="term-gate-error" role="alert">{error}</p>}
        <button type="button" className="term-gate-primary" disabled={busy !== null} onClick={() => void passkey()}>
          {busy === 'passkey' ? 'Waiting on authenticator…' : 'Passkey'}
        </button>
        <div className="term-gate-split">OAuth</div>
        {providers.map((provider) => (
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
        <p className="term-gate-note">First confirmed sign-in claims the operator desk. Later accounts need a row in <code>ledger_operators</code>.</p>
      </section>
    </main>
  );
}
