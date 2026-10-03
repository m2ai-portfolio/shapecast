export const LIMITS = {
  parts: [1, 200],
  nameChars: [1, 80],
  idChars: [1, 40],
  idPattern: /^[a-z0-9_-]+$/,
  lengthMm: [0.1, 300],
  posMm: [-1000, 1000],
  rotDeg: [-360, 360],
  segments: [3, 256],
  defaultSegments: 64,
  profilePoints: [3, 200],
  profileCoord: [-300, 300],
  assumptions: [0, 20],
  assumptionChars: [1, 300],
  triangleBudget: 1_000_000,
  listBytes: 120 * 1024,
  layerUm: [10, 30, 50, 100],
};
export const PART_TYPES = [
  'box',
  'cylinder',
  'cone',
  'sphere',
  'torus',
  'extrude',
  'lathe',
  'wedge',
];

export const EXAMPLE_LIST = {
  name: 'phone stand',
  units: 'mm',
  parts: [
    { id: 'base', type: 'box', size: [70, 60, 4], pos: [0, 0, 2], rot: [0, 0, 0], role: 'add' },
    {
      id: 'back',
      type: 'extrude',
      profile: [
        [0, 0],
        [40, 0],
        [40, 3],
        [0, 3],
      ],
      height: 60,
      pos: [-20, -28, 2],
      rot: [90, 0, 0],
      role: 'add',
    },
  ],
  assumptions: ['overall height estimated at 60 mm, no scale reference given'],
  print: { orientation: 'flat', suggestedLayerUm: 50 },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, range) => isNum(v) && v >= range[0] && v <= range[1];
const tuple = (v, n, range) =>
  Array.isArray(v) && v.length === n && v.every((x) => inRange(x, range));

export function segmentsOf(part) {
  return part.segments ?? LIMITS.defaultSegments;
}

export function triangleCount(part) {
  const n = segmentsOf(part);
  switch (part.type) {
    case 'box':
      return 12;
    case 'wedge':
      return 8;
    case 'cylinder':
      return (part.radiusTop ?? part.radius) > 0 ? 4 * n : 2 * n;
    case 'cone':
      return 2 * n;
    case 'sphere':
      return 2 * n * (Math.max(3, Math.floor(n / 2)) - 1);
    case 'torus':
      return 2 * n * Math.max(8, Math.floor(n / 2));
    case 'extrude':
      return 2 * (part.profile.length - 2) + 2 * part.profile.length;
    case 'lathe':
      return 2 * n * part.profile.length;
    default:
      return 0;
  }
}

export function compactBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i],
      q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// segments p1p2 and p3p4 intersect or touch (collinear overlap and endpoint contact count)
function segsIntersectOrTouch(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const on = (a, b, c) =>
    Math.min(a[0], b[0]) - 1e-9 <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) + 1e-9 &&
    Math.min(a[1], b[1]) - 1e-9 <= c[1] &&
    c[1] <= Math.max(a[1], b[1]) + 1e-9;
  const d1 = d(p3, p4, p1),
    d2 = d(p3, p4, p2),
    d3 = d(p1, p2, p3),
    d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return true;
  if (d1 === 0 && on(p3, p4, p1)) return true;
  if (d2 === 0 && on(p3, p4, p2)) return true;
  if (d3 === 0 && on(p1, p2, p3)) return true;
  if (d4 === 0 && on(p1, p2, p4)) return true;
  return false;
}

function validateProfile(profile, id, errors, lathe) {
  const err = (m) => {
    errors.push(`${id}.profile: ${m}`);
  };
  if (!Array.isArray(profile) || !inRange(profile.length, LIMITS.profilePoints))
    return err('must have 3 to 200 points');
  for (const [i, p] of profile.entries())
    if (!tuple(p, 2, LIMITS.profileCoord)) return err(`point ${i} must be [x, y] within -300..300`);
  const n = profile.length;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  if (same(profile[0], profile[n - 1]))
    return err('first point must not repeat the last (polygon closes implicitly)');
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (same(profile[i], profile[j])) return err(`points ${i} and ${j} are identical`);
  if (Math.abs(signedArea(profile)) < 1e-9) return err('polygon has zero area');
  for (let i = 0; i < n; i++) {
    // adjacent edges that fold back onto each other make a zero-width spike
    const a = profile[(i + n - 1) % n],
      b = profile[i],
      c = profile[(i + 1) % n];
    const ux = b[0] - a[0],
      uy = b[1] - a[1],
      vx = c[0] - b[0],
      vy = c[1] - b[1];
    if (ux * vy - uy * vx === 0 && ux * vx + uy * vy < 0)
      return err(`edges ${(i + n - 1) % n} and ${i} fold back on each other`);
  }
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segsIntersectOrTouch(profile[i], profile[(i + 1) % n], profile[j], profile[(j + 1) % n]))
        return err(`edges ${i} and ${j} intersect or touch`);
    }
  if (lathe) {
    if (profile.some((p) => p[0] < 0)) return err('lathe profile r must be >= 0');
    if (profile.some((p) => p[0] !== 0 && p[0] < 0.01))
      return err('lathe profile r must be 0 or at least 0.01 mm');
    if (!profile.some((p) => p[0] > 0)) return err('lathe profile needs a point with r > 0');
    for (let i = 0; i < n; i++) {
      if (profile[i][0] !== 0) continue;
      const a = profile[(i + n - 1) % n],
        b = profile[(i + 1) % n];
      if (a[0] > 0 && b[0] > 0)
        return err(`touches the axis at a single point (point ${i}); extend it along the axis`);
    }
  }
}

