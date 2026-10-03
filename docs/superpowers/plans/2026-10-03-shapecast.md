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

---

### Task 3: Geometry core: transforms, box, wedge, extrude, mesh checks (`src/geometry.js`)

**Files:**
- Create: `src/geometry.js`
- Test: `tests/geometry.test.js`

**Interfaces:**
- Consumes: `segmentsOf`, `signedArea`, `triangleCount` from `src/schema.js`.
- Produces: `TriBuffer`, `rotationMatrix(rotDeg) -> number[9]`, `transformTriangles(d, pos, rot) -> Float64Array`, `triangulatePolygon(pts) -> number[][]`, `localTriangles(part) -> Float64Array` (9 numbers per triangle, local frame, outward winding), `partToTriangles(part) -> Float64Array` (world frame), `signedVolume(d)`, `flipWinding(d)`, `boundingBox(d) -> {min, max, size}`, `meshChecks(d) -> {ok, errors, volume}`. Triangle data is always a flat `Float64Array` of length `9 * n`: `[ax, ay, az, bx, by, bz, cx, cy, cz, ...]`.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { localTriangles, partToTriangles, meshChecks, signedVolume, boundingBox, triangulatePolygon, rotationMatrix } from '../src/geometry.js';

const part = (p) => ({ id: 'p', pos: [0, 0, 0], rot: [0, 0, 0], role: 'add', ...p });

