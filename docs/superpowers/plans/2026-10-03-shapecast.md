# ShapeCast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build ShapeCast, a Claude live artifact that turns photos, sketches or a prompt into an editable primitive-based 3D model and exports a Chitubox-ready STL (in a zip) sized for the Elegoo Saturn 3.

**Architecture:** Pure ES modules in `src/` (schema validation, geometry, print checks, STL, save lifecycle, prompts) are unit-tested in Node with vitest and inlined by `scripts/build.mjs` into a single `index.html` that the Artifact tool publishes. The page uses the artifact runtime's `sample` (Claude vision), `downloads`, `db`, `assets` and `user` capabilities, Three.js 0.160.0 UMD from cdnjs for the viewport, and JSZip 3.10.1 from cdnjs for the export container.

**Tech Stack:** JavaScript ES2022 modules with `checkJs`, vitest, eslint, prettier, Three.js 0.160.0 (UMD), JSZip 3.10.1, Claude artifact runtime contract 0.2.67.

**Spec:** `docs/superpowers/specs/2026-10-03-shapecast-design.md` (v6). Read it first; every rule below comes from it.

## Global Constraints

- Scripts load only from `https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js` and `https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js`; no other external host, no fetch to any host.
- The page is one `index.html` under 1 MB, no `<!DOCTYPE>`, `<html>`, `<head>` or `<body>` tags (the publish skeleton adds them); `<title>ShapeCast</title>` first, then `<style>`.
- Every colour is a token on `:root`, redefined for dark under `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) … }` and `:root[data-theme="dark"]`; `body` sets `background: var(--bg)`.
- Camera APIs are refused: photos come from `<input type="file" accept="image/*" capture="environment">` or drop. No `alert`, `confirm`, `prompt`, `<a download>`, `window.print`.
- `window.claude` exposes only `use(name)`; every capability may resolve `null` and is null-checked before use. Never retry a `sample` call from code.
- Units are mm, Z up. Saturn 3 build volume 218.88 x 122.88 x 250 mm, XY pixel 19 x 24 um, layer heights 10, 30, 50, 100 um.
- Validator limits: parts 1-200, lengths 0.1-300 mm, segments integer 3-256 (default 64), profiles 3-200 points within -300..300, assumptions 0-20 strings of 1-300 chars, triangle budget 1,000,000, part-list compact JSON at most 120 KiB (122,880 bytes). `role` must be `"add"`.
- Persistence paths: workspace document `data/users/<uid>/workspace`, projects subcollection under it, revisions subcollection under each project. Every prospective document is at most 200 KiB (204,800 bytes) before acceptance and before write. Metadata bounds: name 1-80, brief <= 4,000, scaleRef <= 300, photoAssetIds <= 8, request text truncated to 2,000.
- No em dashes anywhere (code, copy, commits). Commit messages are imperative conventional titles ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Repo loop before every commit: `npm run format && npm run typecheck && npm test && npm run lint`.

## Review Focus

1. A photo file over the `sample.limits().images.maxInputBytes` cap (a 30 MB Pixel HDR shot) must be refused before the call with "photo too large" rather than failing the whole build with `image_rejected`. Test added in Task 11 (`prepareImages`).
2. A Claude reply with a `pos` value such as `1e309` or `"12"` (string) must be rejected by the validator naming the part, not render NaN geometry. Test added in Task 2.
3. A lathe profile listed clockwise and an extrude profile listed clockwise must both produce positive-volume shells (the signed-volume flip must be exercised). Tests added in Tasks 3 and 4.
4. Editing a numeric field to an empty string or `-` mid-typing must not replace the good model; only a valid number is applied. Test added in Task 10 (`applyFieldEdit`).
5. Two parts whose bounding boxes touch exactly (gap 0.000) are neither interpenetrating nor a near miss under the spec's thresholds; the check must report them as a near miss of 0.00 mm, not silently green. Test added in Task 7.

---

### Task 0: Phase 0 probe artifact

**Files:**
- Create: `probe/probe.html`
- Create: `docs/acceptance/2026-10-xx-phase0.md` (filled by hand after Matthew opens the probe)

**Interfaces:**
- Produces: resolved answers to the spec's ASSUMPTION rows (camera via file input on the Pixel, `limits().images` present, both cdnjs scripts load, db refs build without TypeError).

- [ ] **Step 1: Write the probe page**

