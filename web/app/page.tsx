import { OntologyDashboard } from './ontology-dashboard';
import { loadSnapshot } from './supabase-snapshot';

export const dynamic = 'force-dynamic';

export default async function Home() {
  let current;
  try {
    current = await loadSnapshot();
  } catch {
    return <main className="data-unavailable"><section><b>TF://SUPABASE</b><h1>Canonical data unavailable</h1><p>ThesisForge will not substitute a stale local copy. Restore the Supabase connection or publish a fresh dashboard snapshot.</p></section></main>;
  }
  return <OntologyDashboard initialData={current} />;
}
