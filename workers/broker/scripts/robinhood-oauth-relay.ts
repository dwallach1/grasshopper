const HOSTNAME = '127.0.0.1';
const PORT = 18789;
const CLOUD_CALLBACK = new URL(
  'https://quantanamo-broker-gateway.davidwallach2.workers.dev/broker/oauth/callback',
);
const OAUTH_STATE = /^[A-Za-z0-9_-]+\.robinhood$/;
const FORWARDED_PARAMETERS = ['code', 'state', 'error', 'error_description', 'error_uri'] as const;

const server = Bun.serve({
  hostname: HOSTNAME,
  port: PORT,
  fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      return new Response('Not found', { status: 404 });
    }

    const state = url.searchParams.get('state');
    const hasResult = url.searchParams.has('code') || url.searchParams.has('error');
    if (!state || !OAUTH_STATE.test(state) || !hasResult) {
      return new Response('Invalid OAuth callback', { status: 400 });
    }

    const target = new URL(CLOUD_CALLBACK);
    for (const key of FORWARDED_PARAMETERS) {
      const value = url.searchParams.get(key);
      if (value !== null) target.searchParams.set(key, value);
    }

    setTimeout(() => server.stop(), 500);
    return Response.redirect(target, 302);
  },
});

console.log(`Robinhood OAuth relay ready at http://${HOSTNAME}:${PORT}/callback`);
console.log('Waiting for one authorization callback; OAuth codes will not be logged.');
