import { describe, it, expect } from 'vitest';
import { writeBinaryStl, readStlHeader, concatTriangles, listToTriangles } from '../src/stl.js';
import { EXAMPLE_LIST } from '../src/schema.js';
import { partToTriangles } from '../src/geometry.js';

describe('stl', () => {
  it('writes 84 + 50 * n bytes with the header and count parsing back', () => {
    const d = listToTriangles(EXAMPLE_LIST);
    const n = d.length / 9;
    const buf = writeBinaryStl(d, EXAMPLE_LIST.name);
    expect(buf.byteLength).toBe(84 + 50 * n);
    const h = readStlHeader(buf);
    expect(h.triangles).toBe(n);
    expect(h.header).toBe('ShapeCast phone stand');
    const dv = new DataView(buf);
    expect(dv.getFloat32(84 + 12, true)).toBeCloseTo(d[0], 5);
    expect(dv.getUint16(84 + 48, true)).toBe(0);
  });
  it('writes unit normals', () => {
    const buf = writeBinaryStl(
      partToTriangles({ type: 'box', size: [2, 2, 2], pos: [0, 0, 0], rot: [0, 0, 0] }),
    );
    const dv = new DataView(buf);
    const l = Math.hypot(dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true));
    expect(l).toBeCloseTo(1, 5);
  });
  it('concatTriangles preserves order and length', () => {
    const a = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
      b = new Float64Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const c = concatTriangles([a, b]);
    expect(c.length).toBe(18);
    expect(c[9]).toBe(9);
    expect(c[17]).toBe(1);
  });
});
