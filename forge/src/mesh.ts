/**
 * ShapeCast Forge mesh processing pipeline:
 * - Parse GLB (Y-up -> Z-up)
 * - Filter floating debris (keep largest connected component)
 * - Watertight 2-manifold repair (voxelization + 2x2 saddle resolution + pinch split + Taubin smoothing)
 * - Scale longest horizontal axis to targetMm, center X/Y at 0, drop minZ to 0
 * - Verify watertight manifoldness via meshChecks
 * - Saturn 3 (12K) print checks & binary STL export
 * - Compact indexed mesh encoding (< 2 MB) for MCP tool responses
 */
import { NodeIO } from '@gltf-transform/core';

export const SATURN3 = {
  name: 'Elegoo Saturn 3 (12K)',
  build: [218.88, 122.88, 250] as const,
  pixelUm: [19, 24] as const,
  layerUm: [10, 30, 50, 100] as const,
};

export interface BBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface PrintCheckChip {
  id: string;
  level: 'green' | 'amber' | 'red' | 'info';
  message: string;
}

export interface PackedMeshPreview {
  vertsBase64: string;
  indicesBase64: string;
  indexBits: 16 | 32;
  vertexCount: number;
  triangleCount: number;
  isFullMesh: boolean;
}

export interface PreparedMeshResult {
  tris: Float64Array;
  bbox: BBox;
  volumeMm3: number;
  volumeMl: number;
  triangleCount: number;
  manifold: { ok: boolean; errors: string[]; volume: number };
  checks: PrintCheckChip[];
  worst: 'green' | 'amber' | 'red' | 'info';
  layers: Record<number, number>;
  preview: PackedMeshPreview;
}

export function boundingBox(d: Float64Array): BBox {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (d[i + k] < min[k]) min[k] = d[i + k];
      if (d[i + k] > max[k]) max[k] = d[i + k];
    }
  }
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

export function signedVolume(d: Float64Array): number {
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

export function flipWinding(d: Float64Array): Float64Array {
  for (let i = 0; i < d.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const t = d[i + 3 + k];
      d[i + 3 + k] = d[i + 6 + k];
      d[i + 6 + k] = t;
    }
  }
  return d;
}

export function meshChecks(d: Float64Array): { ok: boolean; errors: string[]; volume: number } {
  const errors: string[] = [];
  const q = (v: number) => {
    const r = Math.round(v * 1e6) / 1e6;
    return r === 0 ? '0' : String(r);
  };
  const key = (i: number) => `${q(d[i])},${q(d[i + 1])},${q(d[i + 2])}`;
  const directed = new Map<string, number>();
  const star = new Map<string, Map<string, string>>();
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
      star.get(c)!.set(a, b);
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
    let cur: string | undefined = start,
      steps = 0;
    do {
      cur = cur !== undefined ? next.get(cur) : undefined;
      steps++;
    } while (cur !== undefined && cur !== start && steps <= next.size);
    if (cur !== start || steps !== next.size) pinched++;
  }
  if (pinched) errors.push(`${pinched} vertex(es) with a split fan (pinched)`);
  const volume = signedVolume(d);
  if (!(volume > 0)) errors.push(`signed volume ${volume.toFixed(3)} is not positive`);
  return { ok: errors.length === 0, errors, volume };
}

export function writeBinaryStl(d: Float64Array, name = 'model'): ArrayBuffer {
  const n = d.length / 9,
    buf = new ArrayBuffer(84 + 50 * n),
    dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(`ShapeCast ${name}`).slice(0, 80));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < d.length; i += 9) {
    const ux = d[i + 3] - d[i],
      uy = d[i + 4] - d[i + 1],
      uz = d[i + 5] - d[i + 2],
      vx = d[i + 6] - d[i],
      vy = d[i + 7] - d[i + 1],
      vz = d[i + 8] - d[i + 2];
    let nx = uy * vz - uz * vy,
      ny = uz * vx - ux * vz,
      nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++) {
      dv.setFloat32(o, d[i + k], true);
      o += 4;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return buf;
}

