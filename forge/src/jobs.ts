/**
 * Single-job manager for ShapeCast Forge MCP tools (forge_generate / forge_job).
 * Fails fast when a job is already running or when AlienPC is busy/unavailable.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  comfyStatus,
  runForgePipeline,
  runBlenderRefineOnAlienPc,
  runBlenderScriptOnAlienPc,
  type ForgePipelineOptions,
  type ForgePipelineResult,
} from './comfy.js';
import type { StudioEngine } from './studioPrep.js';

export type JobStage =
  'queued' | 'reference_image' | 'mesh_generation' | 'repair_and_export' | 'done' | 'error';

export interface ForgeJobState {
  jobId: string;
  status: 'running' | 'done' | 'error';
  stage: JobStage;
  name: string;
  targetMm: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  result: ForgePipelineResult | null;
}

export interface JobManagerOptions {
  comfyUrl: string;
  localOutDir?: string;
  skipScp?: boolean;
  gridRes?: number;
  lastJobFile?: string | null;
  runner?: (opts: ForgePipelineOptions) => Promise<ForgePipelineResult>;
}

export function createJobManager(opts: JobManagerOptions) {
  const jobs = new Map<string, ForgeJobState>();
  let activeJobId: string | null = null;
  let lastDoneJobId: string | null = null;
  const runPipeline = opts.runner ?? runForgePipeline;

  if (opts.lastJobFile) {
    try {
      const saved = JSON.parse(readFileSync(opts.lastJobFile, 'utf8')) as ForgeJobState;
      if (saved && saved.jobId && saved.status === 'done' && saved.result) {
        jobs.set(saved.jobId, saved);
        lastDoneJobId = saved.jobId;
      }
    } catch {
      /* no cached job yet */
    }
  }

  function activeJob(): ForgeJobState | null {
    if (!activeJobId) return null;
    const j = jobs.get(activeJobId) ?? null;
    return j && j.status === 'running' ? j : null;
  }

  function lastCompletedJob(): ForgeJobState | null {
    if (!lastDoneJobId) return null;
    const j = jobs.get(lastDoneJobId) ?? null;
    return j && j.status === 'done' ? j : null;
  }

  async function startJob(input: {
    prompt?: string;
    photoBase64?: string;
    studioEngine?: StudioEngine;
    targetMm?: number;
    name?: string;
    seed?: number;
    octreeResolution?: number;
    steps?: number;
    gridRes?: number;
    maxVerts?: number;
    smoothIterations?: number;
    smoothFactor?: number;
    aspectRatioTarget?: [number, number, number];
  }): Promise<
    | { ok: true; job: ForgeJobState }
    | { ok: false; reason: string; alienpc: 'busy' | 'unavailable' | 'invalid' }
  > {
    let rawPrompt = input.prompt?.trim() ?? '';
    let parsedStudioEngine: StudioEngine | undefined = input.studioEngine;
    const studioMatch = rawPrompt.match(/^\[studio:(auto|gemini|openai|local|off)\]\s*(.*)$/is);
    if (studioMatch) {
      parsedStudioEngine = studioMatch[1].toLowerCase() as StudioEngine;
      rawPrompt = studioMatch[2].trim();
    }

    if (!rawPrompt && !input.photoBase64?.trim()) {
      return {
        ok: false,
        alienpc: 'invalid',
        reason: 'Provide a text prompt or a photo to generate a 3D mesh.',
      };
    }
    const current = activeJob();
    if (current) {
      return {
        ok: false,
        alienpc: 'busy',
        reason: `AlienPC is already running job ${current.jobId} (${current.stage}). Try again when it finishes.`,
      };
    }

    const st = await comfyStatus(opts.comfyUrl);
    if (st.alienpc === 'unavailable') {
      return {
        ok: false,
        alienpc: 'unavailable',
        reason: `AlienPC unavailable (${st.reason ?? 'ComfyUI unreachable'}). Try later.`,
      };
    }
    if (st.alienpc === 'busy') {
      return {
        ok: false,
        alienpc: 'busy',
        reason: 'AlienPC is busy with another ComfyUI task. Try later.',
      };
    }

    const isRefine = rawPrompt.startsWith('__FORGE_REFINE__:');
    const isBlender =
      rawPrompt.startsWith('__FORGE_BLENDER__:') ||
      Boolean(input.photoBase64?.startsWith('__FORGE_BLENDER__:'));
    const isHd = rawPrompt.startsWith('__FORGE_HD__:');

    const jobId = 'job_' + randomBytes(6).toString('hex');
    const targetMm = Math.max(10, Math.min(218, input.targetMm ?? 120));
    const label = (
      input.name?.trim() ||
      (!isRefine && !isBlender && !isHd ? rawPrompt : '') ||
      'forge-model'
    ).slice(0, 80);
    const initialStage: JobStage = isRefine
      ? 'repair_and_export'
      : isBlender
        ? 'mesh_generation'
        : 'reference_image';

    const job: ForgeJobState = {
      jobId,
      status: 'running',
      stage: initialStage,
      name: label,
      targetMm,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      result: null,
    };

    // Keep at most 10 finished jobs in memory
    if (jobs.size >= 10) {
      for (const [k, v] of jobs) {
        if (v.status !== 'running') {
          jobs.delete(k);
          break;
        }
      }
    }
    jobs.set(jobId, job);
    activeJobId = jobId;

    // Launch asynchronously
    (async () => {
      try {
        let res: ForgePipelineResult;
        if (isRefine) {
          const cfg = JSON.parse(rawPrompt.slice('__FORGE_REFINE__:'.length));
          res = await runBlenderRefineOnAlienPc({
            comfyUrl: opts.comfyUrl,
            rawGlbFilename: cfg.rawGlbFilename,
            name: label,
            targetMm,
            gridRes: cfg.gridRes ?? 480,
            maxVerts: cfg.maxVerts ?? 46000,
            smoothIterations: cfg.smoothIterations ?? 1,
            smoothFactor: cfg.smoothFactor ?? 0.16,
            aspectRatioTarget: cfg.aspectRatioTarget,
            localOutDir: opts.localOutDir,
            skipScp: opts.skipScp,
          });
        } else if (isBlender) {
          const pyCode = input.photoBase64?.startsWith('__FORGE_BLENDER__:')
            ? Buffer.from(input.photoBase64.slice('__FORGE_BLENDER__:'.length), 'base64').toString(
                'utf8',
              )
            : rawPrompt.slice('__FORGE_BLENDER__:'.length);
          res = await runBlenderScriptOnAlienPc({
            comfyUrl: opts.comfyUrl,
            pythonCode: pyCode,
            name: label,
            targetMm,
            localOutDir: opts.localOutDir,
            skipScp: opts.skipScp,
          });
        } else {
          const hdCfg = isHd ? JSON.parse(rawPrompt.slice('__FORGE_HD__:'.length)) : null;
          res = await runPipeline({
            comfyUrl: opts.comfyUrl,
            prompt: hdCfg ? hdCfg.prompt : rawPrompt || undefined,
            photoBase64: input.photoBase64,
            studioEngine: hdCfg?.studioEngine ?? parsedStudioEngine,
            targetMm,
            name: label,
            seed: input.seed ?? 731,
            octreeResolution: hdCfg?.octreeResolution ?? input.octreeResolution ?? 448,
            steps: hdCfg?.steps ?? input.steps ?? 36,
            gridRes: hdCfg?.gridRes ?? input.gridRes ?? opts.gridRes ?? 450,
            maxVerts: hdCfg?.maxVerts ?? input.maxVerts ?? 46000,
            smoothIterations: hdCfg?.smoothIterations ?? input.smoothIterations ?? 1,
            smoothFactor: hdCfg?.smoothFactor ?? input.smoothFactor ?? 0.16,
            aspectRatioTarget: hdCfg?.aspectRatioTarget ?? input.aspectRatioTarget,
            localOutDir: opts.localOutDir,
            skipScp: opts.skipScp,
            onStage: (stage) => {
              job.stage = stage;
            },
          });
        }
        job.status = 'done';
        job.stage = 'done';
        job.finishedAt = Date.now();
        job.result = res;
        lastDoneJobId = jobId;
        if (opts.lastJobFile) {
          try {
            mkdirSync(dirname(opts.lastJobFile), { recursive: true });
            const serializable = {
              ...job,
              result: { ...res, tris: undefined },
            };
            writeFileSync(opts.lastJobFile, JSON.stringify(serializable));
          } catch {
            /* ignore persistence error */
          }
        }
      } catch (e) {
        job.status = 'error';
        job.stage = 'error';
        job.finishedAt = Date.now();
        job.error = (e as Error).message;
      } finally {
        if (activeJobId === jobId) activeJobId = null;
      }
    })();

    return { ok: true, job };
  }

  function getJob(jobId: string): ForgeJobState | null {
    if (jobId === 'latest') return lastCompletedJob();
    return jobs.get(jobId) ?? null;
  }

  return { startJob, getJob, activeJob, lastCompletedJob };
}

export type JobManager = ReturnType<typeof createJobManager>;
