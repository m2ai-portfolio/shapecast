import JSZip from 'jszip';
import { writeFileSync, mkdirSync } from 'node:fs';
import { writeBinaryStl, listToTriangles } from '../src/stl.js';
import { validatePartList } from '../src/schema.js';
import { SAMPLE_LIST } from '../src/model.js';

const add = (id, type, extra) => ({
  id,
  type,
  pos: [0, 0, 0],
  rot: [0, 0, 0],
  role: 'add',
  ...extra,
});
const base = { units: 'mm', assumptions: [], print: { orientation: 'flat', suggestedLayerUm: 50 } };
const fixtures = {
  'overlapping-boxes': {
    ...base,
    name: 'overlapping boxes',
    parts: [
      add('a', 'box', { size: [20, 20, 10], pos: [0, 0, 5] }),
      add('b', 'box', { size: [20, 20, 10], pos: [10, 0, 14.5] }),
    ],
  },
  'cylinder-on-box': {
    ...base,
    name: 'cylinder on box',
    parts: [
      add('plate', 'box', { size: [40, 40, 4], pos: [0, 0, 2] }),
      add('post', 'cylinder', { radius: 6, height: 30, pos: [0, 0, 18.5] }),
    ],
  },
  'sample-model': SAMPLE_LIST,
};

const zip = new JSZip();
for (const [slug, list] of Object.entries(fixtures)) {
  const v = validatePartList(list);
  if (!v.ok) throw new Error(`${slug}: ${v.errors.join('; ')}`);
  zip.file(`${slug}.stl`, Buffer.from(writeBinaryStl(listToTriangles(list), list.name)));
  zip.file(`${slug}.json`, JSON.stringify(list, null, 2));
}
zip.file(
  'README.txt',
  'ShapeCast Chitubox acceptance fixture. Slice each STL at 50 um on the Saturn 3 profile and inspect the layers through every overlap region: they must be solid, with no cavity or island. Record the result in docs/acceptance/.\n',
);
mkdirSync('tests/fixtures', { recursive: true });
writeFileSync(
  'tests/fixtures/chitubox-acceptance.zip',
  await zip.generateAsync({ type: 'nodebuffer' }),
);
console.log('wrote tests/fixtures/chitubox-acceptance.zip');
