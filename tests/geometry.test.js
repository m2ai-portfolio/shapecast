import { describe, it, expect } from 'vitest';
import {
  localTriangles,
  partToTriangles,
  meshChecks,
  signedVolume,
  boundingBox,
  triangulatePolygon,
  rotationMatrix,
} from '../src/geometry.js';

const part = (p) => ({ id: 'p', pos: [0, 0, 0], rot: [0, 0, 0], role: 'add', ...p });
const r9 = (v) => Math.round(v * 1e9) / 1e9 + 0;

describe('geometry core', () => {
  it('box: 12 triangles, volume 1000 for a 10 mm cube, manifold', () => {
    const d = localTriangles(part({ type: 'box', size: [10, 10, 10] }));
    expect(d.length / 9).toBe(12);
    expect(signedVolume(d)).toBeCloseTo(1000, 6);
    expect(meshChecks(d).ok).toBe(true);
    expect(boundingBox(d)).toEqual({ min: [-5, -5, -5], max: [5, 5, 5], size: [10, 10, 10] });
  });
  it('wedge: 8 triangles, half the box volume, full height at -X', () => {
    const d = localTriangles(part({ type: 'wedge', size: [10, 20, 6] }));
    expect(d.length / 9).toBe(8);
    expect(signedVolume(d)).toBeCloseTo(600, 6);
    expect(meshChecks(d).ok).toBe(true);
    const bb = boundingBox(d);
    expect(bb.size.map(r9)).toEqual([10, 20, 6]);
    for (let i = 2; i < d.length; i += 3) if (d[i] > 2.99) expect(d[i - 2]).toBeCloseTo(-5, 9);
  });
  it('extrude: CCW and CW profiles both give positive volume and pass checks', () => {
    const ccw = localTriangles(
      part({
        type: 'extrude',
        profile: [
          [0, 0],
          [40, 0],
          [40, 3],
          [0, 3],
        ],
        height: 60,
      }),
    );
    const cw = localTriangles(
      part({
        type: 'extrude',
        profile: [
          [0, 3],
          [40, 3],
          [40, 0],
          [0, 0],
        ],
        height: 60,
      }),
    );
    for (const d of [ccw, cw]) {
      expect(signedVolume(d)).toBeCloseTo(40 * 3 * 60, 4);
      expect(meshChecks(d).ok).toBe(true);
    }
    expect(ccw.length / 9).toBe(12);
  });
  it('extrude: concave L profile is triangulated and manifold', () => {
    const d = localTriangles(
      part({
        type: 'extrude',
        profile: [
          [0, 0],
          [10, 0],
          [10, 4],
          [4, 4],
          [4, 10],
          [0, 10],
        ],
        height: 2,
      }),
    );
    expect(meshChecks(d).ok).toBe(true);
    expect(signedVolume(d)).toBeCloseTo((100 - 36) * 2, 6);
  });
  it('triangulatePolygon returns n-2 triangles covering the area', () => {
    const pts = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
    ];
    const tris = triangulatePolygon(pts);
    expect(tris.length).toBe(4);
    const area = tris.reduce(
      (s, [a, b, c]) =>
        s +
        Math.abs(
          (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) -
            (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0]),
        ) /
          2,
      0,
    );
    expect(area).toBeCloseTo(64, 9);
  });
  it('rotationMatrix follows XYZ order (rotate about X first)', () => {
    const m = rotationMatrix([90, 0, 0]);
    expect([m[1], m[4], m[7]].map(r9)).toEqual([0, 0, 1]);
    const m2 = rotationMatrix([90, 0, 90]);
    expect([m2[1], m2[4], m2[7]].map(r9)).toEqual([0, 0, 1]);
    expect([m2[0], m2[3], m2[6]].map(r9)).toEqual([0, 1, 0]);
  });
  it('partToTriangles places the local origin at pos and keeps winding under rotation', () => {
    const d = partToTriangles(
      part({ type: 'box', size: [10, 10, 10], pos: [100, 0, 5], rot: [0, 0, 45] }),
    );
    const bb = boundingBox(d);
    expect(bb.min[2]).toBeCloseTo(0, 9);
    expect(bb.max[2]).toBeCloseTo(10, 9);
    expect((bb.min[0] + bb.max[0]) / 2).toBeCloseTo(100, 9);
    expect(bb.size[0]).toBeCloseTo(Math.SQRT2 * 10, 9);
    expect(signedVolume(d)).toBeCloseTo(1000, 6);
  });
  it('meshChecks catches an open shell, inverted winding and a pinched vertex', () => {
    const d = localTriangles(part({ type: 'box', size: [10, 10, 10] }));
    expect(meshChecks(d.subarray(0, d.length - 9)).errors.join(' ')).toMatch(/edge/);
    const inv = Float64Array.from(d);
    for (let i = 0; i < inv.length; i += 9)
      for (let k = 0; k < 3; k++) {
        const t = inv[i + 3 + k];
        inv[i + 3 + k] = inv[i + 6 + k];
        inv[i + 6 + k] = t;
      }
    expect(meshChecks(inv).errors.join(' ')).toMatch(/volume/);
    const tet = (o) => {
      const a = [o, 0, 0],
        b = [o + 2, 0, 0],
        c = [o + 1, 2, 0],
        t = [0, 0, 3];
      return [
        [a, c, b],
        [a, b, t],
        [b, c, t],
        [c, a, t],
      ];
    };
    const flat = new Float64Array([...tet(0.5), ...tet(-2.5)].flat(2));
    expect(signedVolume(flat)).toBeGreaterThan(0);
    expect(meshChecks(flat).errors.join(' ')).toMatch(/pinched/);
  });
});
