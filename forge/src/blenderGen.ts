/**
 * Server-side Blender 4.3 CAD Python (bpy/bmesh) Architect for ShapeCast Forge.
 * Uses Matthew's OAuth subscriptions directly on ProBook:
 *   1. Claude Sonnet 5.5 (`claude -p --model claude-sonnet-5-5`, via ~/.claude/.credentials.json OAuth)
 *   2. GPT-6.1-Sol (`codex exec -m gpt-6.1-sol`, via ~/.codex/auth.json ChatGPT OAuth, with native `-i` image support)
 *   3. Gemini 3.8 Flash (`gemini-3.8-flash`, fallback)
 * Explicitly strips ANTHROPIC_API_KEY, OPENAI_API_KEY, and OPENROUTER_API_KEY when invoking
 * the Claude and Codex CLIs so requests are 100% covered by OAuth subscriptions ($0 API cost).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

let envLoaded = false;
export function ensureForgeEnvLoaded(): void {
  if (envLoaded) return;
  envLoaded = true;
  const candidates = ['/home/apexaipc/.env.shared', join(homedir(), '.env.shared')];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
        }
      }
    } catch {
      /* ignore */
    }
  }
}

export type CadProviderChoice = 'auto' | 'claude' | 'codex' | 'gemini';

export interface BlenderCadGenOptions {
  brief?: string;
  scaleRef?: string;
  previousCode?: string;
  userFeedback?: string;
  photoBase64?: string;
  errorFeedback?: string;
  preferredProvider?: CadProviderChoice;
  timeoutMs?: number;
}

export interface BlenderCadGenResult {
  name: string;
  pythonCode: string;
  provider: string;
}

