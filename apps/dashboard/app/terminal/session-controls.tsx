'use client';

import { useState } from 'react';

import { createBrowserSupabase } from '../../lib/supabase-browser';

export function SessionControls({ email }: { email: string }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function registerPasskey() {
    setBusy(true);
    setNotice(null);
    const supabase = createBrowserSupabase();
    const { error } = await supabase.auth.registerPasskey();
    setBusy(false);
    if (!error) {
      setNotice('Passkey registered');
      return;
    }
    const origin = window.location.origin;
    if (error.code === 'webauthn_verification_failed' || /credential verification failed/i.test(error.message)) {
      setNotice(
        origin === 'http://localhost:5173'
          ? 'Passkey origin was rejected. Stay on http://localhost:5173 (not 127.0.0.1) and retry.'
          : `Passkeys need http://localhost:5173. You are on ${origin}.`,
      );
      return;
    }
    setNotice(error.message);
  }

  return (
    <div className="term-session">
      <span title={email}>{email}</span>
      <button type="button" disabled={busy} onClick={() => void registerPasskey()}>
        {busy ? '…' : 'Passkey+'}
      </button>
      <form action="/auth/sign-out" method="post">
        <button type="submit">Sign out</button>
      </form>
      {notice && <i>{notice}</i>}
    </div>
  );
}