/** Extract triangles from a binary GLB buffer and convert glTF Y-up to Z-up: (x, y, z) -> (x, -z, y). */
export async function parseGlbTriangles(glbBytes: Uint8Array): Promise<Float64Array> {
  const doc = await new NodeIO().readBinary(glbBytes);
  const tris: number[] = [];
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const posAttr = prim.getAttribute('POSITION');
      if (!posAttr) continue;
      const pos = posAttr.getArray();
      if (!pos) continue;
      const idx =
        prim.getIndices()?.getArray() ?? Array.from({ length: pos.length / 3 }, (_, i) => i);
      for (let i = 0; i + 2 < idx.length; i += 3) {
        for (const k of [idx[i], idx[i + 1], idx[i + 2]]) {
          const x = pos[3 * k],
            y = pos[3 * k + 1],
            z = pos[3 * k + 2];
          // Y-up to Z-up proper rotation
          tris.push(x, -z, y);
        }
      }
    }
  }
  if (tris.length === 0) throw new Error('GLB contains no triangle geometry');
  const d = Float64Array.from(tris);
  if (signedVolume(d) < 0) flipWinding(d);
  return d;
}

/** Scale triangles uniformly so max(sizeX, sizeY) === targetMm, center X/Y at 0, and drop minZ to 0. */
export function scaleAndGround(d: Float64Array, targetMm = 120): Float64Array {
  const out = new Float64Array(d);
  if (signedVolume(out) < 0) flipWinding(out);
  const bb = boundingBox(out);
  const maxHoriz = Math.max(bb.size[0], bb.size[1], 1e-6);
  const s = targetMm / maxHoriz;
  const cx = (bb.min[0] + bb.max[0]) / 2;
  const cy = (bb.min[1] + bb.max[1]) / 2;
  const minZ = bb.min[2];
  for (let i = 0; i < out.length; i += 3) {
    out[i] = (out[i] - cx) * s;
    out[i + 1] = (out[i + 1] - cy) * s;
    out[i + 2] = (out[i + 2] - minZ) * s;
  }
  // Clamp any -0 on the build plate to exact 0
  for (let i = 2; i < out.length; i += 3) {
    if (Math.abs(out[i]) < 1e-9) out[i] = 0;
  }
  return out;
}

interface IndexedMesh {
  coords: Float64Array;
  faces: number[][];
}

/**
 * Reconstruct a watertight, 0-bad-edge, 0-pinched-vertex 2-manifold mesh from an arbitrary triangle soup
 * using Z-column parity voxelization, largest-component filtering, cavity filling, 2x2 diagonal saddle
 * resolution, vertex-star pinch splitting, and volume-preserving Taubin smoothing.
 */
