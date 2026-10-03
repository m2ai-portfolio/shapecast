# ShapeCast design spec

Date: 2026-10-03. Owner: Matthew. Status: v2, revised after Codex checkmate round 1.

## Goal

A Claude live artifact that turns a photo of a physical object, a photo or sketch of a place
or part, or a typed prompt into a clean, printable 3D model for resin printing on an Elegoo
Saturn 3 (12K) via Chitubox. It reproduces the loop in Claude's video "Claude Opus 5.5 turns
graphite into gravity" (2026-09-22): Claude reads a sketch, fixes scale from a known
reference, stands the object up as a 3D model, and iterates on it with the user.

Primary user: Matthew, as a personal maker tool. Secondary: a showable demo of live artifacts.

Devices: capture on a Google Pixel 10 XL or a USB/Wyze camera (photos saved then uploaded),
review on the Surface tablet, slice in Chitubox on AlienPC. Kinect capture is a roadmap item
and out of scope.

## Done condition (observable)

1. `npm test` passes in `~/projects/products/shapecast` (vitest over the pure modules).
2. `npm run build` produces `index.html` under 1 MB with no external script host other than
   cdnjs.cloudflare.com.
3. The artifact is published with capabilities `sample, downloads, db, assets, user`; one
   `ArtifactData` list of `data/users/<uid>/projects` after a Save shows the saved project.
4. Manual acceptance on AlienPC: the fixture zip `tests/fixtures/chitubox-acceptance.zip`
   (overlapping boxes, a cylinder joined to a box at 0.5 mm overlap, and the sample catapult
   arm) is opened in Chitubox, sliced at 50 um, and the layers through every overlap region
   show solid fill with no cavity or island. Matthew records pass or fail in
   `docs/acceptance/2026-10-xx-chitubox.md`. A fail blocks v1 and reopens the export strategy.
5. A project saved from the Pixel's browser reopens on the Surface with its photos and part
   list intact.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Geometry model | Scene-graph of additive primitives | Inspectable, editable per part, no CSG library needed, matches the video's block-by-block build |
| Mesh capture (photogrammetry) | Out of scope for v1 | Needs an external image-to-3D backend; Matthew chose clean parametric parts |
| Booleans / hollowing | v2 (voxel pass) | Schema reserves `role: "sub"` now so v2 adds no breaking change |
| Persistence | `db` + `assets` capabilities | Projects started on the Pixel must open on the Surface and AlienPC |
| Export container | `.zip` holding `.stl` + `.json` + `README.txt` | The downloads allowlist has no `.stl`; `.zip` is allowed |
| Libraries | Three.js 0.160.0 UMD and JSZip 3.10.1, both from cdnjs | Only approved CDN hosts load; esm.sh (used by the older f1tenth artifact) is blocked |

## Platform facts and where each is verifiable

The runtime type definitions for contract 0.2.67 are vendored at `docs/platform/0.2.67/`
(`claude.d.ts`, `sample.d.ts`, `downloads.d.ts`, `db.d.ts`, `assets.d.ts`, `user.d.ts`),
copied verbatim from the artifact-capabilities skill this session. Each claim below cites its
source. Anything marked ASSUMPTION is re-verified in the Phase 0 probe (see Plan).

