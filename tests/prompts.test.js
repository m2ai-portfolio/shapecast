import { describe, it, expect } from 'vitest';
import { builderPrompt, editorPrompt, criticPrompt } from '../src/prompts.js';
import { slugify, readmeText, truncateRequest } from '../src/exportbundle.js';
import { EXAMPLE_LIST } from '../src/schema.js';

describe('prompts', () => {
  it('builder prompt carries the brief, scale reference, image count, envelope, schema and JSON-only instruction', () => {
    const p = builderPrompt({
      brief: 'a phone stand',
      scaleRef: 'the coin is 24.26 mm across',
      imageCount: 2,
    });
    for (const s of [
      'a phone stand',
      '24.26 mm',
      '2 photo',
      '218',
      '122',
      '250',
      '"type"',
      'lathe',
      'Reply with only the JSON',
      'assumptions',
      '0.5 mm',
    ])
      expect(p).toContain(s);
    expect(builderPrompt({ brief: '', scaleRef: '', imageCount: 0 })).toContain(
      'No scale reference',
    );
  });
  it('editor prompt embeds the current list and the request', () => {
    const p = editorPrompt({ partList: EXAMPLE_LIST, request: 'make the slot 2 mm wider' });
    expect(p).toContain('"id":"base"');
    expect(p).toContain('make the slot 2 mm wider');
    expect(p).toContain('complete replacement');
  });
  it('critic prompt embeds telemetry, aspect ratio, and threshold', () => {
    const p = criticPrompt({
      brief: '2022 Chevrolet Corvette C8',
      scaleRef: '120 mm longest side',
      bbox: { size: [120, 55.4, 33.7] },
      triangleCount: 90062,
      volumeMl: 108.2,
      qualityMetrics: { crease_edge_pct: 9.2, symmetry_score: 98.5 },
      iteration: 1,
      threshold: 85,
    });
    expect(p).toContain('2022 Chevrolet Corvette C8');
    expect(p).toContain('120.00 x 55.40 x 33.70');
    expect(p).toContain('refine_remesh');
    expect(p).toContain('aspectRatioTarget');
  });
});

describe('export bundle', () => {
  it('slugify', () => {
    expect(slugify('Phone Stand v2!')).toBe('phone-stand-v2');
    expect(slugify('   ')).toBe('model');
    expect(slugify('x'.repeat(60)).length).toBe(40);
  });
  it('truncateRequest caps at 2000 characters', () => {
    expect(truncateRequest('a'.repeat(2500)).length).toBe(2000);
    expect(truncateRequest('ok')).toBe('ok');
  });
  it('readme lists assumptions, bounding box, checks and layer height', () => {
    const result = {
      bbox: { size: [70, 60, 62] },
      checks: [{ level: 'amber', message: 'Contact not confirmed: back' }],
      volumeMm3: 24000,
    };
    const t = readmeText({ list: EXAMPLE_LIST, result, layerUm: 50 });
    for (const s of [
      'phone stand',
      'overall height estimated',
      '70.00 x 60.00 x 62.00 mm',
      'Contact not confirmed',
      '50 um',
      'flat',
      'Chitubox',
    ])
      expect(t).toContain(s);
  });
});
