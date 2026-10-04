import { NodeIO } from '@gltf-transform/core';
const doc = await new NodeIO().read(process.argv[2]);
const prim = doc.getRoot().listMeshes()[0].listPrimitives()[0];
const pos = prim.getAttribute('POSITION').getArray(),
  idx = prim.getIndices().getArray();
console.log(
  'meshes',
  doc.getRoot().listMeshes().length,
  'prims',
  doc.getRoot().listMeshes()[0].listPrimitives().length,
  'verts',
  pos.length / 3,
  'tris',
  idx.length / 3,
);
// undirected edge multiplicity by vertex index, and directed duplicates
const und = new Map(),
  dir = new Map();
for (let i = 0; i < idx.length; i += 3)
  for (let e = 0; e < 3; e++) {
    const a = idx[i + e],
      b = idx[i + ((e + 1) % 3)];
    const u = a < b ? a + ',' + b : b + ',' + a;
    und.set(u, (und.get(u) || 0) + 1);
    const dk = a + ',' + b;
    dir.set(dk, (dir.get(dk) || 0) + 1);
  }
const hist = {};
for (const c of und.values()) hist[c] = (hist[c] || 0) + 1;
let sameDir = 0;
for (const [k, c] of dir) if (c > 1) sameDir++;
let opposite = 0,
  inconsistent = 0;
for (const [u, c] of und)
  if (c === 2) {
    const [a, b] = u.split(',');
    const ab = dir.get(a + ',' + b) || 0,
      ba = dir.get(b + ',' + a) || 0;
    if (ab === 1 && ba === 1) opposite++;
    else inconsistent++;
  }
// position-duplicate vertices (unwelded seams)
const keys = new Map();
let dupVerts = 0;
for (let v = 0; v < pos.length / 3; v++) {
  const k = `${pos[3 * v].toFixed(6)},${pos[3 * v + 1].toFixed(6)},${pos[3 * v + 2].toFixed(6)}`;
  if (keys.has(k)) dupVerts++;
  else keys.set(k, v);
}
// connected components over triangles sharing vertex indices
const parent = Array.from({ length: pos.length / 3 }, (_, i) => i);
const f = (x) => (parent[x] === x ? x : (parent[x] = f(parent[x])));
for (let i = 0; i < idx.length; i += 3) {
  parent[f(idx[i])] = f(idx[i + 1]);
  parent[f(idx[i + 1])] = f(idx[i + 2]);
}
const comps = new Map();
for (let i = 0; i < idx.length; i += 3) {
  const r = f(idx[i]);
  comps.set(r, (comps.get(r) || 0) + 1);
}
const sizes = [...comps.values()].sort((a, b) => b - a);
console.log(
  'edge multiplicity',
  JSON.stringify(hist),
  'opposite-pairs',
  opposite,
  'same-direction-pairs',
  inconsistent,
  'dup-directed',
  sameDir,
);
console.log(
  'position-duplicate vertices',
  dupVerts,
  'components',
  sizes.length,
  'largest',
  sizes.slice(0, 5),
);
