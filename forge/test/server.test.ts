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
  it('lists the seven forge tools after initialize', async () => {
    await rpc('initialize', init);
    const list = await rpc('tools/list', {});
    expect(list.result.tools.map((t: any) => t.name).sort()).toEqual([
      'forge_blender',
      'forge_generate',
      'forge_job',
      'forge_probe_file',
      'forge_probe_payload',
      'forge_refine',
      'forge_status',
    ]);
  });
  it('forge_status reports AlienPC unavailable within 5 seconds when ComfyUI is down', async () => {
    const t0 = Date.now();
    const r = await rpc('tools/call', { name: 'forge_status', arguments: {} });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.result.structuredContent.alienpc).toBe('unavailable');
  }, 10000);
  it('forge_generate fails fast when AlienPC is unavailable', async () => {
    const r = await rpc('tools/call', {
      name: 'forge_generate',
      arguments: { prompt: '1970 chevy chevelle' },
    });
    expect(r.result.structuredContent.ok).toBe(false);
    expect(r.result.structuredContent.alienpc).toBe('unavailable');
  });
  it('forge_generate and forge_job manage single-job lifecycle and fail fast when busy', async () => {
    const { createServer: createHttp } = await import('node:http');
    const fakeComfy = createHttp((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/queue') {
        res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
      } else {
        res.end(
          JSON.stringify({
            system: { comfyui_version: '0.37.0' },
            devices: [{ name: 'RTX 5080', vram_total: 16e9, vram_free: 14e9 }],
          }),
        );
      }
    });
    await new Promise<void>((r) => fakeComfy.listen(0, '127.0.0.1', r));
    const comfyPort = (fakeComfy.address() as AddressInfo).port;

    let releaseJob!: () => void;
    const gate = new Promise<void>((r) => {
      releaseJob = r;
    });

    const srv2 = createForgeServer({
      publicUrl: 'https://forge.example',
      clientId: CLIENT,
      clientSecret: SECRET,
      ownerPassphrase: PASS,
      comfyUrl: `http://127.0.0.1:${comfyPort}`,
      stateFile: null,
      pipelineRunner: async (opts) => {
        opts.onStage?.('mesh_generation');
        await gate;
        return {
          name: opts.name ?? 'test-car',
          slug: 'test-car',
          bbox: {
            min: [-20, -50, 0],
            max: [20, 50, 30],
            size: [40, 100, 30],
          },
          volumeMm3: 48000,
          volumeMl: 48,
          triangleCount: 12,
          manifold: { ok: true, errors: [] },
          checks: [{ id: 'fit', level: 'ok', title: 'Fits build volume', detail: '40x100x30 mm' }],
          worst: 'ok',
          layers: 600,
          stlBytes: Buffer.alloc(684),
          stlFilename: '2026-10-18-test-car.stl',
          stlPath: 'C:\\Users\\matth\\Documents\\ShapeCast\\2026-10-18-test-car.stl',
          deliveredToAlienPc: true,
          preview: {
            format: 'indexed-f32-u16-v1',
            vertexCount: 8,
            triangleCount: 12,
            isFullMesh: true,
            vertsBase64: Buffer.alloc(96).toString('base64'),
            indicesBase64: Buffer.alloc(72).toString('base64'),
          },
        };
      },
    });
    await new Promise<void>((r) => srv2.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${(srv2.address() as AddressInfo).port}`;

    // Authenticate against srv2
    const verifier = 'y'.repeat(50);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const a = await fetch(`${base2}/authorize`, {
      method: 'POST',
      body: new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT,
        redirect_uri: CLAUDE_CALLBACK,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 's',
        passphrase: PASS,
      }),
      redirect: 'manual',
    });
    const code = new URL(a.headers.get('location')!).searchParams.get('code')!;
    const tok = (
      await (
        await fetch(`${base2}/token`, {
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
        })
      ).json()
    ).access_token;

    const call2 = async (name: string, args: unknown) => {
      const res = await fetch(`${base2}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${tok}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      });
      const txt = await res.text();
      const line = txt.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(line ? line.slice(6) : txt).result.structuredContent;
    };

    try {
      const start = await call2('forge_generate', { prompt: '1970 chevy chevelle', targetMm: 100 });
      expect(start.ok).toBe(true);
      expect(start.jobId).toMatch(/^job_/);

      // Second concurrent job must fail fast with alienpc: 'busy'
      const second = await call2('forge_generate', { prompt: 'another car' });
      expect(second.ok).toBe(false);
      expect(second.alienpc).toBe('busy');

      // Polling while running returns running status
      const running = await call2('forge_job', { jobId: start.jobId });
      expect(running.status).toBe('running');
      expect(running.stage).toBe('mesh_generation');

      // Release job and verify completion
      releaseJob();
      await new Promise((r) => setTimeout(r, 30));
      const done = await call2('forge_job', { jobId: start.jobId });
      expect(done.status).toBe('done');
      expect(done.manifold.ok).toBe(true);
      expect(done.stlPath).toContain('ShapeCast');
      expect(done.preview.isFullMesh).toBe(true);
    } finally {
      await new Promise<void>((r) => srv2.close(() => r()));
      await new Promise<void>((r) => fakeComfy.close(() => r()));
    }
  });
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
