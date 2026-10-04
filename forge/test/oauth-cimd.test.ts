import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createOAuth, CLAUDE_CALLBACK } from '../src/oauth.js';

const PUBLIC = 'https://forge.example:10000';
const CIMD = 'https://claude.ai/oauth/hosted-client-metadata';
const PASS = 'owner-pass-phrase';
const verifier = 'q'.repeat(60);
const challenge = createHash('sha256').update(verifier).digest('base64url');

const goodDoc = {
  client_id: CIMD,
  client_name: 'Claude',
  redirect_uris: [CLAUDE_CALLBACK],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};
function make(docs: Record<string, unknown> = { [CIMD]: goodDoc }, now = () => 5_000_000) {
  let fetches = 0;
  const fetchDoc = async (url: string) => {
    fetches++;
    if (!(url in docs)) throw new Error('404');
    return docs[url];
  };
  const o = createOAuth({
    publicUrl: PUBLIC,
    clientId: 'conf',
    clientSecret: 'sec',
    ownerPassphrase: PASS,
    now,
    fetchClientMetadata: fetchDoc,
  });
  return { o, fetches: () => fetches };
}
const params = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: CIMD,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'x',
    ...over,
  });

describe('client ID metadata document (no client id or secret entered)', () => {
  it('advertises CIMD and public-client token auth in authorization server metadata', () => {
    const m = make().o.authorizationServerMetadata();
    expect(m.client_id_metadata_document_supported).toBe(true);
    expect(m.token_endpoint_auth_methods_supported).toContain('none');
  });
  it('accepts a claude.ai client document and names claude.ai on the consent page', async () => {
    const r = await make().o.authorizePage(params());
    expect(r.status).toBe(200);
    expect(r.body).toContain('claude.ai');
  });
  it('rejects client ids not hosted on https://claude.ai', async () => {
    const evil = 'https://evil.example/claude.ai/meta';
    const { o, fetches } = make({ [evil]: { ...goodDoc, client_id: evil } });
    expect((await o.authorizePage(params({ client_id: evil }))).status).toBe(400);
    expect((await o.authorizePage(params({ client_id: 'http://claude.ai/x' }))).status).toBe(400);
    expect(fetches()).toBe(0);
  });
  it('rejects a document whose client_id differs, or whose redirect_uris lack the callback', async () => {
    expect(
      (
        await make({
          [CIMD]: { ...goodDoc, client_id: 'https://claude.ai/other' },
        }).o.authorizePage(params())
      ).status,
    ).toBe(400);
    expect(
      (
        await make({
          [CIMD]: { ...goodDoc, redirect_uris: ['https://claude.ai/elsewhere'] },
        }).o.authorizePage(params())
      ).status,
    ).toBe(400);
    expect((await make({}).o.authorizePage(params())).status).toBe(400);
  });
  it('caches the document for five minutes', async () => {
    let t = 5_000_000;
    const { o, fetches } = make(undefined, () => t);
    await o.authorizePage(params());
    await o.authorizePage(params());
    expect(fetches()).toBe(1);
    t += 6 * 60 * 1000;
    await o.authorizePage(params());
    expect(fetches()).toBe(2);
  });
  it('completes the flow with PKCE and no client secret, and binds tokens to that client', async () => {
    const { o } = make();
    const a = await o.authorizeSubmit(params({ passphrase: PASS }));
    const code = new URL(a.headers!.Location).searchParams.get('code')!;
    const form = (over: Record<string, string>) =>
      new URLSearchParams({ client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, ...over });
    // the confidential client cannot redeem a code issued to the CIMD client
    const stolen = o.token(
      new URLSearchParams({
        client_id: 'conf',
        client_secret: 'sec',
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLAUDE_CALLBACK,
      }),
    );
    expect(stolen.json.error).toBe('invalid_grant');
    const a2 = await o.authorizeSubmit(params({ passphrase: PASS }));
    const code2 = new URL(a2.headers!.Location).searchParams.get('code')!;
    const r = o.token(
      form({ grant_type: 'authorization_code', code: code2, code_verifier: verifier }),
    );
    expect(r.status).toBe(200);
    const refreshed = o.token(
      form({ grant_type: 'refresh_token', refresh_token: r.json.refresh_token }),
    );
    expect(refreshed.status).toBe(200);
  });
  it('refuses a public-client token request for an unknown client id', () => {
    const r = make().o.token(
      new URLSearchParams({
        client_id: 'https://claude.ai/never-authorized',
        grant_type: 'refresh_token',
        refresh_token: 'x',
      }),
    );
    expect(r.status).toBe(400);
  });
});

describe('passphrase lockout', () => {
  it('locks the authorize form for 15 minutes after 5 wrong passphrases', async () => {
    let t = 5_000_000;
    const { o } = make(undefined, () => t);
    for (let i = 0; i < 5; i++)
      expect((await o.authorizeSubmit(params({ passphrase: 'wrong' }))).status).toBe(401);
    const locked = await o.authorizeSubmit(params({ passphrase: PASS }));
    expect(locked.status).toBe(429);
    expect(locked.headers?.Location).toBeUndefined();
    t += 16 * 60 * 1000;
    expect((await o.authorizeSubmit(params({ passphrase: PASS }))).status).toBe(302);
  });
});
