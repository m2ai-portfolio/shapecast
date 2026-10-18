import { validatePartList } from './schema.js';
import { localTriangles, transformTriangles, meshChecks, boundingBox } from './geometry.js';

export const FIELDS = {
  box: ['size', 'pos', 'rot'],
  wedge: ['size', 'pos', 'rot'],
  cylinder: ['radius', 'radiusTop', 'height', 'segments', 'pos', 'rot'],
  cone: ['radius', 'height', 'segments', 'pos', 'rot'],
  sphere: ['radius', 'segments', 'pos', 'rot'],
  torus: ['radius', 'tube', 'segments', 'pos', 'rot'],
  extrude: ['height', 'pos', 'rot'],
  lathe: ['segments', 'pos', 'rot'],
};
export const DOC_LIMIT = 200 * 1024;
export const META = { name: 80, brief: 4000, scaleRef: 300, photos: 8 };
const clone = (o) => JSON.parse(JSON.stringify(o));

export function applyFieldEdit(list, partId, field, index, raw) {
  const text = String(raw).trim(),
    num = Number(text);
  const label = `${partId}.${field}${index === null || index === undefined ? '' : `[${index}]`}`;
  if (text === '' || !Number.isFinite(num)) return { ok: false, error: `${label}: not a number` };
  const next = clone(list),
    part = next.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, error: `${partId}: no such part` };
  if (index === null || index === undefined) part[field] = num;
  else {
    if (!Array.isArray(part[field])) return { ok: false, error: `${label}: not a tuple` };
    part[field][index] = num;
  }
  const v = validatePartList(next);
  return v.ok ? { ok: true, list: next } : { ok: false, error: v.errors[0] };
}

export function removePart(list, partId) {
  const next = clone(list);
  next.parts = next.parts.filter((p) => p.id !== partId);
  const v = validatePartList(next);
  return v.ok ? { ok: true, list: next } : { ok: false, error: v.errors[0] };
}

export function prepareImages(files, imageLimits) {
  const images = [],
    rejected = [];
  for (const f of files) {
    if (!imageLimits)
      rejected.push({ name: f.name, reason: 'this view cannot send photos to Claude' });
    else if (!imageLimits.mediaTypes.includes(f.type))
      rejected.push({ name: f.name, reason: `type ${f.type || 'unknown'} not accepted` });
    else if (f.size > imageLimits.maxInputBytes)
      rejected.push({
        name: f.name,
        reason: `photo too large (${(f.size / 1048576).toFixed(1)} MB, limit ${Math.round(imageLimits.maxInputBytes / 1048576)} MB)`,
      });
    else if (images.length >= imageLimits.maxCount)
      rejected.push({ name: f.name, reason: `only ${imageLimits.maxCount} photos per build` });
    else images.push(f);
  }
  return { images, rejected };
}

export function documentBytes(doc) {
  return new TextEncoder().encode(JSON.stringify(doc)).length;
}

/** @param {{ projectDoc?: any, revisionDoc?: any }} docs */
export function checkDocumentSizes({ projectDoc, revisionDoc }) {
  if (projectDoc && documentBytes(projectDoc) > DOC_LIMIT)
    return { ok: false, error: 'Project too large to save (over 200 KiB)' };
  if (revisionDoc && documentBytes(revisionDoc) > DOC_LIMIT)
    return { ok: false, error: 'Revision too large to save (over 200 KiB)' };
  return { ok: true };
}

