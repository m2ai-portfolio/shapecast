/**
 * ShapeCast forge: remote MCP server for the claude.ai custom connector.
 * Exposes production tools (forge_status, forge_generate, forge_job) and Phase 0b diagnostic probes.
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
import {
  comfyStatus,
  runBlenderScriptOnAlienPc,
  runBlenderRefineOnAlienPc,
  type ForgePipelineOptions,
  type ForgePipelineResult,
} from './comfy.js';
import { createJobManager, type JobManager } from './jobs.js';

export interface ForgeConfig {
  publicUrl: string;
  clientId: string;
  clientSecret: string;
  ownerPassphrase: string;
  comfyUrl: string;
  stateFile: string | null;
  localOutDir?: string;
  skipScp?: boolean;
  pipelineRunner?: (opts: ForgePipelineOptions) => Promise<ForgePipelineResult>;
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

function buildMcp(cfg: ForgeConfig, jobs: JobManager): McpServer {
  const FORGE_VERSION = '2.9.0';
  const BLENDER_VERSION = '4.3.2';
  const server = new McpServer({ name: 'shapecast-forge', version: FORGE_VERSION });
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
    async () => {
      const st = await comfyStatus(cfg.comfyUrl);
      const active = jobs.activeJob();
      const lastDone = jobs.lastCompletedJob();
      if (active && st.alienpc === 'available') {
        return result({
          ...st,
          version: FORGE_VERSION,
          blender: BLENDER_VERSION,
          alienpc: 'busy',
          activeJob: { jobId: active.jobId, stage: active.stage, name: active.name },
          lastJobId: lastDone?.jobId ?? null,
        });
      }
      return result({
        ...st,
        version: FORGE_VERSION,
        blender: BLENDER_VERSION,
        activeJob: active ? { jobId: active.jobId, stage: active.stage, name: active.name } : null,
        lastJobId: lastDone?.jobId ?? null,
      });
    },
  );

  server.registerTool(
    'forge_generate',
    {
      description:
        'Start generating a watertight, Saturn 3-ready 3D mesh on AlienPC from a text prompt or an inline base64 JPEG photo. Fails fast if AlienPC is busy or offline. Poll forge_job with the returned jobId.',
      inputSchema: {
        prompt: z.string().max(1500).optional(),
        photoBase64: z.string().max(10_000_000).optional(),
        targetMm: z.number().min(10).max(218).optional(),
        name: z.string().max(80).optional(),
        seed: z.number().int().optional(),
        octreeResolution: z.number().int().min(192).max(512).optional(),
        steps: z.number().int().min(15).max(60).optional(),
        gridRes: z.number().int().min(180).max(520).optional(),
        maxVerts: z.number().int().min(20000).max(62000).optional(),
        smoothIterations: z.number().int().min(0).max(10).optional(),
        smoothFactor: z.number().min(0.05).max(1.0).optional(),
        aspectRatioTarget: z.tuple([z.number(), z.number(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      const r = await jobs.startJob(args);
      if (!r.ok) {
        return result({
          ok: false,
          status: 'error',
          alienpc: r.alienpc,
          error: r.reason,
        });
      }
      return result({
        ok: true,
        jobId: r.job.jobId,
        status: r.job.status,
        stage: r.job.stage,
        name: r.job.name,
        targetMm: r.job.targetMm,
      });
    },
  );

  server.registerTool(
    'forge_job',
    {
      description:
        'Check the status of a forge_generate job. When status is "done", returns the repaired preview mesh, bounding box, Saturn 3 print checks, quality metrics, and the STL file path written to AlienPC.',
      inputSchema: {
        jobId: z.string().min(1).max(80),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ jobId }) => {
      const job = jobs.getJob(jobId);
      if (!job) {
        return result({
          ok: false,
          jobId,
          status: 'not_found',
          error: `Unknown job ${jobId}`,
        });
      }
      const elapsedSec = +(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1);
      if (job.status === 'running') {
        return result({
          ok: true,
          jobId: job.jobId,
          status: 'running',
          stage: job.stage,
          name: job.name,
          targetMm: job.targetMm,
          elapsedSec,
        });
      }
      if (job.status === 'error' || !job.result) {
        return result({
          ok: false,
          jobId: job.jobId,
          status: 'error',
          stage: job.stage,
          name: job.name,
          elapsedSec,
          error: job.error ?? 'Generation failed',
        });
      }
      const res = job.result;
      return result({
        ok: true,
        jobId: job.jobId,
        status: 'done',
        stage: 'done',
        name: res.name,
        targetMm: job.targetMm,
        elapsedSec,
        bbox: res.bbox,
        volumeMm3: res.volumeMm3,
        volumeMl: res.volumeMl,
        triangleCount: res.triangleCount,
        manifold: res.manifold,
        checks: res.checks,
        worst: res.worst,
        layers: res.layers,
        stlFilename: res.stlFilename,
        stlPath: res.stlPath,
        deliveredToAlienPc: res.deliveredToAlienPc,
        rawGlbFilename: res.rawGlbFilename,
        qualityMetrics: res.qualityMetrics,
        preview: res.preview,
      });
    },
  );

  server.registerTool(
    'forge_refine',
    {
      description:
        'Fast 3-second Blender 4.3 refinement pass on the raw Hunyuan3D GLB on AlienPC. Re-runs OpenVDB voxel remeshing at higher grid resolution (up to 340), crisp smoothing, higher adaptive vertex budget (up to 60,000 verts / ~120,000 tris), and optional real-world aspect-ratio correction [1.0, widthRatio, heightRatio].',
      inputSchema: {
        rawGlbFilename: z.string().max(120).optional(),
        name: z.string().max(80).optional(),
        targetMm: z.number().min(10).max(218).optional(),
        gridRes: z.number().int().min(200).max(520).optional(),
        maxVerts: z.number().int().min(25000).max(62000).optional(),
        smoothIterations: z.number().int().min(0).max(8).optional(),
        smoothFactor: z.number().min(0.05).max(1.0).optional(),
        aspectRatioTarget: z.tuple([z.number(), z.number(), z.number()]).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async (args) => {
      try {
        const res = await runBlenderRefineOnAlienPc({
          comfyUrl: cfg.comfyUrl,
          rawGlbFilename: args.rawGlbFilename,
          name: args.name ?? 'refined-model',
          targetMm: args.targetMm ?? 120,
          gridRes: args.gridRes ?? 320,
          maxVerts: args.maxVerts ?? 58000,
          smoothIterations: args.smoothIterations ?? 1,
          smoothFactor: args.smoothFactor ?? 0.25,
          aspectRatioTarget: args.aspectRatioTarget,
          localOutDir: cfg.localOutDir,
          skipScp: cfg.skipScp,
        });
        return result({
          ok: true,
          status: 'done',
          name: res.name,
          targetMm: args.targetMm ?? 120,
          bbox: res.bbox,
          volumeMm3: res.volumeMm3,
          volumeMl: res.volumeMl,
          triangleCount: res.triangleCount,
          manifold: res.manifold,
          checks: res.checks,
          worst: res.worst,
          layers: res.layers,
          stlFilename: res.stlFilename,
          stlPath: res.stlPath,
          deliveredToAlienPc: res.deliveredToAlienPc,
          rawGlbFilename: res.rawGlbFilename,
          qualityMetrics: res.qualityMetrics,
          preview: res.preview,
        });
      } catch (e) {
        return result({
          ok: false,
          status: 'error',
          error: (e as Error).message,
        });
      }
    },
  );

  server.registerTool(
    'forge_blender',
    {
      description:
        'Execute a headless Blender 4.3 Python (bpy) script on AlienPC, voxel-remesh and smooth the resulting geometry, write the binary STL to AlienPC, and return the watertight 3D preview mesh and Saturn 3 print checks.',
      inputSchema: {
        pythonCode: z.string().min(5).max(50_000),
        targetMm: z.number().min(10).max(218).optional(),
        name: z.string().max(80).optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ pythonCode, targetMm, name }) => {
      try {
        const res = await runBlenderScriptOnAlienPc({
          comfyUrl: cfg.comfyUrl,
          pythonCode,
          targetMm: targetMm ?? 120,
          name: name ?? 'blender-model',
          localOutDir: cfg.localOutDir,
          skipScp: cfg.skipScp,
        });
        return result({
          ok: true,
          status: 'done',
          name: res.name,
          targetMm: targetMm ?? 120,
          bbox: res.bbox,
          volumeMm3: res.volumeMm3,
          volumeMl: res.volumeMl,
          triangleCount: res.triangleCount,
          manifold: res.manifold,
          checks: res.checks,
          worst: res.worst,
          layers: res.layers,
          stlFilename: res.stlFilename,
          stlPath: res.stlPath,
          deliveredToAlienPc: res.deliveredToAlienPc,
          rawGlbFilename: res.rawGlbFilename,
          qualityMetrics: res.qualityMetrics,
          preview: res.preview,
        });
      } catch (e) {
        return result({
          ok: false,
          status: 'error',
          error: (e as Error).message,
        });
      }
    },
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
  const jobs = createJobManager({
    comfyUrl: cfg.comfyUrl,
    localOutDir: cfg.localOutDir,
    skipScp: cfg.skipScp,
    lastJobFile: cfg.stateFile ? join(dirname(cfg.stateFile), 'last-job.json') : null,
    runner: cfg.pipelineRunner,
  });
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
          path === '/.well-known/openid-configuration' ||
          path === '/' ||
          path === '/forge')
      )
        return json(res, 200, oauth.authorizationServerMetadata());
      if (path === '/authorize' && req.method === 'GET') {
        const r = await oauth.authorizePage(url.searchParams);
        return send(res, r.status, r.body ?? '', r.headers);
      }
      if (path === '/authorize' && req.method === 'POST') {
        const r = await oauth.authorizeSubmit(new URLSearchParams(await readBody(req)));
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
        const rpc = (Array.isArray(body) ? body : [body])
          .map((m: any) => m?.method ?? 'response')
          .join(',');
        res.on('finish', () => {
          if (res.statusCode >= 400)
            console.log(
              `  mcp ${rpc} protocol=${req.headers['mcp-protocol-version'] ?? '-'} accept=${req.headers.accept ?? '-'} -> ${res.statusCode}`,
            );
        });
        const proto = req.headers['mcp-protocol-version'];
        if (
          typeof proto === 'string' &&
          !['2024-11-05', '2025-03-26', '2025-06-18'].includes(proto)
        ) {
          req.headers['mcp-protocol-version'] = '2025-06-18';
        }
        const server = buildMcp(cfg, jobs);
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
