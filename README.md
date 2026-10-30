# Space

A local photogrammetry workbench for scanning a home. Upload drone and handheld photos and videos, run a
reconstruction, then download an **STL** for 3D printing, a **.blend** for Blender, or explore the model in the browser.

Built with Angular 22 (SSR). The API lives in `src/server.ts` and uses SQLite through Node's built-in `node:sqlite`.

## How it works

```
photos ─┐                                   COLMAP (open source, CUDA)
videos ─┴─ ffmpeg frame sampling ──► features ► matching ► sparse SfM ► gravity alignment
                                     ► undistort ► PatchMatch stereo ► fusion ► Poisson / Delaunay mesh
                                                                                     │
                     Blender (headless) ◄────────────────────────────────────────────┘
                     remove noise islands, orient Z-up, scale to print size, decimate
                     ├─ model.glb    coloured mesh for the 3D explorer
                     ├─ model.stl    solidified + voxel-remeshed watertight solid, in mm
                     └─ model.blend  both meshes with a vertex-colour material
```

### How runs are orchestrated

- **The database is the queue.** Starting a run inserts a `queued` row in SQLite. A worker inside the
  Node server claims the oldest queued row atomically, runs the steps one at a time as child processes
  (ffmpeg, COLMAP in Docker, Blender), and writes the step, progress, per-step timings and stats back to
  the row. Only one run executes at a time per server process.
- **The browser only reads.** Pages poll `/api/projects/:id/jobs` every 2 s, so closing, reloading or
  opening the app on another device never affects a run.
- **Server restarts:** the server picks work up again as soon as it starts. A run that was
  mid-flight is queued again and **resumes from its last finished step**. The interrupted step
  continues from COLMAP's files on disk where it can: feature extraction, matching and dense stereo
  skip images, pairs and depth maps they already have. The old COLMAP container (named
  `space-<hash>-job-<id>`) is removed first so it doesn't hold the GPU. After 3 interruptions a run
  is failed instead of retrying forever.
- **Time estimates:** every completed step is stored in the `stage_samples` table with the inputs it
  depended on (image count, quality, source views, triangles). It's kept even when a run is deleted.
  Each step has a built-in cost model, and `/api/calibration` scales it by the median of actual ÷
  estimated over that step's recent samples, separately per quality preset when it has samples. The
  pre-run estimate, the live ETA and the per-step expectations all use it, so they improve with
  every run.
- **Several servers** (e.g. `ng serve` and a production build) can share one `data/` folder: claims
  are atomic, each run records its worker's pid, and cancel requests reach whichever process owns the run.

## Interior and exterior: separate projects

Yes, keep them separate. Each project has a kind that sets sensible defaults:

| | Exterior (drone) | Interior (handheld) |
|---|---|---|
| Mesher | Poisson (smooth, closed) | Delaunay (keeps thin walls, copes with blank surfaces) |
| Video sampling | 1 fps | 2 fps |
| Print size | 150 mm | 200 mm |

Why separate: inside and outside views share almost no matching features, so COLMAP would split them into disconnected
models anyway. They also differ in scale, lighting and the best meshing method. If you later want a combined
"dollhouse", film a continuous walk through an open door from outside to inside. That footage links the two, and a
project containing all of it can register both sides together. Large houses also work better as one project per floor.

## Requirements

- Node 24+ (for `node:sqlite`)
- **COLMAP 3.9+** with CUDA, needed for dense stereo. Any one of:
  - `colmap` on your `PATH` (e.g. `apt install colmap`, or build it from source with CUDA)
  - `COLMAP_BIN=/path/to/colmap`
  - Docker plus the NVIDIA container toolkit: `docker pull colmap/colmap:latest`. It is picked up automatically.
    RTX 50-series (Blackwell) cards need a COLMAP build against CUDA 12.8+. If dense stereo fails with a
    "no kernel image" error, build COLMAP from source with `CMAKE_CUDA_ARCHITECTURES=120`.
- **Blender 4.2+** (`BLENDER_BIN` to override). Official blender.org builds also Draco-compress the GLB.
- **FFmpeg** for videos (`FFMPEG_BIN` to override)

The home page shows which tools the server found.

## Running

```bash
npm install
npm start            # dev server on http://localhost:4200 (API included)
```

Production:

```bash
npm run build
npm run serve:ssr:space.fluin.io   # http://localhost:4000, PORT to change
```

Everything (SQLite database, uploads, job workspaces) goes in `./data`, or in `SPACE_DATA_DIR` if set.
Each run keeps its full COLMAP workspace in `data/projects/<id>/jobs/<job>/`, including `job.log`, the sparse model and
`dense/fused.ply`, so you can open the results in the COLMAP GUI or MeshLab.

## Capture tips

- **Drone:** two or three orbits at different heights and gimbal angles, plus a top-down grid for the roof. Keep 70–80%
  overlap. Overcast light is best.
- **Interior:** turn on all the lights, walk slowly along the walls pointing across the room, and avoid pivoting on the
  spot. Plain walls need furniture or trim in frame to match.
- Upload JPEG/PNG/TIFF with EXIF intact (convert HEIC first) and MP4/MOV video.

## 3D explorer

Orbit or first-person **walk** mode (WASD/arrows, Q/E for up/down, Shift to go faster), captured colour vs clay
shading, wireframe, and a **cut-away** slider that removes the roof or ceiling so you can look into rooms.
