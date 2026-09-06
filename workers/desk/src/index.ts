import { DESK_API_HEADERS, handleDeskApi } from './desk-api';

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const workerFirst = path.startsWith('/api/')
      || path.startsWith('/internal/')
      || path === '/leaderboard'
      || path === '/catalysts'
      || path === '/ontology'
      || path === '/risk'
      || path === '/runs'
      || path === '/learnings'
      || path === '/mates';

    if (!workerFirst) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleDeskApi(request, env);
    } catch (error) {
      console.error(JSON.stringify({
        event: 'desk_worker_error',
        error: error instanceof Error ? error.message : 'unknown',
      }));
      return new Response(JSON.stringify({ error: 'Desk snapshot unavailable' }), {
        status: 503,
        headers: { ...DESK_API_HEADERS, 'Cache-Control': 'no-store' },
      });
    }
  },
} satisfies ExportedHandler<Env>;
