import { describe, it, expect } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  boundingBox,
  signedVolume,
  meshChecks,
  writeBinaryStl,
  parseGlbTriangles,
  repairAndPrepareMesh,
  unpackIndexedMesh,
  saturn3PrintChecks,
} from '../src/mesh.js';

function makeBoxTriangles(sx: number, sy: number, sz: number, offset = [0, 0, 0]): Float64Array {
  const x = sx / 2,
    y = sy / 2,
    z = sz / 2;
  const [ox, oy, oz] = offset;
  const v = [
    [-x + ox, -y + oy, -z + oz],
    [x + ox, -y + oy, -z + oz],
    [x + ox, y + oy, -z + oz],
    [-x + ox, y + oy, -z + oz],
    [-x + ox, -y + oy, z + oz],
    [x + ox, -y + oy, z + oz],
    [x + ox, y + oy, z + oz],
    [-x + ox, y + oy, z + oz],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const tris: number[] = [];
  for (const f of faces) {
    tris.push(...v[f[0]], ...v[f[1]], ...v[f[2]]);
    tris.push(...v[f[0]], ...v[f[2]], ...v[f[3]]);
  }
  return Float64Array.from(tris);
}

describe('forge mesh pipeline', () => {
  it('parses a GLB buffer and converts Y-up to Z-up', async () => {
    const doc = new Document();
    const buf = doc.createBuffer();
    // Box in Y-up: width X=2, height Y=1, depth Z=4 -> in Z-up: X=2, Y=4, Z=1
    const raw = makeBoxTriangles(2, 1, 4);
    const pos = doc
      .createAccessor()
      .setType('VEC3')
      .setArray(Float32Array.from(raw))
      .setBuffer(buf);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos);
    const mesh = doc.createMesh().addPrimitive(prim);
    doc.createScene().addChild(doc.createNode().setMesh(mesh));
    const glb = await new NodeIO().writeBinary(doc);

    const tris = await parseGlbTriangles(glb);
    expect(tris.length / 9).toBe(12);
    const bb = boundingBox(tris);
    expect(bb.size[0]).toBeCloseTo(2, 3);
    expect(bb.size[1]).toBeCloseTo(4, 3);
    expect(bb.size[2]).toBeCloseTo(1, 3);
    expect(signedVolume(tris)).toBeGreaterThan(0);
  });

  it('repairs non-manifold multi-component meshes, scales to targetMm, grounds at z=0, and passes meshChecks', () => {
    // Main box (20x40x10) + small floating debris box (2x2x2 far away) + unclosed stray triangle
    const main = makeBoxTriangles(20, 40, 10, [5, -10, 15]);
    const debris = makeBoxTriangles(2, 2, 2, [100, 100, 100]);
    const stray = Float64Array.from([5, -10, 15, 6, -10, 15, 5, -9, 15]);
    const combined = new Float64Array(main.length + debris.length + stray.length);
    combined.set(main, 0);
    combined.set(debris, main.length);
    combined.set(stray, main.length + debris.length);

    expect(meshChecks(combined).ok).toBe(false);

    const res = repairAndPrepareMesh(combined, { targetMm: 120, gridRes: 48 });
    expect(res.manifold.ok).toBe(true);
    expect(res.manifold.errors).toEqual([]);
    // Longest horizontal side scaled to 120 mm (since main was 20x40, Y should be 120, X ~ 60)
    expect(Math.max(res.bbox.size[0], res.bbox.size[1])).toBeCloseTo(120, 1);
    expect(res.bbox.min[2]).toBeCloseTo(0, 5);
    expect(res.volumeMl).toBeGreaterThan(10);

    // Unpacked preview should also pass meshChecks
    const unpacked = unpackIndexedMesh(res.preview);
    expect(unpacked.length / 9).toBe(res.preview.triangleCount);
    expect(meshChecks(unpacked).ok).toBe(true);

    // Binary STL header + byte size check
    const stl = writeBinaryStl(res.tris, 'repaired');
    expect(stl.byteLength).toBe(84 + 50 * res.triangleCount);
  });

  it('evaluates Saturn 3 build plate fit checks accurately', () => {
    const okFit = saturn3PrintChecks(
      { min: [-50, -30, 0], max: [50, 30, 40], size: [100, 60, 40] },
      50000,
      true,
      50,
    );
    expect(okFit.worst).toBe('green');
    expect(okFit.layers[50]).toBe(800);

    const rotFit = saturn3PrintChecks(
      { min: [-50, -100, 0], max: [50, 100, 40], size: [100, 200, 40] },
      50000,
      true,
      50,
    );
    expect(rotFit.worst).toBe('amber');

    const tooBig = saturn3PrintChecks(
      { min: [-150, -150, 0], max: [150, 150, 40], size: [300, 300, 40] },
      50000,
      true,
      50,
    );
    expect(tooBig.worst).toBe('red');
  });
});
