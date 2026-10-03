import { describe, it, expect } from 'vitest';
import {
  localTriangles,
  meshChecks,
  signedVolume,
  partVolume,
  boundingBox,
} from '../src/geometry.js';
import { triangleCount } from '../src/schema.js';

const part = (p) => ({ id: 'p', pos: [0, 0, 0], rot: [0, 0, 0], role: 'add', ...p });
const cases = [
  part({ type: 'cylinder', radius: 10, height: 20, segments: 64 }),
  part({ type: 'cylinder', radius: 10, radiusTop: 4, height: 20, segments: 64 }),
  part({ type: 'cylinder', radius: 10, radiusTop: 0, height: 20, segments: 64 }),
  part({ type: 'cone', radius: 10, height: 20, segments: 32 }),
  part({ type: 'sphere', radius: 10, segments: 64 }),
  part({ type: 'torus', radius: 20, tube: 4, segments: 64 }),
  part({
    type: 'lathe',
    profile: [
      [0, -10],
      [10, 0],
      [0, 10],
    ],
    segments: 64,
  }),
  part({
    type: 'lathe',
    profile: [
      [0, 0],
      [10, 0],
      [10, 5],
      [0, 5],
    ],
    segments: 64,
  }),
  part({
    type: 'lathe',
    profile: [
      [0, 5],
      [10, 5],
      [10, 0],
      [0, 0],
    ],
    segments: 64,
  }),
  part({
    type: 'lathe',
    profile: [
      [0, 0],
      [10, 0],
      [0, 10],
    ],
    segments: 32,
  }),
  part({
    type: 'lathe',
    profile: [
      [0, 0],
      [12, 0],
      [12, 2],
      [4, 2],
      [4, 20],
      [0, 20],
    ],
    segments: 48,
  }),
  part({ type: 'cylinder', radius: 10, height: 0.5, segments: 64 }),
];

describe('curved primitives', () => {
  for (const p of cases) {
    it(`${p.type} ${JSON.stringify(p.profile ?? p.radiusTop ?? p.height)} is manifold, outward, within triangleCount`, () => {
      const d = localTriangles(p);
      expect(meshChecks(d).errors).toEqual([]);
      expect(d.length / 9).toBeLessThanOrEqual(triangleCount(p));
      const tol = (p.segments ?? 64) >= 64 ? 0.01 : 0.03;
      expect(Math.abs(signedVolume(d) - partVolume(p)) / partVolume(p)).toBeLessThan(tol);
    });
  }
  it('analytic volumes', () => {
    expect(partVolume(part({ type: 'cylinder', radius: 10, height: 20 }))).toBeCloseTo(
      Math.PI * 2000,
      6,
    );
    expect(partVolume(part({ type: 'cone', radius: 10, height: 20 }))).toBeCloseTo(
      (Math.PI * 2000) / 3,
      6,
    );
    expect(partVolume(part({ type: 'sphere', radius: 10 }))).toBeCloseTo(
      (4 / 3) * Math.PI * 1000,
      6,
    );
    expect(partVolume(part({ type: 'torus', radius: 20, tube: 4 }))).toBeCloseTo(
      2 * Math.PI ** 2 * 320,
      6,
    );
    expect(
      partVolume(
        part({
          type: 'lathe',
          profile: [
            [0, 0],
            [10, 0],
            [10, 5],
            [0, 5],
          ],
        }),
      ),
    ).toBeCloseTo(Math.PI * 500, 6);
    expect(
      partVolume(
        part({
          type: 'extrude',
          profile: [
            [0, 0],
            [4, 0],
            [4, 3],
          ],
          height: 2,
        }),
      ),
    ).toBeCloseTo(12, 9);
    expect(partVolume(part({ type: 'wedge', size: [2, 3, 4] }))).toBe(12);
  });
  it('sphere bounding box is 2r and cylinder is centred on its axis', () => {
    const r6 = (v) => Math.round(v * 1e6) / 1e6;
    expect(boundingBox(localTriangles(part({ type: 'sphere', radius: 7 }))).size.map(r6)).toEqual([
      14, 14, 14,
    ]);
    const bb = boundingBox(localTriangles(part({ type: 'cylinder', radius: 5, height: 9 })));
    expect(bb.min[2]).toBeCloseTo(-4.5, 9);
    expect(bb.max[2]).toBeCloseTo(4.5, 9);
  });
  it('forced hourglass lathe fails the vertex-link check', () => {
    const d = localTriangles(
      part({
        type: 'lathe',
        profile: [
          [0, 0],
          [10, -10],
          [20, 0],
          [10, 10],
        ],
        segments: 16,
      }),
    );
    expect(meshChecks(d).errors.join(' ')).toMatch(/pinched/);
  });
});