describe('geometry core', () => {
  it('box: 12 triangles, volume 1000 for a 10 mm cube, manifold', () => {
    const d = localTriangles(part({ type: 'box', size: [10, 10, 10] }));
    expect(d.length / 9).toBe(12);
    expect(signedVolume(d)).toBeCloseTo(1000, 6);
    expect(meshChecks(d).ok).toBe(true);
    expect(boundingBox(d)).toEqual({ min: [-5, -5, -5], max: [5, 5, 5], size: [10, 10, 10] });
  });
  it('wedge: 8 triangles, half the box volume, full height at -X', () => {
    const d = localTriangles(part({ type: 'wedge', size: [10, 20, 6] }));
    expect(d.length / 9).toBe(8);
    expect(signedVolume(d)).toBeCloseTo(600, 6);
    expect(meshChecks(d).ok).toBe(true);
    const bb = boundingBox(d); expect(bb.size).toEqual([10, 20, 6]);
    // the top edge (z = +3) must lie on the -X face
    for (let i = 2; i < d.length; i += 3) if (d[i] > 2.99) expect(d[i - 2]).toBeCloseTo(-5, 9);
  });
  it('extrude: CCW and CW profiles both give positive volume and pass checks', () => {
    const ccw = localTriangles(part({ type: 'extrude', profile: [[0, 0], [40, 0], [40, 3], [0, 3]], height: 60 }));
    const cw = localTriangles(part({ type: 'extrude', profile: [[0, 3], [40, 3], [40, 0], [0, 0]], height: 60 }));
    for (const d of [ccw, cw]) { expect(signedVolume(d)).toBeCloseTo(40 * 3 * 60, 4); expect(meshChecks(d).ok).toBe(true); }
    expect(ccw.length / 9).toBe(12);
  });
  it('extrude: concave L profile is triangulated and manifold', () => {
    const d = localTriangles(part({ type: 'extrude', profile: [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]], height: 2 }));
    expect(meshChecks(d).ok).toBe(true);
    expect(signedVolume(d)).toBeCloseTo((100 - 36) * 2, 6);
  });
  it('triangulatePolygon returns n-2 triangles covering the area', () => {
    const pts = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
    const tris = triangulatePolygon(pts);
    expect(tris.length).toBe(4);
    const area = tris.reduce((s, [a, b, c]) => s + Math.abs((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])) / 2, 0);
    expect(area).toBeCloseTo(64, 9);
  });
  it('rotationMatrix follows XYZ order (rotate about X first)', () => {
    const m = rotationMatrix([90, 0, 0]);
    // (0,1,0) rotated 90 deg about X becomes (0,0,1)
    expect([m[1], m[4], m[7]].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    const m2 = rotationMatrix([90, 0, 90]);
    // (0,1,0) -> X 90 -> (0,0,1) -> Z 90 -> (0,0,1)
    expect([m2[1], m2[4], m2[7]].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
    // (1,0,0) -> X 90 -> (1,0,0) -> Z 90 -> (0,1,0)
    expect([m2[0], m2[3], m2[6]].map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 1, 0]);
  });
  it('partToTriangles places the local origin at pos and keeps winding under rotation', () => {
    const d = partToTriangles(part({ type: 'box', size: [10, 10, 10], pos: [100, 0, 5], rot: [0, 0, 45] }));
    const bb = boundingBox(d);
    expect(bb.min[2]).toBeCloseTo(0, 9); expect(bb.max[2]).toBeCloseTo(10, 9);
    expect((bb.min[0] + bb.max[0]) / 2).toBeCloseTo(100, 9);
    expect(bb.size[0]).toBeCloseTo(Math.SQRT2 * 10, 9);
    expect(signedVolume(d)).toBeCloseTo(1000, 6);
  });
  it('meshChecks catches an open shell, inverted winding and a pinched vertex', () => {
    const d = localTriangles(part({ type: 'box', size: [10, 10, 10] }));
    expect(meshChecks(d.subarray(0, d.length - 9)).errors.join(' ')).toMatch(/edge/);
    const inv = Float64Array.from(d); for (let i = 0; i < inv.length; i += 9) for (let k = 0; k < 3; k++) { const t = inv[i + 3 + k]; inv[i + 3 + k] = inv[i + 6 + k]; inv[i + 6 + k] = t; }
    expect(meshChecks(inv).errors.join(' ')).toMatch(/volume/);
    // two tetrahedra sharing one apex vertex: edge-manifold, positive volume, but pinched
    const tet = (o) => { const a = [o, 0, 0], b = [o + 2, 0, 0], c = [o + 1, 2, 0], t = [0, 0, 3]; return [[a, c, b], [a, b, t], [b, c, t], [c, a, t]]; };
    const flat = new Float64Array([...tet(0.5), ...tet(-2.5)].flat(2));
    const r = meshChecks(flat);
    expect(r.errors.join(' ')).toMatch(/pinched/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/geometry.test.js`  Expected: FAIL, module not found.

- [ ] **Step 3: Write src/geometry.js (core part; curved types arrive in Task 4)**

```js
import { segmentsOf, signedArea, triangleCount } from './schema.js';

export class TriBuffer {
  constructor(capacity) { this.a = new Float64Array(Math.max(1, capacity) * 9); this.n = 0; }
  push(p, q, r) {
    if ((this.n + 1) * 9 > this.a.length) { const g = new Float64Array(this.a.length * 2 + 9); g.set(this.a); this.a = g; }
    const o = this.n * 9, a = this.a;
    a[o] = p[0]; a[o + 1] = p[1]; a[o + 2] = p[2]; a[o + 3] = q[0]; a[o + 4] = q[1]; a[o + 5] = q[2]; a[o + 6] = r[0]; a[o + 7] = r[1]; a[o + 8] = r[2];
    this.n++;
  }
  data() { return this.a.subarray(0, this.n * 9); }
}

export function rotationMatrix([rx, ry, rz]) {
  const d = Math.PI / 180;
  const cx = Math.cos(rx * d), sx = Math.sin(rx * d), cy = Math.cos(ry * d), sy = Math.sin(ry * d), cz = Math.cos(rz * d), sz = Math.sin(rz * d);
  // R = Rz * Ry * Rx (Three.js Euler order "XYZ": rotate about X first)
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, -sy, cy * sx, cy * cx];
}

export function transformTriangles(d, pos, rot) {
  const m = rotationMatrix(rot), out = new Float64Array(d.length);
  for (let i = 0; i < d.length; i += 3) {
    const x = d[i], y = d[i + 1], z = d[i + 2];
    out[i] = m[0] * x + m[1] * y + m[2] * z + pos[0];
    out[i + 1] = m[3] * x + m[4] * y + m[5] * z + pos[1];
    out[i + 2] = m[6] * x + m[7] * y + m[8] * z + pos[2];
  }
  return out;
}

export function signedVolume(d) {
  let v = 0;
  for (let i = 0; i < d.length; i += 9) {
    const ax = d[i], ay = d[i + 1], az = d[i + 2], bx = d[i + 3], by = d[i + 4], bz = d[i + 5], cx = d[i + 6], cy = d[i + 7], cz = d[i + 8];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

export function flipWinding(d) {
  for (let i = 0; i < d.length; i += 9) for (let k = 0; k < 3; k++) { const t = d[i + 3 + k]; d[i + 3 + k] = d[i + 6 + k]; d[i + 6 + k] = t; }
  return d;
}

export function boundingBox(d) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < d.length; i += 3) for (let k = 0; k < 3; k++) { if (d[i + k] < min[k]) min[k] = d[i + k]; if (d[i + k] > max[k]) max[k] = d[i + k]; }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export function triangulatePolygon(pts) {
  const n = pts.length;
  let idx = Array.from({ length: n }, (_, i) => i);
  if (signedArea(pts) < 0) idx.reverse();
  const area = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => area(a, b, p) >= 0 && area(b, c, p) >= 0 && area(c, a, p) >= 0;
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = pts[ia], b = pts[ib], c = pts[ic];
      if (area(a, b, c) <= 1e-12) continue;
      let ear = true;
      for (const j of idx) { if (j === ia || j === ib || j === ic) continue; if (inside(pts[j], a, b, c)) { ear = false; break; } }
      if (!ear) continue;
      out.push([ia, ib, ic]); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) throw new Error('triangulation failed: polygon is not simple');
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

function box(b, [sx, sy, sz]) {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  const v = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
  for (const [p, q, r, s] of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) { b.push(v[p], v[q], v[r]); b.push(v[p], v[r], v[s]); }
}

function extrude(b, profile, h) {
  const tris = triangulatePolygon(profile);
  const n = profile.length;
  const order = signedArea(profile) > 0 ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: n }, (_, i) => n - 1 - i);
  const at = (i, z) => [profile[i][0], profile[i][1], z];
  for (const [p, q, r] of tris) { b.push(at(p, h), at(q, h), at(r, h)); b.push(at(r, 0), at(q, 0), at(p, 0)); }
  for (let k = 0; k < n; k++) { const i = order[k], j = order[(k + 1) % n]; b.push(at(i, 0), at(j, 0), at(j, h)); b.push(at(i, 0), at(j, h), at(i, h)); }
}

function wedge(b, [sx, sy, sz]) {
  const t = new TriBuffer(8);
  extrude(t, [[-sx / 2, -sz / 2], [sx / 2, -sz / 2], [-sx / 2, sz / 2]], sy); // profile in (x, z), extruded along y
  const d = t.data();
  const v = (i, k) => [d[i + k], d[i + k + 2] - sy / 2, d[i + k + 1]]; // (x, y, z) -> (x, z - sy/2, y) is a reflection
  for (let i = 0; i < d.length; i += 9) b.push(v(i, 0), v(i, 6), v(i, 3)); // so swap two corners to restore winding
}

// Curved generators (cylinder, sphere, torus, lathe) are added in Task 4.
const GENERATORS = { box: (b, p) => box(b, p.size), wedge: (b, p) => wedge(b, p.size), extrude: (b, p) => extrude(b, p.profile, p.height) };

export function localTriangles(part) {
  const gen = GENERATORS[part.type];
  if (!gen) throw new Error(`no generator for type ${part.type}`);
  const b = new TriBuffer(triangleCount(part));
  gen(b, part, segmentsOf(part));
  const d = b.data();
  if (signedVolume(d) < 0) flipWinding(d);
  return d;
}

export function partToTriangles(part) { return transformTriangles(localTriangles(part), part.pos, part.rot); }

export function meshChecks(d) {
  const errors = [];
  const key = (i) => `${d[i].toFixed(6)},${d[i + 1].toFixed(6)},${d[i + 2].toFixed(6)}`;
  const directed = new Map(), star = new Map();
  let zero = 0;
  for (let i = 0; i < d.length; i += 9) {
    const ux = d[i + 3] - d[i], uy = d[i + 4] - d[i + 1], uz = d[i + 5] - d[i + 2], vx = d[i + 6] - d[i], vy = d[i + 7] - d[i + 1], vz = d[i + 8] - d[i + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) { zero++; continue; }
    const k = [key(i), key(i + 3), key(i + 6)];
    for (let e = 0; e < 3; e++) {
      const a = k[e], b = k[(e + 1) % 3], c = k[(e + 2) % 3];
      const dk = a + '|' + b; directed.set(dk, (directed.get(dk) || 0) + 1);
      if (!star.has(c)) star.set(c, new Map());
      star.get(c).set(a, b); // opposite edge a -> b as seen from vertex c
    }
  }
  if (zero) errors.push(`${zero} zero-area triangle(s)`);
  let bad = 0;
  for (const [dk, count] of directed) { const [a, b] = dk.split('|'); if (count !== 1 || directed.get(b + '|' + a) !== 1) bad++; }
  if (bad) errors.push(`${bad} edge(s) not shared by exactly two opposite triangles`);
  let pinched = 0;
  for (const next of star.values()) {
    const start = next.keys().next().value; let cur = start, steps = 0;
    do { cur = next.get(cur); steps++; } while (cur !== undefined && cur !== start && steps <= next.size);
    if (cur !== start || steps !== next.size) pinched++;
  }
  if (pinched) errors.push(`${pinched} vertex(es) with a split fan (pinched)`);
  const volume = signedVolume(d);
  if (!(volume > 0)) errors.push(`signed volume ${volume.toFixed(3)} is not positive`);
  return { ok: errors.length === 0, errors, volume };
}
```

- [ ] **Step 4: Run tests until green, then the loop**

Run: `npx vitest run tests/geometry.test.js` then `npm run format && npm run typecheck && npm test && npm run lint`. Expected: PASS. If the pinched-vertex fixture is not flagged, check that `tet()` triangles are outward (each tetrahedron's `signedVolume` positive) and that both apexes share the exact coordinates `[0,0,3]`.

- [ ] **Step 5: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add geometry core with transforms, box, wedge, extrude and manifold checks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Curved primitives and analytic volumes (`src/geometry.js`)

**Files:**
- Modify: `src/geometry.js` (add `cylinder`, `sphere`, `torus`, `lathe`, `partVolume`, extend `GENERATORS`)
- Test: `tests/geometry-curved.test.js`

**Interfaces:**
- Produces: `partVolume(part) -> mm3` (analytic), `localTriangles` now handles all eight types.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { localTriangles, meshChecks, signedVolume, partVolume, boundingBox } from '../src/geometry.js';
import { triangleCount } from '../src/schema.js';

const part = (p) => ({ id: 'p', pos: [0, 0, 0], rot: [0, 0, 0], role: 'add', ...p });
const cases = [
  part({ type: 'cylinder', radius: 10, height: 20, segments: 64 }),
  part({ type: 'cylinder', radius: 10, radiusTop: 4, height: 20, segments: 64 }),
  part({ type: 'cylinder', radius: 10, radiusTop: 0, height: 20, segments: 64 }),
  part({ type: 'cone', radius: 10, height: 20, segments: 32 }),
  part({ type: 'sphere', radius: 10, segments: 64 }),
  part({ type: 'torus', radius: 20, tube: 4, segments: 64 }),
  part({ type: 'lathe', profile: [[0, -10], [10, 0], [0, 10]], segments: 64 }),
  part({ type: 'lathe', profile: [[0, 0], [10, 0], [10, 5], [0, 5]], segments: 64 }),
  part({ type: 'lathe', profile: [[0, 5], [10, 5], [10, 0], [0, 0]], segments: 64 }), // clockwise
  part({ type: 'lathe', profile: [[0, 0], [10, 0], [0, 10]], segments: 32 }),
  part({ type: 'lathe', profile: [[0, 0], [12, 0], [12, 2], [4, 2], [4, 20], [0, 20]], segments: 48 }), // cup with notch
  part({ type: 'cylinder', radius: 10, height: 0.5, segments: 64 }), // thin disk
];

describe('curved primitives', () => {
  for (const p of cases) {
    it(`${p.type} ${JSON.stringify(p.profile ?? p.radiusTop ?? '')} is manifold, outward, and matches triangleCount`, () => {
      const d = localTriangles(p);
      const r = meshChecks(d);
      expect(r.errors).toEqual([]);
      expect(d.length / 9).toBeLessThanOrEqual(triangleCount(p));
      // tessellated volume within 1% of analytic for 64 segments, 3% for fewer
      const tol = (p.segments ?? 64) >= 64 ? 0.01 : 0.03;
      expect(Math.abs(signedVolume(d) - partVolume(p)) / partVolume(p)).toBeLessThan(tol);
    });
  }
  it('analytic volumes', () => {
    expect(partVolume(part({ type: 'cylinder', radius: 10, height: 20 }))).toBeCloseTo(Math.PI * 100 * 20, 6);
    expect(partVolume(part({ type: 'cone', radius: 10, height: 20 }))).toBeCloseTo(Math.PI * 100 * 20 / 3, 6);
    expect(partVolume(part({ type: 'sphere', radius: 10 }))).toBeCloseTo(4 / 3 * Math.PI * 1000, 6);
    expect(partVolume(part({ type: 'torus', radius: 20, tube: 4 }))).toBeCloseTo(2 * Math.PI ** 2 * 20 * 16, 6);
    expect(partVolume(part({ type: 'lathe', profile: [[0, 0], [10, 0], [10, 5], [0, 5]] }))).toBeCloseTo(Math.PI * 100 * 5, 6);
    expect(partVolume(part({ type: 'extrude', profile: [[0, 0], [4, 0], [4, 3]], height: 2 }))).toBeCloseTo(12, 9);
    expect(partVolume(part({ type: 'wedge', size: [2, 3, 4] }))).toBe(12);
  });
  it('sphere bounding box is 2r and cylinder is centred on its axis', () => {
    expect(boundingBox(localTriangles(part({ type: 'sphere', radius: 7 }))).size.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([14, 14, 14]);
    const bb = boundingBox(localTriangles(part({ type: 'cylinder', radius: 5, height: 9 })));
    expect(bb.min[2]).toBeCloseTo(-4.5, 9); expect(bb.max[2]).toBeCloseTo(4.5, 9);
  });
  it('forced hourglass lathe fails the vertex-link check', () => {
    const d = localTriangles(part({ type: 'lathe', profile: [[0, 0], [10, -10], [20, 0], [10, 10]], segments: 16 }));
    expect(meshChecks(d).errors.join(' ')).toMatch(/pinched/);
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/geometry-curved.test.js`  Expected: FAIL, `no generator for type cylinder`.

- [ ] **Step 3: Add the generators and volumes to src/geometry.js**

Insert above `const GENERATORS`:

```js
function circle(n) { const c = []; for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; c.push([Math.cos(a), Math.sin(a)]); } return c; }

function cylinder(b, rb, rt, h, n) {
  const c = circle(n), z0 = -h / 2, z1 = h / 2;
  const B = c.map(([x, y]) => [rb * x, rb * y, z0]), bot = [0, 0, z0], top = [0, 0, z1];
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.push(bot, B[j], B[i]); }
  if (rt > 0) {
    const T = c.map(([x, y]) => [rt * x, rt * y, z1]);
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.push(B[i], B[j], T[j]); b.push(B[i], T[j], T[i]); b.push(top, T[i], T[j]); }
  } else for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.push(B[i], B[j], top); }
}

function sphere(b, r, n) {
  const stacks = Math.max(3, Math.floor(n / 2));
  const ring = (s) => { const phi = (Math.PI * s) / stacks, rr = r * Math.sin(phi), z = r * Math.cos(phi); return circle(n).map(([x, y]) => [rr * x, rr * y, z]); };
  const N = [0, 0, r], S = [0, 0, -r];
  let prev = ring(1);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.push(N, prev[i], prev[j]); }
  for (let s = 2; s < stacks; s++) { const cur = ring(s); for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.push(prev[i], cur[i], cur[j]); b.push(prev[i], cur[j], prev[j]); } prev = cur; }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; b.push(S, prev[j], prev[i]); }
}

function torus(b, R, r, n) {
  const m = Math.max(8, Math.floor(n / 2));
  const P = (i, j) => { const u = (2 * Math.PI * i) / n, v = (2 * Math.PI * j) / m, w = R + r * Math.cos(v); return [w * Math.cos(u), w * Math.sin(u), r * Math.sin(v)]; };
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) { const a = P(i, j), q = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1); b.push(a, q, c); b.push(a, c, d); }
}

function lathe(b, profile, n) {
  const c = circle(n), m = profile.length;
  for (let i = 0; i < m; i++) {
    const [r0, z0] = profile[i], [r1, z1] = profile[(i + 1) % m];
    if (r0 === 0 && r1 === 0) continue;
    for (let j = 0; j < n; j++) {
      const k = (j + 1) % n;
      const A = [r0 * c[j][0], r0 * c[j][1], z0], B = [r0 * c[k][0], r0 * c[k][1], z0], C = [r1 * c[k][0], r1 * c[k][1], z1], D = [r1 * c[j][0], r1 * c[j][1], z1];
      if (r0 > 0) b.push(A, B, C);
      if (r1 > 0) b.push(A, C, D);
    }
  }
}

export function partVolume(p) {
  switch (p.type) {
    case 'box': return p.size[0] * p.size[1] * p.size[2];
    case 'wedge': return (p.size[0] * p.size[1] * p.size[2]) / 2;
    case 'cylinder': { const rt = p.radiusTop ?? p.radius; return (Math.PI * p.height * (p.radius ** 2 + p.radius * rt + rt ** 2)) / 3; }
    case 'cone': return (Math.PI * p.radius ** 2 * p.height) / 3;
    case 'sphere': return (4 / 3) * Math.PI * p.radius ** 3;
    case 'torus': return 2 * Math.PI ** 2 * p.radius * p.tube ** 2;
    case 'extrude': return Math.abs(signedArea(p.profile)) * p.height;
    case 'lathe': { let s = 0; const m = p.profile.length; for (let i = 0; i < m; i++) { const [r0, z0] = p.profile[i], [r1, z1] = p.profile[(i + 1) % m]; s += (r0 * z1 - r1 * z0) * (r0 + r1); } return (Math.abs(s) * Math.PI) / 3; }
    default: return 0;
  }
}
```

Replace `GENERATORS` with:
```js
const GENERATORS = {
  box: (b, p) => box(b, p.size),
  wedge: (b, p) => wedge(b, p.size),
  extrude: (b, p) => extrude(b, p.profile, p.height),
  cylinder: (b, p, n) => cylinder(b, p.radius, p.radiusTop ?? p.radius, p.height, n),
  cone: (b, p, n) => cylinder(b, p.radius, 0, p.height, n),
  sphere: (b, p, n) => sphere(b, p.radius, n),
  torus: (b, p, n) => torus(b, p.radius, p.tube, n),
  lathe: (b, p, n) => lathe(b, p.profile, n),
};
```

- [ ] **Step 4: Run tests until green, then the loop**

Run: `npx vitest run tests/geometry-curved.test.js` then the full loop. Expected: PASS. If the lathe cup fails the edge check, confirm the `toFixed(6)` key welds `r*cos(2*pi)` to `r*cos(0)` (it does because `circle` reuses index `k = (j+1) % n`).

- [ ] **Step 5: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add cylinder, cone, sphere, torus and lathe generators with analytic volumes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Binary STL writer and Chitubox fixture (`src/stl.js`, `scripts/fixture.mjs`)

**Files:**
- Create: `src/stl.js`, `scripts/fixture.mjs`
- Test: `tests/stl.test.js`
- Output: `tests/fixtures/chitubox-acceptance.zip` (committed)

**Interfaces:**
- Produces: `writeBinaryStl(d, name) -> ArrayBuffer`, `readStlHeader(buf) -> {header, triangles}`, `concatTriangles(list: Float64Array[]) -> Float64Array`, `listToTriangles(partList) -> Float64Array` (world triangles of every part concatenated).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { writeBinaryStl, readStlHeader, concatTriangles, listToTriangles } from '../src/stl.js';
import { EXAMPLE_LIST } from '../src/schema.js';
import { partToTriangles } from '../src/geometry.js';

describe('stl', () => {
  it('writes 84 + 50 * n bytes with the header and count parsing back', () => {
    const d = listToTriangles(EXAMPLE_LIST);
    const n = d.length / 9;
    const buf = writeBinaryStl(d, EXAMPLE_LIST.name);
    expect(buf.byteLength).toBe(84 + 50 * n);
    const h = readStlHeader(buf);
    expect(h.triangles).toBe(n);
    expect(h.header).toBe('ShapeCast phone stand');
    const dv = new DataView(buf);
    expect(dv.getFloat32(84 + 12, true)).toBeCloseTo(d[0], 5); // first vertex x after the normal
    expect(dv.getUint16(84 + 48, true)).toBe(0);
  });
  it('writes unit normals', () => {
    const buf = writeBinaryStl(partToTriangles({ type: 'box', size: [2, 2, 2], pos: [0, 0, 0], rot: [0, 0, 0] }));
    const dv = new DataView(buf);
    const l = Math.hypot(dv.getFloat32(84, true), dv.getFloat32(88, true), dv.getFloat32(92, true));
    expect(l).toBeCloseTo(1, 5);
  });
  it('concatTriangles preserves order and length', () => {
    const a = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), b = new Float64Array([9, 8, 7, 6, 5, 4, 3, 2, 1]);
    const c = concatTriangles([a, b]);
    expect(c.length).toBe(18); expect(c[9]).toBe(9); expect(c[17]).toBe(1);
  });
});
```

- [ ] **Step 2: Run to see it fail**  `npx vitest run tests/stl.test.js`  Expected: FAIL, module not found.

- [ ] **Step 3: Write src/stl.js**

```js
import { partToTriangles } from './geometry.js';

export function concatTriangles(list) {
  let n = 0; for (const d of list) n += d.length;
  const out = new Float64Array(n); let o = 0;
  for (const d of list) { out.set(d, o); o += d.length; }
  return out;
}

export function listToTriangles(partList) { return concatTriangles(partList.parts.map(partToTriangles)); }

export function writeBinaryStl(d, name = 'model') {
  const n = d.length / 9, buf = new ArrayBuffer(84 + 50 * n), dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(new TextEncoder().encode(`ShapeCast ${name}`).slice(0, 80));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let i = 0; i < d.length; i += 9) {
    const ux = d[i + 3] - d[i], uy = d[i + 4] - d[i + 1], uz = d[i + 5] - d[i + 2], vx = d[i + 6] - d[i], vy = d[i + 7] - d[i + 1], vz = d[i + 8] - d[i + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
    for (let k = 0; k < 9; k++) { dv.setFloat32(o, d[i + k], true); o += 4; }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}

export function readStlHeader(buf) {
  const dv = new DataView(buf);
  return { header: new TextDecoder().decode(new Uint8Array(buf, 0, 80)).replace(/\0+$/, ''), triangles: dv.getUint32(80, true) };
}
```

- [ ] **Step 4: Write scripts/fixture.mjs**

```js
import JSZip from 'jszip';
import { writeFileSync, mkdirSync } from 'node:fs';
import { writeBinaryStl, listToTriangles } from '../src/stl.js';
import { validatePartList } from '../src/schema.js';

const add = (id, type, extra) => ({ id, type, pos: [0, 0, 0], rot: [0, 0, 0], role: 'add', ...extra });
const fixtures = {
  'overlapping-boxes': { name: 'overlapping boxes', units: 'mm', assumptions: [], print: { orientation: 'flat', suggestedLayerUm: 50 }, parts: [
    add('a', 'box', { size: [20, 20, 10], pos: [0, 0, 5] }), add('b', 'box', { size: [20, 20, 10], pos: [10, 0, 14.5] }) ] },
  'cylinder-on-box': { name: 'cylinder on box', units: 'mm', assumptions: [], print: { orientation: 'flat', suggestedLayerUm: 50 }, parts: [
    add('plate', 'box', { size: [40, 40, 4], pos: [0, 0, 2] }), add('post', 'cylinder', { radius: 6, height: 30, pos: [0, 0, 18.5] }) ] },
  'catapult-arm': { name: 'catapult arm', units: 'mm', assumptions: [], print: { orientation: 'flat', suggestedLayerUm: 50 }, parts: [
    add('arm', 'box', { size: [120, 8, 6], pos: [0, 0, 3] }), add('cup', 'lathe', { profile: [[0, 0], [12, 0], [12, 2], [10, 2], [10, 9], [0, 9]], pos: [52, 0, 5.5] }),
    add('pivot', 'cylinder', { radius: 5, height: 14, rot: [90, 0, 0], pos: [-20, 0, 5] }), add('weight', 'box', { size: [18, 18, 18], pos: [-56, 0, 8.5] }) ] },
};

const zip = new JSZip();
for (const [slug, list] of Object.entries(fixtures)) {
  const v = validatePartList(list); if (!v.ok) throw new Error(`${slug}: ${v.errors.join('; ')}`);
  zip.file(`${slug}.stl`, Buffer.from(writeBinaryStl(listToTriangles(list), list.name)));
  zip.file(`${slug}.json`, JSON.stringify(list, null, 2));
}
zip.file('README.txt', 'ShapeCast Chitubox acceptance fixture. Slice each STL at 50 um on the Saturn 3 profile and inspect the layers through every overlap region: they must be solid, with no cavity or island. Record the result in docs/acceptance/.\n');
mkdirSync('tests/fixtures', { recursive: true });
writeFileSync('tests/fixtures/chitubox-acceptance.zip', await zip.generateAsync({ type: 'nodebuffer' }));
console.log('wrote tests/fixtures/chitubox-acceptance.zip');
```

- [ ] **Step 5: Run tests, generate the fixture, loop**

Run: `npx vitest run tests/stl.test.js && npm run fixture && unzip -l tests/fixtures/chitubox-acceptance.zip` then the full loop. Expected: PASS and seven entries listed.

- [ ] **Step 6: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add binary STL writer and Chitubox acceptance fixture

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Chitubox acceptance gate (manual, blocks everything after it)

**Files:**
- Create: `docs/acceptance/2026-10-xx-chitubox.md`

- [ ] **Step 1: Copy the fixture to AlienPC**

```bash
scp ~/projects/products/shapecast/tests/fixtures/chitubox-acceptance.zip gaming-pc:C:/Users/m2ai/Downloads/
```

- [ ] **Step 2: Matthew slices in Chitubox**

For each of the three STLs: open, Saturn 3 profile, 50 um layer height, no hollowing, slice. Use the layer preview slider and look at the layers through each overlap region (box/box overlap at z 9.5 to 10, cylinder base inside the plate at z 3.5 to 4, cup and pivot joins on the arm). Pass means every layer there is solid fill with no internal gap or stray island.

- [ ] **Step 3: Record**

Write pass or fail per fixture, Chitubox version, and screenshots of one overlap layer each into `docs/acceptance/2026-10-xx-chitubox.md`. Commit. **If any fixture fails, stop the plan here and report**; the export strategy (additive multi-shell STL) has to change before the UI is built.

```bash
git -C ~/projects/products/shapecast add docs/acceptance && git -C ~/projects/products/shapecast commit -m "docs: record Chitubox multi-shell acceptance result

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Print checks (`src/printcheck.js`)

**Files:**
- Create: `src/printcheck.js`
- Test: `tests/printcheck.test.js`

**Interfaces:**
- Consumes: `boundingBox`, `partVolume`, `partToTriangles` from `src/geometry.js`.
- Produces: `SATURN3`, `polygonThickness(pts)`, `minFeature(part)`, `contactGraph(items)`, `buildItems(partList) -> [{part, tris, bbox}]`, `runPrintChecks(items, {layerUm, orientation}) -> {checks:[{id, level:'red'|'amber'|'green'|'info', message}], bbox, volumeMm3, layers:{10,30,50,100}, worst}`.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { runPrintChecks, buildItems, polygonThickness, minFeature } from '../src/printcheck.js';

const list = (parts) => ({ name: 'f', units: 'mm', assumptions: [], print: { orientation: 'flat', suggestedLayerUm: 50 }, parts });
const box = (id, size, pos, rot = [0, 0, 0]) => ({ id, type: 'box', size, pos, rot, role: 'add' });
const run = (parts, opts) => runPrintChecks(buildItems(list(parts)), { layerUm: 50, orientation: 'flat', ...opts });
const find = (r, prefix) => r.checks.filter((c) => c.id.startsWith(prefix));
const msgs = (r) => r.checks.map((c) => `${c.level} ${c.message}`).join('\n');

describe('print checks', () => {
  it('fits, fits only rotated, too large', () => {
    expect(find(run([box('a', [100, 100, 10], [0, 0, 5])]), 'fit')[0].level).toBe('green');
    const rot = find(run([box('a', [120, 200, 10], [0, 0, 5])]), 'fit')[0];
    expect(rot.level).toBe('amber'); expect(rot.message).toMatch(/rotated 90/);
    expect(find(run([box('a', [230, 10, 10], [0, 0, 5])]), 'fit')[0].level).toBe('red');
  });
  it('minimum feature: 0.5 mm disk red, 1.0 mm wall amber, per-type rules', () => {
    const disk = { id: 'd', type: 'cylinder', radius: 10, height: 0.5, pos: [0, 0, 0.25], rot: [0, 0, 0], role: 'add' };
    expect(find(run([disk]), 'feature:d')[0].level).toBe('red');
    const wall = { id: 'w', type: 'extrude', profile: [[0, 0], [40, 0], [40, 1], [0, 1]], height: 20, pos: [0, 0, 0], rot: [0, 0, 0], role: 'add' };
    expect(find(run([wall]), 'feature:w')[0].level).toBe('amber');
    expect(polygonThickness([[0, 0], [40, 0], [40, 1], [0, 1]])).toBeCloseTo(1, 9);
    expect(polygonThickness([[0, 0], [10, 0], [10, 10], [0, 10]])).toBeCloseTo(10, 9);
    expect(minFeature({ type: 'cylinder', radius: 5, radiusTop: 0.3, height: 20 })).toBeCloseTo(0.6, 9);
    expect(minFeature({ type: 'torus', radius: 10, tube: 0.4 })).toBeCloseTo(0.8, 9);
    expect(minFeature({ type: 'lathe', profile: [[0, 0], [10, 0], [10, 0.5], [0, 0.5]] })).toBeCloseTo(0.5, 9);
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
    const r1 = run([box('a', [10, 10, 2], [0, 0, 1]), box('b', [10, 10, 2], [0, 0, 2.5], [0, 0, 45])]);
    expect(msgs(r1)).toMatch(/amber Contact not confirmed: b/);
    const r2 = run([{ id: 'w', type: 'wedge', size: [10, 10, 10], pos: [0, 0, 5], rot: [0, 0, 0], role: 'add' }, box('b', [1, 1, 1], [4, 0, 8])]);
    expect(msgs(r2)).toMatch(/amber Contact not confirmed: b/); expect(find(r2, 'support')[0]?.level).not.toBe('green');
    const r3 = run([{ id: 'c', type: 'cylinder', radius: 5, height: 10, pos: [0, 0, 5], rot: [0, 0, 0], role: 'add' }, { id: 's', type: 'sphere', radius: 5, pos: [9.8, 0, 9], rot: [0, 0, 0], role: 'add' }]);
    expect(msgs(r3)).toMatch(/amber Contact not confirmed: s/);
  });
  it('overhang: a cap wider than its stem needs supports, a stacked box does not', () => {
    const r = run([{ id: 'stem', type: 'cylinder', radius: 3, height: 10, pos: [0, 0, 5], rot: [0, 0, 0], role: 'add' }, box('cap', [20, 20, 2], [0, 0, 10.9])]);
    expect(msgs(r)).toMatch(/amber cap: .*needs supports/);
    const r2 = run([box('a', [10, 10, 10], [0, 0, 5]), box('b', [10, 10, 10], [0, 0, 14.9])]);
    expect(find(r2, 'overhang:').length).toBe(0);
  });
  it('volume is labelled an upper bound, layers computed per height', () => {
    const r = run([box('a', [10, 10, 10], [0, 0, 5])], { layerUm: 50 });
    expect(r.volumeMm3).toBeCloseTo(1000, 6);
    expect(msgs(r)).toMatch(/upper bound/);
    expect(r.layers[50]).toBe(200); expect(r.layers[10]).toBe(1000);
    expect(msgs(r)).toMatch(/19 x 24 um/);
    expect(r.worst).toBe('green');
  });
  it('empty list returns a single info check', () => {
    const r = runPrintChecks([], { layerUm: 50, orientation: 'flat' });
    expect(r.checks.length).toBe(1); expect(r.worst).toBe('info');
  });
});
```

- [ ] **Step 2: Run to see it fail**  `npx vitest run tests/printcheck.test.js`

- [ ] **Step 3: Write src/printcheck.js**

```js
import { boundingBox, partVolume, partToTriangles } from './geometry.js';

export const SATURN3 = { name: 'Elegoo Saturn 3 (12K)', build: [218.88, 122.88, 250], pixelUm: [19, 24], layerUm: [10, 30, 50, 100] };
const EPS = 0.01, NEAR = 0.5;
const f = (v) => v.toFixed(2);

function pointSegDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function polygonThickness(pts) {
  const n = pts.length; let min = Infinity;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (j === i || (j + 1) % n === i) continue; // skip the two edges that touch vertex i
    min = Math.min(min, pointSegDist(pts[i], pts[j], pts[(j + 1) % n]));
  }
  return min;
}

export function minFeature(p) {
  switch (p.type) {
    case 'box': case 'wedge': return Math.min(...p.size);
    case 'cylinder': { const rt = p.radiusTop ?? p.radius; return Math.min(2 * p.radius, rt > 0 ? 2 * rt : Infinity, p.height); }
    case 'cone': return Math.min(2 * p.radius, p.height);
    case 'sphere': return 2 * p.radius;
    case 'torus': return 2 * p.tube;
    case 'extrude': return Math.min(p.height, polygonThickness(p.profile));
    case 'lathe': return polygonThickness(p.profile);
    default: return Infinity;
  }
}

export function buildItems(partList) { return partList.parts.map((part) => { const tris = partToTriangles(part); return { part, tris, bbox: boundingBox(tris) }; }); }

const gaps = (a, b) => [0, 1, 2].map((k) => Math.max(a.min[k], b.min[k]) - Math.min(a.max[k], b.max[k])); // positive = gap, negative = overlap
const axisAligned = (p) => p.type === 'box' && p.rot.every((r) => Math.abs(((r % 90) + 90) % 90) < 1e-6);
const xyOverlapFraction = (lower, upper) => { // share of upper's footprint that lies over lower's footprint
  const ox = Math.max(0, Math.min(lower.max[0], upper.max[0]) - Math.max(lower.min[0], upper.min[0]));
  const oy = Math.max(0, Math.min(lower.max[1], upper.max[1]) - Math.max(lower.min[1], upper.min[1]));
  const area = upper.size[0] * upper.size[1]; return area > 0 ? (ox * oy) / area : 0;
};

export function contactGraph(items) {
  const edges = [], near = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const g = gaps(items[i].bbox, items[j].bbox);
    if (g.every((x) => x <= -EPS)) edges.push({ i, j, confirmed: axisAligned(items[i].part) && axisAligned(items[j].part) });
    else if (g.every((x) => x <= NEAR)) near.push({ i, j, gap: Math.max(0, ...g) });
  }
  return { edges, near };
}

