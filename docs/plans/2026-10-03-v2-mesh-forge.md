# ShapeCast v2: mesh forge plan

Date: 2026-10-03. Owner: Matthew. Produced with /marks-plan. Status: proposed, not started.

## Problem, reframed

v1 has Claude place primitives blind. That works for blocks and functional parts and fails for
organic shapes: the stored Corvette had a slab body with vertical walls, wheels buried inside it,
and two of three wedges reversed. Real shapes need a generated mesh. The artifact cannot reach a
generator directly (no image input on the account, no fetch outside the CDN allowlist), so v2 is
mostly a bridge problem.

## Decisions (Matthew, this session)

| Decision | Choice |
|---|---|
| Front door | Keep the ShapeCast artifact |
| Generator | Local Hunyuan3D on AlienPC |
| Bridge | claude.ai custom connector (remote MCP), so Pixel, Surface and desktop all work |
| Approach | A: new "forge" MCP server on ProBook, exposed on a new Funnel path |
| First input | Text idea (prompt to image to mesh); photos follow |
| Print prep | Repair, scale, plate placement, fit check. Hollowing and supports stay in Chitubox |
| AlienPC busy or off | Fail fast with a clear message, no queue |
| Print file | Written to a folder on AlienPC; the artifact gets a preview mesh and the file name |
| Scenes | Deferred to v3 |
| Kept from v1 | Parametric primitive mode for functional parts, STL writer, Saturn 3 checks |

## Verified facts (this session)

- AlienPC: RTX 5080 16 GB; ComfyUI 0.37.0 running, reachable from ProBook at `10.0.0.24:8188`.
- No Hunyuan3D or TRELLIS weights on AlienPC. Installed: HunyuanVideo 1.5, Flux 1 dev, Qwen Image.
- ComfyUI core has the nodes: `EmptyLatentHunyuan3Dv2`, `Hunyuan3Dv2Conditioning`,
  `Hunyuan3Dv2ConditioningMultiView`, `VAEDecodeHunyuan3D`, `VoxelToMesh`, `VoxelToMeshBasic`,
  `SaveGLB`, `MeshToFile3D` (GLB only), `GetMeshInfo`.
- Weights: `Comfy-Org/hunyuan3D_2.1_repackaged/hunyuan_3d_v2.1.safetensors`, 7,365,943,290 bytes.
- Funnel live at `https://im4tlai-dev.tail2efc28.ts.net` with `/` and `/hook` in use.
- `coordination-mcp` was retired 2026-09-04 (endpoint returns 530). Its `src/oauth.ts` (472 lines,
  OAuth 2.1 + PKCE + DCR) is in `~/projects/_archive/coordination-mcp/` and is reused as a template,
  not revived.
- npm: `manifold-3d` 3.5.4, `@gltf-transform/core` 4.5.1, `@modelcontextprotocol/sdk` 1.32.0.

## Unverified, resolved by Phase 0

- Shape generation peak VRAM and time on the 5080.
- Which model folder and loader the official ComfyUI Hunyuan3D 2.1 template expects.
- claude.ai custom connector auth requirements and whether the archived OAuth satisfies them.
- Largest tool result an artifact can receive through the `mcp` capability (sets the preview size).
- Hunyuan3D community license terms for personal use in the US.

## Architecture

```
artifact (any device)
   | mcp capability, claude.ai custom connector "ShapeCast Forge"
   v
forge MCP server (ProBook, pm2, Funnel path /forge, OAuth)
   |-- forge_status   : ComfyUI reachable? GPU queue empty?  (fail fast otherwise)
   |-- forge_generate : prompt + target size -> job id
   |-- forge_job      : status, preview mesh (decimated), bbox, checks, print file name
   v
ComfyUI on AlienPC (LAN 10.0.0.24:8188, never exposed)
   Flux text->image -> background removal -> Hunyuan3D 2.1 shape -> SaveGLB
   v
forge post-process (ProBook): GLB -> manifold repair -> scale to target mm -> drop to z=0
   -> Saturn 3 fit check (v1 printcheck) -> binary STL (v1 stl.js) -> scp to AlienPC
   C:\Users\matth\Documents\ShapeCast\<date>-<slug>.stl
```

