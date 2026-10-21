/**
 * Automated Step 0 ("Studio Reference Prep") for ShapeCast Forge.
 * Cleans up messy real-world reference photos (removing background clutter, ground shadows,
 * window glare, and perspective distortion) or generates a clean 3D-scanner studio reference
 * image from a text brief using Google Gemini Image Gen (`gemini-2.5-flash-image`) or
 * OpenAI ChatGPT Image Gen (`gpt-image-1`), with automatic fallback to local AlienPC Flux/raw photo.
 */

export type StudioEngine = 'auto' | 'gemini' | 'openai' | 'local' | 'off';

export interface StudioPrepOptions {
  prompt?: string;
  photoBytes?: Uint8Array;
  engine?: StudioEngine;
  geminiApiKey?: string;
  openaiApiKey?: string;
  timeoutMs?: number;
}

export interface StudioPrepResult {
  bytes: Uint8Array;
  ext: 'png' | 'jpg';
  provider: 'gemini' | 'openai' | 'raw_photo';
  model?: string;
}

export function buildStudioPrepPrompt(brief?: string, hasPhoto = false): string {
  const cleanBrief = String(brief ?? '')
    .trim()
    .slice(0, 1000);
  if (hasPhoto) {
    return [
      'Transform this reference photo into an ideal 3D-scanner studio product photograph for high-definition watertight 3D mesh reconstruction:',
      cleanBrief
        ? `- Subject details to emphasize: ${cleanBrief}.`
        : '- Preserve the exact subject identity, proportions, body kit, aerodynamic parts, wheels, and structural details from the input photo.',
      '- Render the complete object in a clean front three-quarter orthographic view, centered in frame with generous white margin on all sides so nothing is cropped.',
      '- Pure solid white studio background (#FFFFFF) with ZERO ground shadow, ZERO cast shadow, and ZERO specular glare or reflections on windows/surfaces.',
      '- Accentuate bold, deep-relief 3D physical crevices: deeply recessed window frames, pronounced rafters/eaves/molding, crisp chamfered panel seams, and strong geometric depth so volumetric 3D reconstruction captures every detail.',
      '- Use uniform satin/matte studio lighting so every panel seam, crease, wheel arch, and geometric edge is sharp, high-contrast, and unambiguous for 3D reconstruction.',
    ].join('\n');
  }
  return [
    `Create an ideal 3D-scanner studio product photograph of: ${cleanBrief || 'a 3D printable object'}.`,
    '- Single complete 3D object centered in frame with generous white margin on all sides.',
    '- Clean front three-quarter orthographic studio view.',
    '- Pure solid white studio background (#FFFFFF) with ZERO ground shadow and ZERO window/specular glare.',
    '- Sculpt with bold, deep-relief physical geometry: deeply recessed window mullions and frames, pronounced eaves/rafters/trim, crisp chamfered edges, and clear crevices suitable for high-detail 3D resin printing.',
    '- Crisp matte studio lighting with sharp geometric creases, clean panel seams, and well-defined structural details.',
  ].join('\n');
}