export function projectDocument(p) {
  return {
    name: String(p.name).slice(0, META.name),
    brief: String(p.brief ?? '').slice(0, META.brief),
    scaleRef: String(p.scaleRef ?? '').slice(0, META.scaleRef),
    photoAssetIds: (p.photoAssetIds ?? []).slice(0, META.photos),
    current: p.current,
    currentRevisionId: p.currentRevisionId ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

/** Build one render item for a part; a failing shell is marked, never thrown. */
export function partItem(part) {
  try {
    const local = localTriangles(part),
      mc = meshChecks(local),
      tris = transformTriangles(local, part.pos, part.rot);
    return { part, tris, bbox: boundingBox(tris), failed: !mc.ok, failure: mc.errors[0] ?? null };
  } catch (e) {
    return {
      part,
      tris: new Float64Array(0),
      bbox: { min: part.pos, max: part.pos, size: [0, 0, 0] },
      failed: true,
      failure: e.message,
    };
  }
}

/** Runtime manifold gate: every shell of a prospective list must pass meshChecks before it is accepted. */
export function geometryGate(list) {
  const errors = [];
  for (const part of list.parts) {
    const it = partItem(part);
    if (it.failed) errors.push(`${part.id}: geometry failed manifold check (${it.failure})`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** Per-part geometry cache keyed by the part's JSON, so re-renders do not regenerate unchanged parts. */
export function createPartCache(maxEntries = 400) {
  const map = new Map();
  return {
    item(part) {
      const key = JSON.stringify(part);
      const hit = map.get(key);
      if (hit) return hit;
      const it = partItem(part);
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, it);
      return it;
    },
    clear() {
      map.clear();
    },
  };
}

export const SAMPLE_LIST = {
  name: 'example: block and catapult arm',
  units: 'mm',
  parts: [
    {
      id: 'block',
      type: 'box',
      size: [40, 40, 40],
      pos: [-60, 0, 20],
      rot: [0, 0, 0],
      role: 'add',
    },
    { id: 'arm', type: 'box', size: [120, 8, 6], pos: [30, 0, 3], rot: [0, 0, 0], role: 'add' },
    {
      id: 'cup',
      type: 'lathe',
      profile: [
        [0, 0],
        [12, 0],
        [12, 2],
        [10, 2],
        [10, 9],
        [0, 9],
      ],
      pos: [82, 0, 5.5],
      rot: [0, 0, 0],
      role: 'add',
    },
    {
      id: 'pivot',
      type: 'cylinder',
      radius: 5,
      height: 14,
      pos: [10, 0, 5],
      rot: [90, 0, 0],
      role: 'add',
    },
  ],
  assumptions: ['example model: the 40 mm block is the scale reference from the catapult video'],
  print: { orientation: 'flat', suggestedLayerUm: 50 },
};

/** Extract target longest horizontal dimension (mm) from scaleRef text, clamped to [10, 218]. */
export function parseScaleRefMm(scaleRef, fallbackMm = 120) {
  const s = String(scaleRef ?? '').trim();
  const m = s.match(/(\d+(?:\.\d+)?)\s*(?:mm|millimet(?:er|re)s?)?\b/i);
  if (!m) return fallbackMm;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return fallbackMm;
  return Math.max(10, Math.min(218, v));
}

function decodeBase64Bytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Unpack an indexed Forge preview payload into a flat Float64Array(triangleCount * 9). */
export function unpackForgePreview(preview) {
  if (!preview || !preview.vertsBase64 || !preview.indicesBase64) return new Float64Array(0);
  const vBytes = decodeBase64Bytes(preview.vertsBase64);
  const iBytes = decodeBase64Bytes(preview.indicesBase64);
  const verts = new Float32Array(
    vBytes.buffer,
    vBytes.byteOffset,
    Math.floor(vBytes.byteLength / 4),
  );
  const indices =
    preview.format === 'indexed-f32-u16-v1'
      ? new Uint16Array(iBytes.buffer, iBytes.byteOffset, Math.floor(iBytes.byteLength / 2))
      : new Uint32Array(iBytes.buffer, iBytes.byteOffset, Math.floor(iBytes.byteLength / 4));
  const triCount = Math.floor(indices.length / 3);
  const tris = new Float64Array(triCount * 9);
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3] * 3,
      i1 = indices[t * 3 + 1] * 3,
      i2 = indices[t * 3 + 2] * 3;
    const base = t * 9;
    tris[base] = verts[i0];
    tris[base + 1] = verts[i0 + 1];
    tris[base + 2] = verts[i0 + 2];
    tris[base + 3] = verts[i1];
    tris[base + 4] = verts[i1 + 1];
    tris[base + 5] = verts[i1 + 2];
    tris[base + 6] = verts[i2];
    tris[base + 7] = verts[i2 + 1];
    tris[base + 8] = verts[i2 + 2];
  }
  return tris;
}

function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(',')[1]);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

/** Shrink a photo Blob/File on-device to a JPEG <= 700 KB and return { blob, base64 }. */
export async function shrinkPhotoForForge(blob, maxSide = 1600) {
  if (blob.size <= 700000 && /jpe?g/i.test(blob.type || '')) {
    return { blob, base64: await blobToBase64(blob) };
  }
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.85, 0.75, 0.6, 0.45]) {
    const out = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
    if (out && out.size <= 700000) {
      return { blob: out, base64: await blobToBase64(out) };
    }
  }
  return shrinkPhotoForForge(blob, Math.round(maxSide * 0.7));
}
