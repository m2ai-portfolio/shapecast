/**
 * Single-owner OAuth 2.1 authorization server for the ShapeCast forge connector.
 *
 * Two ways for claude.ai to identify itself, both with redirects pinned to claude.ai's hosted
 * callback and PKCE S256 required:
 *  - Client ID Metadata Document (claude.ai's default "Use Claude's published identity"):
 *    client_id is an https://claude.ai/ URL whose document is fetched and checked; it is a
 *    public client, so no secret is involved.
 *  - A confidential client (id + secret entered under Advanced settings).
 * Either way the owner passphrase on the authorize page is the gate that proves it is you,
 * with a lockout after repeated wrong passphrases. Tokens are opaque random strings; only
 * their SHA-256 hashes are kept in memory or exported for persistence.
 *
 * Requirements followed: https://claude.com/docs/connectors/building/authentication and
 * https://claude.com/docs/connectors/building/lazy-authentication (CIMD section).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const CIMD_ORIGIN = 'https://claude.ai';

export interface OAuthConfig {
  publicUrl: string; // e.g. https://host.ts.net:10000 (no trailing slash)
  clientId: string;
  clientSecret: string;
  ownerPassphrase: string;
  now?: () => number;
  codeTtlMs?: number;
  accessTtlMs?: number;
  refreshTtlMs?: number;
  /** Fetch a client ID metadata document; injectable for tests. */
  fetchClientMetadata?: (url: string) => Promise<unknown>;
}

export interface HttpResult {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}
export interface TokenResult {
  status: number;
  json: Record<string, any>;
}
interface Expiring {
  exp: number;
  client?: string;
}
interface CodeEntry extends Expiring {
  challenge: string;
  client: string;
}
export interface OAuthState {
  access: [string, Expiring][];
  refresh: [string, Expiring][];
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token = () => randomBytes(32).toString('base64url');
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** A client id that is a claude.ai-hosted metadata document URL. */
export function isCimdId(id: string): boolean {
  try {
    const u = new URL(id);
    return u.origin === CIMD_ORIGIN && u.pathname.length > 1 && !u.search && !u.hash;
  } catch {
    return false;
  }
}

async function defaultFetchClientMetadata(url: string): Promise<unknown> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 20000) throw new Error('client metadata too large');
  return JSON.parse(text);
}