export function buildServerBlenderPrompt(opts: BlenderCadGenOptions): string {
  const { brief, scaleRef, previousCode, userFeedback, photoBase64, errorFeedback } = opts;
  const hasPhoto = Boolean(photoBase64 && photoBase64.trim());

  let revisionSection = '';
  if (previousCode && previousCode.trim()) {
    revisionSection = `\nEXISTING BLENDER 4.3 PYTHON SCRIPT:\n\`\`\`python\n${previousCode.trim()}\n\`\`\`\n`;
    if (errorFeedback && errorFeedback.trim()) {
      revisionSection += `\nCRITICAL FIX REQUIRED — The script above failed in headless Blender 4.3 with this traceback:\n\`\`\`\n${errorFeedback.trim()}\n\`\`\`\nFix the bug and return the complete, corrected Blender 4.3 Python script.\n`;
    } else if (userFeedback && userFeedback.trim()) {
      revisionSection += `\nUSER REVISION REQUEST: ${userFeedback.trim()}\nModify and enhance the script above to fulfill this request while preserving existing crisp CAD features.\n`;
    } else {
      revisionSection += `\nCRITIC DETAIL UPGRADE: Enhance the script above by adding deeper recessed panel trenches, sharper concentric rings/nozzles, radial turbine vanes, cooling louver slat arrays, and fine hard-surface greeble blocks.\n`;
    }
  }

  return `You are a Principal Hard-Surface CAD & Blender 4.3 Python (bpy / bmesh / mathutils) Engineer designing a razor-sharp 3D print model for an Elegoo Saturn 3 (12K) resin printer.
Brief: ${brief && brief.trim() ? brief.trim() : '(from attached reference photo)'}
Scale reference: ${scaleRef && scaleRef.trim() ? scaleRef.trim() : '120 mm longest horizontal dimension'}
Visual Input: ${hasPhoto ? 'Reference image attached — match its exact silhouette, layout, proportions, thruster/feature count, and mechanical details.' : 'Text brief only.'}
${revisionSection}
CRITICAL BLENDER 4.3 API & CAD ARCHITECTURE RULES (ZERO VOXEL REMESHING):
1. Your geometry is exported as 100% EXACT mathematical CAD triangles (ZERO voxel remeshing, ZERO smoothing). Every bevel, 64-segment cylinder ring, radial turbine blade, louver slat, and micro-greeble block is preserved with 0.00 mm precision in Chitubox.
2. Do NOT call \`bpy.ops.wm.read_factory_settings\` and do NOT call export functions (\`stl_export\`, \`gltf\`, etc.). The runner clears the scene before your script and exports all \`MESH\` objects afterward.
3. BLENDER 4.3 API COMPATIBILITY (MANDATORY):
   - NEVER use \`mesh.use_auto_smooth\` (removed in Blender 4.1+).
   - For \`bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x,y,z), rotation=(rx,ry,rz), scale=(sx,sy,sz))\`, ALWAYS pass \`size=1.0\` so \`scale=(sx,sy,sz)\` equals exact millimetre dimensions!
   - For \`bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=r, depth=h, location=(x,y,z), rotation=(rx,ry,rz))\`, use \`radius\` and \`depth\` (never \`height\`).
   - For \`bpy.ops.mesh.primitive_cone_add(vertices=64, radius1=r1, radius2=r2, depth=h, location=(x,y,z), rotation=(rx,ry,rz))\`, use \`radius1\`, \`radius2\`, and \`depth\`.
   - For custom polygonal plates/wedges using \`bmesh\`, create bottom and top vertex rings, connect side quads, call \`bmesh.ops.triangulate(bm, faces=bm.faces)\` and \`bmesh.ops.recalc_face_normals(bm, faces=bm.faces)\`, then write to \`bm.to_mesh(mesh)\`.
4. MULTI-TIERED HARD-SURFACE DETAIL (BUILD 50 TO 150 CRISP GEOMETRIC SUB-PARTS VIA COMPACT LOOPS):
   - Define concise helper functions (\`add_box\`, \`add_poly_extrude\`, \`add_cylinder\`, \`add_cone\`) and use compact Python \`for\` loops with symmetry (\`for sx in (-1, 1):\`, \`for i in range(n):\`) so the entire script is ~120–180 lines of clean Python.
   - Primary Structural Hull / Baffle Frame: Exact polygonal silhouette with raised perimeter armor bevel strips and stepped mounting decks.
   - Cylindrical & Concentric Assemblies (thrusters, engines, wheels, barrels): Use \`vertices=64\`. Build multi-stage concentric cowlings (outer shroud cone, 2–3 stepped inner rings, recessed core, and 16–24 radial cooling vanes/struts arranged in a circle \`for v in range(vanes):\`).
   - Cooling Louvers, Trenches & Micro-Greebles: Populate wings/decks with arrays of angled louver slats, structural ribs, piping conduits, and raised capacitor/greeble blocks (0.8–3.0 mm relief depth).
   - Ensure all sub-parts overlap their parent surface by at least 0.4 mm so the assembly slices cleanly in Chitubox. Use Z as up, units in millimetres, centered around X=0, Y=0, base at Z=0.
5. DIRECT CODE OUTPUT ONLY (ZERO TOOL / SHELL EXECUTION):
   - Do NOT execute any shell commands, do NOT run python/blender/ls/cat, and do NOT inspect the filesystem or workspace.
   - Respond immediately in a single turn with ONLY the \`# NAME:\` comment and the \`\`\`python ... \`\`\` code block.

OUTPUT FORMAT:
Start your response with a single comment line:
# NAME: <short descriptive model name, 1-50 chars>
Followed immediately by a single \`\`\`python ... \`\`\` code block containing the complete, self-contained Blender 4.3 Python script.`;
}