function mergeBoxes(boxes) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const b of boxes) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export function runPrintChecks(items, { layerUm = 50, orientation = 'flat' } = {}) {
  if (!items.length) return { checks: [{ id: 'empty', level: 'info', message: 'No parts yet' }], bbox: null, volumeMm3: 0, layers: {}, worst: 'info' };
  const checks = [];
  const bb = mergeBoxes(items.map((it) => it.bbox));
  const [W, D, H] = SATURN3.build, [sx, sy, sz] = bb.size;
  if (sx <= W && sy <= D && sz <= H) checks.push({ id: 'fit', level: 'green', message: `Fits the plate: ${f(sx)} x ${f(sy)} x ${f(sz)} mm` });
  else if (sy <= W && sx <= D && sz <= H) checks.push({ id: 'fit', level: 'amber', message: `Fits only rotated 90 deg about Z: ${f(sx)} x ${f(sy)} x ${f(sz)} mm` });
  else checks.push({ id: 'fit', level: 'red', message: `Too large: ${f(sx)} x ${f(sy)} x ${f(sz)} mm exceeds ${W} x ${D} x ${H} mm` });

  for (const it of items) {
    const m = minFeature(it.part);
    if (m < 0.8) checks.push({ id: 'feature:' + it.part.id, level: 'red', message: `${it.part.id}: thinnest feature ${f(m)} mm is under 0.8 mm` });
    else if (m < 1.2) checks.push({ id: 'feature:' + it.part.id, level: 'amber', message: `${it.part.id}: thinnest feature ${f(m)} mm is under 1.2 mm` });
  }

  const { edges, near } = contactGraph(items);
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of edges) parent[find(e.i)] = find(e.j);
  const comps = new Map();
  items.forEach((_, i) => { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); });
  const grounded = (i) => items[i].bbox.min[2] <= EPS;
  const confirmedAdj = items.map(() => []), adj = items.map(() => []);
  for (const e of edges) { adj[e.i].push(e.j); adj[e.j].push(e.i); if (e.confirmed) { confirmedAdj[e.i].push(e.j); confirmedAdj[e.j].push(e.i); } }
  const reached = new Set(); const queue = items.map((_, i) => i).filter(grounded); queue.forEach((i) => reached.add(i));
  while (queue.length) { const i = queue.pop(); for (const j of confirmedAdj[i]) if (!reached.has(j)) { reached.add(j); queue.push(j); } }
  let flagged = false;
  for (const members of comps.values()) {
    const ids = (arr) => arr.map((i) => items[i].part.id).join(', ');
    if (!members.some(grounded)) { flagged = true; checks.push({ id: 'support:' + ids(members), level: 'red', message: `Unsupported group: ${ids(members)}` }); continue; }
    const unconfirmed = members.filter((i) => !reached.has(i));
    if (unconfirmed.length) { flagged = true; checks.push({ id: 'contact:' + ids(unconfirmed), level: 'amber', message: `Contact not confirmed: ${ids(unconfirmed)}` }); }
  }
  if (!flagged) checks.push({ id: 'support', level: 'green', message: 'All parts grounded through confirmed contact' });
  for (const nm of near) checks.push({ id: `near:${items[nm.i].part.id}-${items[nm.j].part.id}`, level: 'amber', message: `Near miss: ${items[nm.i].part.id} and ${items[nm.j].part.id} are ${f(nm.gap)} mm apart and will not fuse` });

  if (orientation === 'flat') for (const [i, it] of items.entries()) {
    if (it.bbox.min[2] <= EPS) continue;
    const covered = adj[i].filter((j) => items[j].bbox.min[2] < it.bbox.min[2] - EPS).reduce((best, j) => Math.max(best, xyOverlapFraction(items[j].bbox, it.bbox)), 0);
    if (covered < 0.5) checks.push({ id: 'overhang:' + it.part.id, level: 'amber', message: `${it.part.id}: ${Math.round((1 - covered) * 100)}% of its footprint hangs over nothing, needs supports` });
  }

  const volumeMm3 = items.reduce((s, it) => s + partVolume(it.part), 0);
  checks.push({ id: 'volume', level: 'info', message: `Summed primitive volume ${(volumeMm3 / 1000).toFixed(1)} mL (upper bound; overlaps counted twice)` });
  const layers = Object.fromEntries(SATURN3.layerUm.map((um) => [um, Math.ceil(sz / (um / 1000))]));
  checks.push({ id: 'layers', level: 'info', message: `${layers[layerUm]} layers at ${layerUm} um (${f(sz)} mm tall)` });
  checks.push({ id: 'pixel', level: 'info', message: `XY pixel ${SATURN3.pixelUm[0]} x ${SATURN3.pixelUm[1]} um` });
  const worst = checks.some((c) => c.level === 'red') ? 'red' : checks.some((c) => c.level === 'amber') ? 'amber' : 'green';
  return { checks, bbox: bb, volumeMm3, layers, worst };
}
```

- [ ] **Step 4: Run tests until green, then the loop**

Run: `npx vitest run tests/printcheck.test.js` then the full loop. Expected: PASS. If the sphere/cylinder fixture does not interpenetrate, move the sphere's x so the boxes overlap by more than 0.01 mm (cylinder box max x is 5, sphere box min x must be below 4.99).

- [ ] **Step 5: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add Saturn 3 print checks with contact graph and feature rules

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Request tokens and save generations (`src/lifecycle.js`)

**Files:**
- Create: `src/lifecycle.js`
- Test: `tests/lifecycle.test.js`

**Interfaces:**
- Produces: `createRequestTracker() -> {setProject(id), bump(), token(), isCurrent(token), revisionId}` and `createSaveController({save, debounceMs, setTimer, clearTimer, onChange}) -> {markChanged(), setPendingUploads(n), isDirty(), saveNow(), drain(maxRounds), state(), setAutosave(v)}`. `save(generation)` is the injected async writer; it must snapshot the in-memory state synchronously before its first `await`.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { createRequestTracker, createSaveController } from '../src/lifecycle.js';

function harness() {
  const timers = [];
  const calls = [];
  const ctl = createSaveController({
    save: (gen) => new Promise((res, rej) => calls.push({ gen, res, rej })),
    debounceMs: 1500,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = () => { const ts = timers.splice(0); ts.forEach((t) => t.fn()); };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { ctl, calls, timers, fire, tick };
}

describe('request tracker', () => {
  it('tokens go stale on bump and on project switch', () => {
    const t = createRequestTracker(); t.setProject('p1');
    const tok = t.token(); expect(t.isCurrent(tok)).toBe(true);
    t.bump(); expect(t.isCurrent(tok)).toBe(false);
    const tok2 = t.token(); t.setProject('p2'); expect(t.isCurrent(tok2)).toBe(false);
    expect(t.isCurrent(null)).toBe(false);
  });
});

describe('save controller', () => {
  it('debounces two rapid edits into one write and clears dirty on success', async () => {
    const h = harness();
    h.ctl.markChanged(); h.ctl.markChanged();
    expect(h.timers.length).toBe(1); expect(h.ctl.isDirty()).toBe(true);
    h.fire(); await h.tick();
    expect(h.calls.length).toBe(1); expect(h.calls[0].gen).toBe(2);
    h.calls[0].res(); await h.tick();
    expect(h.ctl.isDirty()).toBe(false); expect(h.ctl.state().savedGeneration).toBe(2);
  });
  it('an edit during a pending write keeps dirty and schedules a follow-up save', async () => {
    const h = harness();
    h.ctl.markChanged(); h.fire(); await h.tick();
    h.ctl.markChanged(); // generation 2 while save(1) is in flight
    h.calls[0].res(); await h.tick();
    expect(h.ctl.state().savedGeneration).toBe(1); expect(h.ctl.isDirty()).toBe(true);
    expect(h.timers.length).toBe(1);
    h.fire(); await h.tick();
    expect(h.calls[1].gen).toBe(2); h.calls[1].res(); await h.tick();
    expect(h.ctl.isDirty()).toBe(false);
  });
  it('a stale snapshot success never advances savedGeneration past its own generation', async () => {
    const h = harness();
    h.ctl.markChanged(); h.fire(); await h.tick();
    h.ctl.markChanged(); h.ctl.markChanged();
    h.calls[0].res(); await h.tick();
    expect(h.ctl.state().savedGeneration).toBe(1); expect(h.ctl.state().generation).toBe(3);
  });
  it('a failed write keeps dirty and exposes the error; saveNow retries', async () => {
    const h = harness();
    h.ctl.markChanged(); h.fire(); await h.tick();
    h.calls[0].rej(new Error('offline')); await h.tick();
    expect(h.ctl.isDirty()).toBe(true); expect(h.ctl.state().error.message).toBe('offline');
    expect(h.timers.length).toBe(0); // no automatic retry loop
    const p = h.ctl.saveNow(); await h.tick();
    expect(h.calls[1].gen).toBe(1); h.calls[1].res(); await p;
    expect(h.ctl.isDirty()).toBe(false); expect(h.ctl.state().error).toBe(null);
  });
  it('pending uploads keep the project dirty even when generations match', async () => {
    const h = harness();
    h.ctl.setPendingUploads(1);
    expect(h.ctl.isDirty()).toBe(true);
    const p = h.ctl.drain(); await h.tick(); h.calls[0].res();
    expect(await p).toBe(false);
    h.ctl.setPendingUploads(0); expect(h.ctl.isDirty()).toBe(false);
  });
  it('drain loops until an edit that lands mid-write is also saved', async () => {
    const h = harness();
    h.ctl.markChanged();
    const p = h.ctl.drain(); await h.tick();
    expect(h.calls[0].gen).toBe(1);
    h.ctl.markChanged();
    h.calls[0].res(); await h.tick(); await h.tick();
    expect(h.calls[1].gen).toBe(2);
    h.calls[1].res();
    expect(await p).toBe(true); expect(h.ctl.isDirty()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see it fail**  `npx vitest run tests/lifecycle.test.js`

- [ ] **Step 3: Write src/lifecycle.js**

```js
export function createRequestTracker() {
  let projectId = null, revisionId = 0;
  return {
    setProject(id) { projectId = id; revisionId = 0; },
    bump() { revisionId++; return revisionId; },
    token() { return { projectId, revisionId }; },
    isCurrent(t) { return !!t && t.projectId === projectId && t.revisionId === revisionId; },
    get revisionId() { return revisionId; },
  };
}