The forge only ever submits its own fixed workflow template. User text goes into the prompt field
only. ComfyUI is never on the Funnel.

## Phases, war game and exit criteria

### Phase 0: probes (no product code)
- Optimistic: weights fit, template runs first try, connector accepts the archived OAuth.
- Pessimistic: 2.1 does not fit 16 GB, and claude.ai needs OAuth details the archive lacks.
- Steps: download weights; run the official template by hand on a Flux image; record VRAM and
  time. Stand up a hello-world MCP on `/forge` with the archived OAuth, add it as a claude.ai
  connector, call it from a scratch artifact that returns 100 KB, 500 KB and 2 MB payloads.
- Done when: one GLB of a car exists on AlienPC; the scratch artifact got a tool result on the
  Pixel; the largest payload that arrived is recorded.
- Take budget: 2 attempts per probe, then escalate with the error.

### Phase 1: forge core as a CLI
- Optimistic: GLB repairs cleanly, scaling is a uniform factor.
- Pessimistic: meshes need voxel remeshing; background removal fails on busy Flux images.
- Steps: `forge "a 2020 C8 Corvette" --length 150` runs the whole pipeline and writes the STL.
- Done when: three prompts (car, figurine, mug) produce STLs that pass the manifold check and
  slice in Chitubox.
- Take budget: 3 pipeline revisions.

### Phase 2: MCP server and OAuth
- Optimistic: archived OAuth drops in.
- Pessimistic: Funnel cert or claude.ai DCR quirks.
- Done when: `forge_status` answers from the Pixel's Claude app, and returns "AlienPC unavailable"
  within 5 seconds when ComfyUI is stopped.
- Take budget: 3 attempts.

### Phase 3: artifact integration
- A "Generate mesh" mode beside v1's parametric mode; preview in the existing viewport; Saturn 3
  checks on the preview bbox; file name and path shown. Export from the artifact only when the
  preview is the full mesh.
- Done when: a text prompt in the artifact produces a sliceable file on AlienPC end to end.
- Take budget: 2 review rounds.

### Phase 4: photo input
- Photo travels as a tool argument, sized by the Phase 0 payload result, into
  `Hunyuan3Dv2Conditioning` instead of the Flux image.
- Done when: a photo of a real object on the Pixel produces a sliceable file.

## Failure table

| Scenario | Detect | Recover |
|---|---|---|
| 2.1 does not fit 16 GB | ComfyUI history error / OOM in Phase 0 | Hunyuan3D-2mini, or lower octree resolution |
| AlienPC off, asleep or gaming | `/system_stats` timeout or `/queue` non-empty | Fail fast: "AlienPC unavailable, try later" |
| Funnel has no cert | curl exit 35, TLS alert 80 | `tailscale cert`; check status.tailscale.com |
| claude.ai rejects connector auth | connector error in claude.ai settings | Compare against the archived Spark-proven OAuth; fix metadata |
| Payload limit below preview size | Phase 0 probe | Decimate harder, or send silhouette plus bbox only |
| Mesh not repairable | manifold status not NoError | Voxel remesh fallback, else report and keep the GLB |
| Busy or multi-object Flux image | empty or multiple mesh components | Prompt template "single object, plain white background"; keep largest component |
| Wrong scale | user target missing | Default longest side 120 mm; show bbox before writing |
| Prompt injection via text field | n/a, fixed workflow | Text only reaches the CLIP prompt input |
| Internet-facing service abuse | Funnel access logs | OAuth required; forge exposes three tools only; ComfyUI stays LAN-only |
| License restricts use | Phase 0 read of LICENSE | Switch to TRELLIS (MIT) |

## Governance

