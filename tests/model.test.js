import { describe, it, expect } from 'vitest';
import {
  applyFieldEdit,
  removePart,
  prepareImages,
  checkDocumentSizes,
  projectDocument,
  DOC_LIMIT,
  SAMPLE_LIST,
} from '../src/model.js';
import { validatePartList, EXAMPLE_LIST } from '../src/schema.js';

describe('applyFieldEdit', () => {
  it('rejects empty, dash and NaN without touching the list', () => {
    for (const raw of ['', '-', 'abc', '1e309']) {
      const r = applyFieldEdit(EXAMPLE_LIST, 'base', 'size', 0, raw);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/base\.size/);
    }
    expect(EXAMPLE_LIST.parts[0].size[0]).toBe(70);
  });
  it('applies a valid tuple edit and a scalar edit, returning a new list', () => {
    const r = applyFieldEdit(EXAMPLE_LIST, 'base', 'size', 2, '6');
    expect(r.ok).toBe(true);
    expect(r.list.parts[0].size).toEqual([70, 60, 6]);
    expect(EXAMPLE_LIST.parts[0].size[2]).toBe(4);
    const r2 = applyFieldEdit(EXAMPLE_LIST, 'back', 'height', null, 55);
    expect(r2.ok).toBe(true);
    expect(r2.list.parts[1].height).toBe(55);
  });
  it('returns the validator message for an out-of-range edit', () => {
    expect(applyFieldEdit(EXAMPLE_LIST, 'base', 'size', 0, 0).error).toMatch(/size must be/);
    expect(applyFieldEdit(EXAMPLE_LIST, 'nope', 'size', 0, 1).error).toMatch(/no such part/);
  });
  it('removePart keeps the list valid or reports why not', () => {
    expect(removePart(EXAMPLE_LIST, 'back').ok).toBe(true);
    const one = removePart(EXAMPLE_LIST, 'back').list;
    expect(removePart(one, 'base').error).toMatch(/parts must have 1/);
  });
});

describe('prepareImages', () => {
  const lim = { maxCount: 2, maxInputBytes: 20 * 1048576, mediaTypes: ['image/jpeg', 'image/png'] };
  const file = (name, type, size) => ({ name, type, size });
  it('filters by type, size and count with reasons', () => {
    const { images, rejected } = prepareImages(
      [
        file('a.jpg', 'image/jpeg', 1000),
        file('b.heic', 'image/heic', 1000),
        file('c.png', 'image/png', 30 * 1048576),
        file('d.png', 'image/png', 10),
        file('e.png', 'image/png', 10),
      ],
      lim,
    );
    expect(images.map((f) => f.name)).toEqual(['a.jpg', 'd.png']);
    expect(rejected.map((r) => r.reason)).toEqual([
      expect.stringMatching(/type image\/heic/),
      expect.stringMatching(/photo too large/),
      expect.stringMatching(/only 2 photos/),
    ]);
  });
  it('rejects everything when the view cannot send images', () => {
    const r = prepareImages([file('a.jpg', 'image/jpeg', 1)], undefined);
    expect(r.images).toEqual([]);
    expect(r.rejected[0].reason).toMatch(/cannot send photos/);
  });
});