export function createSaveController({ save, debounceMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {} }) {
  let generation = 0, savedGeneration = 0, pendingUploads = 0, inFlight = null, timer = null, lastError = null, autosave = true;
  const api = {
    markChanged() { generation++; if (autosave) schedule(); notify(); return generation; },
    setPendingUploads(n) { pendingUploads = n; notify(); },
    isDirty() { return generation !== savedGeneration || pendingUploads > 0; },
    saveNow() { if (timer) { clearTimer(timer); timer = null; } return run(); },
    async drain(maxRounds = 10) {
      for (let i = 0; i < maxRounds; i++) {
        if (!api.isDirty()) return true;
        await api.saveNow();
        if (lastError || pendingUploads > 0) return false;
      }
      return !api.isDirty();
    },
    state() { return { generation, savedGeneration, pendingUploads, saving: !!inFlight, dirty: api.isDirty(), error: lastError }; },
    setAutosave(v) { autosave = v; },
  };
  const notify = () => onChange(api.state());
  function schedule() { if (timer) clearTimer(timer); timer = setTimer(() => { timer = null; run(); }, debounceMs); }
  async function run() {
    if (inFlight) return inFlight;
    const gen = generation;
    inFlight = (async () => {
      try { await save(gen); if (gen > savedGeneration) savedGeneration = gen; lastError = null; }
      catch (e) { lastError = e; }
      finally { inFlight = null; notify(); }
    })();
    await inFlight;
    if (autosave && !lastError && generation !== savedGeneration) schedule();
  }
  return api;
}
```

- [ ] **Step 4: Run tests until green, then the loop.** Expected: PASS. If `drain` returns before the second write, check that `saveNow()` awaits `run()` which awaits `inFlight` (it must not return the stale promise when `inFlight` is already null).

- [ ] **Step 5: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add request tokens and generation-based save controller

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Prompts and export bundle text (`src/prompts.js`, `src/exportbundle.js`)

**Files:**
- Create: `src/prompts.js`, `src/exportbundle.js`
- Test: `tests/prompts.test.js`

**Interfaces:**
- Produces: `builderPrompt({brief, scaleRef, imageCount}) -> string`, `editorPrompt({partList, request}) -> string`, `SCHEMA_TEXT`, `slugify(name) -> string`, `readmeText({list, result, layerUm}) -> string`, `truncateRequest(text) -> string` (2,000 chars).

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { builderPrompt, editorPrompt } from '../src/prompts.js';
import { slugify, readmeText, truncateRequest } from '../src/exportbundle.js';
import { EXAMPLE_LIST } from '../src/schema.js';

describe('prompts', () => {
  it('builder prompt carries the brief, scale reference, image count, envelope, schema and JSON-only instruction', () => {
    const p = builderPrompt({ brief: 'a phone stand', scaleRef: 'the coin is 24.26 mm across', imageCount: 2 });
    for (const s of ['a phone stand', '24.26 mm', '2 photo', '218', '122', '250', '"type"', 'lathe', 'reply with only the JSON', 'assumptions', '0.5 mm']) expect(p).toContain(s);
    expect(builderPrompt({ brief: '', scaleRef: '', imageCount: 0 })).toContain('No scale reference');
  });
  it('editor prompt embeds the current list and the request', () => {
    const p = editorPrompt({ partList: EXAMPLE_LIST, request: 'make the slot 2 mm wider' });
    expect(p).toContain('"id":"base"'); expect(p).toContain('make the slot 2 mm wider'); expect(p).toContain('complete replacement');
  });
});

describe('export bundle', () => {
  it('slugify', () => { expect(slugify('Phone Stand v2!')).toBe('phone-stand-v2'); expect(slugify('   ')).toBe('model'); expect(slugify('x'.repeat(60)).length).toBe(40); });
  it('truncateRequest caps at 2000 characters', () => { expect(truncateRequest('a'.repeat(2500)).length).toBe(2000); expect(truncateRequest('ok')).toBe('ok'); });
  it('readme lists assumptions, bounding box, checks and layer height', () => {
    const result = { bbox: { size: [70, 60, 62] }, checks: [{ level: 'amber', message: 'Contact not confirmed: back' }], volumeMm3: 24000 };
    const t = readmeText({ list: EXAMPLE_LIST, result, layerUm: 50 });
    for (const s of ['phone stand', 'overall height estimated', '70.00 x 60.00 x 62.00 mm', 'Contact not confirmed', '50 um', 'flat', 'Chitubox']) expect(t).toContain(s);
  });
});
```

