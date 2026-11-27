import { DESK_API_HEADERS, handleDeskApi } from './desk-api';
import { errorFields, warmDeskBundleIfSession } from './desk-live';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const workerFirst = path.startsWith('/api/')
      || path.startsWith('/internal/')
      || path === '/leaderboard'
      || path === '/board'
      || path === '/ranks'
      || path === '/catalysts'
      || path === '/books'
      || path === '/theses'
      || path === '/ontology'
      || path === '/risk'
      || path === '/runs'
      || path === '/learnings'
      || path === '/mates';

    if (!workerFirst) {
      return env.ASSETS.fetch(request);
    }

    try {
      return await handleDeskApi(request, env, undefined, ctx);
    } catch (error) {
      const fields = errorFields(error);
      console.error(JSON.stringify({
        event: 'desk_worker_error',
        error: fields.error,
        name: fields.name,
      }));
      return new Response(JSON.stringify({ error: 'Desk ledger unavailable' }), {
        status: 503,
        headers: { ...DESK_API_HEADERS, 'Cache-Control': 'no-store' },
      });
    }
  },

  async scheduled(_controller, env, _ctx): Promise<void> {
    try {
      await warmDeskBundleIfSession(env);
    } catch (error) {
      const fields = errorFields(error);
      console.error(JSON.stringify({
        event: 'desk_bundle_warm_failed',
        error: fields.error,
        name: fields.name,
      }));
    }
  },
} satisfies ExportedHandler<Env>;