describe('documents', () => {
  it('projectDocument carries bounded metadata and the current list', () => {
    const d = projectDocument({
      name: 'p',
      brief: 'b',
      scaleRef: 's',
      photoAssetIds: ['x'],
      current: EXAMPLE_LIST,
      currentRevisionId: 'r1',
      createdAt: 1,
      updatedAt: 2,
    });
    expect(d.current.parts.length).toBe(2);
    expect(d.photoAssetIds).toEqual(['x']);
    expect(d.updatedAt).toBe(2);
  });
  it('checkDocumentSizes refuses anything over 200 KiB and names which document', () => {
    const big = { ...EXAMPLE_LIST, assumptions: [], name: 'x', pad: 'y'.repeat(DOC_LIMIT) };
    expect(checkDocumentSizes({ projectDoc: { current: big } }).error).toMatch(
      /project.*too large/i,
    );
    expect(
      checkDocumentSizes({ projectDoc: { current: EXAMPLE_LIST }, revisionDoc: { partList: big } })
        .error,
    ).toMatch(/revision.*too large/i);
    expect(checkDocumentSizes({ projectDoc: { current: EXAMPLE_LIST } }).ok).toBe(true);
  });
  it('a 4000-char brief with a maximal list and 20 long assumptions still fits', () => {
    const parts = [];
    for (let i = 0; i < 200; i++) {
      const cand = {
        id: 'b' + i,
        type: 'box',
        size: [1.123456, 1.123456, 1.123456],
        pos: [i * 0.000001, 0, 0.561728],
        rot: [0, 0, 0],
        role: 'add',
      };
      if (validatePartList({ ...EXAMPLE_LIST, parts: [...parts, cand] }).ok) parts.push(cand);
      else break;
    }
    const list = { ...EXAMPLE_LIST, parts, assumptions: Array(20).fill('a'.repeat(300)) };
    expect(validatePartList(list).ok).toBe(true);
    expect(
      checkDocumentSizes({
        projectDoc: projectDocument({
          name: 'n'.repeat(80),
          brief: 'b'.repeat(4000),
          scaleRef: 's'.repeat(300),
          photoAssetIds: Array(8).fill('a'.repeat(32)),
          current: list,
          currentRevisionId: 'r',
          createdAt: 0,
          updatedAt: 0,
        }),
      }).ok,
    ).toBe(true);
  });
  it('SAMPLE_LIST validates', () => {
    expect(validatePartList(SAMPLE_LIST).ok).toBe(true);
  });
  describe('geometry gate and part cache', () => {
    it('geometryGate rejects a list whose shell fails the manifold check, naming the part', async () => {
      const { geometryGate } = await import('../src/model.js');
      const bad = {
        ...EXAMPLE_LIST,
        parts: [
          {
            id: 'x',
            type: 'extrude',
            height: 5,
            profile: [
              [0, 0],
              [10, 0],
              [10, 10],
              [10, 5],
              [0, 10],
            ],
            pos: [0, 0, 0],
            rot: [0, 0, 0],
            role: 'add',
          },
        ],
      };
      const r = geometryGate(bad);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toMatch(/^x: geometry failed manifold check/);
      expect(geometryGate(EXAMPLE_LIST).ok).toBe(true);
    });
    it('createPartCache returns the same item for an unchanged part and regenerates on change', async () => {
      const { createPartCache } = await import('../src/model.js');
      const cache = createPartCache();
      const a = cache.item(EXAMPLE_LIST.parts[0]);
      const b = cache.item({ ...EXAMPLE_LIST.parts[0] });
      expect(b).toBe(a);
      const c = cache.item({ ...EXAMPLE_LIST.parts[0], size: [1, 1, 1] });
      expect(c).not.toBe(a);
      expect(c.bbox.size).toEqual([1, 1, 1]);
      cache.clear();
      expect(cache.item(EXAMPLE_LIST.parts[0])).not.toBe(a);
    });
    it('parseScaleRefMm and unpackForgePreview decode Forge payloads accurately', async () => {
      const { parseScaleRefMm, unpackForgePreview } = await import('../src/model.js');
      expect(parseScaleRefMm('150 mm longest side', 120)).toBe(150);
      expect(parseScaleRefMm('no numbers here', 120)).toBe(120);
      expect(parseScaleRefMm('500 mm', 120)).toBe(218);

      const verts = new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]);
      const indices = new Uint16Array([0, 1, 2]);
      const vB64 = Buffer.from(verts.buffer).toString('base64');
      const iB64 = Buffer.from(indices.buffer).toString('base64');
      const tris = unpackForgePreview({
        format: 'indexed-f32-u16-v1',
        vertexCount: 3,
        triangleCount: 1,
        isFullMesh: true,
        vertsBase64: vB64,
        indicesBase64: iB64,
      });
      expect([...tris]).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    });
  });
});