- [ ] **Step 2: Run to see it fail**  `npx vitest run tests/prompts.test.js`

- [ ] **Step 3: Write src/prompts.js**

```js
export const SCHEMA_TEXT = `Output schema (JSON object, nothing else):
{
  "name": string (1-80 chars),
  "units": "mm",
  "parts": [ { "id": "a-z0-9_-", "type": one of box|cylinder|cone|sphere|torus|extrude|lathe|wedge, ...dims, "pos": [x,y,z], "rot": [rx,ry,rz] degrees, "role": "add" } ],
  "assumptions": [ up to 20 short strings, each one estimated dimension or guess ],
  "print": { "orientation": "flat" | "angled", "suggestedLayerUm": 10 | 30 | 50 | 100 }
}
Part dims (mm, 0.1 to 300; segments integer 3-256, default 64):
- box: size [x,y,z]; local origin at the centre
- cylinder: radius, height, optional radiusTop (0 makes a cone); axis is local Z, origin at the axis centre
- cone: radius, height; apex at +Z
- sphere: radius
- torus: radius (ring), tube; ring lies in local XY
- extrude: profile [[x,y],...] (simple polygon, 3-200 points, do not repeat the first point), height; extruded from local z=0 to z=height
- lathe: profile [[r,z],...] revolved about local Z; r >= 0; every point with r = 0 must have a neighbour with r = 0 (touch the axis along an edge, never at one point)
- wedge: size [x,y,z]; right-triangle prism, full height at the -X face, zero at +X
pos is the world position of the part's local origin; rot is Euler XYZ in degrees (X first).
Example:
{"name":"phone stand","units":"mm","parts":[{"id":"base","type":"box","size":[70,60,4],"pos":[0,0,2],"rot":[0,0,0],"role":"add"},{"id":"back","type":"extrude","profile":[[0,0],[40,0],[40,3],[0,3]],"height":60,"pos":[-20,-28,2],"rot":[90,0,0],"role":"add"}],"assumptions":["overall height estimated at 60 mm, no scale reference given"],"print":{"orientation":"flat","suggestedLayerUm":50}}`;

const RULES = `Design rules:
- Additive primitives only (role "add"). Build the object from a few well-placed parts, like blocks.
- Walls at least 1.2 mm thick. Parts that join must overlap by at least 0.5 mm so the shells fuse in the slicer; never leave a gap or an exact touch.
- Keep the whole model inside 218 x 122 x 250 mm (Elegoo Saturn 3). Scale down proportionally if the real object is bigger, and say so in assumptions.
- Put a flat, stable face on z = 0 (the build plate). Every part must be grounded or overlap a grounded part.
- Every dimension you estimated goes in "assumptions" as its own string.
- print.orientation is "flat" unless the object has large unsupported overhangs, then "angled".`;

export function builderPrompt({ brief, scaleRef, imageCount }) {
  const photos = imageCount > 0 ? `You are given ${imageCount} photo${imageCount === 1 ? '' : 's'} of the object or sketch to reproduce.` : 'No photos are given; work from the brief alone.';
  const scale = scaleRef && scaleRef.trim() ? `Scale reference: ${scaleRef.trim()}. Use it to fix real dimensions.` : 'No scale reference was given: estimate real-world dimensions and list every estimate in assumptions.';
  return `You are a mechanical designer producing a resin-printable 3D model for an Elegoo Saturn 3 from photos, a sketch, or a description.
${photos}
${scale}
Brief from the user: ${brief && brief.trim() ? brief.trim() : '(none)'}

${RULES}

${SCHEMA_TEXT}

Reply with only the JSON object.`;
}

export function editorPrompt({ partList, request }) {
  return `You are editing an existing resin-printable 3D model (Elegoo Saturn 3). Apply the user's request and return the complete replacement part list; keep every part you were not asked to change, keep ids stable, and describe what changed in "assumptions".

Current part list:
${JSON.stringify(partList)}

User request: ${request}

${RULES}

${SCHEMA_TEXT}

Reply with only the JSON object.`;
}
```

- [ ] **Step 4: Write src/exportbundle.js**

```js
export function slugify(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model'; }
export function truncateRequest(text) { return String(text ?? '').slice(0, 2000); }

export function readmeText({ list, result, layerUm }) {
  const size = result?.bbox ? result.bbox.size.map((v) => v.toFixed(2)).join(' x ') + ' mm' : 'n/a';
  const lines = [
    `ShapeCast export: ${list.name}`,
    '',
    `Target printer: Elegoo Saturn 3 (12K), slicer Chitubox. Units mm, Z up.`,
    `Bounding box: ${size}`,
    `Suggested orientation: ${list.print.orientation}`,
    `Layer height: ${layerUm} um`,
    `Summed primitive volume: ${result ? (result.volumeMm3 / 1000).toFixed(1) : '?'} mL (upper bound; overlaps counted twice)`,
    '',
    'Assumptions made by the model:',
    ...(list.assumptions.length ? list.assumptions.map((a) => `- ${a}`) : ['- none']),
    '',
    'Print checks at export time:',
    ...((result?.checks ?? []).filter((c) => c.level !== 'info').map((c) => `- [${c.level}] ${c.message}`)),
    '',
    'Open the .stl in Chitubox, keep the parts as one object, add supports where the checks say so, slice at the layer height above.',
  ];
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 5: Run tests, loop, commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add Claude prompts and export readme helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Page shell, editing model, Three.js viewport (`src/page.html`, `src/model.js`, `src/viewport.js`)

**Files:**
- Replace: `src/page.html`
- Create: `src/model.js`, `src/viewport.js`
- Modify: `scripts/build.mjs` (`MODULES` becomes `['schema.js','geometry.js','printcheck.js','stl.js','lifecycle.js','prompts.js','exportbundle.js','model.js','viewport.js','app.js']`)
- Test: `tests/model.test.js`

**Interfaces:**
- Produces (model.js, pure): `FIELDS` (editable fields per type), `applyFieldEdit(list, partId, field, index, raw) -> {ok, list} | {ok:false, error}`, `removePart(list, partId)`, `prepareImages(files, imageLimits) -> {images, rejected:[{name, reason}]}`, `DOC_LIMIT = 204800`, `documentBytes(doc)`, `checkDocumentSizes({projectDoc, revisionDoc}) -> {ok, error}`, `projectDocument(project) -> plain object for db`, `SAMPLE_LIST`.
- Produces (viewport.js, browser): `createViewport(canvas, {onSelect}) -> {setItems(items, selectedId), fit(bbox), view(name), resize(), setTheme()} | null` when `THREE` is missing.

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest';
import { applyFieldEdit, removePart, prepareImages, checkDocumentSizes, projectDocument, DOC_LIMIT, SAMPLE_LIST } from '../src/model.js';
import { validatePartList, EXAMPLE_LIST } from '../src/schema.js';

describe('applyFieldEdit', () => {
  it('rejects empty, dash and NaN without touching the list', () => {
    for (const raw of ['', '-', 'abc', '1e309']) { const r = applyFieldEdit(EXAMPLE_LIST, 'base', 'size', 0, raw); expect(r.ok).toBe(false); expect(r.error).toMatch(/base\.size/); }
    expect(EXAMPLE_LIST.parts[0].size[0]).toBe(70);
  });
  it('applies a valid tuple edit and a scalar edit, returning a new list', () => {
    const r = applyFieldEdit(EXAMPLE_LIST, 'base', 'size', 2, '6');
    expect(r.ok).toBe(true); expect(r.list.parts[0].size).toEqual([70, 60, 6]); expect(EXAMPLE_LIST.parts[0].size[2]).toBe(4);
    const r2 = applyFieldEdit(EXAMPLE_LIST, 'back', 'height', null, 55);
    expect(r2.ok).toBe(true); expect(r2.list.parts[1].height).toBe(55);
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
    const { images, rejected } = prepareImages([file('a.jpg', 'image/jpeg', 1000), file('b.heic', 'image/heic', 1000), file('c.png', 'image/png', 30 * 1048576), file('d.png', 'image/png', 10), file('e.png', 'image/png', 10)], lim);
    expect(images.map((f) => f.name)).toEqual(['a.jpg', 'd.png']);
    expect(rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/type image\/heic/), expect.stringMatching(/photo too large/), expect.stringMatching(/only 2 photos/)]);
  });
  it('rejects everything when the view cannot send images', () => {
    const r = prepareImages([file('a.jpg', 'image/jpeg', 1)], undefined);
    expect(r.images).toEqual([]); expect(r.rejected[0].reason).toMatch(/cannot send photos/);
  });
});

describe('documents', () => {
  it('projectDocument carries bounded metadata and the current list', () => {
    const d = projectDocument({ name: 'p', brief: 'b', scaleRef: 's', photoAssetIds: ['x'], current: EXAMPLE_LIST, currentRevisionId: 'r1', createdAt: 1, updatedAt: 2 });
    expect(d.current.parts.length).toBe(2); expect(d.photoAssetIds).toEqual(['x']); expect(d.updatedAt).toBe(2);
  });
  it('checkDocumentSizes refuses anything over 200 KiB and names which document', () => {
    const big = { ...EXAMPLE_LIST, assumptions: [], name: 'x', pad: 'y'.repeat(DOC_LIMIT) };
    expect(checkDocumentSizes({ projectDoc: { current: big } }).error).toMatch(/project.*too large/i);
    expect(checkDocumentSizes({ projectDoc: { current: EXAMPLE_LIST }, revisionDoc: { partList: big } }).error).toMatch(/revision.*too large/i);
    expect(checkDocumentSizes({ projectDoc: { current: EXAMPLE_LIST } }).ok).toBe(true);
  });
  it('a 4000-char brief with a 120 KiB list still fits', () => {
    const parts = []; let i = 0;
    while (true) { const cand = { id: 'b' + i, type: 'box', size: [1.123456, 1.123456, 1.123456], pos: [i * 0.000001, 0, 0.561728], rot: [0, 0, 0], role: 'add' }; const trial = { ...EXAMPLE_LIST, parts: [...parts, cand] }; if (validatePartList(trial).ok && parts.length < 200) { parts.push(cand); i++; } else break; }
    const list = { ...EXAMPLE_LIST, parts, assumptions: Array(20).fill('a'.repeat(300)) };
    expect(validatePartList(list).ok).toBe(true);
    expect(checkDocumentSizes({ projectDoc: projectDocument({ name: 'n'.repeat(80), brief: 'b'.repeat(4000), scaleRef: 's'.repeat(300), photoAssetIds: Array(8).fill('a'.repeat(32)), current: list, currentRevisionId: 'r', createdAt: 0, updatedAt: 0 }) }).ok).toBe(true);
  });
  it('SAMPLE_LIST validates', () => { expect(validatePartList(SAMPLE_LIST).ok).toBe(true); });
});
```

- [ ] **Step 2: Run to see it fail**  `npx vitest run tests/model.test.js`

- [ ] **Step 3: Write src/model.js**

```js
import { validatePartList } from './schema.js';

export const FIELDS = {
  box: ['size', 'pos', 'rot'], wedge: ['size', 'pos', 'rot'],
  cylinder: ['radius', 'radiusTop', 'height', 'segments', 'pos', 'rot'], cone: ['radius', 'height', 'segments', 'pos', 'rot'],
  sphere: ['radius', 'segments', 'pos', 'rot'], torus: ['radius', 'tube', 'segments', 'pos', 'rot'],
  extrude: ['height', 'pos', 'rot'], lathe: ['segments', 'pos', 'rot'],
};
export const DOC_LIMIT = 200 * 1024;
export const META = { name: 80, brief: 4000, scaleRef: 300, photos: 8 };
const clone = (o) => JSON.parse(JSON.stringify(o));

export function applyFieldEdit(list, partId, field, index, raw) {
  const text = String(raw).trim(), num = Number(text);
  const label = `${partId}.${field}${index === null || index === undefined ? '' : `[${index}]`}`;
  if (text === '' || !Number.isFinite(num)) return { ok: false, error: `${label}: not a number` };
  const next = clone(list), part = next.parts.find((p) => p.id === partId);
  if (!part) return { ok: false, error: `${partId}: no such part` };
  if (index === null || index === undefined) part[field] = num;
  else { if (!Array.isArray(part[field])) return { ok: false, error: `${label}: not a tuple` }; part[field][index] = num; }
  const v = validatePartList(next);
  return v.ok ? { ok: true, list: next } : { ok: false, error: v.errors[0] };
}

export function removePart(list, partId) {
  const next = clone(list); next.parts = next.parts.filter((p) => p.id !== partId);
  const v = validatePartList(next);
  return v.ok ? { ok: true, list: next } : { ok: false, error: v.errors[0] };
}

export function prepareImages(files, imageLimits) {
  const images = [], rejected = [];
  for (const f of files) {
    if (!imageLimits) rejected.push({ name: f.name, reason: 'this view cannot send photos to Claude' });
    else if (!imageLimits.mediaTypes.includes(f.type)) rejected.push({ name: f.name, reason: `type ${f.type || 'unknown'} not accepted` });
    else if (f.size > imageLimits.maxInputBytes) rejected.push({ name: f.name, reason: `photo too large (${(f.size / 1048576).toFixed(1)} MB, limit ${Math.round(imageLimits.maxInputBytes / 1048576)} MB)` });
    else if (images.length >= imageLimits.maxCount) rejected.push({ name: f.name, reason: `only ${imageLimits.maxCount} photos per build` });
    else images.push(f);
  }
  return { images, rejected };
}

export function documentBytes(doc) { return new TextEncoder().encode(JSON.stringify(doc)).length; }

export function checkDocumentSizes({ projectDoc, revisionDoc }) {
  if (projectDoc && documentBytes(projectDoc) > DOC_LIMIT) return { ok: false, error: 'Project too large to save (over 200 KiB)' };
  if (revisionDoc && documentBytes(revisionDoc) > DOC_LIMIT) return { ok: false, error: 'Revision too large to save (over 200 KiB)' };
  return { ok: true };
}

export function projectDocument(p) {
  return {
    name: String(p.name).slice(0, META.name), brief: String(p.brief ?? '').slice(0, META.brief), scaleRef: String(p.scaleRef ?? '').slice(0, META.scaleRef),
    photoAssetIds: (p.photoAssetIds ?? []).slice(0, META.photos), current: p.current, currentRevisionId: p.currentRevisionId ?? null,
    createdAt: p.createdAt, updatedAt: p.updatedAt,
  };
}

export const SAMPLE_LIST = {
  name: 'example: block and catapult arm', units: 'mm',
  parts: [
    { id: 'block', type: 'box', size: [40, 40, 40], pos: [-60, 0, 20], rot: [0, 0, 0], role: 'add' },
    { id: 'arm', type: 'box', size: [120, 8, 6], pos: [30, 0, 3], rot: [0, 0, 0], role: 'add' },
    { id: 'cup', type: 'lathe', profile: [[0, 0], [12, 0], [12, 2], [10, 2], [10, 9], [0, 9]], pos: [82, 0, 5.5], rot: [0, 0, 0], role: 'add' },
    { id: 'pivot', type: 'cylinder', radius: 5, height: 14, pos: [10, 0, 5], rot: [90, 0, 0], role: 'add' },
  ],
  assumptions: ['example model: the 40 mm block is the scale reference from the catapult video'],
  print: { orientation: 'flat', suggestedLayerUm: 50 },
};
```