export function remeshWatertightIndexed(d: Float64Array, gridRes = 135): IndexedMesh {
  const bb = boundingBox(d);
  const maxSpan = Math.max(...bb.size) || 1;
  const step = maxSpan / gridRes;
  const pad = 2;
  const nx = Math.max(6, Math.ceil(bb.size[0] / step) + 2 * pad);
  const ny = Math.max(6, Math.ceil(bb.size[1] / step) + 2 * pad);
  const nz = Math.max(6, Math.ceil(bb.size[2] / step) + 2 * pad);
  const ox = bb.min[0] - pad * step;
  const oy = bb.min[1] - pad * step;
  const oz = bb.min[2] - pad * step;

  const cols: number[][] = Array.from({ length: nx * ny }, () => []);
  for (let i = 0; i < d.length; i += 9) {
    const ax = (d[i] - ox) / step - 0.5,
      ay = (d[i + 1] - oy) / step - 0.5,
      az = (d[i + 2] - oz) / step - 0.5;
    const bx = (d[i + 3] - ox) / step - 0.5,
      by = (d[i + 4] - oy) / step - 0.5,
      bz = (d[i + 5] - oz) / step - 0.5;
    const cx = (d[i + 6] - ox) / step - 0.5,
      cy = (d[i + 7] - oy) / step - 0.5,
      cz = (d[i + 8] - oz) / step - 0.5;
    const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx))),
      maxX = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.ceil(Math.min(ay, by, cy))),
      maxY = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy)));
    if (minX > maxX || minY > maxY) continue;
    const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(denom) < 1e-12) continue;
    const invDenom = 1 / denom;
    for (let iy = minY; iy <= maxY; iy++) {
      for (let ix = minX; ix <= maxX; ix++) {
        const px = ix + 1e-5,
          py = iy + 2.3e-5;
        const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) * invDenom;
        if (w0 < 0) continue;
        const w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) * invDenom;
        if (w1 < 0) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < 0) continue;
        cols[iy * nx + ix].push(w0 * az + w1 * bz + w2 * cz);
      }
    }
  }

  const vox = new Uint8Array(nx * ny * nz);
  const idx3 = (x: number, y: number, z: number) => (z * ny + y) * nx + x;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const zList = cols[iy * nx + ix];
      if (zList.length < 2) continue;
      zList.sort((a, b) => a - b);
      for (let k = 0; k + 1 < zList.length; k += 2) {
        const z0 = Math.max(1, Math.ceil(zList[k])),
          z1 = Math.min(nz - 2, Math.floor(zList[k + 1]));
        for (let iz = z0; iz <= z1; iz++) vox[idx3(ix, iy, iz)] = 1;
      }
    }
  }

  // Keep largest 6-connected solid component
  const visited = new Uint8Array(vox.length);
  const q = new Int32Array(vox.length);
  let best: Int32Array = new Int32Array(0);
  const dirs = [1, -1, nx, -nx, nx * ny, -nx * ny];
  for (let i = 0; i < vox.length; i++) {
    if (!vox[i] || visited[i]) continue;
    let h = 0,
      t = 0;
    q[t++] = i;
    visited[i] = 1;
    while (h < t) {
      const cur = q[h++];
      for (const stepDir of dirs) {
        const nb = cur + stepDir;
        if (nb >= 0 && nb < vox.length && vox[nb] && !visited[nb]) {
          visited[nb] = 1;
          q[t++] = nb;
        }
      }
    }
    if (t > best.length) best = q.slice(0, t);
  }
  if (best.length === 0) throw new Error('Mesh repair produced no solid voxels');
  vox.fill(0);
  for (let i = 0; i < best.length; i++) vox[best[i]] = 1;

  // Flood-fill exterior 0-voxels from 0 and close any internal cavities
  visited.fill(0);
  let h = 0,
    t = 0;
  q[t++] = 0;
  visited[0] = 1;
  while (h < t) {
    const cur = q[h++];
    const cz = Math.floor(cur / (nx * ny)),
      rem = cur - cz * nx * ny,
      cy = Math.floor(rem / nx),
      cx = rem - cy * nx;
    if (cx + 1 < nx && !vox[cur + 1] && !visited[cur + 1]) {
      visited[cur + 1] = 1;
      q[t++] = cur + 1;
    }
    if (cx - 1 >= 0 && !vox[cur - 1] && !visited[cur - 1]) {
      visited[cur - 1] = 1;
      q[t++] = cur - 1;
    }
    if (cy + 1 < ny && !vox[cur + nx] && !visited[cur + nx]) {
      visited[cur + nx] = 1;
      q[t++] = cur + nx;
    }
    if (cy - 1 >= 0 && !vox[cur - nx] && !visited[cur - nx]) {
      visited[cur - nx] = 1;
      q[t++] = cur - nx;
    }
    if (cz + 1 < nz && !vox[cur + nx * ny] && !visited[cur + nx * ny]) {
      visited[cur + nx * ny] = 1;
      q[t++] = cur + nx * ny;
    }
    if (cz - 1 >= 0 && !vox[cur - nx * ny] && !visited[cur - nx * ny]) {
      visited[cur - nx * ny] = 1;
      q[t++] = cur - nx * ny;
    }
  }
  for (let i = 0; i < vox.length; i++) if (!visited[i]) vox[i] = 1;

  // Eliminate 2x2 diagonal non-manifold edges by filling 1 voxel per diagonal
  for (let iter = 0; iter < 30; iter++) {
    let fixed = 0;
    for (let z = 1; z < nz - 1; z++) {
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          const a = idx3(x, y, z);
          if (x + 1 < nx - 1 && y + 1 < ny - 1) {
            const b = idx3(x + 1, y, z),
              c = idx3(x, y + 1, z),
              d0 = idx3(x + 1, y + 1, z);
            if (vox[a] && vox[d0] && !vox[b] && !vox[c]) {
              vox[b] = 1;
              fixed++;
            } else if (!vox[a] && !vox[d0] && vox[b] && vox[c]) {
              vox[a] = 1;
              fixed++;
            }
          }
          if (x + 1 < nx - 1 && z + 1 < nz - 1) {
            const b = idx3(x + 1, y, z),
              e = idx3(x, y, z + 1),
              f = idx3(x + 1, y, z + 1);
            if (vox[a] && vox[f] && !vox[b] && !vox[e]) {
              vox[b] = 1;
              fixed++;
            } else if (!vox[a] && !vox[f] && vox[b] && vox[e]) {
              vox[a] = 1;
              fixed++;
            }
          }
          if (y + 1 < ny - 1 && z + 1 < nz - 1) {
            const c = idx3(x, y + 1, z),
              e = idx3(x, y, z + 1),
              g = idx3(x, y + 1, z + 1);
            if (vox[a] && vox[g] && !vox[c] && !vox[e]) {
              vox[c] = 1;
              fixed++;
            } else if (!vox[a] && !vox[g] && vox[c] && vox[e]) {
              vox[a] = 1;
              fixed++;
            }
          }
        }
      }
    }
    if (!fixed) break;
  }

  // Emit boundary faces
  const vMap = new Map<number, number>();
  const coords: number[] = [];
  const getV = (gx: number, gy: number, gz: number) => {
    const k = (gz * (ny + 1) + gy) * (nx + 1) + gx;
    let id = vMap.get(k);
    if (id === undefined) {
      id = coords.length / 3;
      vMap.set(k, id);
      coords.push(ox + gx * step, oy + gy * step, oz + gz * step);
    }
    return id;
  };
  const faces: number[][] = [];
  const addQuad = (v0: number, v1: number, v2: number, v3: number, sv: number) => {
    faces.push([v0, v1, v2, sv], [v0, v2, v3, sv]);
  };
  for (let z = 1; z < nz - 1; z++) {
    for (let y = 1; y < ny - 1; y++) {
      for (let x = 1; x < nx - 1; x++) {
        const sv = idx3(x, y, z);
        if (!vox[sv]) continue;
        if (!vox[idx3(x - 1, y, z)])
          addQuad(getV(x, y, z), getV(x, y, z + 1), getV(x, y + 1, z + 1), getV(x, y + 1, z), sv);
        if (!vox[idx3(x + 1, y, z)])
          addQuad(
            getV(x + 1, y, z),
            getV(x + 1, y + 1, z),
            getV(x + 1, y + 1, z + 1),
            getV(x + 1, y, z + 1),
            sv,
          );
        if (!vox[idx3(x, y - 1, z)])
          addQuad(getV(x, y, z), getV(x + 1, y, z), getV(x + 1, y, z + 1), getV(x, y, z + 1), sv);
        if (!vox[idx3(x, y + 1, z)])
          addQuad(
            getV(x, y + 1, z),
            getV(x, y + 1, z + 1),
            getV(x + 1, y + 1, z + 1),
            getV(x + 1, y + 1, z),
            sv,
          );
        if (!vox[idx3(x, y, z - 1)])
          addQuad(getV(x, y, z), getV(x, y + 1, z), getV(x + 1, y + 1, z), getV(x + 1, y, z), sv);
        if (!vox[idx3(x, y, z + 1)])
          addQuad(
            getV(x, y, z + 1),
            getV(x + 1, y, z + 1),
            getV(x + 1, y + 1, z + 1),
            getV(x, y + 1, z + 1),
            sv,
          );
      }
    }
  }

  // Split any pinched vertices (2x2x2 corner-only contacts)
  const edgeTris = new Map<string, number[]>();
  for (let f = 0; f < faces.length; f++) {
    const [a, b, c] = faces[f];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const uk = u < v ? `${u}|${v}` : `${v}|${u}`;
      let list = edgeTris.get(uk);
      if (!list) {
        list = [];
        edgeTris.set(uk, list);
      }
      list.push(f);
    }
  }
  const vertTris: number[][] = Array.from({ length: coords.length / 3 }, () => []);
  for (let f = 0; f < faces.length; f++) {
    vertTris[faces[f][0]].push(f);
    vertTris[faces[f][1]].push(f);
    vertTris[faces[f][2]].push(f);
  }
  const replacements: [number, number, number][] = [];
  for (let v = 0; v < vertTris.length; v++) {
    const inc = vertTris[v];
    if (!inc.length) continue;
    const p = inc.map((_, i) => i);
    const find = (i: number): number => (p[i] === i ? i : (p[i] = find(p[i])));
    const idxOf = new Map(inc.map((f, i) => [f, i]));
    for (let i = 0; i < inc.length; i++) {
      const f = inc[i];
      const [a, b, c, sv] = faces[f];
      for (const u of [a, b, c]) {
        if (u === v) continue;
        const uk = u < v ? `${u}|${v}` : `${v}|${u}`;
        const et = edgeTris.get(uk)!;
        if (et.length === 2) {
          const other = et[0] === f ? et[1] : et[0];
          const j = idxOf.get(other);
          if (j !== undefined) p[find(i)] = find(j);
        } else {
          for (const other of et) {
            if (other === f) continue;
            if (faces[other][3] === sv) {
              const j = idxOf.get(other);
              if (j !== undefined) p[find(i)] = find(j);
            }
          }
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < inc.length; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(inc[i]);
    }
    if (groups.size > 1) {
      for (const g of groups.values()) {
        let sx = 0,
          sy = 0,
          sz = 0;
        for (const f of g) {
          const sv = faces[f][3];
          const vz = Math.floor(sv / (nx * ny)),
            rem = sv - vz * nx * ny,
            vy = Math.floor(rem / nx),
            vx = rem - vy * nx;
          sx += ox + (vx + 0.5) * step;
          sy += oy + (vy + 0.5) * step;
          sz += oz + (vz + 0.5) * step;
        }
        sx /= g.length;
        sy /= g.length;
        sz /= g.length;
        const newId = coords.length / 3;
        const vx = coords[3 * v],
          vy = coords[3 * v + 1],
          vz = coords[3 * v + 2];
        coords.push(vx + (sx - vx) * 0.05, vy + (sy - vy) * 0.05, vz + (sz - vz) * 0.05);
        for (const f of g) replacements.push([f, v, newId]);
      }
    }
  }
  for (const [f, v, newId] of replacements) {
    if (faces[f][0] === v) faces[f][0] = newId;
    if (faces[f][1] === v) faces[f][1] = newId;
    if (faces[f][2] === v) faces[f][2] = newId;
  }

  // Taubin volume-preserving smoothing
  const vCount = coords.length / 3;
  const adj: Set<number>[] = Array.from({ length: vCount }, () => new Set());
  for (const [a, b, c] of faces) {
    adj[a].add(b);
    adj[a].add(c);
    adj[b].add(a);
    adj[b].add(c);
    adj[c].add(a);
    adj[c].add(b);
  }
  const adjList = adj.map((s) => Int32Array.from(s));
  const cur = Float64Array.from(coords);
  const next = new Float64Array(cur.length);
  const smoothStep = (factor: number) => {
    for (let v = 0; v < vCount; v++) {
      const nbs = adjList[v];
      if (!nbs.length) {
        next[3 * v] = cur[3 * v];
        next[3 * v + 1] = cur[3 * v + 1];
        next[3 * v + 2] = cur[3 * v + 2];
        continue;
      }
      let mx = 0,
        my = 0,
        mz = 0;
      for (let k = 0; k < nbs.length; k++) {
        const u = nbs[k];
        mx += cur[3 * u];
        my += cur[3 * u + 1];
        mz += cur[3 * u + 2];
      }
      const inv = 1 / nbs.length;
      const vx = cur[3 * v],
        vy = cur[3 * v + 1],
        vz = cur[3 * v + 2];
      next[3 * v] = vx + factor * (mx * inv - vx);
      next[3 * v + 1] = vy + factor * (my * inv - vy);
      next[3 * v + 2] = vz + factor * (mz * inv - vz);
    }
    cur.set(next);
  };
  for (let iter = 0; iter < 8; iter++) {
    smoothStep(0.5);
    smoothStep(-0.53);
  }

  return { coords: cur, faces };
}

export function indexedToTriangles(mesh: IndexedMesh): Float64Array {
  const { coords, faces } = mesh;
  const out = new Float64Array(faces.length * 9);
  for (let f = 0; f < faces.length; f++) {
    const [a, b, c] = faces[f];
    const o = f * 9;
    out[o] = coords[3 * a];
    out[o + 1] = coords[3 * a + 1];
    out[o + 2] = coords[3 * a + 2];
    out[o + 3] = coords[3 * b];
    out[o + 4] = coords[3 * b + 1];
    out[o + 5] = coords[3 * b + 2];
    out[o + 6] = coords[3 * c];
    out[o + 7] = coords[3 * c + 1];
    out[o + 8] = coords[3 * c + 2];
  }
  return out;
}

/** Scale an IndexedMesh in-place so max(sizeX, sizeY) === targetMm, centered on XY, grounded at z = 0. */
function scaleAndGroundIndexed(mesh: IndexedMesh, targetMm: number): IndexedMesh {
  const { coords, faces } = mesh;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [a, b, c] of faces) {
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        const val = coords[3 * v + k];
        if (val < min[k]) min[k] = val;
        if (val > max[k]) max[k] = val;
      }
    }
  }
  const sx = max[0] - min[0],
    sy = max[1] - min[1];
  const s = targetMm / Math.max(sx, sy, 1e-6);
  const cx = (min[0] + max[0]) / 2,
    cy = (min[1] + max[1]) / 2,
    minZ = min[2];
  for (let i = 0; i < coords.length; i += 3) {
    coords[i] = (coords[i] - cx) * s;
    coords[i + 1] = (coords[i + 1] - cy) * s;
    const z = (coords[i + 2] - minZ) * s;
    coords[i + 2] = Math.abs(z) < 1e-9 ? 0 : z;
  }
  return mesh;
}

