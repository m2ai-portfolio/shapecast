# ShapeCast design spec

Date: 2026-10-03. Owner: Matthew. Status: approved in conversation, pending written review.

## Purpose

A Claude live artifact that turns a photo of a physical object, a photo or sketch of a
place or part, or a typed prompt into a clean, printable 3D model for resin printing on an
Elegoo Saturn 3 (12K) via Chitubox. It reproduces the loop shown in Claude's video "Claude
Opus 5.5 turns graphite into gravity" (2026-09-22): Claude reads a sketch, fixes scale from a
known reference, stands the object up as a 3D model, and iterates on it with the user.

Primary user: Matthew, as a personal maker tool. Secondary: a showable demo of live artifacts.

Devices: capture on a Google Pixel 10 XL or a USB/Wyze camera (photos saved then uploaded),
review on the Surface tablet, slice in Chitubox on AlienPC. Kinect capture is a roadmap item
and out of scope.

## Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Geometry model | Scene-graph of additive primitives | Inspectable, editable per part, no CSG library needed, matches the video's block-by-block build |
| Mesh capture (photogrammetry) | Out of scope for v1 | Needs an external image-to-3D backend; Matthew chose clean parametric parts |
| Booleans / hollowing | v2 (voxel pass) | Schema reserves `role: "sub"` now so v2 adds no breaking change |
| Persistence | `db` + `assets` capabilities | Projects started on the Pixel must open on the Surface and AlienPC |
| Export container | `.zip` holding `.stl` + `.json` | The downloads allowlist has no `.stl`; `.zip` is allowed |
| Libraries | Three.js 0.160.0 UMD and JSZip 3.10.1, both from cdnjs | Only approved CDN hosts load; esm.sh (used by the older f1tenth artifact) is blocked |

## Verified platform facts (read this session)

- Artifact pages cannot use the camera, microphone or WebRTC. Photos arrive through
  `<input type="file" accept="image/*" capture="environment">` or drag-and-drop. On Android
  the file input opens the camera directly.
- `sample` capability: `sample.json(input, {images, modelTier, signal, onText, cache})`.
  Images are allowed only when `sample.limits()` reports `images`; each is downsized to about
  1.2 MP. No system prompt; every instruction travels in the input. Errors reject with
  `{code, message, text?}`; never retry from code.
- `downloads.save({filename, data})` allowlist: `gif png jpg jpeg webp mp4 webm txt json md`
  plus `docx pptx epub csv ttf html svg pdf xlsx zip`. The viewer confirms each save.
- `db`: `db.collection(path).doc(id)` with get/set/update/delete/where/orderBy/limit/
  onSnapshot. Rules are fixed at publish. `data/users/<id>/...` is private per viewer.
- `assets.upload(blob)` returns `{id, url}`; store the `id` in db rows and render from
  `"/_blob/" + id`.
- `window.claude` exposes only `use(name)`; every capability resolves later and may be `null`.
- cdnjs serves `three.js/0.160.0/three.min.js` (UMD global `THREE`) and
  `jszip/3.10.1/jszip.min.js` (UMD global `JSZip`). OrbitControls is not in the UMD core; a
  small orbit controller is written inline.
- Elegoo Saturn 3 (12K): build volume 218.88 x 122.88 x 250 mm, XY pixel 19 x 24 um,
  layer height 0.01 to 0.2 mm, slicer Chitubox (.ctb). Sources: elegoo.com product page,
  3dpros.com spec sheet.

## Flow

```
 capture ──> Claude reads ──> part list (JSON, mm) ──> live 3D ──> edit / iterate ──> print check ──> .zip (STL + JSON)
 photo, sketch   vision +       primitives +           Three.js   chat or fields     Saturn 3 rules   Chitubox on AlienPC
 or prompt       scale ref      placement
```

1. **Capture.** One or more photos (file input or drop), an optional typed brief, and an
   optional scale reference ("the coin is 24.26 mm across", "the card is 85.6 mm wide").
   With no reference Claude estimates and must list the estimate under `assumptions`.
2. **Read.** The page calls `sample.json` on the `complex` tier with the images, the brief,
   the scale reference, the Saturn 3 envelope and the schema with one worked example. The
   reply is a full part list.
