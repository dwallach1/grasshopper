import snapshot from '../data/ontology-snapshot.json';
import { OntologyDashboard } from './ontology-dashboard';
import { loadSnapshot } from './supabase-snapshot';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const current = await loadSnapshot(snapshot);
  return <OntologyDashboard initialData={current} />;
}
