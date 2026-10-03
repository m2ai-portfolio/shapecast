import { validatePartList } from './schema.js';

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
