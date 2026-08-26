import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

import { bookmarkFromUnknown, type XBookmark, type XBookmarkPayload } from './bookmarks';
import { readBoundedJson } from '@quantanamo/shared/http';
import { REAUTH_OAUTH_ERRORS, TokenErrorSchema, xOauthFailureMessage } from './x-oauth';

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

const XUserMeSchema = z.object({
  data: z.object({
    id: z.string().min(1),
  }).passthrough(),
}).passthrough();

const XBookmarksPageSchema = z.object({
  data: z.array(z.unknown()).optional(),
  meta: z.object({
    next_token: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const XReadResponseSchema = z.object({
  data: z.array(z.unknown()).optional(),
  includes: z.object({
    tweets: z.array(z.unknown()).optional(),
    users: z.array(z.object({
      id: z.string(),
      username: z.string().optional(),
      name: z.string().optional(),
    }).passthrough()).optional(),
  }).passthrough().optional(),
}).passthrough();

export type XReadUser = { id: string; username: string | null; name: string | null };

/** Tweets pulled from X reads beyond the bookmark timeline (replies, quotes, searches). */
export type XReadPayload = {
  fetchedAt: string;
  tweets: XBookmark[];
  includedTweets: XBookmark[];
  users: XReadUser[];
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

/** Tweet fields shared by bookmark sync and compounding research reads. */
const TWEET_FIELDS = 'created_at,author_id,conversation_id,public_metrics,entities,context_annotations,lang,referenced_tweets';

/** Conservative self-imposed budgets so research crawling never exhausts the X API tier. */
const READ_BUDGET_WINDOW_MS = 15 * 60_000;
export const X_READ_BUDGETS = {
  search: 10,
  lookup: 30,
} as const;

export class XReadBudgetError extends Error {
  constructor(endpoint: string) {
    super(`x_read_budget_exhausted: ${endpoint} budget is exhausted for the current window`);
    this.name = 'XReadBudgetError';
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
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
        create table if not exists read_budget (
          endpoint text not null,
          window_start integer not null,
          used integer not null,
          primary key (endpoint, window_start)
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
    // Env secrets are a last-resort bootstrap after a new Worker/DO. Do not
    // persist them until a refresh or authorization exchange succeeds — the
    // wrangler copies go stale as soon as X rotates the refresh token.
    return {
      access_token: this.env.X_ACCESS_TOKEN,
      refresh_token: this.env.X_REFRESH_TOKEN || null,
      expires_at: null,
    };
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

  private clearStoredToken(): void {
    this.ctx.storage.sql.exec('delete from credential where singleton=1');
  }

  private async requestToken(body: URLSearchParams, operation: string): Promise<StoredToken> {
    const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
    if (this.env.X_CLIENT_SECRET) {
      headers.set('authorization', `Basic ${btoa(`${this.env.X_CLIENT_ID}:${this.env.X_CLIENT_SECRET}`)}`);
    }
    const response = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body });
    const payload = await readBoundedJson(response, MAX_X_RESPONSE_BYTES);
    if (!response.ok) {
      const message = xOauthFailureMessage(operation, response.status, payload);
      const parsed = TokenErrorSchema.safeParse(payload);
      const code = parsed.success ? parsed.data.error : undefined;
      console.error(JSON.stringify({
        event: 'x_oauth_token_failed',
        operation,
        status: response.status,
        error: code || null,
      }));
      if (response.status === 400 && (!code || REAUTH_OAUTH_ERRORS.has(code))) this.clearStoredToken();
      throw new Error(message);
    }
    const parsed = TokenResponseSchema.safeParse(payload);
    if (!parsed.success) throw new Error(`${operation} failed: token response was invalid`);
    const previous = this.storedToken();
    const token = {
      access_token: parsed.data.access_token,
      refresh_token: parsed.data.refresh_token || previous?.refresh_token || null,
      expires_at: Number.isFinite(parsed.data.expires_in)
        ? Date.now() + Number(parsed.data.expires_in) * 1000
        : null,
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

  private async authorizedFetch(path: string, accessToken: string): Promise<Response> {
    return fetch(`https://api.x.com${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  }

  private async xFetch(path: string): Promise<unknown> {
    let token = this.bootstrapToken();
    if (token.expires_at !== null && token.expires_at <= Date.now() + 60_000) token = await this.refreshToken(token);
    let response = await this.authorizedFetch(path, token.access_token);
    if (response.status === 401) {
      token = await this.refreshToken(token);
      response = await this.authorizedFetch(path, token.access_token);
    }
    const payload = await readBoundedJson(response, MAX_X_RESPONSE_BYTES);
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
      const user = XUserMeSchema.parse(await this.xFetch('/2/users/me'));
      const userId = user.data.id;
      const bookmarks: XBookmark[] = [];
      let paginationToken: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_PAGES && bookmarks.length < MAX_BOOKMARKS; pageNumber += 1) {
        const params = new URLSearchParams({
          max_results: '100',
          'tweet.fields': TWEET_FIELDS,
          expansions: 'author_id,referenced_tweets.id',
          'user.fields': 'username,name,verified,description,public_metrics',
        });
        if (paginationToken) params.set('pagination_token', paginationToken);
        const page = XBookmarksPageSchema.parse(
          await this.xFetch(`/2/users/${encodeURIComponent(userId)}/bookmarks?${params.toString()}`),
        );
        if (page.data) {
          bookmarks.push(...page.data.flatMap((candidate) => {
            const bookmark = bookmarkFromUnknown(candidate);
            return bookmark ? [bookmark] : [];
          }));
        }
        paginationToken = page.meta?.next_token;
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

  private consumeReadBudget(endpoint: keyof typeof X_READ_BUDGETS): void {
    const windowStart = Math.floor(Date.now() / READ_BUDGET_WINDOW_MS) * READ_BUDGET_WINDOW_MS;
    this.ctx.storage.sql.exec('delete from read_budget where window_start < ?', windowStart);
    const used = this.ctx.storage.sql.exec<{ used: number }>(
      'select used from read_budget where endpoint=? and window_start=?',
      endpoint,
      windowStart,
    ).toArray()[0]?.used ?? 0;
    if (used >= X_READ_BUDGETS[endpoint]) throw new XReadBudgetError(endpoint);
    this.ctx.storage.sql.exec(
      `insert into read_budget(endpoint,window_start,used) values (?,?,1)
       on conflict(endpoint,window_start) do update set used=read_budget.used+1`,
      endpoint,
      windowStart,
    );
  }

  private parseReadPayload(payload: unknown): XReadPayload {
    const parsed = XReadResponseSchema.parse(payload);
    const toBookmarks = (items: unknown[] | undefined): XBookmark[] =>
      (items ?? []).flatMap((candidate) => {
        const tweet = bookmarkFromUnknown(candidate);
        return tweet ? [tweet] : [];
      });
    return {
      fetchedAt: new Date().toISOString(),
      tweets: toBookmarks(parsed.data),
      includedTweets: toBookmarks(parsed.includes?.tweets),
      users: (parsed.includes?.users ?? []).map((user) => ({
        id: user.id,
        username: user.username ?? null,
        name: user.name ?? null,
      })),
    };
  }

  /** Recent-search read used for LLM-directed research hops. */
  async searchRecent(query: string, maxResults = 25): Promise<XReadPayload> {
    const trimmed = query.trim().slice(0, 256);
    if (!trimmed) throw new Error('X search query must not be empty');
    this.consumeReadBudget('search');
    const params = new URLSearchParams({
      query: trimmed,
      max_results: String(Math.max(10, Math.min(100, maxResults))),
      'tweet.fields': TWEET_FIELDS,
      expansions: 'author_id,referenced_tweets.id',
      'user.fields': 'username,name,verified,public_metrics',
    });
    return this.parseReadPayload(await this.xFetch(`/2/tweets/search/recent?${params.toString()}`));
  }

  /** Read the reply thread ("comments") under a bookmarked tweet. */
  async readConversation(conversationId: string, maxResults = 50): Promise<XReadPayload> {
    if (!/^\d{1,25}$/.test(conversationId)) throw new Error('X conversation id must be numeric');
    return this.searchRecent(`conversation_id:${conversationId}`, maxResults);
  }

  /** Hydrate quoted / referenced / LLM-requested tweets by id. */
  async lookupTweets(ids: string[]): Promise<XReadPayload> {
    const unique = [...new Set(ids.filter((id) => /^\d{1,25}$/.test(id)))].slice(0, 100);
    if (!unique.length) throw new Error('X tweet lookup requires at least one numeric id');
    this.consumeReadBudget('lookup');
    const params = new URLSearchParams({
      ids: unique.join(','),
      'tweet.fields': TWEET_FIELDS,
      expansions: 'author_id,referenced_tweets.id',
      'user.fields': 'username,name,verified,public_metrics',
    });
    return this.parseReadPayload(await this.xFetch(`/2/tweets?${params.toString()}`));
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
