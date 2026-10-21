/**
 * ComfyUI workflow runner and AlienPC STL delivery for ShapeCast Forge.
 * Only submits fixed workflow templates from forge/workflows/; user text only enters the CLIP prompt field.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  parseGlbTriangles,
  repairAndPrepareMesh,
  writeBinaryStl,
  type PreparedMeshResult,
} from './mesh.js';
import { runStudioPrep, type StudioEngine } from './studioPrep.js';

const execFileAsync = promisify(execFile);
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

export function buildHunyuanWorkflow(
  inputImageName: string,
  outputPrefix: string,
  seed = 731,
  {
    octreeResolution = 512,
    steps = 36,
    cfg = 5.5,
  }: { octreeResolution?: number; steps?: number; cfg?: number } = {},
) {
  const wf = JSON.parse(
    readFileSync(join(WORKFLOWS_DIR, 'hunyuan3d21_image_to_mesh.api.json'), 'utf8'),
  );
  wf['2'].inputs.image = inputImageName;
  if (wf['4']?.inputs) wf['4'].inputs.resolution = 8192;
  wf['7'].inputs.seed = seed;
  wf['7'].inputs.steps = Math.max(15, Math.min(60, Math.round(steps)));
  wf['7'].inputs.cfg = Math.max(1, Math.min(10, cfg));
  wf['8'].inputs.num_chunks = 32000;
  wf['8'].inputs.octree_resolution = Math.max(192, Math.min(512, Math.round(octreeResolution)));
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

export async function deliverStlToAlienPc(
  stlBuf: ArrayBuffer,
  stlFilename: string,
  {
    localOutDir,
    sshHost = process.env.FORGE_ALIENPC_SSH ?? 'gaming-pc',
    skipScp = false,
  }: { localOutDir?: string; sshHost?: string; skipScp?: boolean } = {},
): Promise<StlDeliveryResult> {
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
    await execFileAsync(
      'scp',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        localCopyPath,
        `${sshHost}:C:/Users/matth/Documents/ShapeCast/${stlFilename}`,
      ],
      { timeout: 15_000 },
    );
    return { stlFilename, stlPath, localCopyPath, deliveredToAlienPc: true };
  } catch {
    return { stlFilename, stlPath, localCopyPath, deliveredToAlienPc: false };
  }
}

export interface BlenderRemeshOptions {
  gridRes?: number;
  stlMaxVerts?: number;
  maxVerts?: number;
  smoothIterations?: number;
  smoothFactor?: number;
  aspectRatioTarget?: [number, number, number];
  outputStlPath?: string;
}

export interface ForgePipelineOptions extends BlenderRemeshOptions {
  comfyUrl: string;
  prompt?: string;
  photoBase64?: string;
  studioEngine?: StudioEngine;
  targetMm?: number;
  name?: string;
  seed?: number;
  octreeResolution?: number;
  steps?: number;
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
  rawGlbFilename?: string;
  qualityMetrics?: Record<string, any>;
}

export async function runBlenderPostProcessOnAlienPc(
  inputFilename: string,
  subfolder: string,
  outGlbFilename: string,
  targetMm: number,
  gridRes: number,
  sshHost = process.env.FORGE_ALIENPC_SSH ?? 'gaming-pc',
  extra: BlenderRemeshOptions = {},
): Promise<{ ok: boolean; summary?: any }> {
  const inPath = `C:/Users/matth/ComfyUI/output/${subfolder ? `${subfolder}/` : ''}${inputFilename}`;
  const outPath = `C:/Users/matth/ComfyUI/output/shapecast/${outGlbFilename}`;
  const stlMaxVerts = Math.max(46000, Math.min(300000, extra.stlMaxVerts ?? 160000));
  const maxVerts = Math.min(46000, extra.maxVerts ?? 46000);
  const smoothIters = extra.smoothIterations ?? 1;
  const smoothFactor = extra.smoothFactor ?? 0.16;
  const stlArg = extra.outputStlPath ? ` --output-stl "${extra.outputStlPath}"` : '';
  const aspectArg =
    extra.aspectRatioTarget && extra.aspectRatioTarget.length === 3
      ? ` --aspect-target ${extra.aspectRatioTarget.map((n) => Number(n).toFixed(4)).join(',')}`
      : '';
  const cmd = `C:\\Blender\\blender-4.3.2-windows-x64\\blender.exe --background --python C:\\Blender\\blender_postprocess.py -- --input "${inPath}" --output-glb "${outPath}"${stlArg} --target-mm ${targetMm} --grid-res ${gridRes} --stl-max-verts ${stlMaxVerts} --max-verts ${maxVerts} --smooth-iters ${smoothIters} --smooth-factor ${smoothFactor}${aspectArg}`;
  try {
    const { stdout: out } = await execFileAsync(
      'ssh',
      ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, cmd],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const marker = 'BLENDER_POSTPROCESS_JSON:';
    const idx = out.indexOf(marker);
    if (idx === -1) return { ok: false };
    const line = out.slice(idx + marker.length).split(/\r?\n/)[0];
    try {
      return { ok: true, summary: JSON.parse(line) };
    } catch {
      return { ok: true };
    }
  } catch {
    return { ok: false };
  }
}

export async function runBlenderRefineOnAlienPc({
  comfyUrl,
  rawGlbFilename,
  name = 'refined-model',
  targetMm = 120,
  gridRes = 512,
  stlMaxVerts = 160000,
  maxVerts = 46000,
  smoothIterations = 1,
  smoothFactor = 0.15,
  aspectRatioTarget,
  localOutDir,
  skipScp = false,
  sshHost = process.env.FORGE_ALIENPC_SSH ?? 'gaming-pc',
}: {
  comfyUrl: string;
  rawGlbFilename?: string;
  name?: string;
  targetMm?: number;
  localOutDir?: string;
  skipScp?: boolean;
  sshHost?: string;
} & BlenderRemeshOptions): Promise<ForgePipelineResult> {
  const label = (name?.trim() || 'refined-model').slice(0, 80);
  const slug = slugify(label);
  const stlFilename = `${dateStamp()}-${slug}.stl`;
  let targetRaw = rawGlbFilename?.trim() || '';
  if (!targetRaw || /[^a-zA-Z0-9_.-]/.test(targetRaw)) {
    const { stdout: listOut } = await execFileAsync(
      'ssh',
      [
        '-n',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        sshHost,
        'dir /b /od C:\\Users\\matth\\ComfyUI\\output\\shapecast\\sc_*_00001_.glb',
      ],
      { timeout: 10_000 },
    );
    const lines = listOut
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.endsWith('.glb'));
    if (lines.length === 0) {
      throw new Error('No raw Hunyuan3D GLB found on AlienPC to refine');
    }
    targetRaw = lines[lines.length - 1];
  }

  const outGlbFilename = `${targetRaw.replace(/\.glb$/i, '')}_refined_${Date.now().toString(36)}.glb`;
  const post = await runBlenderPostProcessOnAlienPc(
    targetRaw,
    'shapecast',
    outGlbFilename,
    targetMm,
    gridRes,
    sshHost,
    {
      stlMaxVerts,
      maxVerts,
      smoothIterations,
      smoothFactor,
      aspectRatioTarget,
      outputStlPath: skipScp ? undefined : `C:/Users/matth/Documents/ShapeCast/${stlFilename}`,
    },
  );
  if (!post.ok) {
    throw new Error(`Blender refinement failed on ${targetRaw}`);
  }

  const glbBytes = await fetchComfyView(comfyUrl, outGlbFilename, 'shapecast', 'output');
  await new Promise((r) => setImmediate(r));
  const rawTris = await parseGlbTriangles(glbBytes);
  await new Promise((r) => setImmediate(r));
  const prepared = repairAndPrepareMesh(rawTris, { targetMm, gridRes });
  if (!prepared.manifold.ok) {
    throw new Error(`Refined mesh failed manifold check: ${prepared.manifold.errors.join('; ')}`);
  }
  const stlBuf = writeBinaryStl(prepared.tris, label);
  const directStlWritten = Boolean(post.summary?.stl_written);
  const delivery = await deliverStlToAlienPc(stlBuf, stlFilename, {
    localOutDir,
    skipScp: skipScp || directStlWritten,
    sshHost,
  });
  return {
    ...prepared,
    name: label,
    ...delivery,
    deliveredToAlienPc: directStlWritten || delivery.deliveredToAlienPc,
    rawGlbFilename: targetRaw,
    qualityMetrics: post.summary?.quality_metrics ?? undefined,
  };
}

export async function runBlenderScriptOnAlienPc({
  comfyUrl,
  pythonCode,
  name = 'blender-model',
  targetMm = 120,
  gridRes = 260,
  localOutDir,
  skipScp = false,
  sshHost = process.env.FORGE_ALIENPC_SSH ?? 'gaming-pc',
}: {
  comfyUrl: string;
  pythonCode: string;
  name?: string;
  targetMm?: number;
  gridRes?: number;
  localOutDir?: string;
  skipScp?: boolean;
  sshHost?: string;
}): Promise<ForgePipelineResult> {
  const label = (name?.trim() || 'blender-model').slice(0, 80);
  const slug = slugify(label);
  const runId = `sc_bpy_${Date.now().toString(36)}_${slug.slice(0, 12)}`;
  const outGlbFilename = `${runId}_blender.glb`;
  const remoteScriptPath = `C:/Blender/${runId}.py`;
  const localScriptDir = localOutDir ?? join(tmpdir(), 'shapecast-forge-out');
  mkdirSync(localScriptDir, { recursive: true });
  const localScriptPath = join(localScriptDir, `${runId}.py`);

  const stlFilename = `${dateStamp()}-${slug}.stl`;
  const remoteStlPath = `C:/Users/matth/Documents/ShapeCast/${stlFilename}`;
  const wrappedScript = `import bpy, bmesh, os, json
from mathutils import Vector
bpy.ops.wm.read_factory_settings(use_empty=True)
# --- user bpy script ---
${pythonCode}
# --- convert any curves/surfaces to mesh, apply modifiers, scale & export exact CAD ---
for o in list(bpy.context.scene.objects):
    if o.type in {'CURVE', 'SURFACE', 'FONT', 'META'}:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        try:
            bpy.ops.object.convert(target='MESH')
        except Exception:
            pass

mesh_objs = [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.data.polygons) > 0]
if not mesh_objs:
    raise RuntimeError('Blender script produced no mesh objects')

for o in mesh_objs:
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    for m in list(o.modifiers):
        try:
            bpy.ops.object.modifier_apply(modifier=m.name)
        except Exception:
            o.modifiers.remove(m)

bpy.ops.object.select_all(action='DESELECT')
for o in mesh_objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = mesh_objs[0]
if len(mesh_objs) > 1:
    bpy.ops.object.join()

obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

tri = obj.modifiers.new(name='ShapeCastCadTri', type='TRIANGULATE')
tri.quad_method = 'BEAUTY'
bpy.ops.object.modifier_apply(modifier=tri.name)

bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
bm.to_mesh(obj.data)
bm.free()

corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
xs = [c.x for c in corners]
ys = [c.y for c in corners]
zs = [c.z for c in corners]
horiz = max(max(xs) - min(xs), max(ys) - min(ys), 1e-6)
s = float(${targetMm}) / horiz
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
xs = [c.x for c in corners]
ys = [c.y for c in corners]
zs = [c.z for c in corners]
obj.location = (-0.5 * (min(xs) + max(xs)), -0.5 * (min(ys) + max(ys)), -min(zs))
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

stl_faces = len(obj.data.polygons)
stl_verts = len(obj.data.vertices)
os.makedirs('C:/Users/matth/Documents/ShapeCast', exist_ok=True)
bpy.ops.wm.stl_export(filepath='${remoteStlPath}', export_selected_objects=True, ascii_format=False)

if len(obj.data.vertices) > 60000:
    dec = obj.modifiers.new(name='ShapeCastCadPreviewDec', type='DECIMATE')
    dec.decimate_type = 'COLLAPSE'
    dec.ratio = 60000.0 / float(len(obj.data.vertices))
    dec.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=dec.name)

os.makedirs('C:/Users/matth/ComfyUI/output/shapecast', exist_ok=True)
bpy.ops.export_scene.gltf(filepath='C:/Users/matth/ComfyUI/output/shapecast/${outGlbFilename}', export_format='GLB', use_selection=True)
print('BLENDER_CAD_JSON:' + json.dumps({'stl_faces': stl_faces, 'stl_vertices': stl_verts, 'faces': len(obj.data.polygons), 'vertices': len(obj.data.vertices)}))
print('BLENDER_SCRIPT_OK')
`;
  writeFileSync(localScriptPath, wrappedScript, 'utf8');

  await execFileAsync(
    'scp',
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      localScriptPath,
      `${sshHost}:${remoteScriptPath}`,
    ],
    { timeout: 15_000 },
  );

  const cmd = `C:\\Blender\\blender-4.3.2-windows-x64\\blender.exe --background --python "${remoteScriptPath}" & del "${remoteScriptPath.replace(/\//g, '\\')}"`;
  const { stdout } = await execFileAsync(
    'ssh',
    ['-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', sshHost, cmd],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  );
  if (!stdout.includes('BLENDER_SCRIPT_OK')) {
    throw new Error('Blender script did not complete cleanly');
  }

  let cadMeta: Record<string, any> = { mode: 'blender_cad_exact' };
  const cadIdx = stdout.indexOf('BLENDER_CAD_JSON:');
  if (cadIdx !== -1) {
    try {
      cadMeta = {
        ...cadMeta,
        ...JSON.parse(stdout.slice(cadIdx + 'BLENDER_CAD_JSON:'.length).split(/\r?\n/)[0]),
      };
    } catch {
      /* ignore parse error */
    }
  }

  const glbBytes = await fetchComfyView(comfyUrl, outGlbFilename, 'shapecast', 'output');
  await new Promise((r) => setImmediate(r));
  const rawTris = await parseGlbTriangles(glbBytes);
  await new Promise((r) => setImmediate(r));
  const prepared = repairAndPrepareMesh(rawTris, { targetMm, gridRes, preserveExactCad: true });
  const stlBuf = writeBinaryStl(prepared.tris, label);
  const delivery = await deliverStlToAlienPc(stlBuf, stlFilename, {
    localOutDir,
    skipScp: true,
    sshHost,
  });
  return {
    ...prepared,
    name: label,
    ...delivery,
    deliveredToAlienPc: !skipScp,
    rawGlbFilename: outGlbFilename,
    qualityMetrics: cadMeta,
  };
}

