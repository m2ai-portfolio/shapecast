# ShapeCast

A Claude live artifact that turns photos, sketches or a typed brief into an editable,
primitive-based 3D model and exports a Chitubox-ready STL (inside a zip) sized for the
Elegoo Saturn 3 (12K). Modelled on Claude's "turns graphite into gravity" demo: read the
object, fix scale from a known reference, stand it up as blocks, iterate.

- Spec: `docs/superpowers/specs/2026-10-03-shapecast-design.md` (v6, Codex checkmate reviewed)
- Plan: `docs/superpowers/plans/2026-10-03-shapecast.md`
- Published artifact: see `docs/acceptance/` (URL recorded at publish time)

## Build and test

```bash
npm install
npm run format && npm run typecheck && npm test && npm run lint
npm run build      # inlines src/*.js into src/page.html -> index.html
npm run fixture    # writes tests/fixtures/chitubox-acceptance.zip
```

`index.html` is the single file the Artifact tool publishes. Scripts load only from cdnjs
(Three.js 0.160.0 UMD, JSZip 3.10.1). Runtime capabilities: `sample` (Claude vision),
`downloads` (zip export), `db` + `assets` + `user` (private per-viewer projects).

## Layout

| File                  | Role                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `src/schema.js`       | part-list validator, limits, triangle and byte budgets                     |
| `src/geometry.js`     | primitives to triangles, transforms, manifold checks, analytic volumes     |
| `src/printcheck.js`   | Saturn 3 build-volume, feature size, contact graph, overhang, layer counts |
| `src/stl.js`          | binary STL writer                                                          |
| `src/lifecycle.js`    | request tokens (stale replies) and generation-based autosave               |
| `src/prompts.js`      | builder and editor prompts for Claude                                      |
| `src/exportbundle.js` | slug and README text for the export zip                                    |
| `src/model.js`        | field edits, image preparation, document size guards, sample model         |
| `src/viewport.js`     | Three.js scene with a true-size Saturn 3 plate                             |
| `src/app.js`          | DOM glue, capabilities, persistence                                        |
| `docs/platform/`      | vendored artifact runtime type definitions (contract 0.2.67)               |

## Acceptance gates (manual)

1. Phase 0 probe on the Pixel and the Surface (`docs/acceptance/*-phase0.md`).
2. Chitubox slice of `tests/fixtures/chitubox-acceptance.zip` on AlienPC: every overlap region
   must slice solid (`docs/acceptance/*-chitubox.md`).
3. After publish: one `ArtifactData` read of `data/users/<uid>/workspace/projects` after a save,
   one real photo-to-print run, one cross-device reopen.
