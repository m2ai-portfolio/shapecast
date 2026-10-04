import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createForgeServer } from '../src/server.js';
import { CLAUDE_CALLBACK } from '../src/oauth.js';

const CLIENT = 'cid',
  SECRET = 'csecret',
  PASS = 'pass';
let srv: Server, base: string, accessToken: string;

beforeAll(async () => {
  srv = createForgeServer({
    publicUrl: 'https://forge.example', // what clients see; tests talk to the local port
    clientId: CLIENT,
    clientSecret: SECRET,
    ownerPassphrase: PASS,
    comfyUrl: 'http://127.0.0.1:9', // discard port: nothing listens, so ComfyUI is "unavailable"
    stateFile: null,
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  // full OAuth dance
  const verifier = 'z'.repeat(50);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const form = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 's',
    passphrase: PASS,
  });
  const a = await fetch(`${base}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
  const code = new URL(a.headers.get('location')!).searchParams.get('code')!;
  const t = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT,
      client_secret: SECRET,
      redirect_uri: CLAUDE_CALLBACK,
    }),
  });
  accessToken = (await t.json()).access_token;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

const mcp = (body: unknown, auth = true) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(auth ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
async function rpc(method: string, params: unknown) {
  const r = await mcp({ jsonrpc: '2.0', id: 1, method, params });
  expect(r.status).toBe(200);
  const text = await r.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}
const init = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 't', version: '1' },
};

describe('forge server', () => {
  it('serves both discovery documents', async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm.resource).toBe('https://forge.example/mcp');
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as.token_endpoint).toBe('https://forge.example/token');
  });
  it('answers an unauthenticated MCP call with 401 and the resource_metadata pointer', async () => {
    const r = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }, false);
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://forge.example/.well-known/oauth-protected-resource/mcp"',
    );
  });
  it('lists the three probe tools after initialize', async () => {
    await rpc('initialize', init);
    const list = await rpc('tools/list', {});
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual([
      'forge_probe_file',
      'forge_probe_payload',
      'forge_status',
    ]);
  });
  it('forge_status reports AlienPC unavailable within 5 seconds when ComfyUI is down', async () => {
    const t0 = Date.now();
    const r = await rpc('tools/call', { name: 'forge_status', arguments: {} });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.result.structuredContent.alienpc).toBe('unavailable');
  }, 10000);
  it('forge_probe_payload returns exactly the requested size with a checksum', async () => {
    const r = await rpc('tools/call', { name: 'forge_probe_payload', arguments: { kb: 64 } });
    const p = r.result.structuredContent;
    expect(p.data.length).toBe(64 * 1024);
    expect(p.sha256).toBe(createHash('sha256').update(p.data).digest('hex'));
  });
  it('forge_probe_file reports byte count and checksum of the received file', async () => {
    const bytes = Buffer.from('hello forge');
    const r = await rpc('tools/call', {
      name: 'forge_probe_file',
      arguments: { name: 'a.png', base64: bytes.toString('base64') },
    });
    expect(r.result.structuredContent).toMatchObject({
      bytes: 11,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  });
});