function validatePart(part, i, seen, errors) {
  const id = typeof part?.id === 'string' ? part.id : `parts[${i}]`;
  const err = (m) => {
    errors.push(`${id}: ${m}`);
  };
  if (typeof part !== 'object' || part === null) return err('must be an object');
  if (
    typeof part.id !== 'string' ||
    !inRange(part.id.length, LIMITS.idChars) ||
    !LIMITS.idPattern.test(part.id)
  )
    err('id must be 1-40 chars of a-z 0-9 _ -');
  else if (seen.has(part.id)) err('id is not unique');
  else seen.add(part.id);
  if (!PART_TYPES.includes(part.type)) return err(`unknown type "${part.type}"`);
  if (part.role !== 'add')
    return err(part.role === 'sub' ? 'subtractive parts arrive in v2' : 'role must be "add"');
  if (!tuple(part.pos, 3, LIMITS.posMm))
    err('pos must be [x, y, z] finite numbers within -1000..1000');
  if (!tuple(part.rot, 3, LIMITS.rotDeg)) err('rot must be [x, y, z] degrees within -360..360');
  const len = (k) => {
    if (!inRange(part[k], LIMITS.lengthMm)) err(`${k} must be 0.1 to 300 mm`);
  };
  if (
    part.segments !== undefined &&
    (!Number.isInteger(part.segments) || !inRange(part.segments, LIMITS.segments))
  )
    err('segments must be an integer 3 to 256');
  switch (part.type) {
    case 'box':
    case 'wedge':
      if (!tuple(part.size, 3, LIMITS.lengthMm)) err('size must be [x, y, z] each 0.1 to 300 mm');
      break;
    case 'cylinder':
      len('radius');
      len('height');
      if (
        part.radiusTop !== undefined &&
        part.radiusTop !== 0 &&
        !inRange(part.radiusTop, LIMITS.lengthMm)
      )
        err('radiusTop must be 0 or 0.1 to 300 mm');
      break;
    case 'cone':
      len('radius');
      len('height');
      break;
    case 'sphere':
      len('radius');
      break;
    case 'torus':
      len('radius');
      len('tube');
      if (isNum(part.tube) && isNum(part.radius) && part.tube >= part.radius)
        err('tube must be smaller than radius');
      break;
    case 'extrude':
      len('height');
      validateProfile(part.profile, id, errors, false);
      break;
    case 'lathe':
      validateProfile(part.profile, id, errors, true);
      break;
  }
}

export function validatePartList(list) {
  const errors = [];
  if (typeof list !== 'object' || list === null || Array.isArray(list))
    return { ok: false, errors: ['part list must be a JSON object'] };
  if (typeof list.name !== 'string' || !inRange(list.name.length, LIMITS.nameChars))
    errors.push('name must be 1-80 characters');
  if (list.units !== 'mm') errors.push('units must be "mm"');
  if (!Array.isArray(list.parts) || !inRange(list.parts.length, LIMITS.parts))
    errors.push('parts must have 1 to 200 entries');
  if (
    !Array.isArray(list.assumptions) ||
    !inRange(list.assumptions.length, LIMITS.assumptions) ||
    !list.assumptions.every(
      (a) => typeof a === 'string' && inRange(a.length, LIMITS.assumptionChars),
    )
  )
    errors.push('assumptions must be 0-20 strings of 1-300 characters');
  const print = list.print ?? {};
  if (!['flat', 'angled'].includes(print.orientation))
    errors.push('print.orientation must be "flat" or "angled"');
  if (!LIMITS.layerUm.includes(print.suggestedLayerUm))
    errors.push('print.suggestedLayerUm must be 10, 30, 50 or 100');
  if (errors.length) return { ok: false, errors };
  const seen = new Set();
  list.parts.forEach((p, i) => validatePart(p, i, seen, errors));
  if (errors.length) return { ok: false, errors };
  const triangles = list.parts.reduce((s, p) => s + triangleCount(p), 0);
  if (triangles > LIMITS.triangleBudget)
    errors.push(`model needs ${triangles} triangles; the limit is ${LIMITS.triangleBudget}`);
  const bytes = compactBytes(list);
  if (bytes > LIMITS.listBytes)
    errors.push(`part list is ${bytes} bytes; the limit is ${LIMITS.listBytes}`);
  return errors.length ? { ok: false, errors } : { ok: true, value: list, triangles, bytes };
}