export async function runForgePipeline(opts: ForgePipelineOptions): Promise<ForgePipelineResult> {
  const {
    comfyUrl,
    prompt,
    photoBase64,
    studioEngine,
    targetMm = 120,
    name,
    seed = 731,
    gridRes = 512,
    stlMaxVerts = 160000,
    maxVerts = 46000,
    smoothIterations = 1,
    smoothFactor = 0.15,
    aspectRatioTarget,
    octreeResolution = 512,
    steps = 36,
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

  // 2. Step 0 Studio Reference Prep (Gemini -> OpenAI gpt-image-1 -> Local Flux / Raw Photo fallback)
  onStage?.('reference_image');
  let inputImageName: string;
  let studioProvider = 'local';
  const hasPhoto = Boolean(photoBase64 && photoBase64.trim());
  let rawPhotoBytes: Uint8Array | undefined;
  if (hasPhoto) {
    const rawB64 = photoBase64!.includes(',') ? photoBase64!.split(',')[1] : photoBase64!.trim();
    rawPhotoBytes = new Uint8Array(Buffer.from(rawB64, 'base64'));
    if (rawPhotoBytes.byteLength === 0) throw new Error('Uploaded photo is empty');
  }

  const effectiveStudioEngine: StudioEngine = studioEngine ?? (skipScp ? 'local' : 'auto');
  const studioRes = await runStudioPrep({
    prompt,
    photoBytes: rawPhotoBytes,
    engine: effectiveStudioEngine,
  });

  if (studioRes) {
    studioProvider = studioRes.model ?? studioRes.provider;
    inputImageName = await uploadComfyImage(
      comfyUrl,
      studioRes.bytes,
      `${runId}_studio.${studioRes.ext}`,
    );
  } else if (rawPhotoBytes) {
    studioProvider = 'raw_photo';
    inputImageName = await uploadComfyImage(comfyUrl, rawPhotoBytes, `${runId}_input.jpg`);
  } else {
    studioProvider = 'flux_local';
    const fluxWf = buildFluxWorkflow(prompt!, runId, seed);
    const fluxOut = await runComfyWorkflow(comfyUrl, fluxWf, { pollMs });
    const refFile = extractSavedFile(fluxOut['8'], `${runId}_ref_00001_.png`);
    const refBytes = await fetchComfyView(comfyUrl, refFile.filename, refFile.subfolder, 'output');
    inputImageName = await uploadComfyImage(comfyUrl, refBytes, `${runId}_ref.png`);
  }

  // 3. Hunyuan3D 2.1 + BiRefNet image-to-mesh
  onStage?.('mesh_generation');
  const hyWf = buildHunyuanWorkflow(inputImageName, runId, seed, { octreeResolution, steps });
  const hyOut = await runComfyWorkflow(comfyUrl, hyWf, { pollMs });
  const glbFile = extractSavedFile(hyOut['10'], `${runId}_00001_.glb`);

  // 4. Blender 4.3 headless post-process (OpenVDB Voxel Remesh + Dual-Resolution STL/GLB export)
  onStage?.('repair_and_export');
  const stlFilename = `${dateStamp()}-${slug}.stl`;
  let glbBytes: Uint8Array;
  let qualityMetrics: Record<string, any> | undefined;
  let directStlWritten = false;
  if (!skipScp) {
    const blenderGlbName = `${runId}_blender.glb`;
    const post = await runBlenderPostProcessOnAlienPc(
      glbFile.filename,
      glbFile.subfolder,
      blenderGlbName,
      targetMm,
      gridRes,
      undefined,
      {
        stlMaxVerts,
        maxVerts,
        smoothIterations,
        smoothFactor,
        aspectRatioTarget,
        outputStlPath: `C:/Users/matth/Documents/ShapeCast/${stlFilename}`,
      },
    );
    directStlWritten = Boolean(post.summary?.stl_written);
    qualityMetrics = {
      ...(post.summary?.quality_metrics ?? {}),
      studioPrep: studioProvider,
    };
    if (post.ok) {
      glbBytes = await fetchComfyView(comfyUrl, blenderGlbName, 'shapecast', 'output');
    } else {
      glbBytes = await fetchComfyView(comfyUrl, glbFile.filename, glbFile.subfolder, 'output');
    }
  } else {
    glbBytes = await fetchComfyView(comfyUrl, glbFile.filename, glbFile.subfolder, 'output');
  }

  await new Promise((r) => setImmediate(r));
  const rawTris = await parseGlbTriangles(glbBytes);
  await new Promise((r) => setImmediate(r));
  const prepared = repairAndPrepareMesh(rawTris, { targetMm, gridRes });
  if (!prepared.manifold.ok) {
    throw new Error(`Mesh repair failed manifold check: ${prepared.manifold.errors.join('; ')}`);
  }

  const stlBuf = writeBinaryStl(prepared.tris, label);
  const delivery = await deliverStlToAlienPc(stlBuf, stlFilename, {
    localOutDir,
    skipScp: skipScp || directStlWritten,
  });

  return {
    ...prepared,
    name: label,
    ...delivery,
    deliveredToAlienPc: directStlWritten || delivery.deliveredToAlienPc,
    rawGlbFilename: glbFile.filename,
    qualityMetrics,
  };
}
