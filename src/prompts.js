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