3. **Render.** The part list is validated, then built into Three.js meshes on a build plate
   drawn at true Saturn 3 size (218.88 x 122.88 mm, 250 mm height ghosted), 10 mm grid,
   Z up, orbit/zoom/pan.
4. **Iterate.** Two paths. Direct: edit size, position, rotation fields in the parts table.
   Chat: type "make the slot 2 mm wider"; the page sends the current part list plus the
   request on the `quick` tier and receives a full replacement list. Each revision is kept.
5. **Print check.** Deterministic checks run on every change (section below).
6. **Export.** Binary STL (one shell per part, mm, Z up) plus the part-list JSON, zipped and
   offered through `downloads.save`. The user extracts and opens the STL in Chitubox.

## Part list schema

```json
{
  "name": "phone stand",
  "units": "mm",
  "parts": [
    {"id": "base", "type": "box", "size": [70, 60, 4], "pos": [0, 0, 2], "rot": [0, 0, 0], "role": "add"},
    {"id": "back", "type": "extrude", "profile": [[0,0],[40,0],[40,3],[0,3]], "height": 60,
     "pos": [0, -28, 32], "rot": [0, 0, 0], "role": "add"}
  ],
  "assumptions": ["overall height estimated at 60 mm, no scale reference given"],
  "print": {"orientation": "flat", "suggestedLayerUm": 50}
}
```

Part types and required fields (all lengths in mm, angles in degrees, `pos` is the part's
centre, `rot` is Euler XYZ):

| type | fields |
|---|---|
| `box` | `size: [x, y, z]` |
| `cylinder` | `radius`, `height`, optional `radiusTop` for tapers, `segments` (default 64) |
| `cone` | `radius`, `height`, `segments` |
| `sphere` | `radius`, `segments` |
| `torus` | `radius`, `tube`, `segments` |
| `extrude` | `profile: [[x,y],...]` (closed polygon in XY, no self-intersection), `height` along Z |
| `lathe` | `profile: [[r,z],...]` revolved around Z, `segments` |
| `wedge` | `size: [x, y, z]`, right-triangle prism, slope along +X |

`role` is `"add"` in v1. `"sub"` is reserved and rejected by the v1 validator with a message
naming the part. `name`, `units: "mm"`, `parts` (1 to 200 entries), and `assumptions` are
required. Unknown types, non-finite numbers, zero or negative dimensions, and profiles with
fewer than 3 points are rejected with the part id in the message.

## Claude prompt contract

One builder prompt and one editor prompt, both plain strings assembled by the page:

- Role statement: a mechanical designer producing resin-printable parts for a Saturn 3.
- Inputs: what the images show, the user's brief, the scale reference or "none given".
- Rules: additive primitives only; walls at least 1.2 mm; parts must overlap by at least
  0.5 mm where they join so the shells fuse in the slicer; keep the whole model inside
  218 x 122 x 250 mm; prefer a flat, stable face on Z = 0; list every estimated dimension in
  `assumptions`; `print.orientation` is `flat` or `angled`.
- Output: the schema above, one worked example, "reply with only the JSON object".
- Editor prompt adds the current part list and the user's request, and asks for a complete
  replacement list with `assumptions` describing what changed.

Builder runs on `modelTier: "complex"`, editor on `"quick"`, with `cache: false` for edits.
Both show "Thinking..." until first text, offer Stop (AbortController per call), and surface
`truncated` and every error code in plain language.

## UI

Single screen, three columns that stack to one at phone width.

- **Left: Capture.** Photo well (thumbnails, remove), scale reference field, brief textarea,
  Build button. Below it the revision chat: user requests and Claude's assumption notes.
- **Centre: Viewport.** Three.js canvas, build plate at true size with the 250 mm height
  shown as a ghost box, 10 mm grid, axis gizmo, selected part highlighted, bounding box
  readout in mm. Buttons: fit, top, front, iso.
- **Right: Parts and print.** Parts table (id, type, size/pos/rot numeric inputs, delete),
  assumptions panel (amber), print check chips, layer height selector, Export .zip,
  Export JSON, Save project, project picker.

