/**
 * Headless Blender post-processing, written into each job directory and run with
 * `blender --background --factory-startup --python postprocess.py -- <args>`.
 *
 * Takes the raw COLMAP mesh (PLY with vertex colours) and produces:
 *  - model.glb   decimated, coloured mesh for the web explorer
 *  - model.stl   solidified, voxel-remeshed watertight mesh scaled to print size in mm
 *  - model.blend both meshes, millimetre units, vertex-colour material
 */
export const BLENDER_SCRIPT = String.raw`
import bpy, bmesh, sys, json, math
import numpy as np
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, out_dir, target_faces, print_mm, kind = argv[0], argv[1], int(argv[2]), float(argv[3]), argv[4]
cloud = argv[5] if len(argv) > 5 else None  # fused.ply, used to colour meshes that lack colours
print_faces = int(argv[6]) if len(argv) > 6 else target_faces  # 0 target_faces keeps the view mesh whole

def log(msg):
    print("[postprocess] " + msg, flush=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.unit_settings.system = 'METRIC'
scene.unit_settings.length_unit = 'MILLIMETERS'
scene.unit_settings.scale_length = 0.001

log("importing " + src)
bpy.ops.wm.ply_import(filepath=src)
obj = bpy.context.selected_objects[0]
obj.name = "Scan"
me = obj.data
log("imported %d vertices, %d faces" % (len(me.vertices), len(me.polygons)))

# --- Delaunay meshes have no colours: borrow them from the nearest fused points ---
def read_ply_points(path):
    with open(path, "rb") as f:
        header = []
        while True:
            line = f.readline().decode("ascii").strip()
            header.append(line)
            if line == "end_header":
                break
        types = {"float": "<f4", "double": "<f8", "uchar": "u1", "int": "<i4", "uint": "<u4"}
        props = [l.split()[1:] for l in header if l.startswith("property")]
        count = int(next(l for l in header if l.startswith("element vertex")).split()[2])
        dtype = np.dtype([(name, types[t]) for t, name in props])
        return np.fromfile(f, dtype=dtype, count=count)

def transfer_colours(me, cloud_path, k=4):
    pts = read_ply_points(cloud_path)
    if "red" not in pts.dtype.names:
        return
    from scipy.spatial import cKDTree
    xyz = np.stack([pts["x"], pts["y"], pts["z"]], axis=1)
    rgb = np.stack([pts["red"], pts["green"], pts["blue"]], axis=1).astype(np.float32) / 255
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    _, idx = cKDTree(xyz).query(co.reshape(-1, 3), k=k, workers=-1)
    srgb = rgb[idx].mean(axis=1)
    rgba = np.ones((len(me.vertices), 4), dtype=np.float32)
    rgba[:, :3] = srgb
    layer = me.color_attributes.new("Col", 'BYTE_COLOR', 'POINT')
    layer.data.foreach_set("color_srgb", rgba.ravel())
    me.color_attributes.active_color = layer
    log("coloured %d vertices from %d dense points" % (len(me.vertices), len(xyz)))

if cloud and not me.color_attributes:
    transfer_colours(me, cloud)

# --- keep only the large connected pieces (photogrammetry leaves floating noise) ---
def drop_small_islands(me, keep_ratio=0.02):
    n = len(me.vertices)
    if n == 0 or len(me.edges) == 0:
        return
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    a, b = edges[0::2], edges[1::2]
    labels = np.arange(n, dtype=np.int64)
    for _ in range(2000):
        m = np.minimum(labels[a], labels[b])
        before = labels.copy()
        np.minimum.at(labels, a, m)
        np.minimum.at(labels, b, m)
        labels = labels[labels]  # pointer jumping speeds up convergence
        if np.array_equal(before, labels):
            break
    ids, counts = np.unique(labels, return_counts=True)
    largest = counts.max()
    keep = set(ids[counts >= largest * keep_ratio].tolist())
    drop = np.array([l not in keep for l in labels.tolist()])
    if not drop.any():
        return
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.nonzero(drop)[0]], context='VERTS')
    bm.to_mesh(me)
    bm.free()
    log("removed %d noise vertices in %d islands" % (int(drop.sum()), len(ids) - len(keep)))

drop_small_islands(me)

# --- orientation: COLMAP's aligned frame has gravity along +Y, Blender is Z-up ---
obj.matrix_world = Matrix.Rotation(-math.pi / 2, 4, 'X') @ obj.matrix_world
bpy.context.view_layer.objects.active = obj
obj.select_set(True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# --- scale so the longest side is print_mm, centre on XY, sit on Z=0 ---
co = np.empty(len(me.vertices) * 3, dtype=np.float64)
me.vertices.foreach_get("co", co)
co = co.reshape(-1, 3)
lo, hi = co.min(axis=0), co.max(axis=0)
size = float((hi - lo).max()) or 1.0
s = print_mm / size
centre = (lo + hi) / 2
obj.matrix_world = Matrix.Diagonal((s, s, s, 1.0)) @ Matrix.Translation(Vector((-centre[0], -centre[1], -lo[2])))
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
log("scaled to %.1f mm longest side" % print_mm)

# --- decimate the coloured mesh for viewing ---
def decimate(o, faces):
    count = sum(len(p.vertices) - 2 for p in o.data.polygons)  # in triangles
    if count > faces:
        mod = o.modifiers.new("Decimate", 'DECIMATE')
        mod.ratio = faces / count
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
        log("decimated %s %d -> %d faces" % (o.name, count, len(o.data.polygons)))

if target_faces > 0:
    decimate(obj, target_faces)

# vertex-colour material so the .blend and the GLB both show the captured colours
mat = bpy.data.materials.new("ScanColour")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes.get("Principled BSDF")
attr = nt.nodes.new("ShaderNodeVertexColor")
if me.color_attributes:
    attr.layer_name = me.color_attributes[0].name
nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.9
me.materials.append(mat)
# smooth shading shares vertices between faces, roughly halving the GLB size
me.shade_smooth()

# --- printable solid: thicken, then voxel remesh into one watertight manifold ---
printable = obj.copy()
printable.data = obj.data.copy()
printable.name = "Printable"
printable.data.materials.clear()
scene.collection.objects.link(printable)
solid = printable.modifiers.new("Solidify", 'SOLIDIFY')
solid.thickness = max(print_mm * 0.012, 1.2)
solid.offset = -1 if kind == 'interior' else 1
remesh = printable.modifiers.new("Remesh", 'REMESH')
remesh.mode = 'VOXEL'
remesh.voxel_size = print_mm / 450
bpy.context.view_layer.objects.active = printable
for m in list(printable.modifiers):
    bpy.ops.object.modifier_apply(modifier=m.name)
decimate(printable, print_faces)
log("printable mesh has %d faces" % len(printable.data.polygons))

def only(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o

only(printable)
bpy.ops.wm.stl_export(filepath=out_dir + "/model.stl", export_selected_objects=True, ascii_format=False)
log("wrote model.stl")

only(obj)
gltf = dict(filepath=out_dir + "/model.glb", export_format='GLB', use_selection=True, export_yup=True)
draco = dict(export_draco_mesh_compression_enable=True, export_draco_mesh_compression_level=6)
for extra in (dict(export_vertex_color='ACTIVE', **draco), draco, {}):
    try:
        bpy.ops.export_scene.gltf(**extra, **gltf)
        break
    except (TypeError, RuntimeError) as e:
        log("glTF export retry without %s: %s" % (list(extra), e))
log("wrote model.glb")

printable.hide_set(True)
bpy.ops.wm.save_as_mainfile(filepath=out_dir + "/model.blend", compress=True)
log("wrote model.blend")

with open(out_dir + "/postprocess.json", "w") as f:
    dims = [round(v, 2) for v in printable.dimensions]
    json.dump({"dimensionsMm": dims, "faces": len(me.polygons), "printableFaces": len(printable.data.polygons)}, f)
`;
