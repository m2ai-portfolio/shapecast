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

export function runMeshPrintChecks(bbox, volumeMm3, manifoldOk, { layerUm = 50 } = {}) {
  if (!bbox)
    return {
      checks: [{ id: 'empty', level: 'info', message: 'No mesh yet' }],
      bbox: null,
      volumeMm3: 0,
      layers: {},
      worst: 'info',
    };
  const checks = [];
  const [W, D, H] = SATURN3.build,
    [sx, sy, sz] = bbox.size;
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

  checks.push({
    id: 'manifold',
    level: manifoldOk ? 'green' : 'red',
    message: manifoldOk
      ? 'Watertight 2-manifold mesh ready for slicing'
      : 'Mesh has non-manifold edges or holes',
  });

  if (bbox.min[2] >= -EPS && bbox.min[2] <= 0.1)
    checks.push({
      id: 'plate',
      level: 'green',
      message: 'Grounded on the build plate (z = 0.00 mm)',
    });
  else if (bbox.min[2] < -EPS)
    checks.push({
      id: 'plate',
      level: 'red',
      message: `Below the build plate (min z = ${f(bbox.min[2])} mm)`,
    });
  else
    checks.push({
      id: 'plate',
      level: 'amber',
      message: `Elevated above build plate (min z = ${f(bbox.min[2])} mm)`,
    });

  const ml = volumeMm3 / 1000;
  checks.push({
    id: 'volume',
    level: 'info',
    message:
      ml > 25
        ? `Mesh volume ${ml.toFixed(1)} mL (hollow in Chitubox with 2.0 mm wall + 2 drain holes)`
        : `Mesh volume ${ml.toFixed(1)} mL`,
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
  return { checks, bbox, volumeMm3, layers, worst };
}

/**
 * Compute real-world Elegoo Saturn 3 (12K) MSLA print telemetry:
 * estimated print time, layer count, solid vs hollowed resin mass/cost, and build-plate area %.
 */
export function estimateSaturn3Telemetry(bbox, volumeMm3, { layerUm = 50 } = {}) {
  if (!bbox || !(volumeMm3 > 0)) {
    return {
      layers: 0,
      printMinutes: 0,
      printTimeLabel: '—',
      solidMl: 0,
      hollowMl: 0,
      solidGrams: 0,
      hollowGrams: 0,
      solidCostUsd: 0,
      hollowCostUsd: 0,
      recommendHollow: false,
      platePct: 0,
    };
  }
  const [W, D] = SATURN3.build;
  const [sx, sy, sz] = bbox.size;
  const layers = Math.max(1, Math.ceil(sz / (layerUm / 1000)));
  const cureSecByUm = { 10: 1.3, 30: 1.9, 50: 2.5, 100: 3.6 };
  const normalCureSec = cureSecByUm[layerUm] ?? 2.5;
  const peelCycleSec = 5.2; // Saturn 3 Z-lift + retract + rest-before-print
  const burnLayers = Math.min(5, layers);
  const burnSec = burnLayers * (32 + 6.5);
  const normalSec = Math.max(0, layers - burnLayers) * (normalCureSec + peelCycleSec);
  const totalSec = burnSec + normalSec;
  const printMinutes = Math.max(1, Math.round(totalSec / 60));
  const hrs = Math.floor(printMinutes / 60);
  const mins = printMinutes % 60;
  const printTimeLabel = hrs > 0 ? `${hrs}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;

  const solidMl = volumeMm3 / 1000;
  const recommendHollow = solidMl > 25;
  const hollowMl = recommendHollow ? Math.max(8, solidMl * 0.34) : solidMl;
  const densityGPerMl = 1.12; // 8K photopolymer resin
  const usdPerGram = 0.028; // ~$28 / 1kg bottle
  const solidGrams = solidMl * densityGPerMl;
  const hollowGrams = hollowMl * densityGPerMl;
  const solidCostUsd = solidGrams * usdPerGram;
  const hollowCostUsd = hollowGrams * usdPerGram;
  const platePct = Math.min(100, ((sx * sy) / (W * D)) * 100);

  return {
    layers,
    printMinutes,
    printTimeLabel,
    solidMl,
    hollowMl,
    solidGrams,
    hollowGrams,
    solidCostUsd,
    hollowCostUsd,
    recommendHollow,
    platePct,
  };
}

/**
 * Non-destructively orient (Z-spin + X-tilt for MSLA peel-force reduction) and rescale a triangle soup,
 * re-centering X/Y on (0,0) and grounding minZ = 0.00 mm on the Saturn 3 build plate.
 */
export function transformMeshTriangles(
  rawTris,
  { tiltDeg = 0, rotZDeg = 0, targetMm = null } = {},
) {
  if (!rawTris || !rawTris.length) {
    return { tris: new Float32Array(0), bbox: null, scaleFactor: 1 };
  }
  const n = rawTris.length;
  const out = new Float32Array(n);
  const radZ = (rotZDeg * Math.PI) / 180;
  const cz = Math.cos(radZ),
    sz = Math.sin(radZ);
  const radX = (tiltDeg * Math.PI) / 180;
  const cx = Math.cos(radX),
    sx = Math.sin(radX);

  // Measure raw bounds for optional rescaling and smart long-axis MSLA peel tilt
  let rMinX = Infinity,
    rMinY = Infinity,
    rMinZ = Infinity;
  let rMaxX = -Infinity,
    rMaxY = -Infinity,
    rMaxZ = -Infinity;
  for (let i = 0; i < n; i += 3) {
    const x = rawTris[i],
      y = rawTris[i + 1],
      z = rawTris[i + 2];
    if (x < rMinX) rMinX = x;
    if (x > rMaxX) rMaxX = x;
    if (y < rMinY) rMinY = y;
    if (y > rMaxY) rMaxY = y;
    if (z < rMinZ) rMinZ = z;
    if (z > rMaxZ) rMaxZ = z;
  }

  let scaleFactor = 1;
  if (targetMm && targetMm > 0) {
    const maxSpan = Math.max(rMaxX - rMinX, rMaxY - rMinY, rMaxZ - rMinZ, 1e-6);
    scaleFactor = targetMm / maxSpan;
  }
  const rawSpanX = rMaxX - rMinX;
  const rawSpanY = rMaxY - rMinY;
  const rotSpanX = Math.abs(rawSpanX * cz) + Math.abs(rawSpanY * sz);
  const rotSpanY = Math.abs(rawSpanX * sz) + Math.abs(rawSpanY * cz);
  const pitchAlongX = rotSpanX > rotSpanY * 1.05;

  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (let i = 0; i < n; i += 3) {
    const x0 = rawTris[i] * scaleFactor;
    const y0 = rawTris[i + 1] * scaleFactor;
    const z0 = rawTris[i + 2] * scaleFactor;
    // 1. Rotate about Z
    const x1 = x0 * cz - y0 * sz;
    const y1 = x0 * sz + y0 * cz;
    const z1 = z0;
    // 2. Tilt longest horizontal axis upward to minimize FEP cross-sectional suction
    const x2 = pitchAlongX ? x1 * cx - z1 * sx : x1;
    const y2 = pitchAlongX ? y1 : y1 * cx - z1 * sx;
    const z2 = (pitchAlongX ? x1 : y1) * sx + z1 * cx;

    out[i] = x2;
    out[i + 1] = y2;
    out[i + 2] = z2;
    if (x2 < minX) minX = x2;
    if (x2 > maxX) maxX = x2;
    if (y2 < minY) minY = y2;
    if (y2 > maxY) maxY = y2;
    if (z2 < minZ) minZ = z2;
    if (z2 > maxZ) maxZ = z2;
  }

  const shiftX = -0.5 * (minX + maxX);
  const shiftY = -0.5 * (minY + maxY);
  const shiftZ = -minZ;
  for (let i = 0; i < n; i += 3) {
    out[i] += shiftX;
    out[i + 1] += shiftY;
    out[i + 2] += shiftZ;
  }

  const bbox = {
    min: [minX + shiftX, minY + shiftY, 0],
    max: [maxX + shiftX, maxY + shiftY, maxZ + shiftZ],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
  return { tris: out, bbox, scaleFactor };
}

/**
 * Compute how many copies of a given bounding box can nest onto the Elegoo Saturn 3 (12K)
 * 218.88 x 122.88 mm build plate with support-raft clearance margins (capped at 24).
 */
export function maxCopiesOnSaturn3(bbox, { marginMm = 4.5, edgePadMm = 3.0 } = {}) {
  if (!bbox || !bbox.size) return { count: 1, rotate90: false };
  const usableW = SATURN3.build[0] - edgePadMm * 2;
  const usableD = SATURN3.build[1] - edgePadMm * 2;
  const [sx, sy] = bbox.size;
  if (!(sx > 0 && sy > 0)) return { count: 1, rotate90: false };

  const cols0 = Math.floor((usableW + marginMm) / (sx + marginMm));
  const rows0 = Math.floor((usableD + marginMm) / (sy + marginMm));
  const c0 = Math.max(0, cols0 * rows0);

  const cols90 = Math.floor((usableW + marginMm) / (sy + marginMm));
  const rows90 = Math.floor((usableD + marginMm) / (sx + marginMm));
  const c90 = Math.max(0, cols90 * rows90);

  if (c90 > c0) {
    return { count: Math.max(1, Math.min(24, c90)), rotate90: true };
  }
  return { count: Math.max(1, Math.min(24, c0)), rotate90: false };
}

/**
 * Shelf-pack multiple 3D mesh items onto the Elegoo Saturn 3 (12K) build plate,
 * centering each shelf row and centering the overall multi-part array around (0, 0).
 */
export function packBuildPlate(specs, { marginMm = 4.5, edgePadMm = 3.0 } = {}) {
  if (!specs || specs.length === 0) {
    return { items: [], bbox: null, overflowCount: 0 };
  }
  if (specs.length === 1) {
    return { items: specs, bbox: specs[0].bbox, overflowCount: 0 };
  }
  const usableW = SATURN3.build[0] - edgePadMm * 2;
  const usableD = SATURN3.build[1] - edgePadMm * 2;

  // Sort tallest/widest footprint first only when mixed parts are present, preserving order otherwise
  const rows = [];
  let curRow = { items: [], width: 0, depth: 0 };

  for (const sp of specs) {
    const [sx, sy] = sp.bbox.size;
    const neededW = curRow.items.length === 0 ? sx : curRow.width + marginMm + sx;
    if (curRow.items.length > 0 && neededW > usableW + 1e-6) {
      rows.push(curRow);
      curRow = { items: [sp], width: sx, depth: sy };
    } else {
      curRow.items.push(sp);
      curRow.width = neededW;
      if (sy > curRow.depth) curRow.depth = sy;
    }
  }
  if (curRow.items.length > 0) rows.push(curRow);

  const totalDepth =
    rows.reduce((acc, r) => acc + r.depth, 0) + Math.max(0, rows.length - 1) * marginMm;
  let cursorY = -totalDepth / 2;
  let overflowCount = 0;

  let gMinX = Infinity,
    gMinY = Infinity,
    gMinZ = Infinity;
  let gMaxX = -Infinity,
    gMaxY = -Infinity,
    gMaxZ = -Infinity;

  const placed = [];
  for (const row of rows) {
    let cursorX = -row.width / 2;
    const rowCenterY = cursorY + row.depth / 2;
    for (const sp of row.items) {
      const [sx, sy, sz] = sp.bbox.size;
      const cx = cursorX + sx / 2;
      const cy = rowCenterY;
      cursorX += sx + marginMm;

      // Current sp is centered at (0,0) in X/Y; shift by (cx, cy, 0)
      const oldCenterX = 0.5 * (sp.bbox.min[0] + sp.bbox.max[0]);
      const oldCenterY = 0.5 * (sp.bbox.min[1] + sp.bbox.max[1]);
      const dx = cx - oldCenterX;
      const dy = cy - oldCenterY;

      const shiftedTris = new Float32Array(sp.tris.length);
      for (let i = 0; i < sp.tris.length; i += 3) {
        shiftedTris[i] = sp.tris[i] + dx;
        shiftedTris[i + 1] = sp.tris[i + 1] + dy;
        shiftedTris[i + 2] = sp.tris[i + 2];
      }
      const itemBbox = {
        min: [sp.bbox.min[0] + dx, sp.bbox.min[1] + dy, sp.bbox.min[2]],
        max: [sp.bbox.max[0] + dx, sp.bbox.max[1] + dy, sp.bbox.max[2]],
        size: [sx, sy, sz],
      };
      if (
        Math.abs(itemBbox.min[0]) > usableW / 2 + edgePadMm + 0.05 ||
        Math.abs(itemBbox.max[0]) > usableW / 2 + edgePadMm + 0.05 ||
        Math.abs(itemBbox.min[1]) > usableD / 2 + edgePadMm + 0.05 ||
        Math.abs(itemBbox.max[1]) > usableD / 2 + edgePadMm + 0.05
      ) {
        overflowCount++;
      }
      gMinX = Math.min(gMinX, itemBbox.min[0]);
      gMinY = Math.min(gMinY, itemBbox.min[1]);
      gMinZ = Math.min(gMinZ, itemBbox.min[2]);
      gMaxX = Math.max(gMaxX, itemBbox.max[0]);
      gMaxY = Math.max(gMaxY, itemBbox.max[1]);
      gMaxZ = Math.max(gMaxZ, itemBbox.max[2]);

      placed.push({
        ...sp,
        tris: shiftedTris,
        bbox: itemBbox,
      });
    }
    cursorY += row.depth + marginMm;
  }

  const combinedBbox = {
    min: [gMinX, gMinY, gMinZ],
    max: [gMaxX, gMaxY, gMaxZ],
    size: [gMaxX - gMinX, gMaxY - gMinY, gMaxZ - gMinZ],
  };
  return { items: placed, bbox: combinedBbox, overflowCount };
}

/**
 * Exact Green's-Theorem Z-layer cross-sectional curing area profiler (mm^2 vs Z)
 * to quantify FEP suction peel stress across the Elegoo Saturn 3 UV LCD vat.
 */
export function computePeelForceProfile(items, bbox, { bins = 64 } = {}) {
  const areasMm2 = new Float32Array(bins);
  if (!items || !items.length || !bbox || !(bbox.size[2] > 0)) {
    return { areasMm2, peakMm2: 0, peakRatioZ: 0, riskLevel: 'low' };
  }
  const minZ = bbox.min[2];
  const spanZ = Math.max(0.05, bbox.size[2]);
  const dz = spanZ / bins;
  const flatPlateBins = new Float32Array(bins);

  for (const it of items) {
    const tris = it.tris;
    if (!tris || !tris.length) continue;
    for (let i = 0; i < tris.length; i += 9) {
      const x0 = tris[i],
        y0 = tris[i + 1],
        z0 = tris[i + 2];
      const x1 = tris[i + 3],
        y1 = tris[i + 4],
        z1 = tris[i + 5];
      const x2 = tris[i + 6],
        y2 = tris[i + 7],
        z2 = tris[i + 8];

      const tMinZ = Math.min(z0, z1, z2);
      const tMaxZ = Math.max(z0, z1, z2);

      // Capture coplanar horizontal islands/bases that create sudden FEP snap suction
      if (tMaxZ - tMinZ < dz * 0.25) {
        const ux = x1 - x0,
          uy = y1 - y0;
        const vx = x2 - x0,
          vy = y2 - y0;
        const horizArea = 0.5 * Math.abs(ux * vy - uy * vx);
        const bIdx = Math.max(0, Math.min(bins - 1, Math.floor((tMinZ - minZ) / dz)));
        flatPlateBins[bIdx] += horizArea;
        continue;
      }

      const bStart = Math.max(0, Math.floor((tMinZ - minZ) / dz));
      const bEnd = Math.min(bins - 1, Math.floor((tMaxZ - minZ) / dz));

      for (let b = bStart; b <= bEnd; b++) {
        // Offset sample plane slightly from rational midpoints to avoid exact vertex hits
        const zb = minZ + (b + 0.50137) * dz;
        if (zb <= tMinZ || zb >= tMaxZ) continue;

        let upX = 0,
          upY = 0,
          downX = 0,
          downY = 0,
          hasUp = false,
          hasDown = false;

        // Directed edge 0 -> 1
        if ((z0 < zb) !== (z1 < zb)) {
          const t = (zb - z0) / (z1 - z0);
          const px = x0 + t * (x1 - x0);
          const py = y0 + t * (y1 - y0);
          if (z0 < z1) {
            upX = px;
            upY = py;
            hasUp = true;
          } else {
            downX = px;
            downY = py;
            hasDown = true;
          }
        }
        // Directed edge 1 -> 2
        if ((z1 < zb) !== (z2 < zb)) {
          const t = (zb - z1) / (z2 - z1);
          const px = x1 + t * (x2 - x1);
          const py = y1 + t * (y2 - y1);
          if (z1 < z2) {
            upX = px;
            upY = py;
            hasUp = true;
          } else {
            downX = px;
            downY = py;
            hasDown = true;
          }
        }
        // Directed edge 2 -> 0
        if ((z2 < zb) !== (z0 < zb)) {
          const t = (zb - z2) / (z0 - z2);
          const px = x2 + t * (x0 - x2);
          const py = y2 + t * (y0 - y2);
          if (z2 < z0) {
            upX = px;
            upY = py;
            hasUp = true;
          } else {
            downX = px;
            downY = py;
            hasDown = true;
          }
        }

        if (hasUp && hasDown) {
          areasMm2[b] += 0.5 * (downX * upY - downY * upX);
        }
      }
    }
  }

  let peakMm2 = 0;
  let peakBin = 0;
  for (let b = 0; b < bins; b++) {
    const val = Math.max(Math.abs(areasMm2[b]), flatPlateBins[b]);
    areasMm2[b] = val;
    if (val > peakMm2) {
      peakMm2 = val;
      peakBin = b;
    }
  }

  const peakRatioZ = bins > 1 ? peakBin / (bins - 1) : 0;
  const riskLevel = peakMm2 > 2200 ? 'high' : peakMm2 > 950 ? 'moderate' : 'low';
  return { areasMm2, peakMm2, peakRatioZ, riskLevel };
}
