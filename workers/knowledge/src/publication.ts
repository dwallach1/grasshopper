import { boundedJson, parsePublicationResult, type PublicationResult } from '@quantanamo/contracts/publication';
import { readSecret, type SecretBinding } from '@quantanamo/shared/secrets';

export type PublicationEnvironment = {
  SUPABASE_URL: string;
  QUANTANAMO_PUBLICATION_TOKEN_SECRET: SecretBinding;
  QUANTANAMO_PUBLICATION_TOKEN?: string;
};

export async function publishDashboard(env: PublicationEnvironment): Promise<PublicationResult> {
  const publicationToken = await readSecret(
    env.QUANTANAMO_PUBLICATION_TOKEN_SECRET,
    'QUANTANAMO_PUBLICATION_TOKEN',
    env.QUANTANAMO_PUBLICATION_TOKEN,
  );
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/dashboard-publication`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-quantanamo-publication-token': publicationToken,
    },
    body: JSON.stringify({ publishCurrent: true }),
  });
  const value = await boundedJson(response);
  if (!response.ok) throw new Error(`Dashboard projection failed with status ${response.status}`);
  const result = parsePublicationResult(value);
  if (result.target_id !== 'current') {
    throw new Error('Dashboard projection returned an invalid safety contract');
  }
  return result;
}