export function extractBlenderScript(rawText: string, fallbackName = 'blender-cad-model'): {
  name: string;
  pythonCode: string;
} {
  const text = String(rawText ?? '').trim();
  if (!text) {
    throw new Error('Empty response from CAD model');
  }

  // 1. Check if the model returned a JSON object {"name": "...", "pythonCode": "..."}
  if (text.startsWith('{') || text.includes('"pythonCode"')) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*"pythonCode"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed.pythonCode === 'string' && parsed.pythonCode.trim()) {
          return {
            name: String(parsed.name || fallbackName).slice(0, 60),
            pythonCode: parsed.pythonCode.trim(),
          };
        }
      }
    } catch {
      /* fall through to markdown fence extraction */
    }
  }

  // 2. Extract optional # NAME: header
  const nameMatch = text.match(/^#\s*NAME:\s*(.+)$/im);
  const name = (nameMatch ? nameMatch[1].trim() : fallbackName).slice(0, 60) || fallbackName;

  // 3. Extract ```python ... ``` code block
  const fenceMatch =
    text.match(/```(?:python|py)\s*\r?\n([\s\S]*?)```/i) ||
    text.match(/```\s*\r?\n([\s\S]*?)```/);
  if (fenceMatch && fenceMatch[1].trim()) {
    return { name, pythonCode: fenceMatch[1].trim() };
  }

  // 4. If raw Python without fences was returned
  if (text.includes('import bpy')) {
    const idx = text.indexOf('import bpy');
    return { name, pythonCode: text.slice(idx).trim() };
  }

  throw new Error('Model response did not contain a valid Blender Python script');
}

function cleanBase64Jpeg(photoBase64?: string): string | null {
  if (!photoBase64 || !photoBase64.trim()) return null;
  const trimmed = photoBase64.trim();
  return trimmed.includes(',') ? trimmed.split(',')[1] : trimmed;
}

function runOAuthSubprocess(
  binPath: string,
  args: string[],
  stdinText: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Explicitly strip paid API keys so Claude and Codex CLIs strictly use OAuth subscriptions
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.OPENROUTER_API_KEY;

    const cwd = existsSync('/home/apexaipc') ? '/home/apexaipc' : process.cwd();
    const child = spawn(binPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${binPath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (stdinText) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

async function preflightClaudeOAuthQuota(): Promise<void> {
  const credPath = '/home/apexaipc/.claude/.credentials.json';
  if (!existsSync(credPath)) return;
  try {
    const creds = JSON.parse(readFileSync(credPath, 'utf8'));
    const token = creds?.claudeAiOauth?.accessToken;
    if (!token) return;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5-5',
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ok' }],
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 429) {
      throw new Error('Claude OAuth subscription rate-limited (HTTP 429)');
    }
  } catch (e) {
    if ((e as Error).message.includes('HTTP 429')) throw e;
  }
}

async function callClaudeOAuthSonnet55(
  prompt: string,
  tempImagePath: string | null,
  timeoutMs: number,
): Promise<BlenderCadGenResult> {
  await preflightClaudeOAuthQuota();
  const claudeBin = existsSync('/home/apexaipc/.local/bin/claude')
    ? '/home/apexaipc/.local/bin/claude'
    : 'claude';
  const args = [
    '-p',
    '--model',
    'claude-sonnet-5-5',
    '--setting-sources',
    '',
    '--no-session-persistence',
    '--dangerously-skip-permissions',
  ];
  let fullPrompt = prompt;
  if (tempImagePath) {
    args.push('--tools', 'Read', '--add-dir', dirnameOrTmp(tempImagePath));
    fullPrompt = `First, use the Read tool to view the attached reference image at ${tempImagePath}.\n\n${prompt}`;
  } else {
    args.push('--tools', '');
  }

  const { code, stdout, stderr } = await runOAuthSubprocess(
    claudeBin,
    args,
    fullPrompt,
    Math.min(timeoutMs, 45_000),
  );
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`Claude OAuth CLI exited ${code}: ${stderr.slice(0, 240)}`);
  }
  const parsed = extractBlenderScript(stdout);
  return { ...parsed, provider: 'claude-sonnet-5.5-oauth' };
}

function dirnameOrTmp(filePath: string): string {
  const idx = filePath.lastIndexOf('/');
  return idx > 0 ? filePath.slice(0, idx) : '/tmp';
}

