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
    setNotice(error ? error.message : 'Passkey registered');
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
