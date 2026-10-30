import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import { copyFile, link, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import type { JobOutput, JobSettings, OutputKind, Quality } from '../shared/models';
import { BLENDER_SCRIPT } from './blender-script';
import { getDb, jobDir, mediaDir, type JobRow, type MediaRow, type ProjectRow } from './db';
import { blenderBin, colmapCommand, ffmpegBin, type ColmapCommand, type Command } from './tools';

/** Longest image side used for dense stereo, per quality preset. */
const DENSE_SIZE: Record<Quality, number> = { preview: 1000, medium: 2000, high: 3200 };

/** Stage name and the share of overall progress it represents. */
const STAGES = [
  ['Preparing images', 0.03],
  ['Extracting features', 0.07],
  ['Matching features', 0.1],
  ['Sparse reconstruction', 0.15],
  ['Aligning orientation', 0.03],
  ['Undistorting images', 0.04],
  ['Dense stereo', 0.35],
  ['Fusing point cloud', 0.06],
  ['Meshing', 0.07],
  ['Post-processing in Blender', 0.1],
] as const;

type StageName = (typeof STAGES)[number][0];

class Cancelled extends Error {}

/**
 * Runs one reconstruction at a time. Kept on globalThis so dev-server reloads of
 * server.ts don't spawn a second worker against the same database.
 */
class Pipeline {
  private running: { jobId: number; child?: ChildProcess; cancelled: boolean } | null = null;

  enqueue() {
    void this.tick();
  }

  cancel(jobId: number): boolean {
    const db = getDb();
    if (this.running?.jobId === jobId) {
      this.running.cancelled = true;
      this.running.child?.kill('SIGTERM');
      return true;
    }
    const res = db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'queued'`,
      )
      .run(jobId);
    return res.changes > 0;
  }

  private async tick() {
    if (this.running) return;
    const db = getDb();
    const next = db
      .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1`)
      .get() as JobRow | undefined;
    if (!next) return;

    this.running = { jobId: next.id, cancelled: false };
    db.prepare(
      `UPDATE jobs SET status = 'running', started_at = datetime('now'), progress = 0 WHERE id = ?`,
    ).run(next.id);
    try {
      const outputs = await this.process(next);
      db.prepare(
        `UPDATE jobs SET status = 'done', stage = 'Complete', progress = 1, outputs = ?, finished_at = datetime('now') WHERE id = ?`,
      ).run(JSON.stringify(outputs), next.id);
    } catch (err) {
      const cancelled = err instanceof Cancelled || this.running.cancelled;
      db.prepare(
        `UPDATE jobs SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?`,
      ).run(
        cancelled ? 'cancelled' : 'failed',
        cancelled ? null : String((err as Error).message ?? err),
        next.id,
      );
    } finally {
      this.running = null;
      void this.tick();
    }
  }

  private async process(job: JobRow): Promise<JobOutput[]> {
    const db = getDb();
    const settings = JSON.parse(job.settings) as JobSettings;
    const project = db
      .prepare(`SELECT * FROM projects WHERE id = ?`)
      .get(job.project_id) as unknown as ProjectRow;
    const media = db
      .prepare(`SELECT * FROM media WHERE project_id = ?`)
      .all(job.project_id) as unknown as MediaRow[];
    const dir = jobDir(job.project_id, job.id);
    await mkdir(dir, { recursive: true });
    const log = createWriteStream(join(dir, 'job.log'), { flags: 'a' });

    const stageStart = (name: StageName) => {
      let start = 0;
      for (const [n, w] of STAGES) {
        if (n === name) break;
        start += w;
      }
      return start;
    };
    let current: { name: StageName; start: number; weight: number } | null = null;
    const setStage = (name: StageName) => {
      if (this.running?.cancelled) throw new Cancelled();
      const weight = STAGES.find(([n]) => n === name)![1];
      current = { name, start: stageStart(name), weight };
      log.write(`\n=== ${name} ===\n`);
      db.prepare(`UPDATE jobs SET stage = ?, progress = ? WHERE id = ?`).run(
        name,
        current.start,
        job.id,
      );
    };
    const setFraction = (f: number) => {
      if (!current) return;
      db.prepare(`UPDATE jobs SET progress = ? WHERE id = ?`).run(
        current.start + current.weight * Math.min(Math.max(f, 0), 1),
        job.id,
      );
    };
    const exec = (cmd: Command, args: string[], opts: { progress?: boolean } = {}) =>
      this.exec(cmd, args, log, opts.progress ? setFraction : undefined);

    try {
      // 1. Gather inputs: link photos (keeping EXIF for focal length priors) and sample video frames.
      setStage('Preparing images');
      const imagesDir = join(dir, 'images');
      await rm(imagesDir, { recursive: true, force: true });
      const photosDir = join(imagesDir, 'photos');
      await mkdir(photosDir, { recursive: true });
      const photos = media.filter((m) => m.type === 'image');
      const videos = media.filter((m) => m.type === 'video');
      for (const m of photos) {
        const from = join(mediaDir(job.project_id), m.filename);
        const to = join(photosDir, m.filename);
        await link(from, to).catch(() => copyFile(from, to));
      }
      const ffmpeg: Command = { bin: ffmpegBin(), args: [] };
      for (const [i, v] of videos.entries()) {
        // One folder per video so COLMAP gives each clip its own camera intrinsics.
        const out = join(imagesDir, `video-${v.id}`);
        await mkdir(out, { recursive: true });
        await exec(ffmpeg, [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          join(mediaDir(job.project_id), v.filename),
          '-vf',
          `fps=${settings.videoFps},scale='min(3840,iw)':-2`,
          '-qscale:v',
          '2',
          join(out, 'frame-%05d.jpg'),
        ]);
        setFraction((i + 1) / videos.length);
      }
      if (photos.length === 0) await rm(photosDir, { recursive: true });
      const imageCount = await countFiles(imagesDir);
      log.write(`${imageCount} images (${photos.length} photos, ${videos.length} videos)\n`);
      if (imageCount < 3) throw new Error('Need at least 3 images (or a video) to reconstruct');

      const colmap = await colmapCommand(dir);
      if (!colmap) throw new Error('COLMAP is not available. See the system status panel.');
      const cpu = await this.cpuFlags(colmap);
      if (!colmap.gpu)
        log.write('No GPU available to COLMAP: extracting and matching features on the CPU\n');
      const db_ = join(dir, 'database.db');
      await rm(db_, { force: true });

      // 2. Features + matching. Sequential matching suits video-heavy captures and large sets.
      setStage('Extracting features');
      await exec(
        colmap,
        [
          'feature_extractor',
          '--database_path',
          db_,
          '--image_path',
          imagesDir,
          '--ImageReader.single_camera_per_folder',
          '1',
          ...cpu.extract,
        ],
        { progress: true },
      );

      setStage('Matching features');
      const sequential = (videos.length > 0 && photos.length < imageCount / 2) || imageCount > 400;
      await exec(
        colmap,
        [
          sequential ? 'sequential_matcher' : 'exhaustive_matcher',
          '--database_path',
          db_,
          ...cpu.match,
        ],
        {
          progress: true,
        },
      );

      // 3. Structure from motion.
      setStage('Sparse reconstruction');
      const sparseDir = join(dir, 'sparse');
      await rm(sparseDir, { recursive: true, force: true });
      await mkdir(sparseDir, { recursive: true });
      await exec(
        colmap,
        ['mapper', '--database_path', db_, '--image_path', imagesDir, '--output_path', sparseDir],
        {
          progress: true,
        },
      );
      let model = await largestModel(sparseDir);
      if (!model)
        throw new Error(
          'Sparse reconstruction failed: no images could be registered. Add more overlap.',
        );

      // 4. Gravity alignment so models come out upright. Best effort: unaligned models still mesh fine.
      setStage('Aligning orientation');
      const alignedDir = join(dir, 'sparse-aligned');
      await mkdir(alignedDir, { recursive: true });
      try {
        await exec(colmap, [
          'model_orientation_aligner',
          '--image_path',
          imagesDir,
          '--input_path',
          model,
          '--output_path',
          alignedDir,
          '--max_image_size',
          '1024',
        ]);
        model = alignedDir;
      } catch {
        log.write('Orientation alignment failed; continuing with unaligned model\n');
      }

      // 5. Multi-view stereo (CUDA).
      setStage('Undistorting images');
      const denseDir = join(dir, 'dense');
      await rm(denseDir, { recursive: true, force: true });
      const size = String(DENSE_SIZE[settings.quality]);
      await exec(colmap, [
        'image_undistorter',
        '--image_path',
        imagesDir,
        '--input_path',
        model,
        '--output_path',
        denseDir,
        '--output_type',
        'COLMAP',
        '--max_image_size',
        size,
      ]);

      setStage('Dense stereo');
      if (!colmap.gpu) {
        throw new Error(
          'Sparse model done, but dense stereo needs a CUDA GPU. For Docker, install the NVIDIA Container Toolkit, then start a new run.',
        );
      }
      await exec(
        colmap,
        [
          'patch_match_stereo',
          '--workspace_path',
          denseDir,
          '--workspace_format',
          'COLMAP',
          '--PatchMatchStereo.geom_consistency',
          'true',
          '--PatchMatchStereo.max_image_size',
          size,
        ],
        { progress: true },
      );

      setStage('Fusing point cloud');
      const fused = join(denseDir, 'fused.ply');
      await exec(
        colmap,
        [
          'stereo_fusion',
          '--workspace_path',
          denseDir,
          '--workspace_format',
          'COLMAP',
          '--input_type',
          'geometric',
          '--output_path',
          fused,
        ],
        { progress: true },
      );

      // 6. Surface reconstruction. Delaunay copes better with thin walls and textureless interiors.
      setStage('Meshing');
      const rawMesh = join(dir, 'mesh.ply');
      if (settings.mesher === 'delaunay') {
        await exec(colmap, [
          'delaunay_mesher',
          '--input_path',
          denseDir,
          '--input_type',
          'dense',
          '--output_path',
          rawMesh,
        ]);
      } else {
        await exec(colmap, [
          'poisson_mesher',
          '--input_path',
          fused,
          '--output_path',
          rawMesh,
          '--PoissonMeshing.trim',
          project.kind === 'exterior' ? '7' : '5',
        ]);
      }

      // 7. Blender: clean, orient, scale, and export STL/GLB/.blend.
      setStage('Post-processing in Blender');
      const outDir = join(dir, 'output');
      await mkdir(outDir, { recursive: true });
      const script = join(dir, 'postprocess.py');
      await writeFile(script, BLENDER_SCRIPT);
      await exec({ bin: blenderBin(), args: [] }, [
        '--background',
        '--factory-startup',
        '--python-exit-code',
        '1',
        '--python',
        script,
        '--',
        rawMesh,
        outDir,
        String(settings.targetFaces),
        String(settings.printSizeMm),
        project.kind,
      ]);
      await copyFile(rawMesh, join(outDir, 'mesh.ply'));

      return collectOutputs(outDir);
    } finally {
      await new Promise((r) => log.end(r));
    }
  }

  /** Without CUDA, feature extraction/matching must be told to use the CPU. Option names changed in COLMAP 3.12. */
  private async cpuFlags(colmap: ColmapCommand): Promise<{ extract: string[]; match: string[] }> {
    if (colmap.gpu) return { extract: [], match: [] };
    const help = await new Promise<string>((resolve) => {
      execFile(
        colmap.bin,
        [...colmap.args, 'feature_extractor', '-h'],
        { maxBuffer: 4 << 20 },
        (_e, out, err) => resolve(`${out}${err}`),
      );
    });
    const modern = help.includes('FeatureExtraction.use_gpu');
    return {
      extract: [modern ? '--FeatureExtraction.use_gpu' : '--SiftExtraction.use_gpu', '0'],
      match: [modern ? '--FeatureMatching.use_gpu' : '--SiftMatching.use_gpu', '0'],
    };
  }

  private exec(
    cmd: Command,
    args: string[],
    log: WriteStream,
    onProgress?: (f: number) => void,
  ): Promise<void> {
    if (this.running?.cancelled) return Promise.reject(new Cancelled());
    const full = [...cmd.args, ...args];
    log.write(`$ ${cmd.bin} ${full.join(' ')}\n`);
    return new Promise((resolve, reject) => {
      const child = spawn(cmd.bin, full, { stdio: ['ignore', 'pipe', 'pipe'] });
      if (this.running) this.running.child = child;
      const onData = (chunk: Buffer) => {
        log.write(chunk);
        if (!onProgress) return;
        // COLMAP reports progress as "[12/340]" or "Processing view 12 / 340".
        const matches = [
          ...chunk.toString().matchAll(/\[(\d+)\/(\d+)\]|view (\d+) \/ (\d+)|(\d+) \/ (\d+)/g),
        ];
        const last = matches.at(-1);
        if (last) {
          const done = Number(last[1] ?? last[3] ?? last[5]);
          const total = Number(last[2] ?? last[4] ?? last[6]);
          if (total > 0) onProgress(done / total);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', reject);
      child.on('close', (code, signal) => {
        if (this.running) this.running.child = undefined;
        if (this.running?.cancelled) reject(new Cancelled());
        else if (code === 0) resolve();
        else
          reject(
            new Error(`${parse(args[0] ?? cmd.bin).name || cmd.bin} exited with ${signal ?? code}`),
          );
      });
    });
  }
}

async function countFiles(dir: string): Promise<number> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).length;
}

/** COLMAP may split a capture into several models; keep the one with the most registered images. */
async function largestModel(sparseDir: string): Promise<string | null> {
  let best: { path: string; size: number } | null = null;
  for (const name of await readdir(sparseDir)) {
    const images = join(sparseDir, name, 'images.bin');
    if (!existsSync(images)) continue;
    const { size } = await stat(images);
    if (!best || size > best.size) best = { path: join(sparseDir, name), size };
  }
  return best?.path ?? null;
}

const OUTPUT_FILES: [OutputKind, string][] = [
  ['stl', 'model.stl'],
  ['blend', 'model.blend'],
  ['glb', 'model.glb'],
  ['ply', 'mesh.ply'],
];

async function collectOutputs(outDir: string): Promise<JobOutput[]> {
  const outputs: JobOutput[] = [];
  for (const [kind, file] of OUTPUT_FILES) {
    const path = join(outDir, file);
    if (existsSync(path)) outputs.push({ kind, file, size: (await stat(path)).size });
  }
  return outputs;
}

const KEY = Symbol.for('space.fluin.io/pipeline');
const holder = globalThis as unknown as Record<symbol, Pipeline | undefined>;
export const pipeline: Pipeline = (holder[KEY] ??= new Pipeline());
