import { describe, expect, test } from 'bun:test';

import { CaptureSchema, captureResearch } from '../../workers/knowledge/src/capture';
import { withDatabase } from '../../workers/knowledge/src/database';
import { rebuildKnowledgeGraph } from '../../workers/knowledge/src/graph';
import { publishDashboard } from '../../workers/knowledge/src/publication';
import { LOCAL } from './env';
import { ensureE2eThesis, isSupabaseReady, readCurrentSnapshot } from './harness';

const supabaseReady = await isSupabaseReady();

describe.skipIf(!supabaseReady)('local knowledge capture → publication e2e', () => {
  test('captures research into Postgres and refreshes the dashboard projection', async () => {
    const thesisId = await ensureE2eThesis();
    const statement = `E2E prediction ${Date.now()}: AI power demand stays elevated.`;

    const capture = CaptureSchema.parse({
      operation: 'prediction',
      thesis_id: thesisId,
      statement,
      probability: 72,
      key: `e2e-pred-${Date.now()}`,
    });

    const captured = await withDatabase(LOCAL.databaseUrl, (database) =>
      captureResearch(database, capture),
    );
    expect(captured).toMatchObject({ operation: 'prediction' });

    await withDatabase(LOCAL.databaseUrl, rebuildKnowledgeGraph);

    const publication = await publishDashboard({
      SUPABASE_URL: LOCAL.supabaseUrl,
      THESISFORGE_PUBLICATION_TOKEN: LOCAL.publicationToken,
      THESISFORGE_PUBLICATION_TOKEN_SECRET: undefined,
    });
    expect(publication.target_id).toBe('current');

    const snapshot = await readCurrentSnapshot();
    const predictions = snapshot.predictions as Array<{ statement?: string; thesis_id?: string }>;
    expect(predictions.some((row) => row.statement === statement && row.thesis_id === thesisId)).toBe(true);

    const theses = snapshot.theses as Array<{ id?: string }>;
    expect(theses.some((row) => row.id === thesisId)).toBe(true);
  });

  test('updates a thesis view and projects stance into the snapshot', async () => {
    const thesisId = await ensureE2eThesis();
    const variant = `E2E variant ${Date.now()}`;
    const falsifier = `E2E falsifier ${Date.now()}`;

    await withDatabase(LOCAL.databaseUrl, (database) =>
      captureResearch(database, CaptureSchema.parse({
        operation: 'thesis_view',
        thesis_id: thesisId,
        stance: 'bullish',
        variant,
        falsifier,
      })),
    );

    await publishDashboard({
      SUPABASE_URL: LOCAL.supabaseUrl,
      THESISFORGE_PUBLICATION_TOKEN: LOCAL.publicationToken,
      THESISFORGE_PUBLICATION_TOKEN_SECRET: undefined,
    });

    const snapshot = await readCurrentSnapshot();
    const theses = snapshot.theses as Array<{
      id?: string;
      stance?: string;
      variant_perception?: string;
      falsifier?: string;
    }>;
    const thesis = theses.find((row) => row.id === thesisId);
    expect(thesis).toMatchObject({
      stance: 'bullish',
      variant_perception: variant,
      falsifier,
    });
  });
});

if (!supabaseReady) {
  console.warn(
    '[e2e] Skipping knowledge capture tests — start local Supabase with `supabase start && supabase db reset`.',
  );
}