Visual direction: a workshop instrument, not a marketing page. Neutral graphite greys with a
resin-amber accent, a condensed display face for the readouts, tabular numerals everywhere
digits align. Light and dark themes via tokens per the artifact page contract.

## Print check (pure functions, run on every change)

| Check | Rule | Result |
|---|---|---|
| Fits build volume | bounding box within 218.88 x 122.88 x 250 | red if not; amber with "rotate 90 deg about Z fits" when the swapped XY fits |
| Minimum feature | any `size`, `radius*2`, `tube*2`, or profile edge thickness under 0.8 mm | red; 0.8 to 1.2 mm amber |
| Floating parts | a part whose bounding box touches neither Z = 0 nor another part's box (0.5 mm tolerance) | amber, names the part |
| Overhang | for `flat` orientation, parts whose underside is above Z = 0 and not covered by another part | amber, "needs supports" |
| Volume | sum of analytic part volumes | mL, informational |
| Layers | ceil(height / layer height) for 10, 30, 50, 100 um | count, informational |
| Pixel resolution note | states 19 x 24 um XY pixel | informational |

## Export

- STL: binary, little-endian, 80-byte header "ShapeCast <name>", triangle count, then each
  part's world-space triangles with per-face normals. Units mm, Z up (Chitubox default).
- Zip: `shapecast-<slug>.zip` containing `<slug>.stl`, `<slug>.json`, and `README.txt`
  listing the assumptions, bounding box, and the recommended orientation and layer height.
- Delivered through `downloads.save`; `declined` and `unavailable` are handled quietly.

## Persistence

Capabilities declared: `sample`, `downloads`, `db`, `assets`, `user`.

- `db` rules: `{path: "", read: "view", write: "admin"}` and
  `{path: "data/users/{self}", write: "interact"}`. Projects live at
  `data/users/<uid>/projects/<projectId>` so they are private to the viewer.
- Project document: `{name, brief, scaleRef, photoAssetIds[], current: partList,
  revisions: [{at, request, partList, assumptions}], createdAt, updatedAt}`. Revisions are
  capped at 20; older ones are dropped oldest first.
- Photos: `assets.upload(file)`; the returned `id` goes in `photoAssetIds`; thumbnails render
  from `/_blob/<id>`.
- The page opens with the most recently updated project if one exists, otherwise a designed
  empty state that shows a sample part list (a 40 mm block and a catapult arm, marked
  "example") so the viewport is never blank.
- Browser `localStorage` holds only the last selected layer height and view preset,
  wrapped in try/catch.

## Error handling

- Every `claude.use(...)` result is null-checked. Missing `sample` hides Build and the chat
  and shows "Claude is unavailable in this view; you can still edit and export the sample".
  Missing `downloads` hides Export. Missing `db`/`assets` hides Save and shows a note.
- `sample` errors map to viewer copy by code. `invalid_json` keeps the raw reply in a
  collapsible panel with a Try again button. `refused` clears partial output.
- Validation failures name the part id and field and leave the previous good part list
  rendered.
- Three.js init failure (no WebGL) shows the parts table and export still working, with a
  notice in the viewport area.

## Testing

Pure modules live in `src/` and are concatenated into `index.html` by a small build script,
so they can be unit tested with vitest without a browser:

- `schema.js`: validator accepts the worked example, rejects each failure class.
- `geometry.js`: triangle generation per type; triangle counts and bounding boxes for known
  shapes; a 10 mm cube has volume 1000 mm3 within tolerance.
- `stl.js`: binary STL byte length equals 84 + 50 * triangles; header and count parse back.
- `printcheck.js`: each rule exercised in its red, amber, and green state, including the
  rotate-to-fit suggestion.
- `zip.js` (JSZip wrapper): archive lists the three expected entries.

Repo loop per the products group CLAUDE.md: `prettier --write`, `tsc --noEmit` (JS with
checkJs), `vitest run`, `eslint`. The artifact itself gets one preview render before publish
and one `ArtifactData` read after the first publish, as the capability rules require.

## Out of scope for v1

True mesh capture from photos, Kinect input, boolean subtraction and hollowing with drain
holes, support generation, direct file transfer to AlienPC, multi-user sharing.