| Claim | Source |
|---|---|
| `window.claude` exposes only `use(name)`; a capability resolves later and may be `null` | `claude.d.ts` |
| `sample(input, {onText, signal, images, modelTier, cache, tools})`; `sample.json` parses one JSON value; `sample.limits()` reports `images.{maxCount, maxInputBytes, mediaTypes}` only when images are allowed; images are downsized to about 1.2 MP; input text cap 256 KiB | `sample.d.ts` lines 8-13, 192, 306-321, 493-511 |
| sample error codes and the never-retry-from-code rule | `sample.d.ts` lines 538-629 |
| `downloads.save({filename, data})`; allowlist `gif png jpg jpeg webp mp4 webm txt json md docx pptx epub csv ttf html svg pdf xlsx zip`; viewer confirms; `declined` is a normal outcome | `downloads.d.ts` lines 18-35, 64-111 |
| `db.collection(path).doc(id)` get/set/update/delete/where/orderBy/limit/onSnapshot; rules fixed at publish; `data/users/{self}` is a private per-viewer subtree | `db.d.ts` lines 21-78, 420-503 |
| `assets.upload(blob)` resolves `{id, url}`; store the id, display from `"/_blob/" + id` | `assets.d.ts` lines 6, 33-41, 104 |
| `user.id()` resolves an opaque id or `null`; `user.me()` never null | `user.d.ts` lines 89-134 |
| Camera, microphone, WebRTC refused; file inputs, drag-drop and FileReader work | Artifact tool page contract (quoted in `docs/platform/page-contract.md`) |
| Scripts load only from cdnjs.cloudflare.com, cdn.jsdelivr.net/npm, unpkg.com, cdn.tailwindcss.com, code.jquery.com; fetch to any other host blocked | same |
| cdnjs serves `three.js/0.160.0/three.min.js` (UMD) and `jszip/3.10.1/jszip.min.js` | `curl -I` this session, HTTP 200 both; newer three.js releases on cdnjs ship module builds only |
| Saturn 3 (12K): 218.88 x 122.88 x 250 mm, 19 x 24 um XY pixel, 0.01 to 0.2 mm layers, Chitubox | elegoo.com product page; 3dpros.com spec sheet |
| ASSUMPTION: `<input type="file" capture="environment">` opens the Pixel camera inside the Claude Android app | Phase 0 probe |
| ASSUMPTION: `sample.limits().images` is present in the Claude app and desktop viewer Matthew uses | Phase 0 probe |

## Flow

```
 capture ──> Claude reads ──> part list (JSON, mm) ──> live 3D ──> edit / iterate ──> print check ──> .zip (STL + JSON)
 photo, sketch   vision +       primitives +           Three.js   chat or fields     Saturn 3 rules   Chitubox on AlienPC
 or prompt       scale ref      placement
```

1. **Capture.** One or more photos (file input or drop), an optional typed brief, and an
   optional scale reference ("the coin is 24.26 mm across"). With no reference Claude
   estimates and must list the estimate under `assumptions`.
2. **Read.** `sample.json` on the `complex` tier with the images, brief, scale reference, the
   Saturn 3 envelope, and the schema with one worked example. The reply is a full part list.
3. **Render.** Validate, build Three.js meshes on a build plate drawn at true Saturn 3 size
   (218.88 x 122.88 mm, 250 mm height ghosted), 10 mm grid, Z up, orbit/zoom/pan.
4. **Iterate.** Direct: edit size, position, rotation fields in the parts table. Chat: "make
   the slot 2 mm wider" sends the current part list plus the request on the `quick` tier and
   receives a full replacement list. Each accepted revision is kept.
5. **Print check.** Deterministic checks run on every change.
6. **Export.** Binary STL plus part-list JSON and README, zipped, offered via `downloads.save`.

## Part list schema

```json
{
  "name": "phone stand",
  "units": "mm",
  "parts": [
    {"id": "base", "type": "box", "size": [70, 60, 4], "pos": [0, 0, 2], "rot": [0, 0, 0], "role": "add"},
    {"id": "back", "type": "extrude", "profile": [[0,0],[40,0],[40,3],[0,3]], "height": 60,
     "pos": [-20, -28, 2], "rot": [90, 0, 0], "role": "add"}
  ],
  "assumptions": ["overall height estimated at 60 mm, no scale reference given"],
  "print": {"orientation": "flat", "suggestedLayerUm": 50}
}
```

### Local frames (what `pos` and `rot` mean, per type)

`pos` is the world position of the part's **local origin**; `rot` is Euler XYZ in degrees
applied about that origin, in the order X then Y then Z (Three.js `Euler` order "XYZ").
Local origins:

