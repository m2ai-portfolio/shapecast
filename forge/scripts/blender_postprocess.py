"""
Headless Blender 4.x high-resolution post-processor for ShapeCast Forge on AlienPC.
Pipeline:
  1. Import Hunyuan3D GLB (or procedural scene) and join meshes.
  2. Scale longest horizontal dimension (X/Y) to target_mm, center XY, ground Z=0.
  3. High-resolution OpenVDB Voxel Remesh (grid_res=260, ~0.45 mm voxels) to make watertight & union parts.
  4. Separate loose shells and keep only the main solid body.
  5. Smooth at high resolution (4 iterations) to remove any voxel stepping while preserving sharp features.
  6. Adaptive Decimate (Collapse) to ~45,000 vertices (~90,000 triangles) so flat regions use large triangles
     and curved details/spokes/creases keep dense triangles, while staying under the 65,535 Uint16 vertex ceiling.
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
        "grid_res": 260,
        "max_verts": 48000,
        "smooth_iters": 3,
        "smooth_factor": 0.4,
        "aspect_target": "",
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
        elif a == "--max-verts" and i + 1 < len(argv):
            args["max_verts"] = int(argv[i + 1])
            i += 2
        elif a == "--smooth-iters" and i + 1 < len(argv):
            args["smooth_iters"] = int(argv[i + 1])
            i += 2
        elif a == "--smooth-factor" and i + 1 < len(argv):
            args["smooth_factor"] = float(argv[i + 1])
            i += 2
        elif a == "--aspect-target" and i + 1 < len(argv):
            args["aspect_target"] = argv[i + 1]
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


def compute_quality_metrics(obj):
    """Compute geometric quality diagnostics: sharp crease %, bilateral symmetry, and normalized aspect ratio."""
    import math
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.edges.ensure_lookup_table()
    bm.verts.ensure_lookup_table()

    # 1. Crease / feature sharpness (% of edges with dihedral angle between 18 deg and 85 deg)
    crease_edges = 0
    total_edges = max(1, len(bm.edges))
    for e in bm.edges:
        if len(e.link_faces) == 2:
            try:
                ang = math.degrees(e.calc_face_angle())
                if 18.0 <= ang <= 85.0:
                    crease_edges += 1
            except ValueError:
                pass
    crease_pct = round(100.0 * crease_edges / total_edges, 2)

    # 2. Bilateral symmetry across the narrower horizontal axis
    bmin, bmax = get_world_bbox(obj)
    dx = max(1e-6, bmax[0] - bmin[0])
    dy = max(1e-6, bmax[1] - bmin[1])
    dz = max(1e-6, bmax[2] - bmin[2])
    # Symmetry plane is along the narrower horizontal axis (width)
    sym_axis = 1 if dx >= dy else 0
    pos_sum = 0.0
    neg_sum = 0.0
    pos_cnt = 0
    neg_cnt = 0
    for v in bm.verts:
        val = v.co[sym_axis]
        if val >= 0:
            pos_sum += val
            pos_cnt += 1
        else:
            neg_sum += abs(val)
            neg_cnt += 1
    bm.free()

    avg_pos = pos_sum / max(1, pos_cnt)
    avg_neg = neg_sum / max(1, neg_cnt)
    cnt_ratio = min(pos_cnt, neg_cnt) / max(1, max(pos_cnt, neg_cnt))
    span_ratio = min(avg_pos, avg_neg) / max(1e-6, max(avg_pos, avg_neg))
    symmetry_score = round(100.0 * (0.5 * cnt_ratio + 0.5 * span_ratio), 1)

    major_h = max(dx, dy)
    minor_h = min(dx, dy)
    return {
        "crease_edge_pct": crease_pct,
        "symmetry_score": symmetry_score,
        "aspect_ratio": [1.0, round(minor_h / major_h, 3), round(dz / major_h, 3)],
    }


def clean_non_manifold_bmesh(obj):
    """Ensure the mesh is strictly 2-manifold (no boundary edges, wire edges, or pinched vertices)."""
    for _ in range(4):
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-4)
        bmesh.ops.dissolve_degenerate(bm, dist=1e-4, edges=bm.edges)

        # Delete loose verts/edges/faces
        loose_verts = [v for v in bm.verts if not v.link_faces]
        if loose_verts:
            bmesh.ops.delete(bm, geom=loose_verts, context="VERTS")

        # Check if any non-manifold edges or verts exist
        non_manifold_verts = [v for v in bm.verts if not v.is_manifold]
        non_manifold_edges = [e for e in bm.edges if not e.is_manifold]
        if not non_manifold_verts and not non_manifold_edges:
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            bm.to_mesh(obj.data)
            bm.free()
            return True

        # Fill any boundary holes
        boundary_edges = [e for e in bm.edges if e.is_boundary]
        if boundary_edges:
            bmesh.ops.holes_fill(bm, edges=boundary_edges, sides=0)

        bmesh.ops.triangulate(bm, faces=bm.faces)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(obj.data)
        bm.free()

    bm = bmesh.new()
    bm.from_mesh(obj.data)
    ok = all(v.is_manifold for v in bm.verts) and all(e.is_manifold for e in bm.edges)
    bm.free()
    return ok


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
    raw_faces = len(obj.data.polygons)
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

    # 1. High-resolution OpenVDB Voxel Remesh (default grid_res=260 -> ~0.45 mm voxels)
    bmin, bmax = get_world_bbox(obj)
    max_span = max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2], 10.0)
    fine_res = max(180, min(380, int(args["grid_res"])))
    voxel_size = max(0.22, max_span / float(fine_res))

    remesh = obj.modifiers.new(name="ShapeCastVoxelRemesh", type="REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = voxel_size
    remesh.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier=remesh.name)

    # 2. Separate loose shells and keep largest connected solid
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

    # 3. Configurable Smooth (fewer iterations in crisp refinement mode preserves sharp body creases)
    if args["smooth_iters"] > 0 and args["smooth_factor"] > 0:
        smooth = main_obj.modifiers.new(name="ShapeCastSmooth", type="SMOOTH")
        smooth.factor = max(0.05, min(1.0, float(args["smooth_factor"])))
        smooth.iterations = max(1, min(12, int(args["smooth_iters"])))
        bpy.ops.object.modifier_apply(modifier=smooth.name)

    # 4. Adaptive Decimate (Collapse) so vertex count <= max_verts (~48,000-60,000) for Uint16 packing
    cur_verts = len(main_obj.data.vertices)
    max_v = max(15000, min(63000, int(args["max_verts"])))
    if cur_verts > max_v:
        dec = main_obj.modifiers.new(name="ShapeCastDecimate", type="DECIMATE")
        dec.decimate_type = "COLLAPSE"
        dec.ratio = max(0.05, min(0.95, float(max_v) / float(cur_verts)))
        dec.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=dec.name)

    tri = main_obj.modifiers.new(name="ShapeCastTriangulate", type="TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri.name)

    manifold_ok = clean_non_manifold_bmesh(main_obj)

    # Re-scale exact target_mm (and optional aspect_target [1.0, width_ratio, height_ratio]) and ground at Z=0
    bmin, bmax = get_world_bbox(main_obj)
    sx = max(bmax[0] - bmin[0], 1e-6)
    sy = max(bmax[1] - bmin[1], 1e-6)
    sz = max(bmax[2] - bmin[2], 1e-6)
    s2 = args["target_mm"] / max(sx, sy)
    scale_vec = [s2, s2, s2]

    if args["aspect_target"]:
        try:
            parts_ar = [float(x.strip()) for x in args["aspect_target"].split(",") if x.strip()]
            if len(parts_ar) == 3 and parts_ar[0] > 0 and parts_ar[1] > 0 and parts_ar[2] > 0:
                # Normalize relative to major horizontal axis
                r_width = parts_ar[1] / parts_ar[0]
                r_height = parts_ar[2] / parts_ar[0]
                target_major = args["target_mm"]
                target_minor = args["target_mm"] * max(0.15, min(1.0, r_width))
                target_z = args["target_mm"] * max(0.10, min(1.5, r_height))
                if sx >= sy:
                    scale_vec = [target_major / sx, target_minor / sy, target_z / sz]
                else:
                    scale_vec = [target_minor / sx, target_major / sy, target_z / sz]
        except Exception:
            pass

    main_obj.scale = tuple(scale_vec)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

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
    q_metrics = compute_quality_metrics(main_obj)
    summary = {
        "ok": True,
        "manifold": manifold_ok,
        "raw_faces": raw_faces,
        "faces": len(main_obj.data.polygons),
        "vertices": len(main_obj.data.vertices),
        "voxel_size_mm": round(voxel_size, 4),
        "bbox_size_mm": [
            round(bmax[0] - bmin[0], 2),
            round(bmax[1] - bmin[1], 2),
            round(bmax[2] - bmin[2], 2),
        ],
        "quality_metrics": q_metrics,
    }
    print("BLENDER_POSTPROCESS_JSON:" + json.dumps(summary))


if __name__ == "__main__":
    main()