- [ ] **Step 4: Run model tests until green**

- [ ] **Step 5: Write src/viewport.js**

```js
import { SATURN3 } from './printcheck.js';

const cssVar = (name, fallback) => { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fallback; };

export function createViewport(canvas, { onSelect = () => {} } = {}) {
  if (typeof THREE === 'undefined') return null;
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { return null; }
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000); camera.up.set(0, 0, 1);
  const target = new THREE.Vector3(0, 0, 30); let theta = -0.9, phi = 1.05, dist = 420, needsRender = true;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 0.8); sun.position.set(200, -300, 400); scene.add(sun);

  const [W, D, H] = SATURN3.build;
  const plateMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, side: THREE.DoubleSide });
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(W, D), plateMat); plate.position.z = -0.02; scene.add(plate);
  const gridPts = [];
  for (let x = -W / 2; x <= W / 2 + 1e-6; x += 10) gridPts.push(x, -D / 2, 0, x, D / 2, 0);
  for (let y = -D / 2; y <= D / 2 + 1e-6; y += 10) gridPts.push(-W / 2, y, 0, W / 2, y, 0);
  const gridGeo = new THREE.BufferGeometry(); gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(gridPts, 3));
  const gridMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.5 });
  scene.add(new THREE.LineSegments(gridGeo, gridMat));
  const ghostMat = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.35 });
  const ghost = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, D, H)), ghostMat); ghost.position.z = H / 2; scene.add(ghost);

  const group = new THREE.Group(); scene.add(group);
  const colors = { base: 0x8a8f99, accent: 0xd98c1f, failed: 0xb3261e };
  function setTheme() {
    const hex = (v) => parseInt(v.replace('#', ''), 16);
    plateMat.color.setHex(hex(cssVar('--plate', '#9aa0a6'))); gridMat.color.setHex(hex(cssVar('--grid', '#9aa0a6'))); ghostMat.color.setHex(hex(cssVar('--grid', '#9aa0a6')));
    colors.base = hex(cssVar('--part', '#8a8f99')); colors.accent = hex(cssVar('--accent', '#d98c1f')); colors.failed = hex(cssVar('--red', '#b3261e'));
    needsRender = true;
  }
  function setItems(items, selectedId) {
    for (const m of [...group.children]) { group.remove(m); m.geometry.dispose(); m.material.dispose(); }
    for (const it of items) {
      const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(it.tris), 3)); geo.computeVertexNormals();
      const color = it.failed ? colors.failed : it.part.id === selectedId ? colors.accent : colors.base;
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 }));
      mesh.userData.id = it.part.id; group.add(mesh);
    }
    needsRender = true;
  }
  function updateCamera() {
    camera.position.set(target.x + dist * Math.sin(phi) * Math.cos(theta), target.y + dist * Math.sin(phi) * Math.sin(theta), target.z + dist * Math.cos(phi));
    camera.lookAt(target); needsRender = true;
  }
  function fit(bbox) {
    if (!bbox) return;
    target.set((bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2);
    dist = Math.max(...bbox.size) * 1.9 + 40; updateCamera();
  }
  function view(name) {
    if (name === 'top') { theta = -Math.PI / 2; phi = 0.001; } else if (name === 'front') { theta = -Math.PI / 2; phi = Math.PI / 2 - 0.001; } else { theta = -0.9; phi = 1.05; }
    updateCamera();
  }
  function resize() {
    const w = canvas.clientWidth || 300, h = canvas.clientHeight || 300;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); needsRender = true;
  }
  let down = null, moved = false;
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, shift: e.shiftKey }; moved = false; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    if (!down) return; const dx = e.clientX - down.x, dy = e.clientY - down.y; down.x = e.clientX; down.y = e.clientY; if (Math.abs(dx) + Math.abs(dy) > 1) moved = true;
    if (down.b === 0 && !down.shift) { theta -= dx * 0.006; phi = Math.min(Math.PI - 0.02, Math.max(0.02, phi - dy * 0.006)); }
    else { const right = new THREE.Vector3().crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize(); target.addScaledVector(right, -dx * dist * 0.0015); target.addScaledVector(camera.up, dy * dist * 0.0015); }
    updateCamera();
  });
  canvas.addEventListener('pointerup', (e) => {
    if (down && !moved) {
      const r = canvas.getBoundingClientRect(); const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, camera); const hit = ray.intersectObjects(group.children)[0];
      onSelect(hit ? hit.object.userData.id : null);
    }
    down = null;
  });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); dist = Math.min(4000, Math.max(20, dist * Math.exp(e.deltaY * 0.0012))); updateCamera(); }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  new ResizeObserver(resize).observe(canvas.parentElement);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', setTheme);
  function loop() { if (needsRender) { renderer.render(scene, camera); needsRender = false; } requestAnimationFrame(loop); }
  setTheme(); resize(); updateCamera(); loop();
  return { setItems, fit, view, resize, setTheme };
}
```

- [ ] **Step 6: Write src/page.html**

```html
<title>ShapeCast</title>
<style>
/* layout: three columns (capture | viewport | parts and print) that stack at phone width; the viewport is the hero */
:root{
  --bg:#f3f2ee;--fg:#1f1f1c;--muted:#6b6a64;--panel:#ffffff;--line:#d9d6cd;--accent:#c97a12;--accent-ink:#ffffff;
  --red:#b3261e;--amber:#b86e00;--green:#2d7d46;--info:#4a5a73;--plate:#b9b5aa;--grid:#8e8a80;--part:#8a8f99;
  --font-ui:"IBM Plex Sans",system-ui,sans-serif;--font-num:"IBM Plex Mono",ui-monospace,monospace;--font-display:"Barlow Condensed","Arial Narrow",sans-serif;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#17181a;--fg:#ebe9e3;--muted:#9a9890;--panel:#202226;--line:#34373d;--accent:#e0912a;--accent-ink:#1a1a1a;--red:#ff6b61;--amber:#f0a73a;--green:#5fc27d;--info:#9fb4d6;--plate:#3a3d44;--grid:#5a5e66;--part:#a7adb8;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#17181a;--fg:#ebe9e3;--muted:#9a9890;--panel:#202226;--line:#34373d;--accent:#e0912a;--accent-ink:#1a1a1a;--red:#ff6b61;--amber:#f0a73a;--green:#5fc27d;--info:#9fb4d6;--plate:#3a3d44;--grid:#5a5e66;--part:#a7adb8;color-scheme:dark}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 var(--font-ui);padding-block:0;padding-inline:16px}
h1{font:600 28px/1 var(--font-display);letter-spacing:.02em;margin:0;text-wrap:balance}
h2{font:600 13px/1.2 var(--font-ui);text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 8px}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:12px;border-bottom:1px solid var(--line)}
header .sub{color:var(--muted);font-size:12px}
main{display:grid;grid-template-columns:300px minmax(0,1fr) 340px;gap:16px;padding-block:16px;min-height:calc(100% - 60px)}
@media (max-width:1000px){main{grid-template-columns:1fr}}
section.col{display:flex;flex-direction:column;gap:14px;min-width:0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
input,textarea,select,button{font:inherit;color:inherit}
input[type=text],textarea,select{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:6px 8px}
textarea{min-height:72px;resize:vertical}
button{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:6px 10px;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
button:disabled{opacity:.5;cursor:default}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.well{border:1px dashed var(--line);border-radius:6px;padding:10px;text-align:center;color:var(--muted)}
.well.over{border-color:var(--accent)}
.thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.thumb{position:relative;width:64px;height:64px;border-radius:4px;overflow:hidden;border:1px solid var(--line)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb button{position:absolute;top:2px;right:2px;padding:0 5px;line-height:18px;font-size:12px}
.thumb.pending::after{content:"not uploaded";position:absolute;inset:auto 0 0 0;background:var(--amber);color:#000;font-size:10px;text-align:center}
#viewWrap{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:6px;min-height:420px;height:min(70vh,720px);overflow:hidden}
#viewport{width:100%;height:100%;display:block;touch-action:none}
.viewbar{position:absolute;top:8px;left:8px;display:flex;gap:6px}
#bboxReadout{position:absolute;right:10px;bottom:8px;font:12px var(--font-num);color:var(--muted);font-variant-numeric:tabular-nums}
#viewNotice{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);padding:16px;text-align:center}
#status{min-height:20px;font-size:13px;color:var(--muted)}
.chat{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.msg{padding:6px 8px;border-radius:4px;background:var(--bg);border:1px solid var(--line);font-size:13px}
.msg.user{border-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--muted);font-weight:500;padding:4px 2px}
td{padding:3px 2px;vertical-align:top;border-top:1px solid var(--line)}
td input{width:62px;font:12px var(--font-num);font-variant-numeric:tabular-nums;background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:2px 4px}
tr.sel td{background:color-mix(in srgb,var(--accent) 12%,transparent)}
.tuple{display:flex;gap:2px}
.chips{display:flex;flex-direction:column;gap:4px}
.chip{display:flex;gap:8px;align-items:baseline;font-size:12px;padding:4px 8px;border-radius:4px;border:1px solid var(--line)}
.chip::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--info);flex:none;transform:translateY(1px)}
.chip.red::before{background:var(--red)}.chip.amber::before{background:var(--amber)}.chip.green::before{background:var(--green)}
.chip .num{font:12px var(--font-num);font-variant-numeric:tabular-nums}
.assume{border-left:3px solid var(--amber);padding:6px 10px;font-size:13px;background:color-mix(in srgb,var(--amber) 10%,transparent);border-radius:0 4px 4px 0}
.assume ul{margin:4px 0 0 16px;padding:0}
.banner{padding:8px 10px;border-radius:4px;font-size:13px;border:1px solid var(--line)}
.banner.error{border-color:var(--red);color:var(--red)}
.banner.warn{border-color:var(--amber)}
.hidden{display:none!important}
details summary{cursor:pointer;color:var(--muted);font-size:12px}
pre{white-space:pre-wrap;word-break:break-word;font:11px var(--font-num);max-height:200px;overflow:auto}
.small{font-size:12px;color:var(--muted)}
.num{font-family:var(--font-num);font-variant-numeric:tabular-nums}
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono&display=swap">
<header>
  <div><h1>ShapeCast</h1><div class="sub">Photo, sketch or prompt to a Saturn 3 resin print</div></div>
  <div class="row">
    <select id="projectSelect" aria-label="Project"><option value="">New project</option></select>
    <button id="newProjectBtn">New</button>
    <span id="saveState" class="small">local only</span>
  </div>
</header>
<div id="localBanner" class="banner warn hidden">Not signed in to Claude: this session is local only and will not sync.</div>
<div id="message" class="banner error hidden" role="alert"></div>
<div id="switchDialog" class="banner warn hidden">
  <span id="switchText">Unsaved changes.</span>
  <span class="row" style="margin-top:6px"><button id="switchSave" class="primary">Save and switch</button><button id="switchDiscard">Discard and switch</button><button id="switchStay">Stay</button></span>
</div>
<main>
  <section class="col">
    <div class="card">
      <h2>Capture</h2>
      <div id="dropWell" class="well">Drop photos here or <label style="display:inline;color:var(--accent);cursor:pointer"><input id="photoInput" type="file" accept="image/*" capture="environment" multiple hidden>take / choose a photo</label>
        <div id="photoNote" class="small"></div>
        <div id="thumbs" class="thumbs"></div>
      </div>
      <label for="scaleRef" style="margin-top:10px">Scale reference</label>
      <input id="scaleRef" type="text" maxlength="300" placeholder="the coin is 24.26 mm across">
      <label for="brief" style="margin-top:10px">Brief</label>
      <textarea id="brief" maxlength="4000" placeholder="a stand for my phone, slot 12 mm deep, 10 degree lean"></textarea>
      <div class="row" style="margin-top:10px"><button id="buildBtn" class="primary">Build model</button><button id="stopBtn" class="hidden">Stop</button></div>
      <div id="status"></div>
    </div>
    <div class="card">
      <h2>Revise with Claude</h2>
      <div id="chatLog" class="chat"></div>
      <div class="row" style="margin-top:8px"><input id="chatInput" type="text" maxlength="2000" placeholder="make the slot 2 mm wider" style="flex:1"><button id="sendBtn">Send</button></div>
      <div id="staleCard" class="banner warn hidden"><span id="staleText"></span> <span class="row" style="margin-top:6px"><button id="staleApply">Apply anyway</button><button id="staleDiscard">Discard</button></span></div>
    </div>
  </section>
  <section class="col">
    <div id="viewWrap">
      <canvas id="viewport"></canvas>
      <div class="viewbar"><button id="fitBtn">Fit</button><button id="isoBtn">Iso</button><button id="topBtn">Top</button><button id="frontBtn">Front</button></div>
      <div id="bboxReadout"></div>
      <div id="viewNotice" class="hidden">3D preview unavailable in this browser. The parts table and export still work.</div>
    </div>
  </section>
  <section class="col">
    <div class="card">
      <h2>Parts</h2>
      <div class="row" style="margin-bottom:8px"><label for="projectName" style="margin:0">Name</label><input id="projectName" type="text" maxlength="80" style="flex:1"></div>
      <div style="overflow-x:auto"><table id="partsTable"><thead><tr><th>id</th><th>type</th><th>dims</th><th></th></tr></thead><tbody></tbody></table></div>
    </div>
    <div id="assumptions" class="assume hidden"></div>
    <div class="card">
      <h2>Print check <span class="small">Saturn 3</span></h2>
      <div class="row" style="margin-bottom:8px"><label for="layerSelect" style="margin:0">Layer</label><select id="layerSelect" style="width:auto"><option value="10">10 um</option><option value="30">30 um</option><option value="50" selected>50 um</option><option value="100">100 um</option></select></div>
      <div id="checks" class="chips"></div>
      <div class="row" style="margin-top:10px"><button id="exportBtn" class="primary">Export .zip (STL)</button><button id="exportJsonBtn">Export JSON</button></div>
      <div id="exportNote" class="small"></div>
    </div>
    <details class="card"><summary>Raw reply / debug</summary><pre id="rawReply"></pre></details>
  </section>
</main>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<!-- @inline-modules -->
```