```html
<title>ShapeCast Probe</title>
<style>
:root{--bg:#f6f5f2;--fg:#1d1d1b;--ok:#2d7d46;--bad:#b3261e}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#1b1b19;--fg:#ece9e2;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#1b1b19;--fg:#ece9e2;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font:14px system-ui;padding-block:16px;padding-inline:16px}
li{margin-block:6px}.ok{color:var(--ok)}.bad{color:var(--bad)}
</style>
<h1>ShapeCast Phase 0 probe</h1>
<p>Open on the Pixel and the Surface. Screenshot the whole list.</p>
<ul id="out"></ul>
<label>Camera test <input id="cam" type="file" accept="image/*" capture="environment"></label>
<p id="camres"></p>
<button id="zip">Save a 1 KB zip</button> <span id="zipres"></span>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<script>
const out = document.getElementById('out');
const row = (label, ok, detail) => { const li = document.createElement('li'); li.className = ok ? 'ok' : 'bad'; li.textContent = `${label}: ${ok ? 'OK' : 'NO'} ${detail ?? ''}`; out.append(li); };
row('typeof THREE', typeof THREE === 'object', THREE?.REVISION);
row('typeof JSZip', typeof JSZip === 'function');
(async () => {
  const names = ['sample', 'downloads', 'db', 'assets', 'user'];
  const caps = {};
  for (const n of names) { caps[n] = await window.claude?.use(n); row(`use("${n}")`, caps[n] !== null && caps[n] !== undefined); }
  if (caps.sample) { const lim = await caps.sample.limits().catch(() => null); row('sample.limits().images', !!lim?.images, JSON.stringify(lim?.images)); row('sample.limits().tools', !!lim?.tools); }
  if (caps.user) { const id = await caps.user.id(); row('user.id()', !!id, id ? 'present' : 'null'); }
  if (caps.db && caps.user) {
    try { const uid = await caps.user.id(); const ws = caps.db.doc('data/users/' + uid + '/workspace'); const p = ws.collection('projects').doc('probe'); const r = p.collection('revisions').doc('r1'); row('db refs', true, `${ws.path} | ${p.path} | ${r.path}`); }
    catch (e) { row('db refs', false, String(e)); }
  }
  document.getElementById('zip').onclick = async () => {
    const z = new JSZip(); z.file('hello.txt', 'x'.repeat(1024));
    const blob = await z.generateAsync({ type: 'blob' });
    try { const r = await caps.downloads.save({ filename: 'probe.zip', data: blob }); document.getElementById('zipres').textContent = r.status; }
    catch (e) { document.getElementById('zipres').textContent = 'error ' + e.code; }
  };
})();
document.getElementById('cam').onchange = e => { const f = e.target.files[0]; document.getElementById('camres').textContent = f ? `got ${f.type} ${f.size} bytes` : 'no file'; };
</script>
```

- [ ] **Step 2: Publish it**

Use the Artifact tool: `file_path: probe/probe.html`, `icon: "wrench"`, `description: "Temporary capability probe for ShapeCast"`, `capabilities: {sample:{}, downloads:true, db:{rules:[{path:"",read:"view",write:"admin"},{path:"data/users/{self}",write:"interact"}]}, assets:{}, user:{}}`.

- [ ] **Step 3: Matthew opens it on the Pixel (Claude Android app) and on the Surface**

Record each row's OK/NO, whether the camera opened directly from the file input, the images limits JSON, and the zip save status in `docs/acceptance/2026-10-xx-phase0.md` with the screenshots. If `use("sample")` is null or `images` is absent on either device, stop and report; the build pipeline depends on it.

- [ ] **Step 4: Delete the probe artifact (Artifact tool, action delete, after Matthew confirms) and commit the acceptance note**

