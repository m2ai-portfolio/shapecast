import { describe, it, expect } from 'vitest';
import {
  runPrintChecks,
  runMeshPrintChecks,
  buildItems,
  polygonThickness,
  minFeature,
} from '../src/printcheck.js';

const list = (parts) => ({
  name: 'f',
  units: 'mm',
  assumptions: [],
  print: { orientation: 'flat', suggestedLayerUm: 50 },
  parts,
});
const box = (id, size, pos, rot = [0, 0, 0]) => ({ id, type: 'box', size, pos, rot, role: 'add' });
const run = (parts, opts) =>
  runPrintChecks(buildItems(list(parts)), { layerUm: 50, orientation: 'flat', ...opts });
const find = (r, prefix) => r.checks.filter((c) => c.id.startsWith(prefix));
const msgs = (r) => r.checks.map((c) => `${c.level} ${c.message}`).join('\n');

describe('print checks', () => {
  it('fits, fits only rotated, too large', () => {
    expect(find(run([box('a', [100, 100, 10], [0, 0, 5])]), 'fit')[0].level).toBe('green');
    const rot = find(run([box('a', [120, 200, 10], [0, 0, 5])]), 'fit')[0];
    expect(rot.level).toBe('amber');
    expect(rot.message).toMatch(/rotated 90/);
    expect(find(run([box('a', [230, 10, 10], [0, 0, 5])]), 'fit')[0].level).toBe('red');
  });
  it('minimum feature: 0.5 mm disk red, 1.0 mm wall amber, per-type rules', () => {
    const disk = {
      id: 'd',
      type: 'cylinder',
      radius: 10,
      height: 0.5,
      pos: [0, 0, 0.25],
      rot: [0, 0, 0],
      role: 'add',
    };
    expect(find(run([disk]), 'feature:d')[0].level).toBe('red');
    const wall = {
      id: 'w',
      type: 'extrude',
      profile: [
        [0, 0],
        [40, 0],
        [40, 1],
        [0, 1],
      ],
      height: 20,
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      role: 'add',
    };
    expect(find(run([wall]), 'feature:w')[0].level).toBe('amber');
    expect(
      polygonThickness([
        [0, 0],
        [40, 0],
        [40, 1],
        [0, 1],
      ]),
    ).toBeCloseTo(1, 9);
    expect(
      polygonThickness([
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toBeCloseTo(10, 9);
    expect(minFeature({ type: 'cylinder', radius: 5, radiusTop: 0.3, height: 20 })).toBeCloseTo(
      0.6,
      9,
    );
    expect(minFeature({ type: 'torus', radius: 10, tube: 0.4 })).toBeCloseTo(0.8, 9);
    expect(
      minFeature({
        type: 'lathe',
        profile: [
          [0, 0],
          [10, 0],
          [10, 0.5],
          [0, 0.5],
        ],
      }),
    ).toBeCloseTo(0.5, 9);
  });
  it('suspended group is red', () => {
    const r = run([box('a', [10, 10, 2], [0, 0, 5]), box('b', [10, 10, 2], [5, 0, 6])]);
    expect(find(r, 'support:')[0]).toMatchObject({ level: 'red' });
    expect(find(r, 'support:')[0].message).toMatch(/a, b/);
  });
  it('0.4 mm vertical gap: upper box unsupported and listed as a near miss; 0.6 mm gap: no near miss', () => {
    const r = run([box('a', [10, 10, 2], [0, 0, 1]), box('b', [10, 10, 2], [0, 0, 3.4])]);
    expect(msgs(r)).toMatch(/red Unsupported group: b/);
    expect(msgs(r)).toMatch(/amber Near miss: a and b are 0.40 mm apart/);
    const r2 = run([box('a', [10, 10, 2], [0, 0, 1]), box('b', [10, 10, 2], [0, 0, 3.6])]);
    expect(msgs(r2)).toMatch(/red Unsupported group: b/);
    expect(find(r2, 'near:').length).toBe(0);
  });
  it('exactly touching boxes (gap 0.00) are a near miss, not a connection', () => {
    const r = run([box('a', [10, 10, 2], [0, 0, 1]), box('b', [10, 10, 2], [0, 0, 3])]);
    expect(msgs(r)).toMatch(/Near miss: a and b are 0.00 mm apart/);
    expect(msgs(r)).toMatch(/red Unsupported group: b/);
  });
  it('0.5 mm interpenetrating axis-aligned boxes are green', () => {
    const r = run([box('a', [10, 10, 2], [0, 0, 1]), box('b', [10, 10, 2], [0, 0, 2.5])]);
    expect(find(r, 'support')[0].level).toBe('green');
    expect(find(r, 'overhang:').length).toBe(0);
  });
  it('rotated box, wedge, and curved contacts are candidates (amber), never green', () => {
    const r1 = run([
      box('a', [10, 10, 2], [0, 0, 1]),
      box('b', [10, 10, 2], [0, 0, 2.5], [0, 0, 45]),
    ]);
    expect(msgs(r1)).toMatch(/amber Contact not confirmed: b/);
    const r2 = run([
      { id: 'w', type: 'wedge', size: [10, 10, 10], pos: [0, 0, 5], rot: [0, 0, 0], role: 'add' },
      box('b', [1, 1, 1], [4, 0, 8]),
    ]);
    expect(msgs(r2)).toMatch(/amber Contact not confirmed: b/);
    expect(find(r2, 'support')[0]?.level).not.toBe('green');
    const r3 = run([
      {
        id: 'c',
        type: 'cylinder',
        radius: 5,
        height: 10,
        pos: [0, 0, 5],
        rot: [0, 0, 0],
        role: 'add',
      },
      { id: 's', type: 'sphere', radius: 5, pos: [9.8, 0, 9], rot: [0, 0, 0], role: 'add' },
    ]);
    expect(msgs(r3)).toMatch(/amber Contact not confirmed: s/);
  });
  it('overhang: a cap wider than its stem needs supports, a stacked box does not', () => {
    const r = run([
      {
        id: 'stem',
        type: 'cylinder',
        radius: 3,
        height: 10,
        pos: [0, 0, 5],
        rot: [0, 0, 0],
        role: 'add',
      },
      box('cap', [20, 20, 2], [0, 0, 10.9]),
    ]);
    expect(msgs(r)).toMatch(/amber cap: .*needs supports/);
    const r2 = run([box('a', [10, 10, 10], [0, 0, 5]), box('b', [10, 10, 10], [0, 0, 14.9])]);
    expect(find(r2, 'overhang:').length).toBe(0);
  });
  it('volume is labelled an upper bound, layers computed per height', () => {
    const r = run([box('a', [10, 10, 10], [0, 0, 5])], { layerUm: 50 });
    expect(r.volumeMm3).toBeCloseTo(1000, 6);
    expect(msgs(r)).toMatch(/upper bound/);
    expect(r.layers[50]).toBe(200);
    expect(r.layers[10]).toBe(1000);
    expect(msgs(r)).toMatch(/19 x 24 um/);
    expect(r.worst).toBe('green');
  });
  it('empty list returns a single info check', () => {
    const r = runPrintChecks([], { layerUm: 50, orientation: 'flat' });
    expect(r.checks.length).toBe(1);
    expect(r.worst).toBe('info');
  });
  it('a part below the build plate is red and cannot ground a separate tower', () => {
    const r = run([box('base', [40, 40, 4], [0, 0, 0]), box('tower', [10, 10, 30], [60, 0, 15])]);
    expect(msgs(r)).toMatch(/red Below the build plate: base/);
    expect(r.worst).toBe('red');
  });
  it('runMeshPrintChecks evaluates fit, manifold, grounding, and hollowing advice', () => {
    const ok = runMeshPrintChecks(
      { min: [-33, -75, 0], max: [33, 75, 40], size: [66, 150, 40] },
      204000,
      true,
      { layerUm: 50 },
    );
    expect(ok.worst).toBe('amber'); // 66x150 fits rotated 90 deg on 218.88x122.88 plate
    expect(find(ok, 'manifold')[0].level).toBe('green');
    expect(find(ok, 'volume')[0].message).toMatch(/hollow in Chitubox/);
    expect(ok.layers[50]).toBe(800);
  });
});
