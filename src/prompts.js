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
  const photos =
    imageCount > 0
      ? `You are given ${imageCount} photo${imageCount === 1 ? '' : 's'} of the object or sketch to reproduce.`
      : 'No photos are given; work from the brief alone.';
  const scale =
    scaleRef && scaleRef.trim()
      ? `Scale reference: ${scaleRef.trim()}. Use it to fix real dimensions.`
      : 'No scale reference was given: estimate real-world dimensions and list every estimate in assumptions.';
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

export function blenderPrompt({ brief, scaleRef }) {
  return `You are a 3D CAD & Blender 4.3 Python (bpy) engineer building a single connected, watertight 3D mesh for an Elegoo Saturn 3 resin printer.
Brief: ${brief && brief.trim() ? brief.trim() : '(none)'}
Scale reference: ${scaleRef && scaleRef.trim() ? scaleRef.trim() : '120 mm longest horizontal dimension'}

Write a self-contained Blender 4.3 Python script in "pythonCode" that builds the requested 3D object using bpy.ops.meshprimitives, bmesh, modifiers (SUBSURF, BEVEL, BOOLEAN, SOLIDIFY), or procedural geometry.
Rules for pythonCode:
- Do NOT call bpy.ops.wm.read_factory_settings or export functions (the runner clears the scene before your code and exports all MESH objects after).
- Make sure all parts overlap so they form a single connected solid when voxel-remeshed.
- Use Z as up, units in millimetres.

Return ONLY a JSON object with this schema:
{
  "name": string (1-60 chars),
  "pythonCode": string (valid Blender 4.3 Python script using bpy/bmesh/mathutils)
}`;
}

export function criticPrompt({
  brief,
  scaleRef,
  userFeedback,
  bbox,
  triangleCount,
  volumeMl,
  qualityMetrics,
  iteration = 1,
  threshold = 85,
  hasPhotos = false,
  hasRenderView = false,
}) {
  const sizeStr = bbox?.size ? bbox.size.map((x) => Number(x).toFixed(2)).join(' x ') : 'unknown';
  const sx = bbox?.size?.[0] || 120,
    sy = bbox?.size?.[1] || 60,
    sz = bbox?.size?.[2] || 40;
  const majorH = Math.max(sx, sy, 1e-6);
  const minorH = Math.min(sx, sy);
  const currentAspect = [1.0, +(minorH / majorH).toFixed(3), +(sz / majorH).toFixed(3)];
  return `You are a 3D Mesh Quality Critic & Refinement Agent inspecting a generated 3D print model for an Elegoo Saturn 3 resin printer.
Compare the current 3D mesh output against the user's reference brief/photo and determine what is missing, out of place, distorted in proportion, or lacking surface definition.

Reference Brief: ${brief && brief.trim() ? brief.trim() : '(from uploaded reference photo)'}
Scale Reference: ${scaleRef && scaleRef.trim() ? scaleRef.trim() : '120 mm longest side'}
${userFeedback ? `Specific User Refinement Request: ${userFeedback}\n` : ''}Visual Inputs Attached: ${hasPhotos ? 'Reference photo included. ' : ''}${hasRenderView ? '4-view 3D viewport render included.' : 'Using 3D geometric telemetry.'}

Current 3D Mesh Telemetry (Iteration ${iteration}):
- Bounding box (mm): ${sizeStr}
- Normalized aspect ratio [length, width/length, height/length]: ${JSON.stringify(currentAspect)}
- Triangle count: ${triangleCount ?? 0}
- Volume: ${volumeMl ?? 0} mL
- Blender 3D Quality Metrics: ${JSON.stringify(qualityMetrics ?? {})}
- Quality threshold to pass: ${threshold} / 100

Evaluation Guidelines:
1. Check real-world proportions: Single-view 3D generators often inflate the width/depth by 8-15% (for example, a real C8 Corvette is 4630 x 1934 x 1234 mm -> aspect ratio [1.0, 0.418, 0.267]). Always compute the true real-world [1.0, width/length, height/length] ratio for the subject in "aspectRatioTarget".
2. Check surface & crease definition: If crease_edge_pct < 11 or triangleCount < 95000 on a detailed hard-surface/mechanical/vehicle model, or if smoothing softened crisp intakes/spokes/panel lines, recommend "refine_remesh" with higher gridRes (320-340), maxVerts (58000), and crisp smoothing (smoothIterations: 1, smoothFactor: 0.22).
3. Choose "action":
   - "accept": if score >= ${threshold} and no user feedback requests further changes.
   - "refine_remesh": (FAST 3-second Blender pass on raw mesh) if the core 3D shape is present, or on Iteration 1 when proportions (aspectRatioTarget) and crisp hard-surface crease definition (gridRes 320, smoothIterations 1, maxVerts 58000) will elevate the model above threshold.
   - "regenerate_mesh": (90-second ComfyUI Hunyuan3D + Flux pass) ONLY if major structural geometry is completely missing or wrong, or if the user explicitly asked for a different design/pose. Provide a detailed "refinedPrompt" that calls out every missing feature, deep recesses, sharp edges, and clean 3/4 orthographic-style framing.

Return ONLY a JSON object matching this exact schema:
{
  "score": integer (0 to 100),
  "meetsThreshold": boolean,
  "critique": string (concise 1-2 sentence assessment of current mesh vs reference),
  "missingOrOutOfPlace": [ string (up to 4 specific items that are missing, out of proportion, or need sharper definition) ],
  "action": "accept" | "refine_remesh" | "regenerate_mesh",
  "refinedPrompt": string (enriched prompt emphasizing missing details and crisp edges),
  "remeshParams": {
    "gridRes": integer (360 to 500, use 480 for ultra-crisp architectural/hard-surface refinement),
    "maxVerts": integer (45000 to 46000),
    "smoothIterations": integer (0 to 4, use 1 for crisp hard-surface or 2 for organic),
    "smoothFactor": number (0.10 to 0.5, use 0.16 for ultra-crisp creases),
    "aspectRatioTarget": [1.0, number (0.2 to 1.0), number (0.15 to 1.5)]
  },
  "octreeResolution": integer (448 to 512),
  "steps": integer (36 to 45)
}`;
}
