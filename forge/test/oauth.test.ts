import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createOAuth, CLAUDE_CALLBACK, type OAuth } from '../src/oauth.js';

const PUBLIC = 'https://forge.example.ts.net:10000';
const CLIENT = 'shapecast-forge-test';
const SECRET = 'top-secret-value';
const PASS = 'owner-pass-phrase';
const verifier = 'v'.repeat(64);
const challenge = createHash('sha256').update(verifier).digest('base64url');

function make(now = () => 1_000_000): OAuth {
  return createOAuth({
    publicUrl: PUBLIC,
    clientId: CLIENT,
    clientSecret: SECRET,
    ownerPassphrase: PASS,
    now,
  });
}
const authParams = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-1',
    ...over,
  });

async function getCode(o: OAuth): Promise<string> {
  const r = await o.authorizeSubmit(authParams({ passphrase: PASS }));
  expect(r.status).toBe(302);
  const loc = new URL(r.headers!.Location);
  expect(loc.origin + loc.pathname).toBe(CLAUDE_CALLBACK);
  expect(loc.searchParams.get('state')).toBe('st-1');
  return loc.searchParams.get('code')!;
}
const tokenForm = (over: Record<string, string>) =>
  new URLSearchParams({ client_id: CLIENT, client_secret: SECRET, ...over });

describe('discovery metadata', () => {
  it('protected resource metadata names the exact MCP URL and the issuer first', () => {
    const m = make().protectedResourceMetadata();
    expect(m.resource).toBe(`${PUBLIC}/mcp`);
    expect(m.authorization_servers[0]).toBe(PUBLIC);
  });
  it('authorization server metadata advertises S256 PKCE and form token auth', () => {
    const m = make().authorizationServerMetadata();
    expect(m.issuer).toBe(PUBLIC);
    expect(m.authorization_endpoint).toBe(`${PUBLIC}/authorize`);
    expect(m.token_endpoint).toBe(`${PUBLIC}/token`);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    expect(m.token_endpoint_auth_methods_supported).toContain('client_secret_post');
  });
  it('an unauthenticated MCP request gets a 401 pointing at the resource metadata', () => {
    const r = make().checkBearer(undefined);
    expect(r.ok).toBe(false);
    expect(r.wwwAuthenticate).toBe(
      `Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe('authorize', () => {
  it('renders a passphrase form for a valid request', async () => {
    const r = await make().authorizePage(authParams());
    expect(r.status).toBe(200);
    expect(r.body).toContain('name="passphrase"');
    expect(r.body).toContain('claude.ai');
  });
  it('never redirects to a redirect_uri other than the claude.ai callback', async () => {
    const r = await make().authorizePage(authParams({ redirect_uri: 'https://evil.example/cb' }));
    expect(r.status).toBe(400);
    expect(r.headers?.Location).toBeUndefined();
  });
  it('rejects an unknown client and a missing or non-S256 PKCE challenge', async () => {
    expect((await make().authorizePage(authParams({ client_id: 'other' }))).status).toBe(400);
    expect((await make().authorizePage(authParams({ code_challenge_method: 'plain' }))).status).toBe(400);
    expect((await make().authorizePage(authParams({ code_challenge: '' }))).status).toBe(400);
  });
  it('a wrong passphrase issues no code and re-renders the form', async () => {
    const r = await make().authorizeSubmit(authParams({ passphrase: 'nope' }));
    expect(r.status).toBe(401);
    expect(r.headers?.Location).toBeUndefined();
  });
});

describe('token', () => {
  let o: OAuth;
  beforeEach(() => {
    o = make();
  });
  it('exchanges a code once, with the right verifier and client secret', async () => {
    const code = await getCode(o);
    const r = o.token(
      tokenForm({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    );
    expect(r.status).toBe(200);
    expect(r.json.token_type).toBe('Bearer');
    expect(o.checkBearer(`Bearer ${r.json.access_token}`).ok).toBe(true);
    const again = o.token(
      tokenForm({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    );
    expect(again.status).toBe(400);
    expect(again.json.error).toBe('invalid_grant');
  });
  it('rejects a wrong verifier, a wrong secret, and a missing secret', async () => {
    const c1 = await getCode(o);
    expect(
      o.token(
        tokenForm({
          grant_type: 'authorization_code',
          code: c1,
          code_verifier: 'x'.repeat(64),
          redirect_uri: CLAUDE_CALLBACK,
        }),
      ).json.error,
    ).toBe('invalid_grant');
    const c2 = await getCode(o);
    expect(
      o.token(
        tokenForm({
          grant_type: 'authorization_code',
          code: c2,
          code_verifier: verifier,
          redirect_uri: CLAUDE_CALLBACK,
          client_secret: 'bad',
        }),
      ).status,
    ).toBe(401);
    const c3 = await getCode(o);
    const noSecret = new URLSearchParams({
      client_id: CLIENT,
      grant_type: 'authorization_code',
      code: c3,
      code_verifier: verifier,
      redirect_uri: CLAUDE_CALLBACK,
    });
    expect(o.token(noSecret).status).toBe(401);
  });
  it('accepts HTTP Basic client authentication', async () => {
    const code = await getCode(o);
    const basic = 'Basic ' + Buffer.from(`${CLIENT}:${SECRET}`).toString('base64');
    const r = o.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
      basic,
    );
    expect(r.status).toBe(200);
  });
  it('rotates refresh tokens: the old one is invalid after use', async () => {
    const code = await getCode(o);
    const first = o.token(
      tokenForm({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    ).json;
    const second = o.token(
      tokenForm({ grant_type: 'refresh_token', refresh_token: first.refresh_token }),
    );
    expect(second.status).toBe(200);
    expect(second.json.refresh_token).not.toBe(first.refresh_token);
    const replay = o.token(
      tokenForm({ grant_type: 'refresh_token', refresh_token: first.refresh_token }),
    );
    expect(replay.json.error).toBe('invalid_grant');
  });
  it('expires access tokens and codes', async () => {
    let t = 1_000_000;
    const o2 = make(() => t);
    const code = await getCode(o2);
    t += 6 * 60 * 1000;
    expect(
      o2.token(
        tokenForm({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: CLAUDE_CALLBACK,
        }),
      ).json.error,
    ).toBe('invalid_grant');
    const code2 = await getCode(o2);
    const tok = o2.token(
      tokenForm({
        grant_type: 'authorization_code',
        code: code2,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    ).json;
    t += 2 * 60 * 60 * 1000;
    expect(o2.checkBearer(`Bearer ${tok.access_token}`).ok).toBe(false);
  });
  it('round-trips state through export/import with only token hashes stored', async () => {
    const code = await getCode(o);
    const tok = o.token(
      tokenForm({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    ).json;
    const saved = o.exportState();
    expect(JSON.stringify(saved)).not.toContain(tok.access_token);
    expect(JSON.stringify(saved)).not.toContain(tok.refresh_token);
    const o2 = make();
    o2.importState(saved);
    expect(o2.checkBearer(`Bearer ${tok.access_token}`).ok).toBe(true);
  });
});
