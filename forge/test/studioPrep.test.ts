import { describe, expect, it } from 'vitest';
import { buildStudioPrepPrompt, runStudioPrep } from '../src/studioPrep.js';

describe('studioPrep Step 0', () => {
  it('builds a photo-cleanup studio prompt when hasPhoto is true', () => {
    const p = buildStudioPrepPrompt('1991 Acura NSX widebody', true);
    expect(p).toContain('Transform this reference photo');
    expect(p).toContain('1991 Acura NSX widebody');
    expect(p).toContain('#FFFFFF');
    expect(p).toContain('ZERO ground shadow');
  });

  it('builds a text-to-studio prompt when hasPhoto is false', () => {
    const p = buildStudioPrepPrompt('miniature dragon bust', false);
    expect(p).toContain(
      'Create an ideal 3D-scanner studio product photograph of: miniature dragon bust',
    );
    expect(p).toContain('#FFFFFF');
  });

  it('returns null immediately when engine is local or off', async () => {
    const resLocal = await runStudioPrep({ prompt: 'cube', engine: 'local' });
    const resOff = await runStudioPrep({ prompt: 'cube', engine: 'off' });
    expect(resLocal).toBeNull();
    expect(resOff).toBeNull();
  });

  it('returns null cleanly when no API keys are provided', async () => {
    const res = await runStudioPrep({
      prompt: 'cube',
      engine: 'auto',
      geminiApiKey: '',
      openaiApiKey: '',
    });
    expect(res).toBeNull();
  });
});