- Owner: Matthew. Sink: `C:\Users\matth\Documents\ShapeCast\` and pm2 logs. Kill: `pm2 stop forge`
  and remove the `/forge` Funnel path.
- No queue, no cron, no loop, so no Teletraan or No Orphan Loops overlap.
- Displaces: v1's Claude-built geometry for organic objects. v1 stays for exact-size parts.

## Explicitly not doing

Scenes (v3), texture generation, hollowing in the pipeline, cloud generators, reviving
coordination-mcp, exposing ComfyUI to the internet.

## First concrete next step

Phase 0a: download `hunyuan_3d_v2.1.safetensors` to AlienPC and run the official ComfyUI
Hunyuan3D 2.1 template once by hand on a Flux image of a car, recording peak VRAM and time.

## Phase 0a results (2026-10-03, executed)

| Item | Result |
|---|---|
| Weights | `hunyuan_3d_v2.1.safetensors` in `ComfyUI\models\checkpoints`, 7,365,943,290 bytes (matches Hugging Face); listed by `ImageOnlyCheckpointLoader` |
| Background removal | `birefnet.safetensors` (Comfy-Org/BiRefNet, MIT) in `ComfyUI\models\background_removal`, 444,473,596 bytes |
| Reference image | Flux 1 dev fp8, 1024 px, 30 steps: about 65 s cold, faster warm. Prompt must ask for the whole object small in frame or the tail gets cropped |
| Shape generation | Hunyuan3D 2.1, octree 256, 30 steps: 33 to 36 s, **peak VRAM 10.4 to 10.9 GB** of 16 GB |
| Ground slab | Without background removal Hunyuan3D rebuilds the floor shadow as a thin plate under the object. BiRefNet mask composited onto white removes it |
| Proportions (C8, 150 mm) | 66 x 150 x 40 mm; width/length 0.44 vs real 0.42, height/length 0.26 vs real 0.27 |
| Mesher | `surface net` is smooth but non-manifold (52,019 bad edges, 15,274 pinched vertices on the C8). `basic` is near-manifold after welding but voxel-stepped (about 0.6 mm steps at 150 mm). Repair is the core Phase 1 problem |
| License | Hunyuan3D 2.1 community license: excludes EU, UK, South Korea; 1M MAU commercial cap; outputs must not train other models. Fine for personal US use |
| Saved workflows | `forge/workflows/flux_text_to_reference.api.json`, `forge/workflows/hunyuan3d21_image_to_mesh.api.json` (placeholders `PROMPT`, `INPUT_IMAGE.png`, `OUTPUT`) |
| Test print file | `C:\Users\matth\Documents\ShapeCast\2026-10-03-c8-hunyuan3d-150mm.stl` (unrepaired surface-net mesh, for a Chitubox slice test) |

Phase 0a exit criterion met (a GLB of a car exists on AlienPC; VRAM and time recorded). Phase 0b
(claude.ai connector, payload size) not started.

## Phase 0b results (2026-10-04, executed)

| Item | Result |
|---|---|
| Port | claude.ai's connector service only egresses on 443. Port 10000 received zero requests; moved to Funnel 443 under `/forge` (prefix stripped) plus mounts for `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (issuer-with-path discovery). Ollama's `/` mount untouched |
| Connector URL | `https://im4tlai-dev.tail2efc28.ts.net/forge/mcp` |
| Auth | claude.ai auto-detected "Sign in now" + "Use Claude's published identity" (CIMD). Its hosted client id is `https://claude.ai/oauth/mcp-oauth-client-metadata`; fetched and accepted. Owner passphrase entered by Matthew; token issued 03:22 UTC; survives restarts |
| Status tool | Works end to end from an artifact: AlienPC available, RTX 5080, ComfyUI 0.37.0 |
| Result size | Intact at 64 KB, 256 KB, 512 KB, 1 MB, 2 MB, 4 MB. 8 MB fails: "Anthropic proxy: MCP server response stalled while streaming a large body". Note each result carried the data twice (text block + structuredContent), so the real ceiling per copy is between 4 and 8 MB. Design rule: preview payloads at most 2 MB, sent once |
| File arguments | `listTools().fileArgs` is false in the Chrome artifact view, so photos go inline (1 MiB input limit). Page shrinks to a JPEG under 700 KB first |
| Photo path | First probe build overflowed the stack encoding base64 (page bug). Fixed with FileReader + canvas shrink; verified locally with a stub connector (124 KB and 4000x3000 PNG -> 658 KB JPEG, checksums match). Real claude.ai run pending |
