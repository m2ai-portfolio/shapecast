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
