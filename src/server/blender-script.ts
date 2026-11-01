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
flatten = len(argv) > 7 and argv[7] == "1"

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

# --- flatten walls, floors, ceilings and cabinet fronts ---
# Plain surfaces have little texture, so their depth is noisy and the mesh comes out bumpy. On a
# sample of vertices, estimate normals by local PCA and grow planes with RANSAC; each plane keeps
# only connected patches of its inliers, so it can't reach across the room. Every vertex then
# takes the plane its nearest sample points belong to and moves onto it; vertices between two
# planes' patches go onto their intersection line, so corners stay sharp. Decimation then needs
# few triangles for the flat parts.
def flatten_planes(me, size, max_planes=80):
    from scipy.spatial import cKDTree
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(me.vertices)
    if n < 2000:
        return 0, 0.0
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    rng = np.random.default_rng(0)
    pts = co[rng.choice(n, min(n, 200_000), replace=False)]
    tree = cKDTree(pts)
    nd, nb = tree.query(pts, k=32, workers=-1)
    local = pts[nb] - pts[nb].mean(axis=1, keepdims=True)
    w, v = np.linalg.eigh(np.einsum("nki,nkj->nij", local, local))
    normals = v[:, :, 0]
    flat = w[:, 0] / np.maximum(w.sum(axis=1), 1e-12) < 0.01
    # Neighbours closer than this count as the same patch.
    reach = float(np.median(nd[:, 8])) * 2
    # Noise is a few mm to a few cm in a room; the mesh is scaled so its longest side is size.
    tol = size * 0.006
    cos_tol = math.cos(math.radians(30))
    min_pts = max(300, len(pts) // 500)
    label = np.full(len(pts), -1)
    planes = []

    def patches(idx):
        """Splits sample points into connected patches; returns those big enough to keep."""
        pairs = cKDTree(pts[idx]).query_pairs(reach, output_type="ndarray")
        g = coo_matrix((np.ones(len(pairs)), (pairs[:, 0], pairs[:, 1])), shape=(len(idx), len(idx)))
        count, comp = connected_components(g, directed=False)
        sizes = np.bincount(comp, minlength=count)
        return idx[sizes[comp] >= min_pts]

    tries = 0
    while len(planes) < max_planes and tries < max_planes * 3:
        tries += 1
        free = label < 0
        seeds = np.nonzero(flat & free)[0]
        if len(seeds) < min_pts:
            break
        probe = np.nonzero(free)[0]
        probe = probe[rng.choice(len(probe), min(len(probe), 30_000), replace=False)]
        best, best_score = None, 0
        for s in rng.choice(seeds, min(40, len(seeds)), replace=False):
            nrm = normals[s]
            ok = (np.abs((pts[probe] - pts[s]) @ nrm) < tol) & (np.abs(normals[probe] @ nrm) > cos_tol)
            if ok.sum() > best_score:
                best, best_score = s, int(ok.sum())
        nrm, d = normals[best], normals[best] @ pts[best]
        inl = np.zeros(0, dtype=np.int64)
        for _ in range(3):  # refit to the connected inliers
            band = np.nonzero(free & (np.abs(pts @ nrm - d) < tol) & (np.abs(normals @ nrm) > cos_tol))[0]
            inl = patches(band) if len(band) >= min_pts else band[:0]
            if len(inl) < min_pts:
                break
            c = pts[inl].mean(axis=0)
            nrm = np.linalg.svd(pts[inl] - c, full_matrices=False)[2][2]
            d = nrm @ c
        if len(inl) < min_pts:
            flat[best] = False  # this seed isn't on a large plane; try others
            continue
        resid = np.abs(pts[inl] @ nrm - d)
        snap = float(np.clip(3 * 1.4826 * np.median(resid), tol * 0.3, tol))
        label[inl] = len(planes)
        planes.append((nrm, d, snap))
    if not planes:
        return 0, 0.0
    N = np.array([p[0] for p in planes])
    D = np.array([p[1] for p in planes])
    S = np.array([p[2] for p in planes])
    # Each vertex looks at its 8 nearest sample points and their planes.
    _, near = tree.query(co, k=8, workers=-1)
    labs = label[near]
    # The two planes with the most votes, without an n × planes table (meshes reach millions).
    a, b = np.zeros(n, dtype=np.int64), np.zeros(n, dtype=np.int64)
    va, vb = np.zeros(n, dtype=np.int8), np.zeros(n, dtype=np.int8)
    for i in range(len(planes)):
        votes = (labs == i).sum(axis=1, dtype=np.int8)
        first = votes > va
        second = ~first & (votes > vb)
        b[first], vb[first] = a[first], va[first]
        a[first], va[first] = i, votes[first]
        b[second], vb[second] = i, votes[second]
    ea = np.einsum("ij,ij->i", co, N[a]) - D[a]
    eb = np.einsum("ij,ij->i", co, N[b]) - D[b]
    c = np.einsum("ij,ij->i", N[a], N[b])
    # Well inside a patch (most of its sample points on the plane) deeper bumps are noise too.
    near_a = (va >= 3) & (np.abs(ea) < S[a] * np.where(va >= 6, 2, 1))
    corner = near_a & (vb >= 2) & (np.abs(eb) < S[b]) & (np.abs(c) < 0.9)
    one = near_a & ~corner
    out = co.copy()
    out[one] -= ea[one, None] * N[a[one]]
    det = 1 - c[corner] ** 2
    k1 = (ea[corner] - c[corner] * eb[corner]) / det
    k2 = (eb[corner] - c[corner] * ea[corner]) / det
    out[corner] -= k1[:, None] * N[a[corner]] + k2[:, None] * N[b[corner]]
    # Ease off towards the edge of each patch (fewer sample points on the plane) so there's no
    # step where flattening stops; inside the patch, move all the way.
    moved = one | corner
    weight = np.where(moved, np.clip((va - 2) / 4, 0, 1), 0)
    # Vertices left behind among flattened neighbours would show as pits or spikes: if at least
    # three quarters of a vertex's neighbours went onto one plane (and none onto another), so does it.
    edges = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", edges)
    u, v = edges[0::2], edges[1::2]
    degree = np.bincount(u, minlength=n) + np.bincount(v, minlength=n)
    plane_of = np.where(one & (weight >= 0.5), a, -1)
    for _ in range(2):
        on = plane_of >= 0
        hits = np.bincount(u, weights=on[v], minlength=n) + np.bincount(v, weights=on[u], minlength=n)
        hi = np.full(n, -1)
        lo = np.full(n, len(planes))
        for x, y in ((u, v), (v, u)):
            np.maximum.at(hi, x[on[y]], plane_of[y[on[y]]])
            np.minimum.at(lo, x[on[y]], plane_of[y[on[y]]])
        fill = ~moved & (hits >= 0.75 * np.maximum(degree, 1)) & (hi == lo)
        p = hi[fill]
        e = np.einsum("ij,ij->i", co[fill], N[p]) - D[p]
        ok = np.abs(e) < 4 * S[p]
        idx = np.nonzero(fill)[0][ok]
        out[idx] = co[idx] - e[ok, None] * N[p[ok]]
        weight[idx] = 1
        moved[idx] = True
        plane_of[idx] = p[ok]
    co = co + weight[:, None] * (out - co)
    # Pressing a crumpled patch flat folds some triangles over their neighbours, which shows as
    # dark specks. Relax vertices inside each patch towards their neighbours' average, staying on
    # the plane, which unfolds them and evens out the triangles.
    inner = (plane_of >= 0) & (weight >= 1)
    same = (plane_of[u] == plane_of[v]) & inner[u] & inner[v]
    links = np.bincount(u[same], minlength=n) + np.bincount(v[same], minlength=n)
    inner &= links == degree
    p = plane_of[inner]
    for _ in range(5):
        avg = np.zeros((n, 3))
        for k in range(3):
            avg[:, k] = np.bincount(u, weights=co[v, k], minlength=n) + np.bincount(v, weights=co[u, k], minlength=n)
        avg[inner] /= degree[inner, None]
        avg[inner] -= (np.einsum("ij,ij->i", avg[inner], N[p]) - D[p])[:, None] * N[p]
        co[inner] = avg[inner]
    me.vertices.foreach_set("co", co.ravel())
    # Remembered through decimation, to know which edges border flattened surfaces.
    me.attributes.new("flat", 'FLOAT', 'POINT').data.foreach_set("value", moved.astype(np.float32))
    me.update()
    return len(planes), float(moved.mean())

flat_planes, flat_share = 0, 0.0
if flatten:
    flat_planes, flat_share = flatten_planes(me, print_mm)
    log("flattened %d planes, %.0f%% of vertices" % (flat_planes, flat_share * 100))

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
if flat_planes:
    # Big flat triangles meeting an edge would otherwise smear its shading across the wall. Only
    # edges touching flattened surfaces: splitting noisy areas too would double the GLB.
    me.set_sharp_from_angle(angle=math.radians(60))
    flat_v = np.empty(len(me.vertices), dtype=np.float32)
    me.attributes["flat"].data.foreach_get("value", flat_v)
    ev = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", ev)
    sharp = np.empty(len(me.edges), dtype=bool)
    me.attributes["sharp_edge"].data.foreach_get("value", sharp)
    sharp &= np.maximum(flat_v[ev[0::2]], flat_v[ev[1::2]]) > 0.5
    me.attributes["sharp_edge"].data.foreach_set("value", sharp)
    me.attributes.remove(me.attributes["flat"])

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
    json.dump({"dimensionsMm": dims, "faces": len(me.polygons), "printableFaces": len(printable.data.polygons),
               "flatPlanes": flat_planes, "flatShare": round(flat_share, 3)}, f)
`;
