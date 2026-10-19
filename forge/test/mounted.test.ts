import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { createForgeServer } from '../src/server.js';
import { CLAUDE_CALLBACK } from '../src/oauth.js';

// The forge mounted under a path on Funnel 443: https://host/forge -> 127.0.0.1:3420 (prefix stripped).
// /.well-known/oauth-authorization-server and /.well-known/openid-configuration are also mounted to it,
// so the issuer-with-path discovery forms arrive as "/" or "/forge".
let srv: Server, base: string;
beforeAll(async () => {
  srv = createForgeServer({
    publicUrl: 'https://host.example/forge',
    clientId: 'c',
    clientSecret: 's',
    ownerPassphrase: 'p',
    comfyUrl: 'http://127.0.0.1:9',
    stateFile: null,
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

describe('forge mounted under /forge', () => {
  it('advertises URLs under the mount path', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe('https://host.example/forge/mcp');
    expect(prm.authorization_servers).toEqual(['https://host.example/forge']);
    const as = await (await fetch(`${base}/.well-known/openid-configuration`)).json();
    expect(as.issuer).toBe('https://host.example/forge');
    expect(as.authorization_endpoint).toBe('https://host.example/forge/authorize');
  });
  it('serves authorization server metadata for the path-inserted discovery forms', async () => {
    for (const p of ['/', '/forge']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
      expect((await r.json()).issuer).toBe('https://host.example/forge');
    }
  });
  it('posts the passphrase form to the absolute mounted authorize URL', async () => {
    const challenge = createHash('sha256').update('v'.repeat(50)).digest('base64url');
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: 'c',
      redirect_uri: CLAUDE_CALLBACK,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const html = await (await fetch(`${base}/authorize?${q}`)).text();
    expect(html).toContain('action="https://host.example/forge/authorize"');
  });
});
