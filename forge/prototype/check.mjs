// Inspect a Hunyuan3D GLB: triangle count, bbox, manifold checks; write a Saturn 3 STL scaled
// so the longest horizontal side is TARGET mm, Z up, sitting on z = 0.
// usage: node check.mjs in.glb out.stl [targetMm]
import { NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';
import { meshChecks, boundingBox, signedVolume, flipWinding } from '../../src/geometry.js';
import { writeBinaryStl } from '../../src/stl.js';

const [, , inPath, outPath, targetArg] = process.argv;
const target = Number(targetArg ?? 150);
const doc = await new NodeIO().read(inPath);
const tris = [];
for (const mesh of doc.getRoot().listMeshes())
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION').getArray();
    const idx =
      prim.getIndices()?.getArray() ?? Array.from({ length: pos.length / 3 }, (_, i) => i);
    for (let i = 0; i < idx.length; i += 3)
      for (const k of [idx[i], idx[i + 1], idx[i + 2]])
        tris.push(pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]);
  }
let d = Float64Array.from(tris);
console.log('triangles', d.length / 9);
console.log('raw bbox', JSON.stringify(boundingBox(d).size.map((v) => +v.toFixed(3))));
// glTF is Y-up; convert to Z-up: (x, y, z) -> (x, -z, y), a proper rotation (winding kept)
const z = new Float64Array(d.length);
for (let i = 0; i < d.length; i += 3) {
  z[i] = d[i];
  z[i + 1] = -d[i + 2];
  z[i + 2] = d[i + 1];
}
d = z;
if (signedVolume(d) < 0) flipWinding(d);
const bb = boundingBox(d);
const s = target / Math.max(bb.size[0], bb.size[1]);
for (let i = 0; i < d.length; i += 3) {
  d[i] = (d[i] - (bb.min[0] + bb.max[0]) / 2) * s;
  d[i + 1] = (d[i + 1] - (bb.min[1] + bb.max[1]) / 2) * s;
  d[i + 2] = (d[i + 2] - bb.min[2]) * s;
}
const sb = boundingBox(d);
console.log('scaled bbox mm', JSON.stringify(sb.size.map((v) => +v.toFixed(1))));
console.log('volume mL', (signedVolume(d) / 1000).toFixed(1));
const mc = meshChecks(d);
console.log('meshChecks', mc.ok ? 'OK' : mc.errors.join(' | '));
writeFileSync(outPath, Buffer.from(writeBinaryStl(d, 'c8 hunyuan3d 2.1')));
console.log('wrote', outPath);
