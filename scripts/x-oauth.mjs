import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { loadEnv, requireEnv, updateEnv } from './env.mjs';

const env = loadEnv();
requireEnv(env, ['X_CLIENT_ID', 'X_REDIRECT_URI']);

const scopes = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'];
const verifier = base64Url(randomBytes(64));
const challenge = base64Url(createHash('sha256').update(verifier).digest());
const state = base64Url(randomBytes(24));
const redirect = new URL(env.X_REDIRECT_URI);
const port = Number(redirect.port || (redirect.protocol === 'https:' ? 443 : 80));
const pathname = redirect.pathname;

const authUrl = new URL('https://x.com/i/oauth2/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', env.X_CLIENT_ID);
authUrl.searchParams.set('redirect_uri', env.X_REDIRECT_URI);
authUrl.searchParams.set('scope', scopes.join(' '));
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', challenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, env.X_REDIRECT_URI);
    if (url.pathname !== pathname) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const error = url.searchParams.get('error');
    if (error) throw new Error(`${error}: ${url.searchParams.get('error_description') || 'Authorization failed'}`);

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code && !returnedState) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<h1>Waiting for X authorization</h1><p>Open the authorization URL from Codex, then approve ThesisForge.</p>');
      return;
    }

    if (returnedState !== state) throw new Error('OAuth state did not match. Please retry.');
    if (!code) throw new Error('Missing OAuth code in callback.');

    const token = await exchangeCode({ code, verifier, env });
    updateEnv({
      X_ACCESS_TOKEN: token.access_token,
      X_REFRESH_TOKEN: token.refresh_token || env.X_REFRESH_TOKEN || '',
    });

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>X authorization complete</h1><p>You can return to Codex.</p>');
    console.log('\nAuthorization complete. Tokens were saved to .env.local.');
    server.close();
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(err.message);
    console.error(err);
    server.close(() => process.exitCode = 1);
  }
});

server.listen(port, redirect.hostname, () => {
  console.log('Open this URL in your browser and authorize ThesisForge:\n');
  console.log(authUrl.toString());
  console.log('\nWaiting for callback at', env.X_REDIRECT_URI);
});

function base64Url(buffer) {
  return buffer.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function exchangeCode({ code, verifier, env }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.X_REDIRECT_URI,
    code_verifier: verifier,
    client_id: env.X_CLIENT_ID,
  });

  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64')}`;
  }

  const response = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers,
    body,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Token exchange failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return payload;
}