export function createOAuth(cfg: OAuthConfig) {
  const now = cfg.now ?? Date.now;
  const codeTtl = cfg.codeTtlMs ?? 5 * 60 * 1000;
  const accessTtl = cfg.accessTtlMs ?? 60 * 60 * 1000;
  const refreshTtl = cfg.refreshTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const fetchMeta = cfg.fetchClientMetadata ?? defaultFetchClientMetadata;
  const codes = new Map<string, CodeEntry>();
  const access = new Map<string, Expiring>();
  const refresh = new Map<string, Expiring>();
  const metaCache = new Map<string, { exp: number; reason: string | null }>();
  const failures: number[] = [];
  const LOCK_WINDOW = 15 * 60 * 1000,
    LOCK_AFTER = 5;
  const base = cfg.publicUrl.replace(/\/$/, '');
  const resource = `${base}/mcp`;

  const gc = (m: Map<string, Expiring>) => {
    const t = now();
    for (const [k, v] of m) if (v.exp <= t) m.delete(k);
  };

  async function checkCimd(url: string): Promise<string | null> {
    const hit = metaCache.get(url);
    if (hit && hit.exp > now()) return hit.reason;
    let reason: string | null = null;
    try {
      const doc = (await fetchMeta(url)) as Record<string, unknown> | null;
      if (doc?.client_id !== url) reason = 'client metadata client_id does not match its URL';
      else if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.includes(CLAUDE_CALLBACK))
        reason = 'client metadata does not list the claude.ai callback';
    } catch (e) {
      reason = `client metadata unavailable (${(e as Error).message})`;
    }
    metaCache.set(url, { exp: now() + 5 * 60 * 1000, reason });
    return reason;
  }

  async function validateAuthRequest(p: URLSearchParams): Promise<string | null> {
    if (p.get('response_type') !== 'code') return 'response_type must be code';
    if (p.get('redirect_uri') !== CLAUDE_CALLBACK)
      return 'redirect_uri is not the claude.ai callback';
    if (p.get('code_challenge_method') !== 'S256') return 'code_challenge_method must be S256';
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(p.get('code_challenge') ?? ''))
      return 'code_challenge missing or malformed';
    const id = p.get('client_id') ?? '';
    if (isCimdId(id)) return checkCimd(id);
    if (!id || !safeEqual(id, cfg.clientId)) return 'unknown client_id';
    return null;
  }

  function lockedOut(): boolean {
    const t = now();
    while (failures.length && failures[0] <= t - LOCK_WINDOW) failures.shift();
    return failures.length >= LOCK_AFTER;
  }

  function page(p: URLSearchParams, message: string): string {
    const hidden = [
      'response_type',
      'client_id',
      'redirect_uri',
      'code_challenge',
      'code_challenge_method',
      'state',
      'scope',
      'resource',
    ]
      .filter((k) => p.has(k))
      .map((k) => `<input type="hidden" name="${k}" value="${esc(p.get(k)!)}">`)
      .join('');
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShapeCast Forge sign-in</title>
<body style="font:16px system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<h1 style="font-size:20px">ShapeCast Forge</h1>
<p>claude.ai is asking to use your ShapeCast Forge connector, which runs 3D generation on AlienPC. Enter the owner passphrase to allow it.</p>
${message ? `<p style="color:#b3261e">${esc(message)}</p>` : ''}
<form method="post" action="/authorize">${hidden}
<label>Owner passphrase <input name="passphrase" type="password" autocomplete="current-password" required style="width:100%;padding:8px;margin-top:4px"></label>
<button style="margin-top:12px;padding:8px 16px">Allow</button></form></body>`;
  }

  /** The authenticated client id, or null. CIMD clients are public, so they carry no secret. */
  function clientAuth(form: URLSearchParams, authorization?: string): string | null {
    let id = form.get('client_id') ?? '',
      secret = form.get('client_secret') ?? '';
    if (authorization?.startsWith('Basic ')) {
      const raw = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      id = decodeURIComponent(raw.slice(0, i));
      secret = decodeURIComponent(raw.slice(i + 1));
    }
    if (isCimdId(id)) return id;
    return !!secret && safeEqual(id, cfg.clientId) && safeEqual(secret, cfg.clientSecret)
      ? id
      : null;
  }

  function issue(client: string): TokenResult {
    const a = token(),
      r = token(),
      t = now();
    access.set(sha(a), { exp: t + accessTtl, client });
    refresh.set(sha(r), { exp: t + refreshTtl, client });
    gc(access);
    gc(refresh);
    return {
      status: 200,
      json: {
        access_token: a,
        token_type: 'Bearer',
        expires_in: Math.floor(accessTtl / 1000),
        refresh_token: r,
      },
    };
  }
  const grantError = (desc: string): TokenResult => ({
    status: 400,
    json: { error: 'invalid_grant', error_description: desc },
  });
  const badRequest = (bad: string): HttpResult => ({
    status: 400,
    headers: { 'Content-Type': 'text/plain' },
    body: `Invalid authorization request: ${bad}`,
  });

  return {
    protectedResourceMetadata() {
      return {
        resource,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
        scopes_supported: ['forge'],
      };
    },
    authorizationServerMetadata() {
      return {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: [
          'none',
          'client_secret_post',
          'client_secret_basic',
        ],
        client_id_metadata_document_supported: true,
        scopes_supported: ['forge'],
      };
    },
    checkBearer(header: string | undefined): { ok: boolean; wwwAuthenticate: string } {
      const www = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
      if (!header?.startsWith('Bearer ')) return { ok: false, wwwAuthenticate: www };
      const e = access.get(sha(header.slice(7).trim()));
      return { ok: !!e && e.exp > now(), wwwAuthenticate: www };
    },
    async authorizePage(p: URLSearchParams): Promise<HttpResult> {
      const bad = await validateAuthRequest(p);
      if (bad) return badRequest(bad);
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: page(p, ''),
      };
    },
    async authorizeSubmit(p: URLSearchParams): Promise<HttpResult> {
      const bad = await validateAuthRequest(p);
      if (bad) return badRequest(bad);
      if (lockedOut())
        return {
          status: 429,
          headers: { 'Content-Type': 'text/plain', 'Retry-After': '900' },
          body: 'Too many wrong passphrases. Try again in 15 minutes.',
        };
      if (!safeEqual(p.get('passphrase') ?? '', cfg.ownerPassphrase)) {
        failures.push(now());
        return {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: page(p, 'Wrong passphrase.'),
        };
      }
      failures.length = 0;
      const code = token();
      codes.set(sha(code), {
        exp: now() + codeTtl,
        challenge: p.get('code_challenge')!,
        client: p.get('client_id')!,
      });
      const loc = new URL(CLAUDE_CALLBACK);
      loc.searchParams.set('code', code);
      if (p.get('state')) loc.searchParams.set('state', p.get('state')!);
      return { status: 302, headers: { Location: loc.toString() } };
    },
    token(form: URLSearchParams, authorization?: string): TokenResult {
      const client = clientAuth(form, authorization);
      if (!client) return { status: 401, json: { error: 'invalid_client' } };
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const key = sha(form.get('code') ?? '');
        const entry = codes.get(key);
        codes.delete(key); // single use, even on failure
        if (!entry || entry.exp <= now() || entry.client !== client)
          return grantError('code unknown, used, expired or issued to another client');
        if (form.get('redirect_uri') && form.get('redirect_uri') !== CLAUDE_CALLBACK)
          return grantError('redirect_uri mismatch');
        const v = form.get('code_verifier') ?? '';
        if (!safeEqual(createHash('sha256').update(v).digest('base64url'), entry.challenge))
          return grantError('PKCE verification failed');
        return issue(client);
      }
      if (grant === 'refresh_token') {
        const key = sha(form.get('refresh_token') ?? '');
        const entry = refresh.get(key);
        refresh.delete(key); // rotation: the old refresh token dies here
        if (!entry || entry.exp <= now() || (entry.client ?? cfg.clientId) !== client)
          return grantError('refresh_token unknown, used, expired or issued to another client');
        return issue(client);
      }
      return { status: 400, json: { error: 'unsupported_grant_type' } };
    },
    exportState(): OAuthState {
      gc(access);
      gc(refresh);
      return { access: [...access.entries()], refresh: [...refresh.entries()] };
    },
    importState(s: OAuthState) {
      const t = now();
      for (const [k, v] of s.access ?? []) if (v.exp > t) access.set(k, v);
      for (const [k, v] of s.refresh ?? []) if (v.exp > t) refresh.set(k, v);
    },
  };
}
export type OAuth = ReturnType<typeof createOAuth>;
