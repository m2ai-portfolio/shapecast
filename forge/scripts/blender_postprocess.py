"""
Headless Blender 4.x post-processor for ShapeCast Forge on AlienPC.
Usage:
  blender.exe --background --python blender_postprocess.py -- \
    --input C:/Users/matth/ComfyUI/output/shapecast/in.glb \
    --output-glb C:/Users/matth/ComfyUI/output/shapecast/out_blender.glb \
    --output-stl C:/Users/matth/Documents/ShapeCast/out.stl \
    --target-mm 120
"""
import sys
import os
import json
import bpy
import bmesh
from mathutils import Vector


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []
    args = {
        "input": "",
        "output_glb": "",
        "output_stl": "",
        "target_mm": 120.0,
        "grid_res": 150,
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--input" and i + 1 < len(argv):
            args["input"] = argv[i + 1]
            i += 2
        elif a == "--output-glb" and i + 1 < len(argv):
            args["output_glb"] = argv[i + 1]
            i += 2
        elif a == "--output-stl" and i + 1 < len(argv):
            args["output_stl"] = argv[i + 1]
            i += 2
        elif a == "--target-mm" and i + 1 < len(argv):
            args["target_mm"] = float(argv[i + 1])
            i += 2
        elif a == "--grid-res" and i + 1 < len(argv):
            args["grid_res"] = int(argv[i + 1])
            i += 2
        else:
            i += 1
    return args


def get_world_bbox(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    return (min(xs), min(ys), min(zs)), (max(xs), max(ys), max(zs))


def main():
    args = parse_args()
    if not args["input"] or not os.path.exists(args["input"]):
        raise RuntimeError(f"Input file not found: {args['input']}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=args["input"])

    mesh_objs = [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.polygons) > 0]
    if not mesh_objs:
        raise RuntimeError("No mesh objects found in imported GLB")

    bpy.ops.object.select_all(action="DESELECT")
    for o in mesh_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objs[0]
    if len(mesh_objs) > 1:
        bpy.ops.object.join()

    obj = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Scale longest horizontal dimension (X or Y) to target_mm before voxel remesh
    bmin, bmax = get_world_bbox(obj)
    sx = bmax[0] - bmin[0]
    sy = bmax[1] - bmin[1]
    horiz = max(sx, sy, 1e-6)
    scale_factor = args["target_mm"] / horiz
    obj.scale = (scale_factor, scale_factor, scale_factor)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    # Center XY at origin and ground Z at 0
    bmin, bmax = get_world_bbox(obj)
    cx = 0.5 * (bmin[0] + bmax[0])
    cy = 0.5 * (bmin[1] + bmax[1])
    obj.location = (-cx, -cy, -bmin[2])
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    # 1. Native C++ OpenVDB Voxel Remesh (unions overlapping parts & welds faces)
    bmin, bmax = get_world_bbox(obj)
    max_span = max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2], 10.0)
    voxel_size = max(0.35, max_span / float(args["grid_res"]))

    remesh = obj.modifiers.new(name="ShapeCastVoxelRemesh", type="REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = voxel_size
    remesh.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier=remesh.name)

    # 2. Separate loose shells after voxel remesh and keep largest connected solid
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=1e-4)
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")

    parts = [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.polygons) > 0]
    parts.sort(key=lambda o: len(o.data.polygons), reverse=True)
    main_obj = parts[0]
    for extra in parts[1:]:
        bpy.data.objects.remove(extra, do_unlink=True)

    bpy.ops.object.select_all(action="DESELECT")
    main_obj.select_set(True)
    bpy.context.view_layer.objects.active = main_obj

    # 3. Smooth + Triangulate
    smooth = main_obj.modifiers.new(name="ShapeCastSmooth", type="SMOOTH")
    smooth.factor = 0.45
    smooth.iterations = 3
    bpy.ops.object.modifier_apply(modifier=smooth.name)

    tri = main_obj.modifiers.new(name="ShapeCastTriangulate", type="TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)

    # Clean normals & re-ground at Z=0
    bm = bmesh.new()
    bm.from_mesh(main_obj.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(main_obj.data)
    bm.free()

    bmin, bmax = get_world_bbox(main_obj)
    cx = 0.5 * (bmin[0] + bmax[0])
    cy = 0.5 * (bmin[1] + bmax[1])
    main_obj.location = (-cx, -cy, -bmin[2])
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    if args["output_glb"]:
        os.makedirs(os.path.dirname(os.path.abspath(args["output_glb"])), exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=args["output_glb"],
            export_format="GLB",
            use_selection=True,
        )

    if args["output_stl"]:
        os.makedirs(os.path.dirname(os.path.abspath(args["output_stl"])), exist_ok=True)
        bpy.ops.wm.stl_export(
            filepath=args["output_stl"],
            export_selected_objects=True,
            ascii_format=False,
        )

    bmin, bmax = get_world_bbox(main_obj)
    summary = {
        "ok": True,
        "faces": len(main_obj.data.polygons),
        "vertices": len(main_obj.data.vertices),
        "voxel_size_mm": round(voxel_size, 4),
        "bbox_size_mm": [
            round(bmax[0] - bmin[0], 2),
            round(bmax[1] - bmin[1], 2),
            round(bmax[2] - bmin[2], 2),
        ],
    }
    print("BLENDER_POSTPROCESS_JSON:" + json.dumps(summary))


if __name__ == "__main__":
    main()
