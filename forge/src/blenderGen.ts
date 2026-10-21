/**
 * Server-side Blender 4.3 CAD Python (bpy/bmesh) Architect for ShapeCast Forge.
 * Runs directly on ProBook using Claude Sonnet 4.5 (OpenRouter), GPT-4.1 (OpenAI),
 * or Gemini 2.5 Flash (Google) with 8,192 output tokens—eliminating the Claude.ai
 * browser artifact iframe's sample.json token limit ("Claude returned no text for this prompt")
 * and automatically self-healing any Blender 4.3 Python runtime errors on AlienPC.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

export interface BlenderCadGenOptions {
  brief?: string;
  scaleRef?: string;
  previousCode?: string;
  userFeedback?: string;
  photoBase64?: string;
  errorFeedback?: string;
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
4. MULTI-TIERED HARD-SURFACE DETAIL (BUILD 60 TO 250+ CRISP GEOMETRIC SUB-PARTS):
   - Define clean helper functions (\`add_box\`, \`add_poly_extrude\`, \`add_thruster_nozzle\`, \`add_panel_grid\`, etc.) and use Python \`for\` loops with symmetry (\`for sx in (-1, 1):\`, \`for i in range(n):\`).
   - Primary Structural Hull / Baffle Frame: Exact polygonal silhouette with raised perimeter armor bevel strips and stepped mounting decks.
   - Cylindrical & Concentric Assemblies (thrusters, engines, wheels, barrels): Use \`vertices=64\`. Build multi-stage concentric cowlings (outer shroud cone, 2–3 stepped inner rings, recessed core, and 16–28 radial cooling vanes/struts arranged in a circle \`for v in range(vanes):\`).
   - Cooling Louvers, Trenches & Micro-Greebles: Populate wings/decks with arrays of angled louver slats, structural ribs, piping conduits, and raised capacitor/greeble blocks (0.8–3.0 mm relief depth).
   - Ensure all sub-parts overlap their parent surface by at least 0.4 mm so the assembly slices cleanly in Chitubox. Use Z as up, units in millimetres, centered around X=0, Y=0, base at Z=0.

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

async function callOpenRouterClaude(
  prompt: string,
  b64Image: string | null,
  apiKey: string,
  timeoutMs: number,
): Promise<BlenderCadGenResult> {
  const content: any[] = [];
  if (b64Image) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64Image}` },
    });
  }
  content.push({ type: 'text', text: prompt });

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'anthropic/claude-sonnet-4.5',
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter claude-sonnet-4.5 HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const parsed = extractBlenderScript(raw);
  return { ...parsed, provider: 'claude-sonnet-4.5' };
}

async function callOpenAiGpt4(
  prompt: string,
  b64Image: string | null,
  apiKey: string,
  timeoutMs: number,
): Promise<BlenderCadGenResult> {
  const content: any[] = [];
  if (b64Image) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${b64Image}` },
    });
  }
  content.push({ type: 'text', text: prompt });

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenAI gpt-4.1 HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  const raw = data?.choices?.[0]?.message?.content ?? '';
  const parsed = extractBlenderScript(raw);
  return { ...parsed, provider: 'gpt-4.1' };
}

async function callGeminiFlash(
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.2,
      },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Gemini 2.5 Flash HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  const textParts = (data?.candidates?.[0]?.content?.parts ?? [])
    .map((p: any) => p?.text ?? '')
    .join('\n');
  const parsed = extractBlenderScript(textParts);
  return { ...parsed, provider: 'gemini-2.5-flash' };
}

export async function generateBlenderCadScript(
  opts: BlenderCadGenOptions,
): Promise<BlenderCadGenResult> {
  ensureForgeEnvLoaded();
  const prompt = buildServerBlenderPrompt(opts);
  const b64Image = cleanBase64Jpeg(opts.photoBase64);
  const timeoutMs = opts.timeoutMs ?? 55_000;
  const fallbackName = (opts.brief?.trim() || 'blender-cad-model').slice(0, 50);

  const errors: string[] = [];

  // 1. Primary: Claude Sonnet 4.5 via OpenRouter (8,192 output tokens, zero iframe cap)
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (openRouterKey) {
    try {
      const r = await callOpenRouterClaude(prompt, b64Image, openRouterKey, timeoutMs);
      return { ...r, name: r.name === 'blender-cad-model' ? fallbackName : r.name };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  // 2. Fallback 1: OpenAI GPT-4.1 (8,192 output tokens, multimodal)
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    try {
      const r = await callOpenAiGpt4(prompt, b64Image, openAiKey, timeoutMs);
      return { ...r, name: r.name === 'blender-cad-model' ? fallbackName : r.name };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  // 3. Fallback 2: Google Gemini 2.5 Flash (8,192 output tokens, multimodal)
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const r = await callGeminiFlash(prompt, b64Image, geminiKey, timeoutMs);
      return { ...r, name: r.name === 'blender-cad-model' ? fallbackName : r.name };
    } catch (e) {
      errors.push((e as Error).message);
    }
  }

  throw new Error(
    `Server-side Blender CAD generation failed: ${errors.join(' | ') || 'no API keys configured'}`,
  );
}
