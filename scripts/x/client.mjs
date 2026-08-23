import { Buffer } from 'node:buffer';
import { updateEnv } from './env.mjs';


export class XClient {
  constructor(env) {
    this.env = env;
  }

  async fetch(path, retried = false) {
    const response = await fetch(`https://api.x.com${path}`, {
      headers: { authorization: `Bearer ${this.env.X_ACCESS_TOKEN}` },
    });

    if (response.status === 401 && this.env.X_REFRESH_TOKEN && !retried) {
      const token = await requestToken(new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.env.X_REFRESH_TOKEN,
        client_id: this.env.X_CLIENT_ID,
      }), this.env, 'Token refresh');
      this.env.X_ACCESS_TOKEN = token.access_token;
      if (token.refresh_token) this.env.X_REFRESH_TOKEN = token.refresh_token;
      updateEnv({
        X_ACCESS_TOKEN: this.env.X_ACCESS_TOKEN,
        X_REFRESH_TOKEN: this.env.X_REFRESH_TOKEN,
      });
      return this.fetch(path, true);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`X API failed (${response.status}): ${JSON.stringify(payload)}`);
    return payload;
  }
}


export function exchangeAuthorizationCode({ code, verifier, env }) {
  return requestToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.X_REDIRECT_URI,
    code_verifier: verifier,
    client_id: env.X_CLIENT_ID,
  }), env, 'Token exchange');
}


async function requestToken(body, env, operation) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (env.X_CLIENT_SECRET) {
    headers.authorization = `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString('base64')}`;
  }

  const response = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${operation} failed (${response.status}): ${JSON.stringify(payload)}`);
  return payload;
}