```bash
git -C ~/projects/products/shapecast add probe docs/acceptance && git -C ~/projects/products/shapecast commit -m "docs: record Phase 0 capability probe results

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 1: Repo scaffold, tooling, build script

**Files:**
- Create: `package.json`, `jsconfig.json`, `.prettierrc`, `eslint.config.js`, `.gitignore`, `vitest.config.js`
- Create: `scripts/build.mjs`
- Create: `src/page.html` (minimal shell, replaced in Task 10)
- Create: `src/app.js` (placeholder `init`, replaced in Task 10)
- Test: `tests/build.test.js`

**Interfaces:**
- Produces: `npm run build` writes `index.html` by inlining `src/*.js` in the order listed in `scripts/build.mjs` (`MODULES`) into the `<!-- @inline-modules -->` marker of `src/page.html`, stripping `import` lines and `export ` keywords. Later tasks add their module name to `MODULES`.

- [ ] **Step 1: Write package.json and configs**

```json
{
  "name": "shapecast",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc -p jsconfig.json --noEmit",
    "format": "prettier --write .",
    "build": "node scripts/build.mjs",
    "fixture": "node scripts/fixture.mjs"
  },
  "devDependencies": {
    "eslint": "^9.0.0",
    "@eslint/js": "^9.0.0",
    "globals": "^15.0.0",
    "jszip": "^3.10.1",
    "prettier": "^3.0.0",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

`jsconfig.json`:
```json
{
  "compilerOptions": { "checkJs": true, "allowJs": true, "noEmit": true, "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler", "lib": ["ES2022", "DOM"], "strict": false, "types": [] },
  "include": ["src/**/*.js", "scripts/**/*.mjs", "tests/**/*.js"]
}
```

`.prettierrc`: `{ "singleQuote": true, "printWidth": 100 }`

`eslint.config.js`:
```js
import js from '@eslint/js';
import globals from 'globals';
export default [
  js.configs.recommended,
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...globals.browser, ...globals.node, THREE: 'readonly', JSZip: 'readonly' } }, rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }] } },
  { ignores: ['index.html', 'node_modules/**', 'tests/fixtures/**'] },
];
```

`vitest.config.js`: `export default { test: { include: ['tests/**/*.test.js'] } };`

`.gitignore`: `node_modules/` and `tests/fixtures/*.zip` is NOT ignored (the fixture is a deliverable); add `index.html` only if you prefer building in CI; for this repo keep `index.html` committed.

- [ ] **Step 2: Write the failing build test**

`tests/build.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { buildPage } from '../scripts/build.mjs';

describe('buildPage', () => {
  it('inlines modules, strips import/export, keeps marker order', () => {
    const page = '<title>T</title>\n<!-- @inline-modules -->\n<p>x</p>';
    const modules = [
      { name: 'a.js', source: "import { b } from './b.js';\nexport function a() { return b(); }\n" },
      { name: 'b.js', source: 'export const b = () => 1;\n' },
    ];
    const out = buildPage(page, modules);
    expect(out).not.toMatch(/^import /m);
    expect(out).not.toMatch(/^export /m);
    expect(out).toContain('// --- a.js ---');
    expect(out.indexOf('// --- a.js ---')).toBeLessThan(out.indexOf('// --- b.js ---'));
    expect(out).toContain('<p>x</p>');
    expect(out).not.toContain('@inline-modules');
  });
  it('refuses external script hosts other than cdnjs', () => {
    expect(() => buildPage('<script src="https://esm.sh/x"></script><!-- @inline-modules -->', [])).toThrow(/cdnjs/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npm install && npx vitest run tests/build.test.js`
Expected: FAIL, cannot find `../scripts/build.mjs`.

- [ ] **Step 4: Write scripts/build.mjs**

```js
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MODULES = ['schema.js', 'geometry.js', 'printcheck.js', 'stl.js', 'lifecycle.js', 'prompts.js', 'exportbundle.js', 'app.js'];
const ALLOWED_HOST = 'https://cdnjs.cloudflare.com/';

export function stripModuleSyntax(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*import\s.*from\s+['"].*['"];?\s*$/.test(line))
    .map((line) => line.replace(/^export\s+(default\s+)?/, ''))
    .join('\n');
}

export function buildPage(page, modules) {
  for (const m of page.matchAll(/<script[^>]*src="([^"]+)"/g)) {
    if (!m[1].startsWith(ALLOWED_HOST)) throw new Error(`external script must come from cdnjs: ${m[1]}`);
  }
  const body = modules.map((m) => `// --- ${m.name} ---\n${stripModuleSyntax(m.source)}`).join('\n');
  if (!page.includes('<!-- @inline-modules -->')) throw new Error('page.html lacks <!-- @inline-modules --> marker');
  return page.replace('<!-- @inline-modules -->', `<script>\n'use strict';\n${body}\n</script>`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const page = readFileSync(join(root, 'src/page.html'), 'utf8');
  const modules = MODULES.filter((n) => { try { statSync(join(root, 'src', n)); return true; } catch { return false; } })
    .map((n) => ({ name: n, source: readFileSync(join(root, 'src', n), 'utf8') }));
  const out = buildPage(page, modules);
  writeFileSync(join(root, 'index.html'), out);
  const kb = Buffer.byteLength(out) / 1024;
  if (kb > 1024) throw new Error(`index.html is ${kb.toFixed(0)} KB, over the 1 MB limit`);
  console.log(`index.html written, ${kb.toFixed(1)} KB, ${modules.length} modules`);
}
```

`src/page.html` (minimal for now):
```html
<title>ShapeCast</title>
<style>:root{--bg:#f6f5f2;--fg:#1d1d1b}body{background:var(--bg);color:var(--fg)}</style>
<div id="app">ShapeCast scaffold</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<!-- @inline-modules -->
```

`src/app.js` (placeholder): `export function init() { document.getElementById('app').textContent = 'ShapeCast'; }\nif (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);`

- [ ] **Step 5: Run tests, build, loop**

Run: `npm run format && npm run typecheck && npm test && npm run lint && npm run build`
Expected: tests PASS, `index.html written`.

- [ ] **Step 6: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "chore: scaffold shapecast repo with inlining build

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Part list validator (`src/schema.js`)

**Files:**
- Create: `src/schema.js`
- Test: `tests/schema.test.js`

**Interfaces:**
- Produces: `LIMITS`, `PART_TYPES`, `segmentsOf(part)`, `triangleCount(part)`, `signedArea(pts)`, `compactBytes(value)`, `validatePartList(list) -> {ok:true, value, triangles, bytes} | {ok:false, errors:string[]}`, `EXAMPLE_LIST` (the spec's worked example, valid).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { validatePartList, triangleCount, EXAMPLE_LIST, LIMITS } from '../src/schema.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const withPart = (patch) => { const l = clone(EXAMPLE_LIST); Object.assign(l.parts[0], patch); return l; };
const lathe = (profile) => ({ ...clone(EXAMPLE_LIST), parts: [{ id: 'l', type: 'lathe', profile, pos: [0, 0, 0], rot: [0, 0, 0], role: 'add' }] });

describe('validatePartList', () => {
  it('accepts the worked example', () => {
    const r = validatePartList(EXAMPLE_LIST);
    expect(r.ok).toBe(true);
    expect(r.triangles).toBeGreaterThan(0);
  });
  it('rejects non-object input', () => { expect(validatePartList(null).ok).toBe(false); expect(validatePartList([]).ok).toBe(false); });
  it('rejects wrong units, missing parts, bad print block', () => {
    const r = validatePartList({ ...clone(EXAMPLE_LIST), units: 'in', parts: [], print: { orientation: 'up', suggestedLayerUm: 25 } });
    expect(r.errors.join('\n')).toMatch(/units/); expect(r.errors.join('\n')).toMatch(/parts/); expect(r.errors.join('\n')).toMatch(/orientation/); expect(r.errors.join('\n')).toMatch(/suggestedLayerUm/);
  });
  it('rejects duplicate and malformed ids, naming the part', () => {
    const l = clone(EXAMPLE_LIST); l.parts[1].id = l.parts[0].id;
    expect(validatePartList(l).errors[0]).toMatch(new RegExp(`^${l.parts[0].id}: id is not unique`));
    expect(validatePartList(withPart({ id: 'Bad Id' })).errors[0]).toMatch(/id must be/);
  });
  it('rejects role sub with the v2 message and unknown types', () => {
    expect(validatePartList(withPart({ role: 'sub' })).errors[0]).toMatch(/subtractive parts arrive in v2/);
    expect(validatePartList(withPart({ type: 'blob' })).errors[0]).toMatch(/unknown type/);
  });
  it('rejects non-finite, string, zero and negative dimensions by part id', () => {
    for (const bad of [[1e309, 0, 0], ['12', 0, 0], [0, 0]]) expect(validatePartList(withPart({ pos: bad })).errors[0]).toMatch(/^base: pos/);
    expect(validatePartList(withPart({ size: [0, 10, 10] })).errors[0]).toMatch(/^base: size/);
    expect(validatePartList(withPart({ size: [-1, 10, 10] })).errors[0]).toMatch(/^base: size/);
    expect(validatePartList(withPart({ size: [301, 10, 10] })).errors[0]).toMatch(/^base: size/);
  });
  it('rejects bad segments and torus tube >= radius', () => {
    expect(validatePartList(withPart({ segments: 2.5 })).errors[0]).toMatch(/segments/);
    const l = clone(EXAMPLE_LIST); l.parts[0] = { id: 't', type: 'torus', radius: 5, tube: 5, pos: [0, 0, 0], rot: [0, 0, 0], role: 'add' };
    expect(validatePartList(l).errors[0]).toMatch(/tube must be smaller/);
  });
  it('rejects profiles: too few points, repeated endpoint, duplicates, zero area, self-intersection', () => {
    const ext = (profile) => { const l = clone(EXAMPLE_LIST); l.parts[1].profile = profile; return validatePartList(l).errors[0]; };
    expect(ext([[0, 0], [1, 0]])).toMatch(/3 to 200 points/);
    expect(ext([[0, 0], [1, 0], [1, 1], [0, 0]])).toMatch(/first point must not repeat/);
    expect(ext([[0, 0], [0, 0], [1, 1]])).toMatch(/identical/);
    expect(ext([[0, 0], [1, 1], [2, 2]])).toMatch(/zero area/);
    expect(ext([[0, 0], [10, 10], [10, 0], [0, 10]])).toMatch(/intersect/);
  });
  it('rejects lathe profiles with negative r, no r>0, or an isolated axis touch', () => {
    expect(validatePartList(lathe([[-1, 0], [10, 0], [10, 5]])).errors[0]).toMatch(/r must be >= 0/);
    expect(validatePartList(lathe([[0, 0], [0, 5], [0, 10]])).errors[0]).toMatch(/zero area|r > 0/);
    expect(validatePartList(lathe([[0, 0], [10, -10], [20, 0], [10, 10]])).errors[0]).toMatch(/single point \(point 0\)/);
    expect(validatePartList(lathe([[0, 0], [10, 10], [20, 10]])).errors[0]).toMatch(/single point/);
  });
  it('accepts sphere-like, cylinder and cone lathe profiles', () => {
    for (const p of [[[0, -10], [10, 0], [0, 10]], [[0, 0], [10, 0], [10, 5], [0, 5]], [[0, 0], [10, 0], [0, 10]]]) expect(validatePartList(lathe(p)).ok).toBe(true);
  });
  it('enforces assumptions bounds', () => {
    expect(validatePartList({ ...clone(EXAMPLE_LIST), assumptions: ['x'.repeat(301)] }).errors[0]).toMatch(/assumptions/);
    expect(validatePartList({ ...clone(EXAMPLE_LIST), assumptions: Array(21).fill('a') }).errors[0]).toMatch(/assumptions/);
  });
  it('enforces the triangle budget and the byte budget', () => {
    const l = clone(EXAMPLE_LIST); l.parts = Array.from({ length: 200 }, (_, i) => ({ id: 's' + i, type: 'sphere', radius: 5, segments: 256, pos: [0, 0, 0], rot: [0, 0, 0], role: 'add' }));
    expect(validatePartList(l).errors[0]).toMatch(/triangles/);
    const big = clone(EXAMPLE_LIST); big.parts = Array.from({ length: 200 }, (_, i) => ({ id: 'e' + i, type: 'extrude', height: 1, profile: Array.from({ length: 200 }, (__, k) => [Math.cos(k / 200 * 6.283) * 10 + k * 1e-7, Math.sin(k / 200 * 6.283) * 10]), pos: [0, 0, 0], rot: [0, 0, 0], role: 'add' }));
    const r = validatePartList(big);
    expect(r.ok).toBe(false); expect(r.errors.join(' ')).toMatch(/bytes/);
  });
  it('counts triangles per type', () => {
    expect(triangleCount({ type: 'box' })).toBe(12);
    expect(triangleCount({ type: 'cylinder', radius: 1, segments: 8 })).toBe(32);
    expect(triangleCount({ type: 'cylinder', radius: 1, radiusTop: 0, segments: 8 })).toBe(16);
    expect(triangleCount({ type: 'sphere', segments: 8 })).toBe(2 * 8 * 3);
    expect(triangleCount({ type: 'extrude', profile: [[0, 0], [1, 0], [1, 1], [0, 1]] })).toBe(12);
    expect(LIMITS.listBytes).toBe(122880);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/schema.test.js`  Expected: FAIL, module not found.

- [ ] **Step 3: Write src/schema.js**

```js
export const LIMITS = {
  parts: [1, 200], nameChars: [1, 80], idChars: [1, 40], idPattern: /^[a-z0-9_-]+$/,
  lengthMm: [0.1, 300], posMm: [-1000, 1000], rotDeg: [-360, 360], segments: [3, 256], defaultSegments: 64,
  profilePoints: [3, 200], profileCoord: [-300, 300], assumptions: [0, 20], assumptionChars: [1, 300],
  triangleBudget: 1_000_000, listBytes: 120 * 1024, layerUm: [10, 30, 50, 100],
};
export const PART_TYPES = ['box', 'cylinder', 'cone', 'sphere', 'torus', 'extrude', 'lathe', 'wedge'];

export const EXAMPLE_LIST = {
  name: 'phone stand',
  units: 'mm',
  parts: [
    { id: 'base', type: 'box', size: [70, 60, 4], pos: [0, 0, 2], rot: [0, 0, 0], role: 'add' },
    { id: 'back', type: 'extrude', profile: [[0, 0], [40, 0], [40, 3], [0, 3]], height: 60, pos: [-20, -28, 2], rot: [90, 0, 0], role: 'add' },
  ],
  assumptions: ['overall height estimated at 60 mm, no scale reference given'],
  print: { orientation: 'flat', suggestedLayerUm: 50 },
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inRange = (v, [lo, hi]) => isNum(v) && v >= lo && v <= hi;
const tuple = (v, n, range) => Array.isArray(v) && v.length === n && v.every((x) => inRange(x, range));

export function segmentsOf(part) { return part.segments ?? LIMITS.defaultSegments; }

export function triangleCount(part) {
  const n = segmentsOf(part);
  switch (part.type) {
    case 'box': return 12;
    case 'wedge': return 8;
    case 'cylinder': return (part.radiusTop ?? part.radius) > 0 ? 4 * n : 2 * n;
    case 'cone': return 2 * n;
    case 'sphere': return 2 * n * (Math.max(3, Math.floor(n / 2)) - 1);
    case 'torus': return 2 * n * Math.max(8, Math.floor(n / 2));
    case 'extrude': return 2 * (part.profile.length - 2) + 2 * part.profile.length;
    case 'lathe': return 2 * n * part.profile.length;
    default: return 0;
  }
}

export function compactBytes(value) { return new TextEncoder().encode(JSON.stringify(value)).length; }

export function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

function segsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function validateProfile(profile, id, errors, lathe) {
  const err = (m) => { errors.push(`${id}.profile: ${m}`); };
  if (!Array.isArray(profile) || !inRange(profile.length, LIMITS.profilePoints)) return err('must have 3 to 200 points');
  for (const [i, p] of profile.entries()) if (!tuple(p, 2, LIMITS.profileCoord)) return err(`point ${i} must be [x, y] within -300..300`);
  const n = profile.length;
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  if (same(profile[0], profile[n - 1])) return err('first point must not repeat the last (polygon closes implicitly)');
  for (let i = 0; i < n - 1; i++) if (same(profile[i], profile[i + 1])) return err(`points ${i} and ${i + 1} are identical`);
  if (Math.abs(signedArea(profile)) < 1e-9) return err('polygon has zero area');
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (segsIntersect(profile[i], profile[(i + 1) % n], profile[j], profile[(j + 1) % n])) return err(`edges ${i} and ${j} intersect`);
  }
  if (lathe) {
    if (profile.some((p) => p[0] < 0)) return err('lathe profile r must be >= 0');
    if (!profile.some((p) => p[0] > 0)) return err('lathe profile needs a point with r > 0');
    for (let i = 0; i < n; i++) {
      if (profile[i][0] !== 0) continue;
      const a = profile[(i + n - 1) % n], b = profile[(i + 1) % n];
      if (a[0] > 0 && b[0] > 0) return err(`touches the axis at a single point (point ${i}); extend it along the axis`);
    }
  }
}

function validatePart(part, i, seen, errors) {
  const id = typeof part?.id === 'string' ? part.id : `parts[${i}]`;
  const err = (m) => { errors.push(`${id}: ${m}`); };
  if (typeof part !== 'object' || part === null) return err('must be an object');
  if (typeof part.id !== 'string' || !inRange(part.id.length, LIMITS.idChars) || !LIMITS.idPattern.test(part.id)) err('id must be 1-40 chars of a-z 0-9 _ -');
  else if (seen.has(part.id)) err('id is not unique');
  else seen.add(part.id);
  if (!PART_TYPES.includes(part.type)) return err(`unknown type "${part.type}"`);
  if (part.role !== 'add') return err(part.role === 'sub' ? 'subtractive parts arrive in v2' : 'role must be "add"');
  if (!tuple(part.pos, 3, LIMITS.posMm)) err('pos must be [x, y, z] finite numbers within -1000..1000');
  if (!tuple(part.rot, 3, LIMITS.rotDeg)) err('rot must be [x, y, z] degrees within -360..360');
  const len = (k) => { if (!inRange(part[k], LIMITS.lengthMm)) err(`${k} must be 0.1 to 300 mm`); };
  if (part.segments !== undefined && (!Number.isInteger(part.segments) || !inRange(part.segments, LIMITS.segments))) err('segments must be an integer 3 to 256');
  switch (part.type) {
    case 'box': case 'wedge': if (!tuple(part.size, 3, LIMITS.lengthMm)) err('size must be [x, y, z] each 0.1 to 300 mm'); break;
    case 'cylinder': len('radius'); len('height'); if (part.radiusTop !== undefined && part.radiusTop !== 0 && !inRange(part.radiusTop, LIMITS.lengthMm)) err('radiusTop must be 0 or 0.1 to 300 mm'); break;
    case 'cone': len('radius'); len('height'); break;
    case 'sphere': len('radius'); break;
    case 'torus': len('radius'); len('tube'); if (isNum(part.tube) && isNum(part.radius) && part.tube >= part.radius) err('tube must be smaller than radius'); break;
    case 'extrude': len('height'); validateProfile(part.profile, id, errors, false); break;
    case 'lathe': validateProfile(part.profile, id, errors, true); break;
  }
}

export function validatePartList(list) {
  const errors = [];
  if (typeof list !== 'object' || list === null || Array.isArray(list)) return { ok: false, errors: ['part list must be a JSON object'] };
  if (typeof list.name !== 'string' || !inRange(list.name.length, LIMITS.nameChars)) errors.push('name must be 1-80 characters');
  if (list.units !== 'mm') errors.push('units must be "mm"');
  if (!Array.isArray(list.parts) || !inRange(list.parts.length, LIMITS.parts)) errors.push('parts must have 1 to 200 entries');
  if (!Array.isArray(list.assumptions) || !inRange(list.assumptions.length, LIMITS.assumptions) || !list.assumptions.every((a) => typeof a === 'string' && inRange(a.length, LIMITS.assumptionChars))) errors.push('assumptions must be 0-20 strings of 1-300 characters');
  const print = list.print ?? {};
  if (!['flat', 'angled'].includes(print.orientation)) errors.push('print.orientation must be "flat" or "angled"');
  if (!LIMITS.layerUm.includes(print.suggestedLayerUm)) errors.push('print.suggestedLayerUm must be 10, 30, 50 or 100');
  if (errors.length) return { ok: false, errors };
  const seen = new Set();
  list.parts.forEach((p, i) => validatePart(p, i, seen, errors));
  if (errors.length) return { ok: false, errors };
  const triangles = list.parts.reduce((s, p) => s + triangleCount(p), 0);
  if (triangles > LIMITS.triangleBudget) errors.push(`model needs ${triangles} triangles; the limit is ${LIMITS.triangleBudget}`);
  const bytes = compactBytes(list);
  if (bytes > LIMITS.listBytes) errors.push(`part list is ${bytes} bytes; the limit is ${LIMITS.listBytes}`);
  return errors.length ? { ok: false, errors } : { ok: true, value: list, triangles, bytes };
}
```

- [ ] **Step 4: Run tests until green, then the loop**

Run: `npx vitest run tests/schema.test.js` then `npm run format && npm run typecheck && npm test && npm run lint`. Expected: PASS. If the byte-budget test's profile points are rejected as identical, nudge the `1e-7` jitter; the test only needs a valid list over 122,880 bytes.

- [ ] **Step 5: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add part list validator with budgets and lathe axis rule

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
