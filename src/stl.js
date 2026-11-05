import { partToTriangles } from './geometry.js';

export function concatTriangles(list) {
  let n = 0;
  for (const d of list) n += d.length;
  const out = new Float64Array(n);
  let o = 0;
  for (const d of list) {
    out.set(d, o);
    o += d.length;
  }
  return out;
}

export function listToTriangles(partList) {
  return concatTriangles(partList.parts.map(partToTriangles));
}

export function writeBinaryStl(d, name = 'model') {
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

export function readStlHeader(buf) {
  const dv = new DataView(buf);
  return {
    header: new TextDecoder().decode(new Uint8Array(buf, 0, 80)).replace(/\0+$/, ''),
    triangles: dv.getUint32(80, true),
  };
}

/**
 * Parse a binary (or ASCII fallback) STL ArrayBuffer into a centered, Z=0 grounded Float32Array
 * triangle soup (9 floats per triangle) with exact signed tetrahedral volume and bounding box.
 */
export function parseStlBuffer(buf) {
  const byteLen = buf.byteLength;
  if (byteLen < 84) throw new Error('STL file is too small (< 84 bytes).');
  const dv = new DataView(buf);
  const triCount = dv.getUint32(80, true);
  const expectedBytes = 84 + triCount * 50;

  let tris;
  if (triCount > 0 && triCount <= 2_000_000 && expectedBytes <= byteLen && byteLen - expectedBytes < 512) {
    tris = new Float32Array(triCount * 9);
    let o = 84;
    for (let t = 0; t < triCount; t++) {
      o += 12; // skip face normal
      const base = t * 9;
      for (let k = 0; k < 9; k++) {
        tris[base + k] = dv.getFloat32(o, true);
        o += 4;
      }
      o += 2; // attr byte count
    }
  } else {
    // ASCII STL fallback
    const text = new TextDecoder().decode(new Uint8Array(buf));
    const verts = [];
    const re = /vertex\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)\s+([+-]?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      verts.push(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    const cleanLen = Math.floor(verts.length / 9) * 9;
    if (cleanLen === 0) throw new Error('Unrecognized or empty STL file.');
    tris = new Float32Array(verts.slice(0, cleanLen));
  }

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  let signedVol6 = 0;

  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i],
      ay = tris[i + 1],
      az = tris[i + 2];
    const bx = tris[i + 3],
      by = tris[i + 4],
      bz = tris[i + 5];
    const cx = tris[i + 6],
      cy = tris[i + 7],
      cz = tris[i + 8];
    if (ax < minX) minX = ax;
    if (bx < minX) minX = bx;
    if (cx < minX) minX = cx;
    if (ax > maxX) maxX = ax;
    if (bx > maxX) maxX = bx;
    if (cx > maxX) maxX = cx;

    if (ay < minY) minY = ay;
    if (by < minY) minY = by;
    if (cy < minY) minY = cy;
    if (ay > maxY) maxY = ay;
    if (by > maxY) maxY = by;
    if (cy > maxY) maxY = cy;

    if (az < minZ) minZ = az;
    if (bz < minZ) minZ = bz;
    if (cz < minZ) minZ = cz;
    if (az > maxZ) maxZ = az;
    if (bz > maxZ) maxZ = bz;
    if (cz > maxZ) maxZ = cz;

    signedVol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }

  const shiftX = -0.5 * (minX + maxX);
  const shiftY = -0.5 * (minY + maxY);
  const shiftZ = -minZ;
  for (let i = 0; i < tris.length; i += 3) {
    tris[i] += shiftX;
    tris[i + 1] += shiftY;
    tris[i + 2] += shiftZ;
  }

  const bbox = {
    min: [minX + shiftX, minY + shiftY, 0],
    max: [maxX + shiftX, maxY + shiftY, maxZ + shiftZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
  const volumeMm3 = Math.max(1, Math.abs(signedVol6) / 6);
  return {
    tris,
    triangleCount: tris.length / 9,
    bbox,
    volumeMm3,
  };
}