- [ ] **Step 7: Update `MODULES` in scripts/build.mjs, run the loop and the build**

Run: `npm run format && npm run typecheck && npm test && npm run lint && npm run build`. Expected: PASS; `index.html` written. The page shows only the shell until Task 11 (app.js still the placeholder from Task 1).

- [ ] **Step 8: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: add page shell, field-edit model and Three.js viewport

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Application glue: capture, inference, editing, export, persistence (`src/app.js`)

**Files:**
- Replace: `src/app.js`
- Test: none new (pure logic was tested in Tasks 2-10); verification is the build, one preview, and the publish checks in Task 12.

**Interfaces:**
- Consumes every module's exports listed above plus the DOM ids in `src/page.html`.
- Produces: `init()` wired to DOM ready.

- [ ] **Step 1: Write src/app.js**

```js
import { validatePartList } from './schema.js';
import { localTriangles, transformTriangles, meshChecks, boundingBox } from './geometry.js';
import { runPrintChecks } from './printcheck.js';
import { writeBinaryStl, concatTriangles } from './stl.js';
import { createRequestTracker, createSaveController } from './lifecycle.js';
import { builderPrompt, editorPrompt } from './prompts.js';
import { slugify, readmeText, truncateRequest } from './exportbundle.js';
import { FIELDS, applyFieldEdit, removePart, prepareImages, checkDocumentSizes, projectDocument, SAMPLE_LIST, META } from './model.js';
import { createViewport } from './viewport.js';

const $ = (id) => document.getElementById(id);
const caps = { sample: null, downloads: null, db: null, assets: null, user: null };
let imageLimits = null, uid = null, viewport = null, saveCtl = null;
const tracker = createRequestTracker();
const state = { project: null, unsavedRevisions: [], items: [], result: null, selectedId: null, layerUm: 50, inference: null, stale: null, pendingSwitch: null };

const canPersist = () => !!(caps.db && caps.assets && uid);
const newId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function newProject(list = SAMPLE_LIST) {
  const now = Date.now();
  return { id: newId('p'), name: list.name, brief: '', scaleRef: '', photos: [], current: list, currentRevisionId: null, createdAt: now, updatedAt: now };
}

// ---------- messages ----------
function showError(text) { const m = $('message'); m.textContent = text; m.classList.toggle('hidden', !text); }
function note(text) { $('photoNote').textContent = text; }
function setBusy(on, text) { $('status').textContent = text; $('buildBtn').disabled = on || !caps.sample; $('sendBtn').disabled = on || !caps.sample; $('stopBtn').classList.toggle('hidden', !on); }
function addChat(role, text) { const d = document.createElement('div'); d.className = `msg ${role}`; d.textContent = text; $('chatLog').append(d); d.scrollIntoView({ block: 'nearest' }); }

// ---------- render ----------
function render() {
  const list = state.project.current;
  const v = validatePartList(list);
  if (!v.ok) { showError(v.errors[0]); return; }
  let anyFailed = false;
  state.items = list.parts.map((part) => {
    try {
      const local = localTriangles(part), mc = meshChecks(local), tris = transformTriangles(local, part.pos, part.rot);
      if (!mc.ok) anyFailed = true;
      return { part, tris, bbox: boundingBox(tris), failed: !mc.ok, failure: mc.errors[0] };
    } catch (e) { anyFailed = true; return { part, tris: new Float64Array(0), bbox: { min: part.pos, max: part.pos, size: [0, 0, 0] }, failed: true, failure: e.message }; }
  });
  state.result = runPrintChecks(state.items, { layerUm: state.layerUm, orientation: list.print.orientation });
  viewport?.setItems(state.items, state.selectedId);
  renderParts(); renderChecks(anyFailed); renderAssumptions(); renderThumbs();
  $('projectName').value = state.project.name; $('brief').value = state.project.brief; $('scaleRef').value = state.project.scaleRef;
  $('bboxReadout').textContent = state.result.bbox ? state.result.bbox.size.map((x) => x.toFixed(1)).join(' x ') + ' mm' : '';
  $('exportBtn').disabled = anyFailed || !caps.downloads;
  $('exportNote').textContent = anyFailed ? 'Export is disabled until every part passes the geometry check.' : $('exportNote').textContent;
}

function renderParts() {
  const tbody = $('partsTable').querySelector('tbody'); tbody.innerHTML = '';
  for (const it of state.items) {
    const p = it.part, tr = document.createElement('tr'); tr.dataset.id = p.id; if (p.id === state.selectedId) tr.className = 'sel';
    const tdId = document.createElement('td'); tdId.textContent = p.id; if (it.failed) { tdId.style.color = 'var(--red)'; tdId.title = it.failure; }
    const tdType = document.createElement('td'); tdType.textContent = p.type;
    const tdDims = document.createElement('td');
    for (const field of FIELDS[p.type]) {
      const wrap = document.createElement('div'); wrap.className = 'tuple'; const lab = document.createElement('span'); lab.className = 'small'; lab.textContent = field; lab.style.width = '58px'; wrap.append(lab);
      const vals = Array.isArray(p[field]) ? p[field] : [p[field]];
      vals.forEach((val, i) => { const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'decimal'; inp.id = `f-${p.id}-${field}-${i}`; inp.value = val ?? ''; inp.placeholder = field === 'radiusTop' ? '= radius' : field === 'segments' ? '64' : ''; inp.dataset.id = p.id; inp.dataset.field = field; inp.dataset.index = Array.isArray(p[field]) ? String(i) : ''; inp.addEventListener('change', onFieldChange); wrap.append(inp); });
      tdDims.append(wrap);
    }
    const tdX = document.createElement('td'); const del = document.createElement('button'); del.textContent = 'x'; del.title = 'Remove part'; del.addEventListener('click', () => { const r = removePart(state.project.current, p.id); r.ok ? applyList(r.list) : showError(r.error); }); tdX.append(del);
    tr.append(tdId, tdType, tdDims, tdX); tr.addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') { state.selectedId = p.id; render(); } });
    tbody.append(tr);
  }
}
function onFieldChange(e) {
  const { id, field, index } = e.target.dataset;
  if (e.target.value.trim() === '' && (field === 'radiusTop' || field === 'segments')) { const next = JSON.parse(JSON.stringify(state.project.current)); delete next.parts.find((p) => p.id === id)[field]; const v = validatePartList(next); v.ok ? applyList(next) : showError(v.errors[0]); return; }
  const r = applyFieldEdit(state.project.current, id, field, index === '' ? null : Number(index), e.target.value);
  if (r.ok) { showError(''); applyList(r.list); } else { showError(r.error); render(); }
}
function renderChecks(anyFailed) {
  const box = $('checks'); box.innerHTML = '';
  const chips = [...(anyFailed ? state.items.filter((i) => i.failed).map((i) => ({ level: 'red', message: `${i.part.id}: geometry failed manifold check (${i.failure})` })) : []), ...state.result.checks];
  for (const c of chips) { const d = document.createElement('div'); d.className = `chip ${c.level}`; d.textContent = c.message; box.append(d); }
}
function renderAssumptions() {
  const a = state.project.current.assumptions, el = $('assumptions'); el.classList.toggle('hidden', !a.length);
  el.innerHTML = ''; const h = document.createElement('strong'); h.textContent = 'Assumptions'; const ul = document.createElement('ul'); for (const s of a) { const li = document.createElement('li'); li.textContent = s; ul.append(li); } el.append(h, ul);
}
function renderThumbs() {
  const t = $('thumbs'); t.innerHTML = '';
  for (const ph of state.project.photos) {
    const d = document.createElement('div'); d.className = 'thumb' + (canPersist() && !ph.assetId ? ' pending' : ''); const img = document.createElement('img'); img.alt = 'photo'; img.src = ph.url || '/_blob/' + ph.assetId; const b = document.createElement('button'); b.textContent = 'x'; b.title = 'Remove photo';
    b.addEventListener('click', () => { state.project.photos = state.project.photos.filter((p) => p !== ph); saveCtl.setPendingUploads(state.project.photos.filter((p) => !p.assetId && canPersist()).length); saveCtl.markChanged(); renderThumbs(); });
    d.append(img, b); t.append(d);
  }
}

// ---------- model changes ----------
function assetIds() { return state.project.photos.filter((p) => p.assetId).map((p) => p.assetId); }
function applyList(list, { request = null } = {}) {
  const now = Date.now();
  const rev = request ? { id: newId('r'), doc: { at: now, request: truncateRequest(request), partList: list } } : null;
  const prospective = projectDocument({ ...state.project, photoAssetIds: assetIds(), current: list, currentRevisionId: rev?.id ?? state.project.currentRevisionId, updatedAt: now });
  const size = checkDocumentSizes({ projectDoc: prospective, revisionDoc: rev?.doc });
  if (!size.ok) { showError(size.error); return false; }
  state.project.current = list; state.project.updatedAt = now;
  if (rev) { state.unsavedRevisions.push(rev); state.project.currentRevisionId = rev.id; }
  tracker.bump(); saveCtl.markChanged(); render(); return true;
}
function metaChange() {
  const prospective = projectDocument({ ...state.project, name: $('projectName').value, brief: $('brief').value, scaleRef: $('scaleRef').value, photoAssetIds: assetIds() });
  const size = checkDocumentSizes({ projectDoc: prospective }); if (!size.ok) { showError(size.error); return; }
  state.project.name = $('projectName').value.slice(0, META.name) || state.project.name; state.project.brief = $('brief').value.slice(0, META.brief); state.project.scaleRef = $('scaleRef').value.slice(0, META.scaleRef);
  saveCtl.markChanged();
}
function addPhotos(files) {
  for (const f of files) {
    if (state.project.photos.length >= META.photos) { note(`At most ${META.photos} photos per project.`); break; }
    state.project.photos.push({ localId: newId('ph'), file: f, url: URL.createObjectURL(f) });
  }
  if (canPersist()) saveCtl.setPendingUploads(state.project.photos.filter((p) => !p.assetId).length);
  saveCtl.markChanged(); renderThumbs();
}

// ---------- Claude ----------
async function runInference(kind, requestText) {
  if (!caps.sample || state.inference) return;
  const controller = new AbortController(), token = tracker.token();
  state.inference = { controller, token }; setBusy(true, 'Thinking...'); showError('');
  let prompt, images = [];
  if (kind === 'build') {
    const files = state.project.photos.map((p) => p.file).filter(Boolean);
    const prep = prepareImages(files, imageLimits);
    const stored = state.project.photos.length - files.length;
    const notes = prep.rejected.map((r) => `${r.name}: ${r.reason}`); if (stored) notes.push(`${stored} saved photo${stored > 1 ? 's' : ''} cannot be re-sent; add them again to use them`);
    note(notes.join('; ')); images = prep.images;
    prompt = builderPrompt({ brief: state.project.brief, scaleRef: state.project.scaleRef, imageCount: images.length });
    addChat('user', `Build: ${state.project.brief || '(photos only)'}${state.project.scaleRef ? ` [scale: ${state.project.scaleRef}]` : ''}`);
  } else { prompt = editorPrompt({ partList: state.project.current, request: requestText }); addChat('user', requestText); }
  try {
    const reply = await caps.sample.json(prompt, { signal: controller.signal, images: images.length ? images : undefined, modelTier: kind === 'build' ? 'complex' : 'quick', cache: false, onText: ({ text }) => { $('rawReply').textContent = text; setBusy(true, 'Writing...'); } });
    const v = validatePartList(reply);
    if (!v.ok) { $('rawReply').textContent = JSON.stringify(reply, null, 2); showError(`Claude's reply was rejected: ${v.errors[0]}. Try again or simplify the request.`); return; }
    const request = kind === 'build' ? `build: ${state.project.brief || 'from photos'}` : requestText;
    if (!tracker.isCurrent(token)) { state.stale = { list: reply, request }; $('staleText').textContent = 'This result is for an older revision of the project (you edited or switched meanwhile).'; $('staleCard').classList.remove('hidden'); return; }
    if (applyList(reply, { request })) { addChat('claude', reply.assumptions.length ? reply.assumptions.join(' | ') : 'Model updated.'); if (kind === 'build') viewport?.fit(state.result.bbox); }
  } catch (e) { handleSampleError(e); }
  finally { state.inference = null; setBusy(false, ''); }
}
function handleSampleError(e) {
  const code = e?.code || 'upstream_error';
  if (code === 'cancelled') return;
  if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) { caps.sample = null; setBusy(false, 'Claude is not available for this artifact in this view.'); return; }
  if (code === 'invalid_json') { $('rawReply').textContent = e.text || ''; showError("Claude's reply was not valid JSON. Try again, or ask for a simpler model."); return; }
  if (code === 'refused') { $('rawReply').textContent = ''; showError('Claude declined this request. Change the brief or photos and try again.'); return; }
  const copy = { rate_limited: 'Too many requests right now. Wait a minute and try again.', session_expired: 'Your Claude session expired. Sign in again and retry.', image_rejected: 'A photo was rejected (type or size). Remove it and try again.', images_unavailable: 'This view cannot send photos; the brief alone will be used.', prompt_too_large: 'The model is too large to send back for editing. Remove parts and try again.', empty_completion: 'Claude returned nothing. Simplify the request and try again.', upstream_error: 'Claude could not be reached. Try again in a moment.' };
  showError(copy[code] || copy.upstream_error);
}

