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
        "grid_res": 512,
        "stl_max_verts": 160000,
        "max_verts": 46000,
        "smooth_iters": 1,
        "smooth_factor": 0.15,
        "sharpen_iters": 0,
        "sharpen_factor": 0.0,
        "planar_deg": 0.0,
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
        elif a == "--stl-max-verts" and i + 1 < len(argv):
            args["stl_max_verts"] = int(argv[i + 1])
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
        elif a == "--sharpen-iters" and i + 1 < len(argv):
            args["sharpen_iters"] = int(argv[i + 1])
            i += 2
        elif a == "--sharpen-factor" and i + 1 < len(argv):
            args["sharpen_factor"] = float(argv[i + 1])
            i += 2
        elif a == "--planar-deg" and i + 1 < len(argv):
            args["planar_deg"] = float(argv[i + 1])
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


def sharpen_creases_bmesh(obj, iterations=2, strength=0.35):
    """
    3D Unsharp Mask / Crease Enhancer on the decimated mesh:
    Sharpens ridges (rafters, roof eaves, window mullions) and deepens recessed grooves
    while guaranteeing zero flipped triangles and 100% manifold topology.
    """
    import math
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    for _ in range(max(1, min(5, int(iterations)))):
        bm.normal_update()
        deltas = {}
        for v in bm.verts:
            if not v.is_manifold or len(v.link_edges) < 3:
                continue
            # Check if vertex participates in at least one feature crease edge (>= 14 deg)
            max_ang = 0.0
            for e in v.link_edges:
                if len(e.link_faces) == 2:
                    try:
                        ang = math.degrees(e.calc_face_angle())
                        if ang > max_ang:
                            max_ang = ang
                    except ValueError:
                        pass
            if max_ang < 14.0:
                continue

            # Compute neighbor centroid
            nb_sum = Vector((0.0, 0.0, 0.0))
            for e in v.link_edges:
                nb_sum += e.other_vert(v).co
            nb_avg = nb_sum / float(len(v.link_edges))

            # Unsharp displacement: push vertex away from local Laplacian average along normal component
            lap = v.co - nb_avg
            n = v.normal
            proj = lap.dot(n) * n
            # Weight by crease sharpness (stronger on 25-90 deg architectural edges)
            w = min(1.0, (max_ang - 12.0) / 45.0) * float(strength)
            deltas[v.index] = proj * w

        # Apply deltas safely: revert any vertex whose move would invert or degenerate an adjacent face
        for idx, delta in deltas.items():
            v = bm.verts[idx]
            old_co = v.co.copy()
            old_normals = [f.normal.copy() for f in v.link_faces]
            v.co = old_co + delta
            valid = True
            for f, old_n in zip(v.link_faces, old_normals):
                f.normal_update()
                if f.calc_area() < 1e-6 or f.normal.dot(old_n) < 0.35:
                    valid = False
                    break
            if not valid:
                v.co = old_co
                for f in v.link_faces:
                    f.normal_update()

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(obj.data)
    bm.free()


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

    # 1. Ultra-fine OpenVDB Voxel Remesh (default grid_res=512 -> ~0.23 mm voxels)
    bmin, bmax = get_world_bbox(obj)
    max_span = max(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2], 10.0)
    fine_res = max(220, min(520, int(args["grid_res"])))
    voxel_size = max(0.14, max_span / float(fine_res))

    remesh = obj.modifiers.new(name="ShapeCastVoxelRemesh", type="REMESH")
    remesh.mode = "VOXEL"
    remesh.voxel_size = voxel_size
    remesh.adaptivity = 0.0
    bpy.ops.object.modifier_apply(modifier=remesh.name)

    # 2. Separate loose shells and keep main body + any substantial detail parts (>= 0.5% of main body)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=1e-4)
    bpy.ops.mesh.separate(type="LOOSE")
    bpy.ops.object.mode_set(mode="OBJECT")

    parts = [o for o in bpy.context.scene.objects if o.type == "MESH" and len(o.data.polygons) > 0]
    parts.sort(key=lambda o: len(o.data.polygons), reverse=True)
    max_part_faces = len(parts[0].data.polygons)
    keep_parts = [parts[0]]
    for extra in parts[1:]:
        if len(extra.data.polygons) >= max(400, int(max_part_faces * 0.005)):
            keep_parts.append(extra)
        else:
            bpy.data.objects.remove(extra, do_unlink=True)

    bpy.ops.object.select_all(action="DESELECT")
    for kp in keep_parts:
        kp.select_set(True)
    bpy.context.view_layer.objects.active = keep_parts[0]
    if len(keep_parts) > 1:
        bpy.ops.object.join()
    main_obj = bpy.context.view_layer.objects.active

    # 3a. Micro De-Staircase pass (removes sub-voxel stepping without rounding features)
    if args["smooth_iters"] > 0 and args["smooth_factor"] > 0:
        smooth = main_obj.modifiers.new(name="ShapeCastSmooth", type="SMOOTH")
        smooth.factor = max(0.05, min(0.5, float(args["smooth_factor"])))
        smooth.iterations = max(1, min(4, int(args["smooth_iters"])))
        bpy.ops.object.modifier_apply(modifier=smooth.name)

    # Apply exact uniform target_mm scaling (preserving true 1:1:1 isotropic proportions) and ground Z=0
    bmin, bmax = get_world_bbox(main_obj)
    sx = max(bmax[0] - bmin[0], 1e-6)
    sy = max(bmax[1] - bmin[1], 1e-6)
    s2 = args["target_mm"] / max(sx, sy)
    main_obj.scale = (s2, s2, s2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

    bmin, bmax = get_world_bbox(main_obj)
    cx = 0.5 * (bmin[0] + bmax[0])
    cy = 0.5 * (bmin[1] + bmax[1])
    main_obj.location = (-cx, -cy, -bmin[2])
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    # 4a. Planar Decimate on near-coplanar micro-faces if requested
    if args.get("planar_deg", 0) > 0:
        import math
        planar = main_obj.modifiers.new(name="ShapeCastPlanar", type="DECIMATE")
        planar.decimate_type = "DISSOLVE"
        planar.angle_limit = math.radians(max(1.0, min(8.0, float(args["planar_deg"]))))
        bpy.ops.object.modifier_apply(modifier=planar.name)
        tri_pre = main_obj.modifiers.new(name="ShapeCastTriPre", type="TRIANGULATE")
        bpy.ops.object.modifier_apply(modifier=tri_pre.name)

    # 4b. Tier 1: Ultra-HD Decimate (~160,000 verts / ~320,000 tris) for direct AlienPC STL printing
    cur_verts = len(main_obj.data.vertices)
    stl_max_v = max(46000, min(300000, int(args.get("stl_max_verts", 160000))))
    if cur_verts > stl_max_v:
        dec_hd = main_obj.modifiers.new(name="ShapeCastDecimateHD", type="DECIMATE")
        dec_hd.decimate_type = "COLLAPSE"
        dec_hd.ratio = max(0.05, min(0.98, float(stl_max_v) / float(cur_verts)))
        dec_hd.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=dec_hd.name)

    tri_hd = main_obj.modifiers.new(name="ShapeCastTriHD", type="TRIANGULATE")
    bpy.ops.object.modifier_apply(modifier=tri_hd.name)

    if args.get("sharpen_iters", 0) > 0 and args.get("sharpen_factor", 0) > 0:
        sharpen_creases_bmesh(
            main_obj,
            iterations=max(2, int(args["sharpen_iters"]) * 2),
            strength=max(0.30, float(args["sharpen_factor"])),
        )

    clean_non_manifold_bmesh(main_obj)

    # Re-ground Z=0 before Ultra-HD STL export
    bmin, bmax = get_world_bbox(main_obj)
    cx = 0.5 * (bmin[0] + bmax[0])
    cy = 0.5 * (bmin[1] + bmax[1])
    main_obj.location = (-cx, -cy, -bmin[2])
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    stl_faces = len(main_obj.data.polygons)
    stl_vertices = len(main_obj.data.vertices)
    stl_written = False
    if args["output_stl"]:
        os.makedirs(os.path.dirname(os.path.abspath(args["output_stl"])), exist_ok=True)
        bpy.ops.wm.stl_export(
            filepath=args["output_stl"],
            export_selected_objects=True,
            ascii_format=False,
        )
        stl_written = os.path.exists(args["output_stl"])

    # 5. Tier 2: Adaptive QEM Decimate to <= max_verts (~46,000 verts / ~92,000 tris) for fast MCP preview
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

    if args.get("sharpen_iters", 0) > 0 and args.get("sharpen_factor", 0) > 0:
        sharpen_creases_bmesh(
            main_obj,
            iterations=2,
            strength=max(0.24, float(args["sharpen_factor"]) * 0.85),
        )

    manifold_ok = clean_non_manifold_bmesh(main_obj)

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

    bmin, bmax = get_world_bbox(main_obj)
    q_metrics = compute_quality_metrics(main_obj)
    q_metrics["stl_faces"] = stl_faces
    q_metrics["stl_vertices"] = stl_vertices
    q_metrics["grid_res"] = fine_res
    summary = {
        "ok": True,
        "manifold": manifold_ok,
        "raw_faces": raw_faces,
        "stl_faces": stl_faces,
        "stl_vertices": stl_vertices,
        "stl_written": stl_written,
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
