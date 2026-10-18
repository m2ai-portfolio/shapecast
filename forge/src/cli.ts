#!/usr/bin/env node
/**
 * ShapeCast Forge CLI (Phase 1):
 *   node dist/cli.js "a 2020 C8 Corvette" --length 150
 *   node dist/cli.js --photo ./input.jpg --name "mug" --length 100
 */
import { readFileSync } from 'node:fs';
import { runForgePipeline } from './comfy.js';

export function parseCliArgs(argv: string[]) {
  let prompt = '';
  let photoPath: string | null = null;
  let targetMm = 120;
  let name: string | undefined;
  let comfyUrl = process.env.FORGE_COMFY_URL ?? 'http://10.0.0.24:8188';
  let outDir: string | undefined;
  let seed = 731;
  let gridRes = 120;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if ((a === '--length' || a === '--size' || a === '--target-mm' || a === '-l') && argv[i + 1]) {
      targetMm = Number(argv[++i]);
    } else if ((a === '--prompt' || a === '-p') && argv[i + 1]) {
      prompt = argv[++i];
    } else if (a === '--photo' && argv[i + 1]) {
      photoPath = argv[++i];
    } else if (a === '--name' && argv[i + 1]) {
      name = argv[++i];
    } else if (a === '--comfy' && argv[i + 1]) {
      comfyUrl = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      outDir = argv[++i];
    } else if (a === '--seed' && argv[i + 1]) {
      seed = Number(argv[++i]);
    } else if (a === '--res' && argv[i + 1]) {
      gridRes = Number(argv[++i]);
    } else if (!a.startsWith('-')) {
      prompt = prompt ? `${prompt} ${a}` : a;
    }
  }
  return { prompt, photoPath, targetMm, name, comfyUrl, outDir, seed, gridRes };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  if (!args.prompt && !args.photoPath) {
    console.error('Usage: forge "<prompt>" [--length <mm>] [--photo <path>] [--out <dir>]');
    process.exit(1);
  }
  const photoBase64 = args.photoPath ? readFileSync(args.photoPath).toString('base64') : undefined;

  const t0 = Date.now();
  const res = await runForgePipeline({
    comfyUrl: args.comfyUrl,
    prompt: args.prompt || undefined,
    photoBase64,
    targetMm: args.targetMm,
    name: args.name,
    seed: args.seed,
    gridRes: args.gridRes,
    localOutDir: args.outDir,
    onStage: (stage) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] stage: ${stage}`),
  });

  console.log(
    JSON.stringify(
      {
        name: res.name,
        triangles: res.triangleCount,
        bboxMm: res.bbox.size.map((v) => +v.toFixed(2)),
        volumeMl: res.volumeMl,
        manifold: res.manifold.ok,
        worstCheck: res.worst,
        stlPath: res.stlPath,
        localCopyPath: res.localCopyPath,
        deliveredToAlienPc: res.deliveredToAlienPc,
        elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((e) => {
    console.error('forge failed:', (e as Error).message);
    process.exit(1);
  });
}
