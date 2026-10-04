/**
 * ShapeCast forge: remote MCP server for the claude.ai custom connector.
 * Phase 0b exposes probe tools only (status, payload size, file argument).
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createOAuth, type OAuth } from './oauth.js';

export interface ForgeConfig {
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  ownerPassphrase: string;
  comfyUrl: string;
  stateFile: string | null;
}

const MAX_BODY = 25 * 1024 * 1024; // a 16 MiB staged file arrives as ~21 MiB of base64

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function send(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
const json = (
  res: ServerResponse,
  status: number,
  obj: unknown,
  headers: Record<string, string> = {},
) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...headers });

async function comfyStatus(comfyUrl: string) {
  const get = async (path: string) => {
    const r = await fetch(`${comfyUrl}${path}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  try {
    const [stats, queue] = await Promise.all([get('/system_stats'), get('/queue')]);
    const running = queue.queue_running?.length ?? 0,
      pending = queue.queue_pending?.length ?? 0;
    const dev = stats.devices?.[0];
    return {
      alienpc: running + pending > 0 ? 'busy' : 'available',
      queue: { running, pending },
      gpu: dev?.name ?? null,
      vramFreeMB: dev?.vram_free ? Math.round(dev.vram_free / 1048576) : null,
      comfyui: stats.system?.comfyui_version ?? null,
    };
  } catch (e) {
    return { alienpc: 'unavailable', reason: (e as Error).message };
  }
}

function buildMcp(cfg: ForgeConfig): McpServer {
  const server = new McpServer({ name: 'shapecast-forge', version: '0.1.0' });
  const result = (obj: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
    structuredContent: obj,
  });
  server.registerTool(
    'forge_status',
    {
      description:
        'Report whether AlienPC (the GPU machine running ComfyUI) can take a 3D generation job right now: available, busy, or unavailable.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => result(await comfyStatus(cfg.comfyUrl)),
  );
  server.registerTool(
    'forge_probe_payload',
    {
      description:
        'Diagnostic: return a text payload of the requested size in KiB with its SHA-256, to measure how large a tool result can reach the caller.',
      inputSchema: { kb: z.number().int().min(1).max(32768) },
      annotations: { readOnlyHint: true },
    },
    async ({ kb }) => {
      const unit = 'ShapeCastForgePayloadProbe0123456789abcdefghijklmnopqrstuvwxyzABCDEF-'; // 64 chars
      const data = unit.repeat(Math.ceil((kb * 1024) / unit.length)).slice(0, kb * 1024);
      return result({ kb, data, sha256: createHash('sha256').update(data).digest('hex') });
    },
  );
  server.registerTool(
    'forge_probe_file',
    {
      description:
        'Diagnostic: receive a file as base64 and report its byte count and SHA-256, to test sending photos to the forge.',
      inputSchema: { name: z.string().max(200), base64: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ name, base64 }) => {
      const bytes = Buffer.from(base64, 'base64');
      return result({
        name,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    },
  );
  return server;
}

function loadState(oauth: OAuth, file: string | null) {
  if (!file) return;
  try {
    oauth.importState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    /* first run */
  }
}
function saveState(oauth: OAuth, file: string | null) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(oauth.exportState()), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function createForgeServer(cfg: ForgeConfig): Server {
  const oauth = createOAuth(cfg);
  loadState(oauth, cfg.stateFile);
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const started = Date.now();
    res.on('finish', () =>
      console.log(
        `${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`,
      ),
    );
    try {
      if (
        req.method === 'GET' &&
        (path === '/.well-known/oauth-protected-resource' ||
          path === '/.well-known/oauth-protected-resource/mcp')
      )
        return json(res, 200, oauth.protectedResourceMetadata());
      if (
        req.method === 'GET' &&
        (path === '/.well-known/oauth-authorization-server' ||
          path === '/.well-known/openid-configuration')
      )
        return json(res, 200, oauth.authorizationServerMetadata());
      if (path === '/authorize' && req.method === 'GET') {
        const r = oauth.authorizePage(url.searchParams);
        return send(res, r.status, r.body ?? '', r.headers);
      }
      if (path === '/authorize' && req.method === 'POST') {
        const r = oauth.authorizeSubmit(new URLSearchParams(await readBody(req)));
        return send(res, r.status, r.body ?? '', r.headers);
      }
      if (path === '/token' && req.method === 'POST') {
        const r = oauth.token(new URLSearchParams(await readBody(req)), req.headers.authorization);
        if (r.status === 200) saveState(oauth, cfg.stateFile);
        return json(res, r.status, r.json);
      }
      if (path === '/mcp') {
        const auth = oauth.checkBearer(req.headers.authorization);
        if (!auth.ok)
          return json(
            res,
            401,
            { error: 'unauthorized' },
            { 'WWW-Authenticate': auth.wwwAuthenticate },
          );
        if (req.method !== 'POST')
          return json(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
        const body = JSON.parse(await readBody(req));
        const server = buildMcp(cfg);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      if (path === '/healthz') return json(res, 200, { ok: true });
      return json(res, 404, { error: 'not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      console.error(`${req.method} ${path} failed: ${(e as Error).message}`);
      if (!res.headersSent)
        json(res, status, { error: status === 413 ? 'payload too large' : 'internal error' });
    }
  });
}

// Entry point: node dist/server.js (env from ~/.env.shared via the pm2 wrapper)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const need = (k: string) => {
    const v = process.env[k];
    if (!v) {
      console.error(`missing env ${k}`);
      process.exit(1);
    }
    return v;
  };
  const port = Number(process.env.FORGE_PORT ?? 3420);
  const srv = createForgeServer({
    publicUrl: need('FORGE_PUBLIC_URL'),
    clientId: need('FORGE_CLIENT_ID'),
    clientSecret: need('FORGE_CLIENT_SECRET'),
    ownerPassphrase: need('FORGE_OWNER_PASSPHRASE'),
    comfyUrl: process.env.FORGE_COMFY_URL ?? 'http://10.0.0.24:8188',
    stateFile: join(homedir(), '.local/state/shapecast-forge/oauth.json'),
  });
  srv.listen(port, '127.0.0.1', () =>
    console.log(`shapecast-forge listening on 127.0.0.1:${port}`),
  );
}