// ---------- export ----------
async function exportFile(kind) {
  const list = state.project.current, slug = slugify(list.name);
  let data, filename;
  if (kind === 'zip') {
    const zip = new JSZip();
    zip.file(`${slug}.stl`, writeBinaryStl(concatTriangles(state.items.map((it) => it.tris)), list.name));
    zip.file(`${slug}.json`, JSON.stringify(list, null, 2));
    zip.file('README.txt', readmeText({ list, result: state.result, layerUm: state.layerUm }));
    data = await zip.generateAsync({ type: 'blob' }); filename = `shapecast-${slug}.zip`;
  } else { data = JSON.stringify(list, null, 2); filename = `shapecast-${slug}.json`; }
  try { const r = await caps.downloads.save({ filename, data }); $('exportNote').textContent = r.status === 'saved' ? `Saved ${filename}.${kind === 'zip' ? ' Extract it and open the .stl in Chitubox.' : ''}` : ''; }
  catch (e) { const c = e?.code; $('exportNote').textContent = c === 'declined' ? 'Export cancelled.' : c === 'rate_limited' ? 'A save is already open; finish it first.' : c === 'unavailable' ? 'Saving files is unavailable in this view.' : `Export failed (${c}).`; if (c === 'unavailable') { $('exportBtn').disabled = true; $('exportJsonBtn').disabled = true; } }
}

// ---------- persistence ----------
const projectsCol = () => caps.db.doc(`data/users/${uid}/workspace`).collection('projects');
async function saveProject(_gen) {
  const snap = JSON.parse(JSON.stringify({ ...state.project, photos: undefined })); // synchronous snapshot of the state at this generation
  const unsaved = [...state.unsavedRevisions];
  for (const ph of state.project.photos) { if (ph.assetId || !ph.file) continue; try { const r = await caps.assets.upload(ph.file); ph.assetId = r.id; ph.error = null; } catch (e) { ph.error = e?.code || 'upload failed'; } }
  const pending = state.project.photos.filter((p) => !p.assetId).length; saveCtl.setPendingUploads(pending); renderThumbs();
  const doc = projectDocument({ ...snap, photoAssetIds: assetIds() });
  const size = checkDocumentSizes({ projectDoc: doc }); if (!size.ok) throw new Error(size.error);
  await projectsCol().doc(snap.id).set(doc);
  const revCol = projectsCol().doc(snap.id).collection('revisions');
  for (const rev of unsaved) { await revCol.doc(rev.id).set(rev.doc); state.unsavedRevisions = state.unsavedRevisions.filter((r) => r !== rev); }
  const all = await revCol.orderBy('at', 'asc').get();
  for (const d of all.docs.slice(0, Math.max(0, all.size - 20))) await revCol.doc(d.id).delete();
  if (pending) throw new Error(`${pending} photo${pending > 1 ? 's' : ''} not uploaded`);
}
function makeSaveCtl() {
  const ctl = createSaveController({ save: canPersist() ? saveProject : async () => {}, onChange: (s) => { $('saveState').textContent = !canPersist() ? 'local only' : s.error ? `Not saved: ${s.error.message}. Retry` : s.saving ? 'saving...' : s.dirty ? 'unsaved changes' : 'saved'; $('saveState').style.cursor = s.error ? 'pointer' : ''; } });
  if (!canPersist()) ctl.setAutosave(false);
  return ctl;
}
async function loadProjectList() {
  const q = await projectsCol().orderBy('updatedAt', 'desc').limit(50).get();
  const sel = $('projectSelect'); sel.innerHTML = '<option value="">New project</option>';
  for (const d of q.docs) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.data().name; sel.append(o); }
  return q.docs;
}
function installProject(project) {
  state.project = project; state.unsavedRevisions = []; state.selectedId = null; state.stale = null; $('staleCard').classList.add('hidden'); $('chatLog').innerHTML = ''; $('rawReply').textContent = '';
  tracker.setProject(project.id); saveCtl = makeSaveCtl(); $('projectSelect').value = canPersist() ? project.id : '';
  render(); viewport?.fit(state.result.bbox);
}
async function openProject(id) {
  const s = await projectsCol().doc(id).get();
  if (!s.exists) { showError('Project not found.'); return; }
  const d = s.data();
  const v = validatePartList(d.current); if (!v.ok) { showError(`Stored project is invalid: ${v.errors[0]}`); return; }
  installProject({ id, name: d.name, brief: d.brief ?? '', scaleRef: d.scaleRef ?? '', photos: (d.photoAssetIds ?? []).map((a) => ({ localId: a, assetId: a })), current: d.current, currentRevisionId: d.currentRevisionId ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt });
}
function requestSwitch(action) {
  if (!saveCtl.isDirty()) return action();
  state.pendingSwitch = action; $('switchText').textContent = canPersist() ? 'This project has unsaved changes.' : 'This session is local only; unsaved changes will be lost.';
  $('switchSave').classList.toggle('hidden', !canPersist()); $('switchSave').textContent = 'Save and switch'; $('switchDialog').classList.remove('hidden');
}
async function doSwitchSave() {
  document.querySelector('main').inert = true;
  const ok = await saveCtl.drain();
  document.querySelector('main').inert = false;
  if (ok) { $('switchDialog').classList.add('hidden'); await state.pendingSwitch(); }
  else { $('switchText').textContent = `Could not save: ${saveCtl.state().error?.message ?? 'uploads pending'}. Retry, discard the unsaved changes, or stay.`; $('switchSave').textContent = 'Retry'; }
}

// ---------- init ----------
async function init() {
  $('photoInput').addEventListener('change', (e) => { addPhotos([...e.target.files]); e.target.value = ''; });
  const well = $('dropWell');
  well.addEventListener('dragover', (e) => { e.preventDefault(); well.classList.add('over'); }); well.addEventListener('dragleave', () => well.classList.remove('over'));
  well.addEventListener('drop', (e) => { e.preventDefault(); well.classList.remove('over'); addPhotos([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))); });
  for (const id of ['projectName', 'brief', 'scaleRef']) $(id).addEventListener('change', metaChange);
  $('buildBtn').addEventListener('click', () => runInference('build'));
  $('sendBtn').addEventListener('click', () => { const t = $('chatInput').value.trim(); if (!t) return; $('chatInput').value = ''; runInference('edit', t); });
  $('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('sendBtn').click(); });
  $('stopBtn').addEventListener('click', () => state.inference?.controller.abort());
  $('staleApply').addEventListener('click', () => { if (state.stale && applyList(state.stale.list, { request: state.stale.request })) addChat('claude', 'Older result applied.'); state.stale = null; $('staleCard').classList.add('hidden'); });
  $('staleDiscard').addEventListener('click', () => { state.stale = null; $('staleCard').classList.add('hidden'); });
  $('exportBtn').addEventListener('click', () => exportFile('zip')); $('exportJsonBtn').addEventListener('click', () => exportFile('json'));
  $('layerSelect').addEventListener('change', (e) => { state.layerUm = Number(e.target.value); try { localStorage.setItem('shapecast.layerUm', e.target.value); } catch { /* per-viewer convenience only */ } render(); });
  try { const l = localStorage.getItem('shapecast.layerUm'); if (l) { state.layerUm = Number(l); $('layerSelect').value = l; } } catch { /* ignore */ }
  $('fitBtn').addEventListener('click', () => viewport?.fit(state.result?.bbox)); for (const v of ['iso', 'top', 'front']) $(`${v}Btn`).addEventListener('click', () => viewport?.view(v));
  $('newProjectBtn').addEventListener('click', () => requestSwitch(async () => installProject(newProject())));
  $('projectSelect').addEventListener('change', (e) => { const id = e.target.value; requestSwitch(async () => (id ? openProject(id) : installProject(newProject()))); });
  $('switchSave').addEventListener('click', doSwitchSave);
  $('switchDiscard').addEventListener('click', async () => { $('switchDialog').classList.add('hidden'); await state.pendingSwitch(); });
  $('switchStay').addEventListener('click', () => { $('switchDialog').classList.add('hidden'); $('projectSelect').value = canPersist() ? state.project.id : ''; });
  $('saveState').addEventListener('click', () => { if (saveCtl?.state().error) saveCtl.saveNow(); });

  viewport = createViewport($('viewport'), { onSelect: (id) => { state.selectedId = id; render(); } });
  if (!viewport) $('viewNotice').classList.remove('hidden');
  installProject(newProject());

  await Promise.all(Object.keys(caps).map(async (n) => { caps[n] = (await window.claude?.use(n)) ?? null; }));
  if (caps.sample) { const lim = await caps.sample.limits().catch(() => null); imageLimits = lim?.images ?? null; if (!imageLimits) note('This view cannot send photos to Claude; the brief alone is used.'); else $('photoInput').accept = imageLimits.mediaTypes.join(','); setBusy(false, ''); }
  else setBusy(false, 'Claude is unavailable in this view; you can still edit and export.');
  if (!caps.downloads) { $('exportBtn').disabled = true; $('exportJsonBtn').disabled = true; $('exportNote').textContent = 'Saving files is unavailable in this view.'; }
  uid = caps.user ? await caps.user.id().catch(() => null) : null;
  if (canPersist()) { const docs = await loadProjectList(); if (docs.length) await openProject(docs[0].id); else installProject(state.project); }
  else { $('localBanner').classList.remove('hidden'); saveCtl = makeSaveCtl(); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
```

- [ ] **Step 2: Build and look once**

Run: `npm run format && npm run typecheck && npm test && npm run lint && npm run build`. Expected: PASS, `index.html` under 1 MB. Open `index.html` locally in a browser once (the capabilities resolve `null` there, so the page must show the sample model, the local-only banner, the parts table with editable fields, print chips, and disabled Build/Export). Fix anything visibly broken, rebuild, and do not loop beyond one more look.

- [ ] **Step 3: Commit**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "feat: wire capture, Claude inference, editing, export and persistence

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Publish, verify, hand off

**Files:**
- Create: `README.md` (what it is, how to build, where it is published, the acceptance notes)
- Create: `docs/acceptance/2026-10-xx-publish.md`

- [ ] **Step 1: Publish the artifact**

Artifact tool, `file_path: index.html`, `icon: "cube"`, `description: "Turn photos, sketches or a prompt into an editable 3D model and export a Chitubox-ready STL for the Elegoo Saturn 3"`, `capabilities: {sample:{}, downloads:true, db:{rules:[{path:"",read:"view",write:"admin"},{path:"data/users/{self}",write:"interact"}]}, assets:{}, user:{}}`. Record the URL in `README.md`.

- [ ] **Step 2: One functional pass (Done condition 3)**

Matthew opens the artifact, edits one field of the sample (so the project becomes dirty and autosaves), then: `ArtifactData` `list` on collection `data/users/<uid>/workspace/projects` must show one document whose `current.parts` has four entries. Also one `list` with a lower `as_level` (viewer) must show nothing, since the subtree is private. Record both results in `docs/acceptance/2026-10-xx-publish.md`.

- [ ] **Step 3: Real run**

Matthew photographs a small object next to a coin on the Pixel, enters the scale reference, builds, makes one chat edit, exports the zip, and opens the STL in Chitubox on AlienPC. Then opens the same artifact on the Surface and confirms the project appears with its photo (Done condition 5). Record in the same acceptance note, with the Chitubox screenshot.

- [ ] **Step 4: Commit and hand off**

```bash
git -C ~/projects/products/shapecast add -A && git -C ~/projects/products/shapecast commit -m "docs: add README and publish acceptance notes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then run `/next` for project `shapecast` with the artifact URL, the acceptance results, and the v2 backlog (subtractive parts and hollowing via a voxel pass, Kinect capture, re-sending stored photos to Claude).
