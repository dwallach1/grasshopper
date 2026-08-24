import { DurableObject } from 'cloudflare:workers';

import type { XBookmark, XBookmarkPayload, XContextAnnotation } from './bookmarks';
import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  parseJson,
  type JsonObject,
  type JsonValue,
} from '@thesisforge/shared/json';

type TokenResponse = JsonObject & {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

type StoredToken = {
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
};

const MAX_X_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_BOOKMARKS = 1000;
const MAX_PAGES = 10;
const SYNC_LEASE_MS = 5 * 60_000;
const SCOPES = ['tweet.read', 'users.read', 'bookmark.read', 'offline.access'];

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

async function boundedJson(response: Response): Promise<JsonValue> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_X_RESPONSE_BYTES) throw new Error('X response exceeded its size limit');
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_X_RESPONSE_BYTES) {
        await reader.cancel('response size limit exceeded');
        throw new Error('X response exceeded its size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(output);
  return text ? parseJson(text) : null;
}

function isTokenResponse(value: JsonValue): value is TokenResponse {
  return isJsonObject(value)
    && isJsonString(value.access_token)
    && (value.refresh_token === undefined || isJsonString(value.refresh_token))
    && (value.expires_in === undefined || isJsonNumber(value.expires_in))
    && (value.token_type === undefined || isJsonString(value.token_type))
    && (value.scope === undefined || isJsonString(value.scope));
}

function optionalString(value: JsonValue | undefined): string | undefined {
  return isJsonString(value) ? value : undefined;
}

function contextAnnotation(value: JsonValue): XContextAnnotation | null {
  if (!isJsonObject(value)) return null;
  const domain = isJsonObject(value.domain) ? {
    id: optionalString(value.domain.id),
    name: optionalString(value.domain.name),
    description: optionalString(value.domain.description),
  } : undefined;
  const entity = isJsonObject(value.entity) ? {
    id: optionalString(value.entity.id),
    name: optionalString(value.entity.name),
    description: optionalString(value.entity.description),
  } : undefined;
  return { domain, entity };
}

function bookmarkFromJson(value: JsonValue): XBookmark | null {
  if (!isJsonObject(value) || !isJsonString(value.id)) return null;
  const urls = isJsonObject(value.entities) && Array.isArray(value.entities.urls)
    ? value.entities.urls.flatMap((candidate) => {
        if (!isJsonObject(candidate)) return [];
        return [{
          url: optionalString(candidate.url),
          expanded_url: optionalString(candidate.expanded_url),
          display_url: optionalString(candidate.display_url),
        }];
      })
    : undefined;
  const annotations = Array.isArray(value.context_annotations)
    ? value.context_annotations.flatMap((candidate) => {
        const parsed = contextAnnotation(candidate);
        return parsed ? [parsed] : [];
      })
    : undefined;
  return {
    id: value.id,
    author_id: optionalString(value.author_id),
    created_at: optionalString(value.created_at),
    text: optionalString(value.text),
    entities: urls ? { urls } : undefined,
    context_annotations: annotations,
    raw_json: JSON.stringify(value),
  };
}

export type XVaultEnvironment = {
  X_ACCESS_TOKEN?: string;
  X_REFRESH_TOKEN?: string;
  X_CLIENT_ID: string;
  X_CLIENT_SECRET?: string;
  X_REDIRECT_URI: string;
};

export class XCredentialVault extends DurableObject<XVaultEnvironment> {
  constructor(ctx: DurableObjectState, env: XVaultEnvironment) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        create table if not exists credential (
          singleton integer primary key check(singleton=1),
          access_token text not null,
          refresh_token text,
          expires_at integer,
          updated_at integer not null
        );
        create table if not exists oauth_state (
          state text primary key,
          verifier text not null,
          redirect_uri text not null,
          expires_at integer not null
        );
        create table if not exists sync_lease (
          singleton integer primary key check(singleton=1),
          expires_at integer not null
        );
      `);
    });
  }

  private storedToken(): StoredToken | null {
    const rows = this.ctx.storage.sql.exec<StoredToken>(
      'select access_token, refresh_token, expires_at from credential where singleton=1',
    ).toArray();
    return rows[0] || null;
  }

  private bootstrapToken(): StoredToken {
    const stored = this.storedToken();
    if (stored) return stored;
    if (!this.env.X_ACCESS_TOKEN) throw new Error('X credential vault has not been authorized');
    const token = {
      access_token: this.env.X_ACCESS_TOKEN,
      refresh_token: this.env.X_REFRESH_TOKEN || null,
      expires_at: null,
    };
    this.persistToken(token);
    return token;
  }

  private persistToken(token: StoredToken): void {
    this.ctx.storage.sql.exec(
      `insert into credential(singleton,access_token,refresh_token,expires_at,updated_at)
       values (1,?,?,?,?)
       on conflict(singleton) do update set access_token=excluded.access_token,
         refresh_token=excluded.refresh_token, expires_at=excluded.expires_at,
         updated_at=excluded.updated_at`,
      token.access_token,
      token.refresh_token,
      token.expires_at,
      Date.now(),
    );
  }

  private async requestToken(body: URLSearchParams, operation: string): Promise<StoredToken> {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    if (this.env.X_CLIENT_SECRET) {
      headers.set('authorization', `Basic ${btoa(`${this.env.X_CLIENT_ID}:${this.env.X_CLIENT_SECRET}`)}`);
    }
    const response = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body });
    const payload = await boundedJson(response);
    if (!response.ok || !isTokenResponse(payload)) throw new Error(`${operation} failed with status ${response.status}`);
    const previous = this.storedToken();
    const token = {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || previous?.refresh_token || null,
      expires_at: Number.isFinite(payload.expires_in) ? Date.now() + Number(payload.expires_in) * 1000 : null,
    };
    this.persistToken(token);
    return token;
  }

  private async refreshToken(current: StoredToken): Promise<StoredToken> {
    if (!current.refresh_token) throw new Error('X refresh token is unavailable; reauthorization is required');
    return this.requestToken(new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
      client_id: this.env.X_CLIENT_ID,
    }), 'X token refresh');
  }

  private async xFetch(path: string, retry = true): Promise<JsonValue> {
    let token = this.bootstrapToken();
    if (token.expires_at !== null && token.expires_at <= Date.now() + 60_000) token = await this.refreshToken(token);
    const response = await fetch(`https://api.x.com${path}`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    });
    if (response.status === 401 && retry) {
      await this.refreshToken(token);
      return this.xFetch(path, false);
    }
    const payload = await boundedJson(response);
    if (!response.ok) throw new Error(`X API failed with status ${response.status}`);
    return payload;
  }

  async authorizationUrl(redirectUri: string): Promise<string> {
    if (redirectUri !== this.env.X_REDIRECT_URI) throw new Error('X redirect URI is not approved');
    const verifierBytes = new Uint8Array(64);
    const stateBytes = new Uint8Array(24);
    crypto.getRandomValues(verifierBytes);
    crypto.getRandomValues(stateBytes);
    const verifier = base64Url(verifierBytes);
    const state = base64Url(stateBytes);
    const challenge = await sha256Base64Url(verifier);
    this.ctx.storage.sql.exec('delete from oauth_state where expires_at < ?', Date.now());
    this.ctx.storage.sql.exec(
      'insert into oauth_state(state,verifier,redirect_uri,expires_at) values (?,?,?,?)',
      state,
      verifier,
      redirectUri,
      Date.now() + 10 * 60_000,
    );
    const url = new URL('https://x.com/i/oauth2/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.env.X_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SCOPES.join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  async completeAuthorization(code: string, state: string, redirectUri: string): Promise<{ authorized: true }> {
    const row = this.ctx.storage.sql.exec<{ verifier: string; redirect_uri: string; expires_at: number }>(
      'select verifier,redirect_uri,expires_at from oauth_state where state=?',
      state,
    ).toArray()[0];
    if (!row || row.expires_at < Date.now() || row.redirect_uri !== redirectUri || redirectUri !== this.env.X_REDIRECT_URI) {
      throw new Error('X OAuth state is invalid or expired');
    }
    await this.requestToken(new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: row.verifier,
      client_id: this.env.X_CLIENT_ID,
    }), 'X authorization exchange');
    this.ctx.storage.sql.exec('delete from oauth_state where state=?', state);
    return { authorized: true };
  }

  async fetchBookmarks(): Promise<XBookmarkPayload> {
    const lease = this.ctx.storage.sql.exec<{ expires_at: number }>(
      'select expires_at from sync_lease where singleton=1',
    ).toArray()[0];
    if (lease && lease.expires_at > Date.now()) throw new Error('An X bookmark synchronization is already running');
    this.ctx.storage.sql.exec(
      `insert into sync_lease(singleton,expires_at) values(1,?)
       on conflict(singleton) do update set expires_at=excluded.expires_at`,
      Date.now() + SYNC_LEASE_MS,
    );
    try {
      const user = await this.xFetch('/2/users/me');
      const userRecord = isJsonObject(user) && isJsonObject(user.data) ? user.data : null;
      const userId = isJsonString(userRecord?.id) ? userRecord.id : null;
      if (!userRecord || !userId) throw new Error('X did not return the authorized user id');
      const bookmarks: XBookmark[] = [];
      let paginationToken: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_PAGES && bookmarks.length < MAX_BOOKMARKS; pageNumber += 1) {
        const params = new URLSearchParams({
          max_results: '100',
          'tweet.fields': 'created_at,author_id,public_metrics,entities,context_annotations,lang,referenced_tweets',
          expansions: 'author_id,referenced_tweets.id',
          'user.fields': 'username,name,verified,description,public_metrics',
        });
        if (paginationToken) params.set('pagination_token', paginationToken);
        const value = await this.xFetch(`/2/users/${encodeURIComponent(userId)}/bookmarks?${params.toString()}`);
        const page = isJsonObject(value) ? value : {};
        if (Array.isArray(page.data)) {
          bookmarks.push(...page.data.flatMap((candidate) => {
            const bookmark = bookmarkFromJson(candidate);
            return bookmark ? [bookmark] : [];
          }));
        }
        const meta = isJsonObject(page.meta) ? page.meta : null;
        paginationToken = isJsonString(meta?.next_token) ? meta.next_token : undefined;
        if (!paginationToken) break;
      }
      return {
        fetchedAt: new Date().toISOString(),
        user: { id: userId },
        bookmarks: bookmarks.slice(0, MAX_BOOKMARKS),
      };
    } finally {
      this.ctx.storage.sql.exec('delete from sync_lease where singleton=1');
    }
  }

  async status(): Promise<{ configured: boolean; refreshable: boolean; updatedAt: number | null }> {
    const row = this.ctx.storage.sql.exec<{ refresh_token: string | null; updated_at: number }>(
      'select refresh_token,updated_at from credential where singleton=1',
    ).toArray()[0];
    return {
      configured: Boolean(row || this.env.X_ACCESS_TOKEN),
      refreshable: Boolean(row?.refresh_token || this.env.X_REFRESH_TOKEN),
      updatedAt: row?.updated_at || null,
    };
  }
}