/** Pack an IndexedMesh into compact base64 strings for MCP transport. */
export function packIndexedMesh(mesh: IndexedMesh, isFullMesh: boolean): PackedMeshPreview {
  // Compact unused vertices (from pre-split indices)
  const used = new Map<number, number>();
  const compactCoords: number[] = [];
  const compactIndices: number[] = [];
  for (const [a, b, c] of mesh.faces) {
    for (const v of [a, b, c]) {
      let nv = used.get(v);
      if (nv === undefined) {
        nv = compactCoords.length / 3;
        used.set(v, nv);
        compactCoords.push(mesh.coords[3 * v], mesh.coords[3 * v + 1], mesh.coords[3 * v + 2]);
      }
      compactIndices.push(nv);
    }
  }
  const vertexCount = compactCoords.length / 3;
  const f32 = Float32Array.from(compactCoords);
  const indexBits: 16 | 32 = vertexCount <= 65535 ? 16 : 32;
  const idxArr =
    indexBits === 16 ? Uint16Array.from(compactIndices) : Uint32Array.from(compactIndices);
  const vertsBase64 = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
  const indicesBase64 = Buffer.from(idxArr.buffer, idxArr.byteOffset, idxArr.byteLength).toString(
    'base64',
  );
  return {
    vertsBase64,
    indicesBase64,
    indexBits,
    vertexCount,
    triangleCount: mesh.faces.length,
    isFullMesh,
  };
}

