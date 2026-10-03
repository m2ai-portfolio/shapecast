import { boundingBox, partVolume, partToTriangles } from './geometry.js';

export const SATURN3 = {
  name: 'Elegoo Saturn 3 (12K)',
  build: [218.88, 122.88, 250],
  pixelUm: [19, 24],
  layerUm: [10, 30, 50, 100],
};
const EPS = 0.01,
  NEAR = 0.5;
const f = (v) => v.toFixed(2);

function pointSegDist(p, a, b) {
  const dx = b[0] - a[0],
    dy = b[1] - a[1],
    l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Minimum distance from any vertex to any non-adjacent edge: a conservative local wall thickness. */
export function polygonThickness(pts) {
  const n = pts.length;
  let min = Infinity;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (j === i || (j + 1) % n === i) continue; // the two edges that touch vertex i
      min = Math.min(min, pointSegDist(pts[i], pts[j], pts[(j + 1) % n]));
    }
  return min;
}

export function minFeature(p) {
  switch (p.type) {
    case 'box':
    case 'wedge':
      return Math.min(...p.size);
    case 'cylinder': {
      const rt = p.radiusTop ?? p.radius;
      return Math.min(2 * p.radius, rt > 0 ? 2 * rt : Infinity, p.height);
    }
    case 'cone':
      return Math.min(2 * p.radius, p.height);
    case 'sphere':
      return 2 * p.radius;
    case 'torus':
      return 2 * p.tube;
    case 'extrude':
      return Math.min(p.height, polygonThickness(p.profile));
    case 'lathe':
      return polygonThickness(p.profile);
    default:
      return Infinity;
  }
}

export function buildItems(partList) {
  return partList.parts.map((part) => {
    const tris = partToTriangles(part);
    return { part, tris, bbox: boundingBox(tris) };
  });
}

// positive = gap, negative = overlap, per axis
const gaps = (a, b) =>
  [0, 1, 2].map((k) => Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k]));
const axisAligned = (p) =>
  p.type === 'box' && p.rot.every((r) => Math.abs(((r % 90) + 90) % 90) < 1e-6);
// share of upper's footprint that lies over lower's footprint
const xyOverlapFraction = (lower, upper) => {
  const ox = Math.max(
    0,
    Math.min(lower.max[0], upper.max[0]) - Math.max(lower.min[0], upper.min[0]),
  );
  const oy = Math.max(
    0,
    Math.min(lower.max[1], upper.max[1]) - Math.max(lower.min[1], upper.min[1]),
  );
  const area = upper.size[0] * upper.size[1];
  return area > 0 ? (ox * oy) / area : 0;
};

export function contactGraph(items) {
  const edges = [],
    near = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const g = gaps(items[i].bbox, items[j].bbox);
      if (g.every((x) => x <= -EPS))
        edges.push({ i, j, confirmed: axisAligned(items[i].part) && axisAligned(items[j].part) });
      else if (g.every((x) => x <= NEAR)) near.push({ i, j, gap: Math.max(0, ...g) });
    }
  return { edges, near };
}

