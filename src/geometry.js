import { segmentsOf, signedArea, triangleCount } from './schema.js';

export class TriBuffer {
  constructor(capacity) {
    this.a = new Float64Array(Math.max(1, capacity) * 9);
    this.n = 0;
  }
  push(p, q, r) {
    if ((this.n + 1) * 9 > this.a.length) {
      const g = new Float64Array(this.a.length * 2 + 9);
      g.set(this.a);
      this.a = g;
    }
    const o = this.n * 9,
      a = this.a;
    a[o] = p[0];
    a[o + 1] = p[1];
    a[o + 2] = p[2];
    a[o + 3] = q[0];
    a[o + 4] = q[1];
    a[o + 5] = q[2];
    a[o + 6] = r[0];
    a[o + 7] = r[1];
    a[o + 8] = r[2];
    this.n++;
  }
  data() {
    return this.a.subarray(0, this.n * 9);
  }
}

/** Rotation matrix (row-major 3x3) for Euler XYZ degrees: R = Rz * Ry * Rx, X applied first. */
export function rotationMatrix(rot) {
  const d = Math.PI / 180;
  const cx = Math.cos(rot[0] * d),
    sx = Math.sin(rot[0] * d),
    cy = Math.cos(rot[1] * d),
    sy = Math.sin(rot[1] * d),
    cz = Math.cos(rot[2] * d),
    sz = Math.sin(rot[2] * d);
  return [
    cz * cy,
    cz * sy * sx - sz * cx,
    cz * sy * cx + sz * sx,
    sz * cy,
    sz * sy * sx + cz * cx,
    sz * sy * cx - cz * sx,
    -sy,
    cy * sx,
    cy * cx,
  ];
}

export function transformTriangles(d, pos, rot) {
  const m = rotationMatrix(rot),
    out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i += 3) {
    const x = d[i],
      y = d[i + 1],
      z = d[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z + pos[0];
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z + pos[1];
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z + pos[2];
  }
  return out;
}

