/**
 * Single-owner OAuth 2.1 authorization server for the ShapeCast forge connector.
 *
 * Model: one confidential client (id + secret entered once in claude.ai's "Use your own OAuth
 * client" fields), redirects pinned to claude.ai's hosted callback, PKCE S256 required, and an
 * owner passphrase on the authorize page as a second lock. Tokens are opaque random strings;
 * only their SHA-256 hashes are kept in memory or exported for persistence.
 *
 * Requirements followed: https://claude.com/docs/connectors/building/authentication
 * (401 + resource_metadata, resource equals the MCP URL, first authorization server wins,
 * form-urlencoded token endpoint, rotating refresh tokens, invalid_grant on bad refresh).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

export interface OAuthConfig {
  publicUrl: string; // e.g. https://host.ts.net:10000 (no trailing slash)
  clientId: string;
  clientSecret: string;
  ownerPassphrase: string;
  now?: () => number;
  codeTtlMs?: number;
  accessTtlMs?: number;
  refreshTtlMs?: number;
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
}
interface CodeEntry extends Expiring {
  challenge: string;
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

export function createOAuth(cfg: OAuthConfig) {
  const now = cfg.now ?? Date.now;
  const codeTtl = cfg.codeTtlMs ?? 5 * 60 * 1000;
  const accessTtl = cfg.accessTtlMs ?? 60 * 60 * 1000;
  const refreshTtl = cfg.refreshTtlMs ?? 30 * 24 * 60 * 60 * 1000;
  const codes = new Map<string, CodeEntry>();
  const access = new Map<string, Expiring>();
  const refresh = new Map<string, Expiring>();
  const base = cfg.publicUrl.replace(/\/$/, '');
  const resource = `${base}/mcp`;

  const gc = (m: Map<string, Expiring>) => {
    const t = now();
    for (const [k, v] of m) if (v.exp <= t) m.delete(k);
  };

  function validateAuthRequest(p: URLSearchParams): string | null {
    if (p.get('response_type') !== 'code') return 'response_type must be code';
    if (!p.get('client_id') || !safeEqual(p.get('client_id')!, cfg.clientId))
      return 'unknown client_id';
    if (p.get('redirect_uri') !== CLAUDE_CALLBACK)
      return 'redirect_uri is not the claude.ai callback';
    if (p.get('code_challenge_method') !== 'S256') return 'code_challenge_method must be S256';
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(p.get('code_challenge') ?? ''))
      return 'code_challenge missing or malformed';
    return null;
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

  function clientAuth(form: URLSearchParams, authorization?: string): boolean {
    let id = form.get('client_id') ?? '',
      secret = form.get('client_secret') ?? '';
    if (authorization?.startsWith('Basic ')) {
      const raw = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const i = raw.indexOf(':');
      id = decodeURIComponent(raw.slice(0, i));
      secret = decodeURIComponent(raw.slice(i + 1));
    }
    return !!secret && safeEqual(id, cfg.clientId) && safeEqual(secret, cfg.clientSecret);
  }

  function issue(): TokenResult {
    const a = token(),
      r = token(),
      t = now();
    access.set(sha(a), { exp: t + accessTtl });
    refresh.set(sha(r), { exp: t + refreshTtl });
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
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        scopes_supported: ['forge'],
      };
    },
    checkBearer(header: string | undefined): { ok: boolean; wwwAuthenticate: string } {
      const www = `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`;
      if (!header?.startsWith('Bearer ')) return { ok: false, wwwAuthenticate: www };
      const e = access.get(sha(header.slice(7).trim()));
      return { ok: !!e && e.exp > now(), wwwAuthenticate: www };
    },
    authorizePage(p: URLSearchParams): HttpResult {
      const bad = validateAuthRequest(p);
      if (bad)
        return {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
          body: `Invalid authorization request: ${bad}`,
        };
      return {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
        body: page(p, ''),
      };
    },
    authorizeSubmit(p: URLSearchParams): HttpResult {
      const bad = validateAuthRequest(p);
      if (bad)
        return {
          status: 400,
          headers: { 'Content-Type': 'text/plain' },
          body: `Invalid authorization request: ${bad}`,
        };
      if (!safeEqual(p.get('passphrase') ?? '', cfg.ownerPassphrase))
        return {
          status: 401,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
          body: page(p, 'Wrong passphrase.'),
        };
      const code = token();
      codes.set(sha(code), { exp: now() + codeTtl, challenge: p.get('code_challenge')! });
      const loc = new URL(CLAUDE_CALLBACK);
      loc.searchParams.set('code', code);
      if (p.get('state')) loc.searchParams.set('state', p.get('state')!);
      return { status: 302, headers: { Location: loc.toString() } };
    },
    token(form: URLSearchParams, authorization?: string): TokenResult {
      if (!clientAuth(form, authorization))
        return { status: 401, json: { error: 'invalid_client' } };
      const grant = form.get('grant_type');
      if (grant === 'authorization_code') {
        const key = sha(form.get('code') ?? '');
        const entry = codes.get(key);
        codes.delete(key); // single use, even on failure
        if (!entry || entry.exp <= now()) return grantError('code unknown, used or expired');
        if (form.get('redirect_uri') && form.get('redirect_uri') !== CLAUDE_CALLBACK)
          return grantError('redirect_uri mismatch');
        const v = form.get('code_verifier') ?? '';
        if (!safeEqual(createHash('sha256').update(v).digest('base64url'), entry.challenge))
          return grantError('PKCE verification failed');
        return issue();
      }
      if (grant === 'refresh_token') {
        const key = sha(form.get('refresh_token') ?? '');
        const entry = refresh.get(key);
        refresh.delete(key); // rotation: the old refresh token dies here
        if (!entry || entry.exp <= now())
          return grantError('refresh_token unknown, used or expired');
        return issue();
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