export async function runGeminiStudioPrep({
  prompt,
  photoBytes,
  apiKey,
  timeoutMs = 35_000,
}: {
  prompt?: string;
  photoBytes?: Uint8Array;
  apiKey: string;
  timeoutMs?: number;
}): Promise<StudioPrepResult> {
  const models = ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'];
  const parts: Array<Record<string, unknown>> = [];
  if (photoBytes && photoBytes.byteLength > 0) {
    parts.push({
      inlineData: {
        mimeType: 'image/jpeg',
        data: Buffer.from(photoBytes).toString('base64'),
      },
    });
  }
  parts.push({
    text: buildStudioPrepPrompt(prompt, Boolean(photoBytes && photoBytes.byteLength > 0)),
  });

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
            responseModalities: ['TEXT', 'IMAGE'],
          },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Gemini ${model} HTTP ${res.status}: ${errBody.slice(0, 200)}`);
      }
      const data = (await res.json()) as any;
      const candidateParts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
      for (const p of candidateParts) {
        const inline = p?.inlineData ?? p?.inline_data;
        if (inline?.data && typeof inline.data === 'string') {
          const bytes = new Uint8Array(Buffer.from(inline.data, 'base64'));
          if (bytes.byteLength > 256) {
            const mime = String(inline.mimeType ?? inline.mime_type ?? 'image/png');
            return {
              bytes,
              ext: mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : 'png',
              provider: 'gemini',
              model,
            };
          }
        }
      }
      throw new Error(`Gemini ${model} returned no image inlineData`);
    } catch (e) {
      lastErr = e as Error;
    }
  }
  throw lastErr ?? new Error('Gemini Studio Prep failed');
}

export async function runOpenAiStudioPrep({
  prompt,
  photoBytes,
  apiKey,
  timeoutMs = 50_000,
}: {
  prompt?: string;
  photoBytes?: Uint8Array;
  apiKey: string;
  timeoutMs?: number;
}): Promise<StudioPrepResult> {
  const studioPrompt = buildStudioPrepPrompt(
    prompt,
    Boolean(photoBytes && photoBytes.byteLength > 0),
  );
  let res: Response;
  if (photoBytes && photoBytes.byteLength > 0) {
    const form = new FormData();
    form.append('model', 'gpt-image-1');
    form.append('prompt', studioPrompt);
    form.append('size', '1024x1024');
    form.append('quality', 'medium');
    form.append(
      'image',
      new Blob([Buffer.from(photoBytes)], { type: 'image/jpeg' }),
      'reference.jpg',
    );
    res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } else {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: studioPrompt,
        size: '1024x1024',
        quality: 'medium',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OpenAI gpt-image-1 HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  const first = data?.data?.[0];
  if (first?.b64_json && typeof first.b64_json === 'string') {
    const bytes = new Uint8Array(Buffer.from(first.b64_json, 'base64'));
    if (bytes.byteLength > 256) {
      return { bytes, ext: 'png', provider: 'openai', model: 'gpt-image-1' };
    }
  }
  if (first?.url && typeof first.url === 'string') {
    const imgRes = await fetch(first.url, { signal: AbortSignal.timeout(20_000) });
    if (imgRes.ok) {
      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      if (bytes.byteLength > 256) {
        return { bytes, ext: 'png', provider: 'openai', model: 'gpt-image-1' };
      }
    }
  }
  throw new Error('OpenAI gpt-image-1 returned no image data');
}

export async function runStudioPrep(opts: StudioPrepOptions): Promise<StudioPrepResult | null> {
  const engine: StudioEngine = opts.engine ?? 'auto';
  if (engine === 'local' || engine === 'off') {
    return null;
  }

  const geminiKey = (
    opts.geminiApiKey ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY ??
    ''
  ).trim();
  const openaiKey = (opts.openaiApiKey ?? process.env.OPENAI_API_KEY ?? '').trim();

  const tryOrder: Array<'gemini' | 'openai'> =
    engine === 'openai'
      ? ['openai', 'gemini']
      : engine === 'gemini'
        ? ['gemini', 'openai']
        : ['gemini', 'openai'];

  for (const provider of tryOrder) {
    if (provider === 'gemini' && geminiKey) {
      try {
        return await runGeminiStudioPrep({
          prompt: opts.prompt,
          photoBytes: opts.photoBytes,
          apiKey: geminiKey,
          timeoutMs: opts.timeoutMs,
        });
      } catch (e) {
        console.warn(`StudioPrep (Gemini) fallback: ${(e as Error).message}`);
      }
    }
    if (provider === 'openai' && openaiKey) {
      try {
        return await runOpenAiStudioPrep({
          prompt: opts.prompt,
          photoBytes: opts.photoBytes,
          apiKey: openaiKey,
          timeoutMs: opts.timeoutMs,
        });
      } catch (e) {
        console.warn(`StudioPrep (OpenAI) fallback: ${(e as Error).message}`);
      }
    }
  }
  return null;
}
