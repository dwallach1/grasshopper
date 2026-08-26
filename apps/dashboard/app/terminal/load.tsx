import { TerminalApp } from './app';
import { loadDesk } from '../../lib/ledger';

export const dynamic = 'force-dynamic';

export async function TerminalPage() {
  const loaded = await loadDesk()
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
            The local terminal reads live Supabase tables, not a mock. Set{' '}
            <code>QUANTANAMO_DATABASE_URL</code> or <code>SUPABASE_SECRET_KEY</code> in the repo-root{' '}
            <code>.env.local</code>. See <code>LOCAL.md</code>.
          </p>
          <p>
            <code>{loaded.message}</code>
          </p>
        </section>
      </main>
    );
  }
  return <TerminalApp initial={loaded.desk} />;
}
