import { SignInScreen } from '../auth/sign-in';
import { TerminalApp } from './app';
import { loadDesk } from '../../lib/ledger';
import { readOperatorSession } from '../../lib/operator-session';

export const dynamic = 'force-dynamic';

export async function TerminalPage() {
  const session = await readOperatorSession();
  if (session === 'unauthenticated') {
    return <SignInScreen denied={false} />;
  }
  if (session === 'forbidden') {
    return <SignInScreen denied />;
  }
  const loaded = await loadDesk(session.accessToken)
    .then((desk) => ({ ok: true as const, desk }))
    .catch((error) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : 'unknown error',
    }));
  if (!loaded.ok) {
    return (
      <main className="data-unavailable">
        <section>
          <b>Ledger</b>
          <h1>Canonical data unavailable</h1>
          <p>
            Signed in as <code>{session.email}</code>, but the ledger query failed. Confirm operator
            RLS is applied and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> is the anon/publishable
            key. See <code>LOCAL.md</code>.
          </p>
          <p>
            <code>{loaded.message}</code>
          </p>
        </section>
      </main>
    );
  }
  return <TerminalApp initial={loaded.desk} operatorEmail={session.email} />;
}