async function callCodexOAuthGpt61Sol(
  prompt: string,
  tempImagePath: string | null,
  timeoutMs: number,
): Promise<BlenderCadGenResult> {
  const codexBin = existsSync('/home/apexaipc/.local/bin/codex')
    ? '/home/apexaipc/.local/bin/codex'
    : 'codex';
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '-C',
    existsSync('/home/apexaipc') ? '/home/apexaipc' : '/tmp',
    '-m',
    'gpt-6.1-sol',
    '-c',
    'model_reasoning_effort="low"',
    '-c',
    'mcp_servers={}',
  ];
  if (tempImagePath) {
    args.push('-i', tempImagePath);
  }
  args.push('-');

  const { code, stdout, stderr } = await runOAuthSubprocess(
    codexBin,
    args,
    prompt,
    Math.max(timeoutMs, 120_000),
  );
  if (code !== 0 && !stdout.trim()) {
    throw new Error(`Codex OAuth CLI exited ${code}: ${stderr.slice(0, 240)}`);
  }
  const parsed = extractBlenderScript(stdout);
  return { ...parsed, provider: 'gpt-6.1-sol-oauth' };
}

async function callGemini38Flash(
  prompt: string,
  b64Image: string | null,
  apiKey: string,
  timeoutMs: number,
): Promise<BlenderCadGenResult> {
  const parts: any[] = [];
  if (b64Image) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: b64Image,
      },
    });
  }
  parts.push({ text: prompt });

  const models = ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.1-flash-lite'];
  let lastErr: Error | null = null;
  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            maxOutputTokens: 12000,
            temperature: 0.2,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
        signal: AbortSignal.timeout(Math.max(timeoutMs, 65_000)),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 180)}`);
      }
      const data = (await res.json()) as any;
      const textParts = (data?.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => p?.text ?? '')
        .join('\n');
      const parsed = extractBlenderScript(textParts);
      return { ...parsed, provider: model };
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error('Gemini CAD generation failed');
}

export async function generateBlenderCadScript(
  opts: BlenderCadGenOptions,
): Promise<BlenderCadGenResult> {
  ensureForgeEnvLoaded();
  const prompt = buildServerBlenderPrompt(opts);
  const b64Image = cleanBase64Jpeg(opts.photoBase64);
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const fallbackName = (opts.brief?.trim() || 'blender-cad-model').slice(0, 50);

  let tempImagePath: string | null = null;
  if (b64Image) {
    tempImagePath = join(tmpdir(), `sc_cad_ref_${Date.now()}.jpg`).replace(/\\/g, '/');
    writeFileSync(tempImagePath, Buffer.from(b64Image, 'base64'));
  }

  const pref = opts.preferredProvider ?? 'auto';
  const order: Array<'claude' | 'codex' | 'gemini'> =
    pref === 'codex'
      ? ['codex', 'claude', 'gemini']
      : pref === 'gemini'
        ? ['gemini', 'claude', 'codex']
        : ['claude', 'codex', 'gemini'];

  const errors: string[] = [];
  try {
    for (const p of order) {
      try {
        if (p === 'claude') {
          const r = await callClaudeOAuthSonnet55(prompt, tempImagePath, timeoutMs);
          return { ...r, name: r.name === 'blender-cad-model' ? fallbackName : r.name };
        }
        if (p === 'codex') {
          const r = await callCodexOAuthGpt61Sol(prompt, tempImagePath, timeoutMs);
          return { ...r, name: r.name === 'blender-cad-model' ? fallbackName : r.name };
        }
        if (p === 'gemini') {
          const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
          if (!geminiKey) continue;
          const r = await callGemini38Flash(prompt, b64Image, geminiKey, timeoutMs);
          return { ...r, name: r.name === 'blender-cad-model' ? fallbackName : r.name };
        }
      } catch (e) {
        errors.push((e as Error).message);
      }
    }

    throw new Error(
      `Server-side Blender CAD generation failed: ${errors.join(' | ') || 'no providers available'}`,
    );
  } finally {
    if (tempImagePath) {
      try {
        unlinkSync(tempImagePath);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function runServerOAuthJsonSample({
  prompt,
  imagesBase64 = [],
  timeoutMs = 75_000,
}: {
  prompt: string;
  imagesBase64?: string[];
  timeoutMs?: number;
}): Promise<{ json: any; text: string; provider: string }> {
  ensureForgeEnvLoaded();
  const tempPaths: string[] = [];
  for (let i = 0; i < imagesBase64.length; i++) {
    const clean = cleanBase64Jpeg(imagesBase64[i]);
    if (clean) {
      const p = join(tmpdir(), `sc_sample_${Date.now()}_${i}.jpg`).replace(/\\/g, '/');
      writeFileSync(p, Buffer.from(clean, 'base64'));
      tempPaths.push(p);
    }
  }

  const parseJsonFromText = (raw: string) => {
    const trimmed = raw.trim();
    const fence = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)```/i);
    if (fence) return JSON.parse(fence[1].trim());
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    return JSON.parse(trimmed);
  };

  try {
    // 1. Try Claude Sonnet 5.5 OAuth CLI (preflight quota first so 429 fails fast)
    try {
      await preflightClaudeOAuthQuota();
      const claudeBin = existsSync('/home/apexaipc/.local/bin/claude')
        ? '/home/apexaipc/.local/bin/claude'
        : 'claude';
      const args = [
        '-p',
        '--model',
        'claude-sonnet-5-5',
        '--dangerously-skip-permissions',
        '--setting-sources',
        '',
        '--no-session-persistence',
      ];
      let fullPrompt = prompt;
      if (tempPaths.length) {
        args.push('--tools', 'Read', '--add-dir', dirnameOrTmp(tempPaths[0]));
        fullPrompt = `First, use the Read tool to inspect these attached image file(s): ${tempPaths.join(', ')}\n\n${prompt}`;
      } else {
        args.push('--tools', '');
      }
      const { stdout } = await runOAuthSubprocess(claudeBin, args, fullPrompt, Math.min(timeoutMs, 35_000));
      const parsed = parseJsonFromText(stdout);
      return { json: parsed, text: stdout.trim(), provider: 'claude-sonnet-5.5-oauth' };
    } catch {
      /* fallback to Codex OAuth */
    }

    // 2. Fallback: Codex GPT-6.1-Sol OAuth CLI (run in trusted /home/apexaipc directory)
    try {
      const codexBin = existsSync('/home/apexaipc/.local/bin/codex')
        ? '/home/apexaipc/.local/bin/codex'
        : 'codex';
      const trustedDir = existsSync('/home/apexaipc') ? '/home/apexaipc' : tmpdir();
      const args = [
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '-C',
        trustedDir,
        '-m',
        'gpt-6.1-sol',
        '-c',
        'model_reasoning_effort="low"',
        '-c',
        'mcp_servers={}',
      ];
      for (const tp of tempPaths) {
        args.push('-i', tp);
      }
      args.push('-');
      const { stdout } = await runOAuthSubprocess(codexBin, args, prompt, Math.max(timeoutMs, 90_000));
      const parsed = parseJsonFromText(stdout);
      return { json: parsed, text: stdout.trim(), provider: 'gpt-6.1-sol-oauth' };
    } catch (codexErr) {
      // 3. Final fallback: Gemini Flash API if configured
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
      if (!apiKey) throw codexErr;
      const parts: any[] = [];
      for (const b64 of imagesBase64) {
        const clean = cleanBase64Jpeg(b64);
        if (clean) parts.push({ inline_data: { mime_type: 'image/jpeg', data: clean } });
      }
      parts.push({ text: prompt });
      let lastGeminiErr: any = codexErr;
      for (const modelName of ['gemini-3.8-flash', 'gemini-3.8-pro', 'gemini-3.1-flash-lite']) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts }],
              generationConfig: {
                temperature: 0.2,
                maxOutputTokens: 4096,
                thinkingConfig: { thinkingBudget: 0 },
              },
            }),
            signal: AbortSignal.timeout(Math.max(timeoutMs, 45_000)),
          });
          if (!res.ok) throw new Error(`${modelName} HTTP ${res.status}`);
          const data: any = await res.json();
          const text = (data?.candidates?.[0]?.content?.parts || [])
            .map((p: any) => p.text || '')
            .join('\n')
            .trim();
          const parsed = parseJsonFromText(text);
          return { json: parsed, text, provider: modelName };
        } catch (ge) {
          lastGeminiErr = ge;
        }
      }
      throw lastGeminiErr;
    }
  } finally {
    for (const tp of tempPaths) {
      try {
        unlinkSync(tp);
      } catch {
        /* ignore */
      }
    }
  }
}