function mergeBoxes(boxes) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export function runPrintChecks(items, { layerUm = 50, orientation = 'flat' } = {}) {
  if (!items.length)
    return {
      checks: [{ id: 'empty', level: 'info', message: 'No parts yet' }],
      bbox: null,
      volumeMm3: 0,
      layers: {},
      worst: 'info',
    };
  const checks = [];
  const bb = mergeBoxes(items.map((it) => it.bbox));
  const [W, D, H] = SATURN3.build,
    [sx, sy, sz] = bb.size;
  if (sx <= W && sy <= D && sz <= H)
    checks.push({
      id: 'fit',
      level: 'green',
      message: `Fits the plate: ${f(sx)} x ${f(sy)} x ${f(sz)} mm`,
    });
  else if (sy <= W && sx <= D && sz <= H)
    checks.push({
      id: 'fit',
      level: 'amber',
      message: `Fits only rotated 90 deg about Z: ${f(sx)} x ${f(sy)} x ${f(sz)} mm`,
    });
  else
    checks.push({
      id: 'fit',
      level: 'red',
      message: `Too large: ${f(sx)} x ${f(sy)} x ${f(sz)} mm exceeds ${W} x ${D} x ${H} mm`,
    });

  for (const it of items) {
    const m = minFeature(it.part);
    if (m < 0.8)
      checks.push({
        id: 'feature:' + it.part.id,
        level: 'red',
        message: `${it.part.id}: thinnest feature ${f(m)} mm is under 0.8 mm`,
      });
    else if (m < 1.2)
      checks.push({
        id: 'feature:' + it.part.id,
        level: 'amber',
        message: `${it.part.id}: thinnest feature ${f(m)} mm is under 1.2 mm`,
      });
  }

  const { edges, near } = contactGraph(items);
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of edges) parent[find(e.i)] = find(e.j);
  const comps = new Map();
  items.forEach((_, i) => {
    const r = find(i);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(i);
  });
  const grounded = (i) => items[i].bbox.min[2] <= EPS;
  const sunk = items.map((_, i) => i).filter((i) => items[i].bbox.min[2] < -EPS);
  let flagged = false;
  if (sunk.length) {
    flagged = true;
    checks.push({
      id: 'plate:' + sunk.map((i) => items[i].part.id).join(', '),
      level: 'red',
      message: `Below the build plate: ${sunk.map((i) => items[i].part.id).join(', ')} (move every part to z >= 0)`,
    });
  }
  const confirmedAdj = items.map(() => []),
    adj = items.map(() => []);
  for (const e of edges) {
    adj[e.i].push(e.j);
    adj[e.j].push(e.i);
    if (e.confirmed) {
      confirmedAdj[e.i].push(e.j);
      confirmedAdj[e.j].push(e.i);
    }
  }
  const reached = new Set();
  const queue = items.map((_, i) => i).filter(grounded);
  queue.forEach((i) => reached.add(i));
  while (queue.length) {
    const i = queue.pop();
    for (const j of confirmedAdj[i])
      if (!reached.has(j)) {
        reached.add(j);
        queue.push(j);
      }
  }
  const ids = (arr) => arr.map((i) => items[i].part.id).join(', ');
  for (const members of comps.values()) {
    if (!members.some(grounded)) {
      flagged = true;
      checks.push({
        id: 'support:' + ids(members),
        level: 'red',
        message: `Unsupported group: ${ids(members)}`,
      });
      continue;
    }
    const unconfirmed = members.filter((i) => !reached.has(i));
    if (unconfirmed.length) {
      flagged = true;
      checks.push({
        id: 'contact:' + ids(unconfirmed),
        level: 'amber',
        message: `Contact not confirmed: ${ids(unconfirmed)}`,
      });
    }
  }
  if (!flagged)
    checks.push({
      id: 'support',
      level: 'green',
      message: 'All parts grounded through confirmed contact',
    });
  for (const nm of near)
    checks.push({
      id: `near:${items[nm.i].part.id}-${items[nm.j].part.id}`,
      level: 'amber',
      message: `Near miss: ${items[nm.i].part.id} and ${items[nm.j].part.id} are ${f(nm.gap)} mm apart and will not fuse`,
    });

  if (orientation === 'flat')
    for (const [i, it] of items.entries()) {
      if (it.bbox.min[2] <= EPS) continue;
      const covered = adj[i]
        .filter((j) => items[j].bbox.min[2] < it.bbox.min[2] - EPS)
        .reduce((best, j) => Math.max(best, xyOverlapFraction(items[j].bbox, it.bbox)), 0);
      if (covered < 0.5)
        checks.push({
          id: 'overhang:' + it.part.id,
          level: 'amber',
          message: `${it.part.id}: ${Math.round((1 - covered) * 100)}% of its footprint hangs over nothing, needs supports`,
        });
    }

  const volumeMm3 = items.reduce((s, it) => s + partVolume(it.part), 0);
  checks.push({
    id: 'volume',
    level: 'info',
    message: `Summed primitive volume ${(volumeMm3 / 1000).toFixed(1)} mL (upper bound; overlaps counted twice)`,
  });
  const layers = Object.fromEntries(SATURN3.layerUm.map((um) => [um, Math.ceil(sz / (um / 1000))]));
  checks.push({
    id: 'layers',
    level: 'info',
    message: `${layers[layerUm]} layers at ${layerUm} um (${f(sz)} mm tall)`,
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
  return { checks, bbox: bb, volumeMm3, layers, worst };
}
