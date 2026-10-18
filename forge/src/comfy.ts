/**
 * ComfyUI workflow runner and AlienPC STL delivery for ShapeCast Forge.
 * Only submits fixed workflow templates from forge/workflows/; user text only enters the CLIP prompt field.
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseGlbTriangles,
  repairAndPrepareMesh,
  writeBinaryStl,
  type PreparedMeshResult,
} from './mesh.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(__dirname, '..', 'workflows');

export interface ComfyStatusResult {
  alienpc: 'available' | 'busy' | 'unavailable';
  queue?: { running: number; pending: number };
  gpu?: string | null;
  vramFreeMB?: number | null;
  comfyui?: string | null;
  reason?: string;
}

export function slugify(name: string): string {
  return (
    String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'model'
  );
}

export function dateStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function comfyStatus(comfyUrl: string): Promise<ComfyStatusResult> {
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

export function buildFluxWorkflow(promptText: string, outputPrefix: string, seed = 731) {
  const wf = JSON.parse(
    readFileSync(join(WORKFLOWS_DIR, 'flux_text_to_reference.api.json'), 'utf8'),
  );
  const cleanPrompt = String(promptText).trim().slice(0, 1500);
  // Frame prompt so the entire object fits with margin on a plain white background
  wf['2'].inputs.text =
    `single 3D object centered in frame, whole object visible from front to back with generous white margin around all sides, plain white studio background, clean three-quarter product view, no floor shadow: ${cleanPrompt}`;
  wf['5'].inputs.seed = seed;
  wf['8'].inputs.filename_prefix = `shapecast/${outputPrefix}_ref`;
  return wf;
}

export function buildHunyuanWorkflow(inputImageName: string, outputPrefix: string, seed = 731) {
  const wf = JSON.parse(
    readFileSync(join(WORKFLOWS_DIR, 'hunyuan3d21_image_to_mesh.api.json'), 'utf8'),
  );
  wf['2'].inputs.image = inputImageName;
  wf['7'].inputs.seed = seed;
  wf['10'].inputs.filename_prefix = `shapecast/${outputPrefix}`;
  wf['24'].inputs.filename_prefix = `shapecast/${outputPrefix}_cutout`;
  return wf;
}

export async function runComfyWorkflow(
  comfyUrl: string,
  workflow: Record<string, any>,
  { pollMs = 1500, timeoutMs = 240_000 }: { pollMs?: number; timeoutMs?: number } = {},
): Promise<Record<string, any>> {
  const sub = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!sub.ok) {
    const errText = await sub.text().catch(() => '');
    throw new Error(`ComfyUI /prompt HTTP ${sub.status}: ${errText.slice(0, 200)}`);
  }
  const { prompt_id: promptId } = (await sub.json()) as { prompt_id: string };
  if (!promptId) throw new Error('ComfyUI did not return a prompt_id');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const hRes = await fetch(`${comfyUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!hRes.ok) continue;
    const hist = (await hRes.json()) as Record<string, any>;
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      const msgs = JSON.stringify(entry.status?.messages ?? []);
      throw new Error(`ComfyUI workflow failed: ${msgs.slice(0, 300)}`);
    }
    if (entry.outputs && Object.keys(entry.outputs).length > 0) {
      return entry.outputs;
    }
  }
  throw new Error(`ComfyUI workflow timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export async function fetchComfyView(
  comfyUrl: string,
  filename: string,
  subfolder = 'shapecast',
  type = 'output',
): Promise<Uint8Array> {
  const q = new URLSearchParams({ filename, subfolder, type });
  const r = await fetch(`${comfyUrl}/view?${q}`, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`ComfyUI /view HTTP ${r.status} for ${subfolder}/${filename}`);
  return new Uint8Array(await r.arrayBuffer());
}

export async function uploadComfyImage(
  comfyUrl: string,
  bytes: Uint8Array,
  filename: string,
): Promise<string> {
  const form = new FormData();
  const mime = filename.endsWith('.png') ? 'image/png' : 'image/jpeg';
  form.append('image', new Blob([Buffer.from(bytes)], { type: mime }), filename);
  form.append('overwrite', 'true');
  const r = await fetch(`${comfyUrl}/upload/image`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`ComfyUI /upload/image HTTP ${r.status}`);
  const data = (await r.json()) as { name?: string; subfolder?: string };
  if (!data.name) throw new Error('ComfyUI /upload/image returned no filename');
  return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
}

export function extractSavedFile(
  nodeOutput: Record<string, any> | undefined,
  fallbackFilename: string,
): { filename: string; subfolder: string } {
  if (nodeOutput) {
    for (const val of Object.values(nodeOutput)) {
      if (Array.isArray(val) && val.length > 0) {
        const first = val[0];
        if (first && typeof first === 'object' && typeof first.filename === 'string') {
          return { filename: first.filename, subfolder: first.subfolder ?? 'shapecast' };
        }
        if (typeof first === 'string' && first.endsWith('.glb')) {
          const parts = first.split('/');
          return parts.length > 1
            ? { subfolder: parts.slice(0, -1).join('/'), filename: parts[parts.length - 1] }
            : { subfolder: 'shapecast', filename: first };
        }
      }
    }
  }
  return { filename: fallbackFilename, subfolder: 'shapecast' };
}

export interface StlDeliveryResult {
  stlFilename: string;
  stlPath: string;
  localCopyPath: string;
  deliveredToAlienPc: boolean;
}

export function deliverStlToAlienPc(
  stlBuf: ArrayBuffer,
  stlFilename: string,
  {
    localOutDir,
    sshHost = process.env.FORGE_ALIENPC_SSH ?? 'gaming-pc',
    skipScp = false,
  }: { localOutDir?: string; sshHost?: string; skipScp?: boolean } = {},
): StlDeliveryResult {
  const alienPcDir = 'C:\\Users\\matth\\Documents\\ShapeCast';
  const stlPath = `${alienPcDir}\\${stlFilename}`;
  const outDir = localOutDir ?? join(tmpdir(), 'shapecast-forge-out');
  mkdirSync(outDir, { recursive: true });
  const localCopyPath = join(outDir, stlFilename);
  writeFileSync(localCopyPath, Buffer.from(stlBuf));

  if (skipScp) {
    return { stlFilename, stlPath, localCopyPath, deliveredToAlienPc: false };
  }

  try {
    execFileSync(
      'scp',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        localCopyPath,
        `${sshHost}:C:/Users/matth/Documents/ShapeCast/${stlFilename}`,
      ],
      { timeout: 15_000, stdio: 'pipe' },
    );
    return { stlFilename, stlPath, localCopyPath, deliveredToAlienPc: true };
  } catch {
    return { stlFilename, stlPath, localCopyPath, deliveredToAlienPc: false };
  }
}

export interface ForgePipelineOptions {
  comfyUrl: string;
  prompt?: string;
  photoBase64?: string;
  targetMm?: number;
  name?: string;
  seed?: number;
  gridRes?: number;
  localOutDir?: string;
  skipScp?: boolean;
  pollMs?: number;
  onStage?: (stage: 'reference_image' | 'mesh_generation' | 'repair_and_export') => void;
}

export interface ForgePipelineResult extends PreparedMeshResult {
  name: string;
  stlFilename: string;
  stlPath: string;
  localCopyPath: string;
  deliveredToAlienPc: boolean;
}

export async function runForgePipeline(opts: ForgePipelineOptions): Promise<ForgePipelineResult> {
  const {
    comfyUrl,
    prompt,
    photoBase64,
    targetMm = 120,
    name,
    seed = 731,
    gridRes = 128,
    localOutDir,
    skipScp = false,
    pollMs = 1500,
    onStage,
  } = opts;

  if (!prompt?.trim() && !photoBase64?.trim()) {
    throw new Error('Provide either a text prompt or a photo');
  }

  // 1. Fail-fast preflight check
  const status = await comfyStatus(comfyUrl);
  if (status.alienpc === 'unavailable') {
    throw new Error(`AlienPC unavailable (${status.reason ?? 'ComfyUI unreachable'})`);
  }
  if (status.alienpc === 'busy') {
    throw new Error('AlienPC busy (ComfyUI queue is not empty)');
  }

  const label = (name?.trim() || prompt?.trim() || 'photo-model').slice(0, 80);
  const slug = slugify(label);
  const runId = `sc_${Date.now().toString(36)}_${slug.slice(0, 16)}`;

  // 2. Reference image (Flux text-to-image OR direct photo upload)
  onStage?.('reference_image');
  let inputImageName: string;
  if (photoBase64 && photoBase64.trim()) {
    const rawB64 = photoBase64.includes(',') ? photoBase64.split(',')[1] : photoBase64.trim();
    const imgBytes = new Uint8Array(Buffer.from(rawB64, 'base64'));
    if (imgBytes.byteLength === 0) throw new Error('Uploaded photo is empty');
    inputImageName = await uploadComfyImage(comfyUrl, imgBytes, `${runId}_input.jpg`);
  } else {
    const fluxWf = buildFluxWorkflow(prompt!, runId, seed);
    const fluxOut = await runComfyWorkflow(comfyUrl, fluxWf, { pollMs });
    const refFile = extractSavedFile(fluxOut['8'], `${runId}_ref_00001_.png`);
    const refBytes = await fetchComfyView(comfyUrl, refFile.filename, refFile.subfolder, 'output');
    inputImageName = await uploadComfyImage(comfyUrl, refBytes, `${runId}_ref.png`);
  }

  // 3. Hunyuan3D 2.1 + BiRefNet image-to-mesh
  onStage?.('mesh_generation');
  const hyWf = buildHunyuanWorkflow(inputImageName, runId, seed);
  const hyOut = await runComfyWorkflow(comfyUrl, hyWf, { pollMs });
  const glbFile = extractSavedFile(hyOut['10'], `${runId}_00001_.glb`);
  const glbBytes = await fetchComfyView(comfyUrl, glbFile.filename, glbFile.subfolder, 'output');

  // 4. Watertight manifold repair, scale, print checks & STL delivery
  onStage?.('repair_and_export');
  const rawTris = await parseGlbTriangles(glbBytes);
  const prepared = repairAndPrepareMesh(rawTris, { targetMm, gridRes });
  if (!prepared.manifold.ok) {
    throw new Error(`Mesh repair failed manifold check: ${prepared.manifold.errors.join('; ')}`);
  }

  const stlFilename = `${dateStamp()}-${slug}.stl`;
  const stlBuf = writeBinaryStl(prepared.tris, label);
  const delivery = deliverStlToAlienPc(stlBuf, stlFilename, { localOutDir, skipScp });

  return {
    ...prepared,
    name: label,
    ...delivery,
  };
}