export function signedVolume(d) {
  let v = 0;
  for (let i = 0; i < d.length; i += 9) {
    const ax = d[i],
      ay = d[i + 1],
      az = d[i + 2],
      bx = d[i + 3],
      by = d[i + 4],
      bz = d[i + 5],
      cx = d[i + 6],
      cy = d[i + 7],
      cz = d[i + 8];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function flipWinding(d) {
  for (let i = 0; i < d.length; i += 9)
    for (let k = 0; k < 3; k++) {
      const t = d[i + 3 + k];
      d[i + 3 + k] = d[i + 6 + k];
      d[i + 6 + k] = t;
    }
  return d;
}

export function boundingBox(d) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.length; i += 3)
    for (let k = 0; k < 3; k++) {
      if (d[i + k] < min[k]) min[k] = d[i + k];
      if (d[i + k] > max[k]) max[k] = d[i + k];
    }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/** Ear clipping over a simple polygon; returns index triples with CCW winding. */
export function triangulatePolygon(pts) {
  const n = pts.length;
  const idx = Array.from({ length: n }, (_, i) => i);
  if (signedArea(pts) < 0) idx.reverse();
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => area(a, b, p) >= 0 && area(b, c, p) >= 0 && area(c, a, p) >= 0;
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length],
        ib = idx[i],
        ic = idx[(i + 1) % idx.length];
      const a = pts[ia],
        b = pts[ib],
        c = pts[ic];
      if (area(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inside(pts[j], a, b, c)) {
          ear = false;
          break;
        }
      }
      if (!ear) continue;
      out.push([ia, ib, ic]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('triangulation failed: polygon is not simple');
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

function box(b, size) {
  const x = size[0] / 2,
    y = size[1] / 2,
    z = size[2] / 2;
  const v = [
    [-x, -y, -z],
    [x, -y, -z],
    [x, y, -z],
    [-x, y, -z],
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  for (const f of faces) {
    b.push(v[f[0]], v[f[1]], v[f[2]]);
    b.push(v[f[0]], v[f[2]], v[f[3]]);
  }
}

function extrude(b, profile, h) {
  const tris = triangulatePolygon(profile);
  const n = profile.length;
  const order =
    signedArea(profile) > 0
      ? Array.from({ length: n }, (_, i) => i)
      : Array.from({ length: n }, (_, i) => n - 1 - i);
  const at = (i, z) => [profile[i][0], profile[i][1], z];
  for (const t of tris) {
    b.push(at(t[0], h), at(t[1], h), at(t[2], h));
    b.push(at(t[2], 0), at(t[1], 0), at(t[0], 0));
  }
  for (let k = 0; k < n; k++) {
    const i = order[k],
      j = order[(k + 1) % n];
    b.push(at(i, 0), at(j, 0), at(j, h));
    b.push(at(i, 0), at(j, h), at(i, h));
  }
}

function wedge(b, size) {
  const sx = size[0],
    sy = size[1],
    sz = size[2];
  const t = new TriBuffer(8);
  // profile in (x, z), extruded along y; full height at the -X face
  extrude(
    t,
    [
      [-sx / 2, -sz / 2],
      [sx / 2, -sz / 2],
      [-sx / 2, sz / 2],
    ],
    sy,
  );
  const d = t.data();
  // (x, y, z) -> (x, z - sy/2, y) is a reflection, so swap two corners to restore winding
  const v = (i, k) => [d[i + k], d[i + k + 2] - sy / 2, d[i + k + 1]];
  for (let i = 0; i < d.length; i += 9) b.push(v(i, 0), v(i, 6), v(i, 3));
}

// Curved generators (cylinder, sphere, torus, lathe) are added in Task 4.
const GENERATORS = {
  box: (b, p) => box(b, p.size),
  wedge: (b, p) => wedge(b, p.size),
  extrude: (b, p) => extrude(b, p.profile, p.height),
};

export function localTriangles(part) {
  const gen = GENERATORS[part.type];
  if (!gen) throw new Error(`no generator for type ${part.type}`);
  const b = new TriBuffer(triangleCount(part));
  gen(b, part, segmentsOf(part));
  const d = b.data();
  if (signedVolume(d) < 0) flipWinding(d);
  return d;
}

export function partToTriangles(part) {
  return transformTriangles(localTriangles(part), part.pos, part.rot);
}

export function meshChecks(d) {
  const errors = [];
  const key = (i) => `${d[i].toFixed(6)},${d[i + 1].toFixed(6)},${d[i + 2].toFixed(6)}`;
  const directed = new Map(),
    star = new Map();
  let zero = 0;
  for (let i = 0; i < d.length; i += 9) {
    const ux = d[i + 3] - d[i],
      uy = d[i + 4] - d[i + 1],
      uz = d[i + 5] - d[i + 2],
      vx = d[i + 6] - d[i],
      vy = d[i + 7] - d[i + 1],
      vz = d[i + 8] - d[i + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) {
      zero++;
      continue;
    }
    const k = [key(i), key(i + 3), key(i + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e],
        b = k[(e + 1) % 3],
        c = k[(e + 2) % 3];
      const dk = a + '|' + b;
      directed.set(dk, (directed.get(dk) || 0) + 1);
      if (!star.has(c)) star.set(c, new Map());
      star.get(c).set(a, b); // opposite edge a -> b as seen from vertex c
    }
  }
  if (zero) errors.push(`${zero} zero-area triangle(s)`);
  let bad = 0;
  for (const [dk, count] of directed) {
    const [a, b] = dk.split('|');
    if (count !== 1 || directed.get(b + '|' + a) !== 1) bad++;
  }
  if (bad) errors.push(`${bad} edge(s) not shared by exactly two opposite triangles`);
  let pinched = 0;
  for (const next of star.values()) {
    const start = next.keys().next().value;
    let cur = start,
      steps = 0;
    do {
      cur = next.get(cur);
      steps++;
    } while (cur !== undefined && cur !== start && steps <= next.size);
    if (cur !== start || steps !== next.size) pinched++;
  }
  if (pinched) errors.push(`${pinched} vertex(es) with a split fan (pinched)`);
  const volume = signedVolume(d);
  if (!(volume > 0)) errors.push(`signed volume ${volume.toFixed(3)} is not positive`);
  return { ok: errors.length === 0, errors, volume };
}