| type | fields | local origin and axes |
|---|---|---|
| `box` | `size: [x, y, z]` | centre of the box |
| `cylinder` | `radius`, `height`, optional `radiusTop` (0 allowed, gives a cone), `segments` | centre of the axis; axis is local Z; `radius` is the bottom (z = -height/2) radius |
| `cone` | `radius`, `height`, `segments` | same as cylinder with `radiusTop = 0` (alias kept for the model's convenience) |
| `sphere` | `radius`, `segments` | centre |
| `torus` | `radius` (ring), `tube`, `segments` | centre; ring lies in local XY |
| `extrude` | `profile: [[x,y],...]`, `height` | profile coordinates are local XY as written, extrusion from local z = 0 to z = height |
| `lathe` | `profile: [[r,z],...]`, `segments` | axis is local Z at r = 0; profile coordinates as written |
| `wedge` | `size: [x, y, z]` | centre of the bounding box; right-triangle prism, full height at -X face, zero at +X face |

The viewport and the exporter use one shared function `partToTriangles(part)` that returns
world-space triangles, so what is shown is what is exported.

### Validator rules (all enforced before any geometry is allocated)

- Top level: `name` string 1-80 chars; `units` exactly `"mm"`; `parts` array 1-200 entries;
  `assumptions` array of strings (may be empty); `print.orientation` in `flat|angled`;
  `print.suggestedLayerUm` one of 10, 30, 50, 100.
- Part: `id` string 1-40 chars matching `^[a-z0-9_-]+$`, unique within the list; `type` in
  the table above; `role` exactly `"add"` (`"sub"` is rejected with "subtractive parts arrive
  in v2"); `pos` and `rot` exact 3-tuples of finite numbers; `rot` within -360..360.
- Lengths (`size` entries, `radius`, `radiusTop`, `height`, `tube`): finite, 0.1 to 300 mm.
  `radiusTop` may be 0. `tube` < `radius` for torus.
- `segments`: integer 3 to 256, default 64.
- `profile`: 3 to 200 points, each an exact 2-tuple of finite numbers within -300..300;
  first point must not equal last (the polygon is implicitly closed); no two consecutive
  points equal; no self-intersection (O(n^2) segment test, adjacent edges excluded);
  non-zero signed area. Lathe profiles additionally require r >= 0 for every point and at
  least one point with r > 0.
- Triangle budget: the validator computes each part's triangle count from its type and
  `segments`/profile size (closed-form, no allocation) and rejects a list whose total exceeds
  1,000,000 triangles.
- Every rejection message names the part id and the field.

## Geometry contract (closed, consistently oriented shells)

Each part produces one closed, edge-manifold triangle shell with outward normals:

- `box`, `wedge`: explicit vertex lists, 12 and 8 triangles.
- `cylinder`/`cone`: side quads split into triangles, plus bottom and top fans. A zero
  `radiusTop` emits only the apex triangles (no degenerate top fan).
- `sphere`: UV sphere with pole fans, no zero-area triangles at the poles.
- `torus`: closed grid, both directions wrap.
- `extrude`: caps by ear-clipping triangulation of the validated simple polygon (own
  implementation, no Three.js dependency so it is testable in Node), side quads along the
  polygon edges. Cap winding is fixed from the profile's signed area so normals face out.
- `lathe`: the closed (r,z) polygon is revolved; each profile edge becomes a ring of quads.
  Edges with r = 0 at both ends produce no triangles; edges with r = 0 at one end produce a
  fan. The result is closed because the profile polygon is closed.
- After generation, each shell's signed volume is computed; a negative value flips every
  triangle. A `meshChecks(shell)` function verifies: every undirected edge is shared by
  exactly two triangles with opposite direction (welded by quantised vertex key at 1e-6 mm),
  no triangle has zero area, signed volume > 0. Tests run `meshChecks` on every type at
  several parameterisations, including `radiusTop = 0`, a thin disk, a profile with a
  concave notch, and a lathe profile touching the axis.

## Claude prompt contract

One builder prompt and one editor prompt, both plain strings assembled by the page:

- Role: a mechanical designer producing resin-printable parts for a Saturn 3.
- Inputs: what the images show, the user's brief, the scale reference or "none given".
- Rules: additive primitives only; walls at least 1.2 mm; parts must overlap by at least
  0.5 mm where they join so the shells fuse in the slicer; keep the model inside
  218 x 122 x 250 mm; prefer a flat, stable face on Z = 0; list every estimated dimension in
  `assumptions`; `print.orientation` is `flat` or `angled`.
- Output: the schema and local-frame table, one worked example, "reply with only the JSON".
- Editor prompt adds the current part list and the request, asking for a complete
  replacement list whose `assumptions` describe what changed.

Builder runs on `modelTier: "complex"`, editor on `"quick"` with `cache: false`. Both show
"Thinking..." until first text, offer Stop (new AbortController per call), and surface
`truncated` and every error code in plain language.

### Request lifecycle (stale responses, concurrency)

- One inference in flight at a time: Build and Send are disabled while a call runs; Stop
  aborts it.
- Every call captures a token `{projectId, revisionId}` at dispatch. On resolve, the page
  compares with the live `{projectId, revisionId}`. If either differs (project switched, or a
  direct field edit created a new revision meanwhile) the response is **not applied**; it is
  shown as a card "Result for an older revision" with Apply anyway and Discard.
- Direct edits during inference are allowed and bump `revisionId`.
- Tests: switch project mid-flight, Stop then new request, edit during inference, and the
  normal path, all with a fake `sample` that resolves on demand.

## UI

Single screen, three columns that stack to one at phone width.

- **Left: Capture.** Photo well (thumbnails, remove), scale reference field, brief textarea,
  Build button. Below it the revision chat: user requests and Claude's assumption notes.
- **Centre: Viewport.** Three.js canvas, build plate at true size with the 250 mm height as a
  ghost box, 10 mm grid, axis gizmo, selected part highlighted, bounding box readout in mm.
  Buttons: fit, top, front, iso.
- **Right: Parts and print.** Parts table (id, type, size/pos/rot numeric inputs, delete),
  assumptions panel (amber), print check chips, layer height selector, Export .zip, Export
  JSON, Save state, project picker.

Visual direction: a workshop instrument, not a marketing page. Neutral graphite greys with a
resin-amber accent, a condensed display face for the readouts, tabular numerals wherever
digits align. Light and dark themes via tokens per the artifact page contract.

## Print check (pure functions, run on every change)

| Check | Rule | Result |
|---|---|---|
| Fits build volume | world bounding box within 218.88 x 122.88 x 250 | red if not; amber "rotate 90 deg about Z fits" when swapped XY fits |
| Minimum feature | per type: box/wedge min(size); cylinder min(2r, 2*radiusTop if > 0, height); cone min(2r, height); sphere 2r; torus 2*tube; extrude min(height, polygonThickness(profile)); lathe polygonThickness(profile). `polygonThickness` = min distance from any vertex to any non-adjacent edge of the polygon (a conservative lower bound on local wall thickness) | under 0.8 mm red; 0.8 to 1.2 mm amber |
| Floating parts | Build a graph: nodes are parts, an edge where world bounding boxes overlap or touch within 0.5 mm. Connected components that contain no part whose box reaches z <= 0.5 mm are **unsupported groups** (red, lists the ids). Any bounding-box edge is a candidate contact, not proof: a component attached only through boxes whose primitives are both non-box types is reported amber "contact not confirmed" | red / amber |
| Overhang | for `flat` orientation, parts whose lowest z is above 0.5 mm and whose footprint is not covered by any part below | amber, "needs supports" |
| Volume | sum of analytic part volumes, labelled "summed primitive volume (upper bound; overlaps counted twice)" | mL, informational |
| Layers | ceil(height / layer height) for 10, 30, 50, 100 um | count, informational |
| Pixel note | "XY pixel 19 x 24 um" | informational |

Fixtures: suspended two-part group, two parts 0.4 mm apart (counts as touching), two parts
0.6 mm apart (floating), overlapping boxes whose contact is confirmed, a cylinder beside a
sphere whose boxes overlap but shells may not (amber), a 0.5 mm disk, a 1.0 mm wall extrude,
a model that fits only after rotation.

## Export

- STL: binary, little-endian, 80-byte header "ShapeCast <name>", uint32 triangle count, then
  each world-space triangle with its face normal and a zero attribute word. mm, Z up.
- Zip: `shapecast-<slug>.zip` with `<slug>.stl`, `<slug>.json`, and `README.txt` listing
  the assumptions, bounding box, orientation, layer height, and the print-check results.
- Delivered through `downloads.save`; `declined` and `unavailable` handled quietly.
- Acceptance fixture: `npm run fixture` writes `tests/fixtures/chitubox-acceptance.zip` with
  the three cases in the done condition. Its pass/fail in Chitubox decides whether additive
  multi-shell export stands (see Done condition 4).

## Persistence

Capabilities declared: `sample`, `downloads`, `db`, `assets`, `user`.

- `db` rules: `{path: "", read: "view", write: "admin"}` and
  `{path: "data/users/{self}", write: "interact"}`. Projects live at
  `data/users/<uid>/projects/<projectId>`.
- Identity: `uid = await user.id()`. If `user` or `db` or `assets` resolves `null`, or `uid`
  is `null`, Save is hidden and a banner says "Not signed in to Claude: this session is
  local only and will not sync". The page remains fully usable.
- Project document: `{name, brief, scaleRef, photoAssetIds[], current, revisions[],
  createdAt, updatedAt}`. Revisions capped at 20, oldest dropped.
- Save sequencing: photos upload first (`assets.upload`), then the project doc is written
  with the asset ids. A photo whose upload fails stays in memory marked "not uploaded" and
  the doc write still proceeds without it.
- Dirty state: every change sets `dirty`; a debounced (1.5 s) autosave writes when idle,
  one write at a time; a failed write keeps `dirty`, shows "Not saved, retry", and never
  discards in-memory state. Switching projects with `dirty` set shows an inline choice
  (Save and switch / Discard / Stay); `confirm()` is never used.
- Conflicts: last write wins. On open, if the stored `updatedAt` is newer than the
  in-memory copy's, the stored copy loads. No merging.
- The page opens with the most recently updated project if one exists, otherwise an empty
  state showing a sample part list (a 40 mm block and a catapult arm, marked "example").
- `localStorage` holds only the last layer height and view preset, wrapped in try/catch.

## Error handling

- Every `claude.use(...)` result is null-checked. Missing `sample` hides Build and the chat:
  "Claude is unavailable in this view; you can still edit and export". Missing `downloads`
  hides Export. Missing `db`/`assets`/`user` triggers the local-only banner.
- `sample` errors map to viewer copy by code. `invalid_json` keeps the raw reply in a
  collapsible panel with Try again. `refused` clears partial output.
- Validation failures name the part id and field and leave the previous good list rendered.
- Three.js init failure (no WebGL) keeps the parts table and export working with a notice.

## Repository layout and tooling

```
~/projects/products/shapecast/
  package.json        scripts: test (vitest run), lint (eslint .), typecheck (tsc -p jsconfig.json --noEmit),
                      format (prettier --write .), build (node scripts/build.mjs), fixture (node scripts/fixture.mjs)
  jsconfig.json       checkJs: true, target ES2022, lib DOM
  .prettierrc, eslint.config.js
  src/schema.js       validator (pure)
  src/geometry.js     partToTriangles, polygon triangulation, meshChecks, volumes (pure)
  src/printcheck.js   rules above (pure)
  src/stl.js          binary STL writer (pure)
  src/lifecycle.js    request token logic, autosave state machine (pure, injectable clocks)
  src/app.js          page glue: capabilities, Three.js, DOM
  src/page.html       markup, tokens, styles; `<!-- @inline src/*.js -->` markers
  scripts/build.mjs   inlines src/*.js into src/page.html and writes index.html
  scripts/fixture.mjs writes tests/fixtures/chitubox-acceptance.zip using src/stl.js
  tests/*.test.js     vitest
  docs/platform/      vendored runtime type definitions + page-contract.md
  docs/acceptance/    Chitubox slice results
```

Dev dependencies: vitest, eslint, prettier, typescript, jszip (for the fixture script only;
the page loads JSZip from cdnjs). No runtime dependencies.

## Plan

0. **Phase 0 probe (half a day).** Publish a 60-line probe artifact that declares the five
   capabilities and shows: `sample.limits()`, whether `use()` returned null for each, a file
   input with `capture="environment"`, and one `downloads.save` of a 1 KB zip. Matthew opens
   it on the Pixel and the Surface. Both ASSUMPTION rows above are resolved from what it
   shows. Deleted afterwards.
1. Repo scaffold and tooling (layout above), CI-free; `npm test` runs green on an empty suite.
2. `schema.js` with tests for every rejection class and the worked example.
3. `geometry.js`: per-type generation, ear clipping, `meshChecks`, volumes; tests per type.
4. `stl.js` and `scripts/fixture.mjs`; byte-length and round-trip tests; fixture zip written.
5. **Chitubox acceptance** on AlienPC (Done condition 4). Stop here if it fails.
6. `printcheck.js` with the fixtures listed.
7. `lifecycle.js` (tokens, autosave) with the four concurrency tests.
8. `page.html` + `app.js`: capture, viewport, parts table, prompts, export, persistence.
9. Build, preview once, publish; `ArtifactData` read after one Save (Done condition 3).
10. Cross-device check (Done condition 5), then `/next` handoff.

## Out of scope for v1

True mesh capture from photos, Kinect input, boolean subtraction and hollowing with drain
holes, support generation, direct file transfer to AlienPC, multi-user sharing.