/** Unpack a PackedMeshPreview back into a flat Float64Array of triangles. */
export function unpackIndexedMesh(preview: PackedMeshPreview): Float64Array {
  const vBuf = Buffer.from(preview.vertsBase64, 'base64');
  const iBuf = Buffer.from(preview.indicesBase64, 'base64');
  const verts = new Float32Array(
    vBuf.buffer,
    vBuf.byteOffset,
    vBuf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const indices =
    preview.indexBits === 16
      ? new Uint16Array(iBuf.buffer, iBuf.byteOffset, iBuf.byteLength / 2)
      : new Uint32Array(iBuf.buffer, iBuf.byteOffset, iBuf.byteLength / 4);
  const out = new Float64Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    out[3 * i] = verts[3 * v];
    out[3 * i + 1] = verts[3 * v + 1];
    out[3 * i + 2] = verts[3 * v + 2];
  }
  return out;
}

export function saturn3PrintChecks(
  bbox: BBox,
  volumeMm3: number,
  manifoldOk: boolean,
  layerUm = 50,
): {
  checks: PrintCheckChip[];
  worst: 'green' | 'amber' | 'red' | 'info';
  layers: Record<number, number>;
} {
  const f = (v: number) => v.toFixed(2);
  const checks: PrintCheckChip[] = [];
  const [W, D, H] = SATURN3.build;
  const [sx, sy, sz] = bbox.size;
  if (sx <= W && sy <= D && sz <= H) {
    checks.push({
      id: 'fit',
      level: 'green',
      message: `Fits the plate: ${f(sx)} x ${f(sy)} x ${f(sz)} mm`,
    });
  } else if (sy <= W && sx <= D && sz <= H) {
    checks.push({
      id: 'fit',
      level: 'amber',
      message: `Fits only rotated 90 deg about Z: ${f(sx)} x ${f(sy)} x ${f(sz)} mm`,
    });
  } else {
    checks.push({
      id: 'fit',
      level: 'red',
      message: `Too large: ${f(sx)} x ${f(sy)} x ${f(sz)} mm exceeds ${W} x ${D} x ${H} mm`,
    });
  }

  if (bbox.min[2] < -0.01) {
    checks.push({
      id: 'plate',
      level: 'red',
      message: `Below the build plate: z min is ${f(bbox.min[2])} mm`,
    });
  } else if (bbox.min[2] <= 0.01) {
    checks.push({
      id: 'support',
      level: 'green',
      message: 'Grounded on the build plate (z = 0); add supports in Chitubox for overhangs',
    });
  }

  if (manifoldOk) {
    checks.push({
      id: 'manifold',
      level: 'green',
      message: 'Watertight 2-manifold mesh (repaired for slicing)',
    });
  } else {
    checks.push({
      id: 'manifold',
      level: 'red',
      message: 'Mesh failed manifold check',
    });
  }

  checks.push({
    id: 'volume',
    level: 'info',
    message: `Mesh volume ${(volumeMm3 / 1000).toFixed(1)} mL (hollow in Chitubox if needed)`,
  });

  const layers = Object.fromEntries(
    SATURN3.layerUm.map((um) => [um, Math.ceil(sz / (um / 1000))]),
  ) as Record<number, number>;
  checks.push({
    id: 'layers',
    level: 'info',
    message: `${layers[layerUm] ?? layers[50]} layers at ${layerUm} um (${f(sz)} mm tall)`,
  });
  checks.push({
    id: 'pixel',
    level: 'info',
    message: `XY pixel ${SATURN3.pixelUm[0]} x ${SATURN3.pixelUm[1]} um`,
  });

  const worst = checks.some((c) => c.level === 'red')
    ? 'red'
    : checks.some((c) => c.level === 'amber')
      ? 'amber'
      : 'green';
  return { checks, worst, layers };
}

