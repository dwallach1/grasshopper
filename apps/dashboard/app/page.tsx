import { OntologyDashboard } from './ontology-dashboard';
import { loadSnapshot } from './supabase-snapshot';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let current;
  try {
    current = await loadSnapshot();
  } catch (error) {
    console.error(
      'Canonical dashboard snapshot unavailable:',
      error instanceof Error ? error.message : 'unknown error',
    );
    return (
      <main className="data-unavailable">
        <section>
          <b>Supabase</b>
          <h1>Canonical data unavailable</h1>
          <p>
            Quantanamo will not substitute a stale local copy. Check{' '}
            <code>apps/dashboard/.dev.vars</code> (see <code>.dev.vars.prod.example</code> for live
            production), or restore the Supabase connection and publish a fresh dashboard snapshot.
          </p>
        </section>
      </main>
    );
  }
  return <OntologyDashboard initialData={current} />;
}
