/**
 * Single-job manager for ShapeCast Forge MCP tools (forge_generate / forge_job).
 * Fails fast when a job is already running or when AlienPC is busy/unavailable.
 */
import { randomBytes } from 'node:crypto';
import {
  comfyStatus,
  runForgePipeline,
  type ForgePipelineOptions,
  type ForgePipelineResult,
} from './comfy.js';

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
  runner?: (opts: ForgePipelineOptions) => Promise<ForgePipelineResult>;
}

export function createJobManager(opts: JobManagerOptions) {
  const jobs = new Map<string, ForgeJobState>();
  let activeJobId: string | null = null;
  const runPipeline = opts.runner ?? runForgePipeline;

  function activeJob(): ForgeJobState | null {
    if (!activeJobId) return null;
    const j = jobs.get(activeJobId) ?? null;
    return j && j.status === 'running' ? j : null;
  }

  async function startJob(input: {
    prompt?: string;
    photoBase64?: string;
    targetMm?: number;
    name?: string;
    seed?: number;
  }): Promise<
    | { ok: true; job: ForgeJobState }
    | { ok: false; reason: string; alienpc: 'busy' | 'unavailable' | 'invalid' }
  > {
    if (!input.prompt?.trim() && !input.photoBase64?.trim()) {
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

    const jobId = 'job_' + randomBytes(6).toString('hex');
    const targetMm = Math.max(10, Math.min(218, input.targetMm ?? 120));
    const label = (input.name?.trim() || input.prompt?.trim() || 'photo-model').slice(0, 80);
    const job: ForgeJobState = {
      jobId,
      status: 'running',
      stage: 'reference_image',
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
        const res = await runPipeline({
          comfyUrl: opts.comfyUrl,
          prompt: input.prompt,
          photoBase64: input.photoBase64,
          targetMm,
          name: label,
          seed: input.seed ?? 731,
          gridRes: opts.gridRes ?? 115,
          localOutDir: opts.localOutDir,
          skipScp: opts.skipScp,
          onStage: (stage) => {
            job.stage = stage;
          },
        });
        job.status = 'done';
        job.stage = 'done';
        job.finishedAt = Date.now();
        job.result = res;
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
    return jobs.get(jobId) ?? null;
  }

  return { startJob, getJob, activeJob };
}

export type JobManager = ReturnType<typeof createJobManager>;