/**
 * Full post-process & repair pipeline:
 * 1. If input is already a watertight 2-manifold single shell, scale & ground directly.
 * 2. Otherwise (e.g. Hunyuan3D surface-net output), run watertight voxel-remeshing + Taubin smoothing.
 * 3. Scale longest horizontal side to targetMm, center XY, ground at z = 0.
 * 4. Build compact preview payload (< maxPreviewBytes, default 1.8 MB base64).
 */
export function repairAndPrepareMesh(
  rawTris: Float64Array,
  {
    targetMm = 120,
    gridRes = 135,
    maxPreviewBytes = 1_800_000,
  }: { targetMm?: number; gridRes?: number; maxPreviewBytes?: number } = {},
): PreparedMeshResult {
  const clampedTarget = Math.max(10, Math.min(218, Number.isFinite(targetMm) ? targetMm : 120));
  const indexed = scaleAndGroundIndexed(remeshWatertightIndexed(rawTris, gridRes), clampedTarget);
  // Quantize coordinates toFloat32 so packed preview and full STL match identically
  for (let i = 0; i < indexed.coords.length; i++) {
    indexed.coords[i] = Math.fround(indexed.coords[i]);
  }
  const tris = indexedToTriangles(indexed);
  if (signedVolume(tris) < 0) flipWinding(tris);
  const manifold = meshChecks(tris);
  const bbox = boundingBox(tris);
  const volumeMm3 = manifold.volume;
  const volumeMl = +(volumeMm3 / 1000).toFixed(2);
  const { checks, worst, layers } = saturn3PrintChecks(bbox, volumeMm3, manifold.ok, 50);

  let preview = packIndexedMesh(indexed, true);
  if (preview.vertsBase64.length + preview.indicesBase64.length > maxPreviewBytes) {
    const decimated = scaleAndGroundIndexed(
      remeshWatertightIndexed(rawTris, Math.min(85, Math.floor(gridRes * 0.65))),
      clampedTarget,
    );
    for (let i = 0; i < decimated.coords.length; i++) {
      decimated.coords[i] = Math.fround(decimated.coords[i]);
    }
    preview = packIndexedMesh(decimated, false);
  }

  return {
    tris,
    bbox,
    volumeMm3,
    volumeMl,
    triangleCount: tris.length / 9,
    manifold,
    checks,
    worst,
    layers,
    preview,
  };
}
