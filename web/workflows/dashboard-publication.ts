import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import {
  boundedJson,
  isPublicationResult,
  type PublicationResult,
} from './publication-contract';

type PublicationParams = {
  publishCurrent?: boolean;
  requestedBy?: string;
};

export class DashboardPublicationWorkflow extends WorkflowEntrypoint<
  Cloudflare.Env,
  PublicationParams
> {
  async run(
    event: Readonly<WorkflowEvent<PublicationParams>>,
    step: WorkflowStep,
  ): Promise<PublicationResult> {
    const publishCurrent = event.payload.publishCurrent === true;
    const requestedBy = event.payload.requestedBy || 'manual';

    const result = await step.do(
      publishCurrent ? 'publish current dashboard snapshot' : 'publish shadow dashboard snapshot',
      {
        retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
        timeout: '2 minutes',
      },
      async (context) => {
        console.log(JSON.stringify({
          event: 'dashboard_publication_attempt',
          attempt: context.attempt,
          mode: publishCurrent ? 'current' : 'shadow',
          requestedBy,
        }));

        const response = await fetch(
          `${this.env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/dashboard-publication`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-thesisforge-publication-token': this.env.THESISFORGE_PUBLICATION_TOKEN,
            },
            body: JSON.stringify({
              publishCurrent,
            }),
          },
        );
        const body = await boundedJson(response);
        if (!response.ok) {
          console.error(JSON.stringify({
            event: 'dashboard_publication_failed',
            status: response.status,
            mode: publishCurrent ? 'current' : 'shadow',
          }));
          throw new Error(`Supabase publication failed with status ${response.status}`);
        }
        if (!isPublicationResult(body)) {
          throw new Error('Supabase publication returned an invalid result');
        }
        return body;
      },
    );

    await step.do('verify non-trading publication result', async () => {
      if (result.trading_enabled !== false) {
        throw new Error('Dashboard publication must never enable trading');
      }
      if (!publishCurrent && result.target_id !== 'cloudflare-shadow') {
        throw new Error('Shadow publication wrote to an unexpected target');
      }
      if (publishCurrent && result.target_id !== 'current') {
        throw new Error('Current publication wrote to an unexpected target');
      }
      console.log(JSON.stringify({
        event: 'dashboard_publication_complete',
        targetId: result.target_id,
        matchesCurrent: result.matches_current,
        changedKeys: result.changed_keys,
        thesisCount: result.thesis_count,
      }));
    });

    return result;
  }
}

const worker = {
  fetch(): Response {
    return new Response('Not found', { status: 404 });
  },
};

export default worker;
