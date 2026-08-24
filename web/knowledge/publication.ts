import { boundedJson, isPublicationResult, type PublicationResult } from '../workflows/publication-contract';

export type PublicationEnvironment = {
  SUPABASE_URL: string;
  THESISFORGE_PUBLICATION_TOKEN: string;
};

export async function publishDashboard(env: PublicationEnvironment): Promise<PublicationResult> {
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/dashboard-publication`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-thesisforge-publication-token': env.THESISFORGE_PUBLICATION_TOKEN,
    },
    body: JSON.stringify({ publishCurrent: true }),
  });
  const value = await boundedJson(response);
  if (!response.ok) throw new Error(`Dashboard projection failed with status ${response.status}`);
  if (!isPublicationResult(value) || value.target_id !== 'current' || value.trading_enabled !== false) {
    throw new Error('Dashboard projection returned an invalid safety contract');
  }
  return value;
}
