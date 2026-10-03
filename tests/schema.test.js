import { describe, it, expect } from 'vitest';
import { validatePartList, triangleCount, EXAMPLE_LIST, LIMITS } from '../src/schema.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const withPart = (patch) => {
  const l = clone(EXAMPLE_LIST);
  Object.assign(l.parts[0], patch);
  return l;
};
const lathe = (profile) => ({
  ...clone(EXAMPLE_LIST),
  parts: [{ id: 'l', type: 'lathe', profile, pos: [0, 0, 0], rot: [0, 0, 0], role: 'add' }],
});

describe('validatePartList', () => {
  it('accepts the worked example', () => {
    const r = validatePartList(EXAMPLE_LIST);
    expect(r.ok).toBe(true);
    expect(r.triangles).toBeGreaterThan(0);
  });
  it('rejects non-object input', () => {
    expect(validatePartList(null).ok).toBe(false);
    expect(validatePartList([]).ok).toBe(false);
  });
  it('rejects wrong units, missing parts, bad print block', () => {
    const r = validatePartList({
      ...clone(EXAMPLE_LIST),
      units: 'in',
      parts: [],
      print: { orientation: 'up', suggestedLayerUm: 25 },
    });
    const all = r.errors.join('\n');
    expect(all).toMatch(/units/);
    expect(all).toMatch(/parts/);
    expect(all).toMatch(/orientation/);
    expect(all).toMatch(/suggestedLayerUm/);
  });
  it('rejects duplicate and malformed ids, naming the part', () => {
    const l = clone(EXAMPLE_LIST);
    l.parts[1].id = l.parts[0].id;
    expect(validatePartList(l).errors[0]).toMatch(
      new RegExp(`^${l.parts[0].id}: id is not unique`),
    );
    expect(validatePartList(withPart({ id: 'Bad Id' })).errors[0]).toMatch(/id must be/);
  });
  it('rejects role sub with the v2 message and unknown types', () => {
    expect(validatePartList(withPart({ role: 'sub' })).errors[0]).toMatch(
      /subtractive parts arrive in v2/,
    );
    expect(validatePartList(withPart({ type: 'blob' })).errors[0]).toMatch(/unknown type/);
  });
  it('rejects non-finite, string, zero and negative dimensions by part id', () => {
    for (const bad of [
      [Number('1e309'), 0, 0],
      ['12', 0, 0],
      [0, 0],
    ])
      expect(validatePartList(withPart({ pos: bad })).errors[0]).toMatch(/^base: pos/);
    expect(validatePartList(withPart({ size: [0, 10, 10] })).errors[0]).toMatch(/^base: size/);
    expect(validatePartList(withPart({ size: [-1, 10, 10] })).errors[0]).toMatch(/^base: size/);
    expect(validatePartList(withPart({ size: [301, 10, 10] })).errors[0]).toMatch(/^base: size/);
  });
  it('rejects bad segments and torus tube >= radius', () => {
    expect(validatePartList(withPart({ segments: 2.5 })).errors[0]).toMatch(/segments/);
    const l = clone(EXAMPLE_LIST);
    l.parts[0] = {
      id: 't',
      type: 'torus',
      radius: 5,
      tube: 5,
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      role: 'add',
    };
    expect(validatePartList(l).errors[0]).toMatch(/tube must be smaller/);
  });
  it('rejects profiles: too few points, repeated endpoint, duplicates, zero area, self-intersection', () => {
    const ext = (profile) => {
      const l = clone(EXAMPLE_LIST);
      l.parts[1].profile = profile;
      return validatePartList(l).errors[0];
    };
    expect(
      ext([
        [0, 0],
        [1, 0],
      ]),
    ).toMatch(/3 to 200 points/);
    expect(
      ext([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ]),
    ).toMatch(/first point must not repeat/);
    expect(
      ext([
        [0, 0],
        [0, 0],
        [1, 1],
      ]),
    ).toMatch(/identical/);
    expect(
      ext([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
    ).toMatch(/zero area/);
    expect(
      ext([
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 8],
      ]),
    ).toMatch(/intersect/);
  });
  it('rejects lathe profiles with negative r, no r>0, or an isolated axis touch', () => {
    expect(
      validatePartList(
        lathe([
          [-1, 0],
          [10, 0],
          [10, 5],
        ]),
      ).errors[0],
    ).toMatch(/r must be >= 0/);
    expect(
      validatePartList(
        lathe([
          [0, 0],
          [0, 5],
          [0, 10],
        ]),
      ).errors[0],
    ).toMatch(/zero area|r > 0/);
    expect(
      validatePartList(
        lathe([
          [0, 0],
          [10, -10],
          [20, 0],
          [10, 10],
        ]),
      ).errors[0],
    ).toMatch(/single point \(point 0\)/);
    expect(
      validatePartList(
        lathe([
          [0, 0],
          [10, 10],
          [20, 10],
        ]),
      ).errors[0],
    ).toMatch(/single point/);
  });
  it('accepts sphere-like, cylinder and cone lathe profiles', () => {
    for (const p of [
      [
        [0, -10],
        [10, 0],
        [0, 10],
      ],
      [
        [0, 0],
        [10, 0],
        [10, 5],
        [0, 5],
      ],
      [
        [0, 0],
        [10, 0],
        [0, 10],
      ],
    ])
      expect(validatePartList(lathe(p)).ok).toBe(true);
  });
  it('enforces assumptions bounds', () => {
    expect(
      validatePartList({ ...clone(EXAMPLE_LIST), assumptions: ['x'.repeat(301)] }).errors[0],
    ).toMatch(/assumptions/);
    expect(
      validatePartList({ ...clone(EXAMPLE_LIST), assumptions: Array(21).fill('a') }).errors[0],
    ).toMatch(/assumptions/);
  });
  it('enforces the triangle budget and the byte budget', () => {
    const l = clone(EXAMPLE_LIST);
    l.parts = Array.from({ length: 200 }, (_, i) => ({
      id: 's' + i,
      type: 'sphere',
      radius: 5,
      segments: 256,
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      role: 'add',
    }));
    expect(validatePartList(l).errors[0]).toMatch(/triangles/);
    const big = clone(EXAMPLE_LIST);
    big.parts = Array.from({ length: 200 }, (_, i) => ({
      id: 'e' + i,
      type: 'extrude',
      height: 1,
      profile: Array.from({ length: 200 }, (__, k) => [
        Math.cos((k / 200) * 6.283) * 10,
        Math.sin((k / 200) * 6.283) * 10,
      ]),
      pos: [0, 0, 0],
      rot: [0, 0, 0],
      role: 'add',
    }));
    const r = validatePartList(big);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/bytes/);
  });
  it('counts triangles per type', () => {
    expect(triangleCount({ type: 'box' })).toBe(12);
    expect(triangleCount({ type: 'cylinder', radius: 1, segments: 8 })).toBe(32);
    expect(triangleCount({ type: 'cylinder', radius: 1, radiusTop: 0, segments: 8 })).toBe(16);
    expect(triangleCount({ type: 'sphere', segments: 8 })).toBe(2 * 8 * 3);
    expect(
      triangleCount({
        type: 'extrude',
        profile: [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
      }),
    ).toBe(12);
    expect(LIMITS.listBytes).toBe(122880);
  });
});
