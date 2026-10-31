import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, type WriteStream } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join, parse } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DENSE_SIZE,
  DENSE_SOURCES,
  PANO_VIEWS,
  STAGES,
  isSpherical,
  stlFaces,
  useSequentialMatching,
  type JobOutput,
  type JobSettings,
  type EstimateInput,
  MATCH_GAPS,
  type GapMatches,
  type JobStats,
  type OutputKind,
  type StageName,
  type StageTiming,
} from '../shared/models';
import { BLENDER_SCRIPT } from './blender-script';
import {
  addFramesAtGaps,
  findPathBreaks,
  originalFramesIn,
  parseFrame,
  readPoses,
} from './camera-path';
import {
  getDb,
  isAlive,
  jobDir,
  mediaDir,
  type JobRow,
  type MediaRow,
  type ProjectRow,
} from './db';
import {
  blenderBin,
  colmapCommand,
  ffmpegBin,
  jobContainerName,
  jobContainers,
  removeContainer,
  type ColmapCommand,
  type Command,
} from './tools';

class Cancelled extends Error {}

/**
 * Runs one reconstruction at a time. Kept on globalThis so dev-server reloads of
 * server.ts don't spawn a second worker against the same database (see the bottom of this file).
 */
class Pipeline {
  private running: { jobId: number; child?: ChildProcess; cancelled: boolean } | null = null;

  private cleanedUp = false;

  enqueue() {
    if (!this.cleanedUp) {
      this.cleanedUp = true;
      void this.removeOrphans().then(() => this.tick());
    } else {
      void this.tick();
    }
  }

  /**
   * COLMAP containers outlive a crashed or restarted server and would keep the GPU busy. Remove any
   * whose job isn't being run by a live server.
   */
  private async removeOrphans() {
    for (const jobId of await jobContainers()) {
      const row = getDb().prepare(`SELECT status, worker_pid FROM jobs WHERE id = ?`).get(jobId) as
        { status: string; worker_pid: number | null } | undefined;
      const ownedElsewhere =
        row?.status === 'running' &&
        row.worker_pid !== null &&
        row.worker_pid !== process.pid &&
        isAlive(row.worker_pid);
      if (!ownedElsewhere) await removeContainer(jobContainerName(jobId));
    }
  }

  cancel(jobId: number): boolean {
    const db = getDb();
    if (this.running?.jobId === jobId) {
      this.running.cancelled = true;
      this.running.child?.kill('SIGTERM');
      // Killing the docker client doesn't always stop the container itself.
      void removeContainer(jobContainerName(jobId));
      return true;
    }
    // A job running in another server process is cancelled by flag; its worker polls for it.
    const flagged = db
      .prepare(`UPDATE jobs SET cancel_requested = 1 WHERE id = ? AND status = 'running'`)
      .run(jobId);
    if (flagged.changes > 0) return true;
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

    // Claim atomically so two servers sharing the database never run the same job.
    const claimed = db
      .prepare(
        `UPDATE jobs SET status = 'running', worker_pid = ?, attempts = attempts + 1,
           started_at = COALESCE(started_at, datetime('now'))
         WHERE id = ? AND status = 'queued'`,
      )
      .run(process.pid, next.id);
    if (claimed.changes === 0) return void this.tick();

    this.running = { jobId: next.id, cancelled: false };
    const cancelPoll = setInterval(() => {
      const row = db.prepare(`SELECT cancel_requested FROM jobs WHERE id = ?`).get(next.id) as
        { cancel_requested: number } | undefined;
      if (!row || row.cancel_requested) this.cancel(next.id);
    }, 2000);
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
      clearInterval(cancelPoll);
      this.running = null;
      void this.tick();
    }
  }

  /**
   * Runs the steps in order. A run resumed after a server restart skips steps that already
   * finished, and the step that was interrupted continues from COLMAP's files on disk where it can
   * (feature extraction, matching and dense stereo skip work that already exists).
   */
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

    const timings = JSON.parse(job.stages || '[]') as StageTiming[];
    const stats = JSON.parse(job.stats || '{}') as JobStats;
    const finished = new Set(
      timings.filter((t) => t.finishedAt && !t.interrupted).map((t) => t.name),
    );
    if (timings.length)
      log.write(`\n=== Resuming after restart (attempt ${job.attempts + 1}) ===\n`);

    const saveTimings = () =>
      db.prepare(`UPDATE jobs SET stages = ? WHERE id = ?`).run(JSON.stringify(timings), job.id);
    const addStats = (more: JobStats) => {
      Object.assign(stats, more);
      db.prepare(`UPDATE jobs SET stats = ? WHERE id = ?`).run(JSON.stringify(stats), job.id);
    };
    const estimateInputs = (): EstimateInput => ({
      images: stats.images ?? 0,
      photos: stats.photos ?? 0,
      videos: stats.videos ?? 0,
      quality: settings.quality,
      targetFaces: settings.targetFaces,
      denseSources: DENSE_SOURCES[settings.quality],
    });
    const recordSample = db.prepare(
      `INSERT INTO stage_samples (job_id, stage, seconds, inputs) VALUES (?, ?, ?, ?)`,
    );

    const stageStart = (name: StageName) => {
      let start = 0;
      for (const st of STAGES) {
        if (st.name === name) break;
        start += st.weight;
      }
      return start;
    };
    let current: { name: StageName; start: number; weight: number } | null = null;
    let stageFraction = 0;
    const setFraction = (f: number) => {
      // Tools print assorted "n / m" counters; never let the bar move backwards within a step.
      f = Math.min(Math.max(f, 0), 1);
      if (!current || f <= stageFraction) return;
      stageFraction = f;
      db.prepare(`UPDATE jobs SET progress = ? WHERE id = ?`).run(
        current.start + current.weight * f,
        job.id,
      );
    };

    /** Runs one step unless an earlier attempt finished it, recording its duration. */
    const step = async (name: StageName, run: (resumed: boolean) => Promise<void>) => {
      if (finished.has(name)) {
        log.write(`\n=== ${name}: already done ===\n`);
        return;
      }
      if (this.running?.cancelled) throw new Cancelled();
      const resumed = timings.some((t) => t.name === name);
      const weight = STAGES.find((st) => st.name === name)!.weight;
      current = { name, start: stageStart(name), weight };
      stageFraction = 0;
      const timing: StageTiming = { name, startedAt: new Date().toISOString(), finishedAt: null };
      timings.push(timing);
      saveTimings();
      log.write(`\n=== ${name}${resumed ? ' (resumed)' : ''} ===\n`);
      db.prepare(`UPDATE jobs SET stage = ?, progress = ? WHERE id = ?`).run(
        name,
        current.start,
        job.id,
      );
      try {
        await run(resumed);
      } catch (err) {
        timing.finishedAt = new Date().toISOString();
        timing.interrupted = true;
        saveTimings();
        throw err;
      }
      timing.finishedAt = new Date().toISOString();
      saveTimings();
      // A resumed step only redid part of the work, so its time would skew the estimates.
      if (!resumed) {
        const seconds = (Date.parse(timing.finishedAt) - Date.parse(timing.startedAt)) / 1000;
        recordSample.run(job.id, name, seconds, JSON.stringify(estimateInputs()));
      }
    };

    const exec = (
      cmd: Command,
      args: string[],
      opts: { progress?: boolean | ((f: number) => void) } = {},
    ) =>
      this.exec(
        cmd,
        args,
        log,
        typeof opts.progress === 'function'
          ? opts.progress
          : opts.progress
            ? setFraction
            : undefined,
      );

    const imagesDir = join(dir, 'images');
    const photos = media.filter((m) => m.type === 'image');
    const videos = media.filter((m) => m.type === 'video');
    const db_ = join(dir, 'database.db');
    const sparseDir = join(dir, 'sparse');
    const alignedDir = join(dir, 'sparse-aligned');
    const denseDir = join(dir, 'dense');
    const fused = join(denseDir, 'fused.ply');
    const rawMesh = join(dir, 'mesh.ply');
    const rigConfig = join(dir, 'rigs.json');
    const outDir = join(dir, 'output');
    const size = String(DENSE_SIZE[settings.quality]);
    /** The aligned model if alignment succeeded, else the largest sparse model. */
    const model = async () =>
      existsSync(join(alignedDir, 'images.bin')) ? alignedDir : await largestModel(sparseDir);

    try {
      // 1. Gather inputs: link photos (keeping EXIF for focal length priors) and sample video frames.
      await step('Preparing images', async () => {
        await rm(imagesDir, { recursive: true, force: true });
        const photosDir = join(imagesDir, 'photos');
        await mkdir(photosDir, { recursive: true });
        const ffmpeg: Command = { bin: ffmpegBin(), args: [] };
        const rigs: PanoRig[] = [];
        for (const m of photos.filter((p) => isSpherical(p.width, p.height))) {
          // 360° photos of the same size share one rig, so each photo becomes one rig frame.
          const prefix = `pano-photos-${m.width}`;
          const size = panoViewSize(m.width!);
          if (!rigs.some((g) => g.prefix === prefix)) rigs.push({ prefix, size });
          const input = join(mediaDir(job.project_id), m.filename);
          await splitPanorama(ffmpeg, exec, input, join(imagesDir, prefix), size, `${m.id}.jpg`);
        }
        for (const m of photos.filter((p) => !isSpherical(p.width, p.height))) {
          const from = join(mediaDir(job.project_id), m.filename);
          const to = join(photosDir, m.filename);
          await link(from, to).catch(() => copyFile(from, to));
        }
        for (const [i, v] of videos.entries()) {
          if (isSpherical(v.width, v.height)) {
            const prefix = `pano-${v.id}`;
            const size = panoViewSize(v.width!);
            rigs.push({ prefix, size });
            const input = join(mediaDir(job.project_id), v.filename);
            const out = join(imagesDir, prefix);
            await splitPanorama(
              ffmpeg,
              exec,
              input,
              out,
              size,
              'frame-%05d.jpg',
              settings.videoFps,
            );
            setFraction((i + 1) / videos.length);
            continue;
          }
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
        if ((await readdir(photosDir)).length === 0) await rm(photosDir, { recursive: true });
        await writeFile(rigConfig, JSON.stringify(rigs.map(panoRigConfig), null, 2));
        const imageCount = await countFiles(imagesDir);
        log.write(`${imageCount} images (${photos.length} photos, ${videos.length} videos)\n`);
        addStats({
          images: imageCount,
          photos: photos.length,
          videos: videos.length,
          videoFrames: await videoFrameCount(imagesDir),
          spherical: [...photos, ...videos].filter((m) => isSpherical(m.width, m.height)).length,
          sourceWidth:
            Math.max(
              0,
              ...rigs.map((g) => g.size),
              ...[...photos, ...videos]
                .filter((m) => !isSpherical(m.width, m.height) && m.width && m.width > 0)
                .map((m) => Math.min(m.width!, m.type === 'video' ? 3840 : Infinity)),
            ) || undefined,
        });
        if (imageCount < 3) throw new Error('Need at least 3 images (or a video) to reconstruct');
      });
      const imageCount = stats.images ?? (await countFiles(imagesDir));

      const colmap = await colmapCommand(dir, jobContainerName(job.id));
      await removeContainer(jobContainerName(job.id));
      if (!colmap) throw new Error('COLMAP is not available. See the system status panel.');
      const cpu = await this.cpuFlags(colmap);
      addStats({ gpu: colmap.gpu, denseSources: DENSE_SOURCES[settings.quality] });
      if (!colmap.gpu) {
        log.write('No GPU available to COLMAP: extracting and matching features on the CPU\n');
      }

      const pano =
        existsSync(rigConfig) && JSON.parse(await readFile(rigConfig, 'utf8')).length > 0;
      // 360° views have exact intrinsics from ffmpeg; refine focal lengths only for real cameras.
      const allPano = pano && media.every((m) => isSpherical(m.width, m.height));

      // 2. Features + matching. Both skip images/pairs already in the database when resumed.
      await step('Extracting features', async (resumed) => {
        if (!resumed) await rm(db_, { force: true });
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
        // 360° views: tell COLMAP each frame's views share one centre at known rotations.
        if (pano) {
          await exec(colmap, [
            ...['rig_configurator', '--database_path', db_, '--rig_config_path', rigConfig],
          ]);
        }
      });

      await step('Matching features', async () => {
        // Sequential matching suits video-heavy captures and large sets.
        const sequential = useSequentialMatching(imageCount, photos.length, videos.length);
        await exec(
          colmap,
          [
            sequential ? 'sequential_matcher' : 'exhaustive_matcher',
            '--database_path',
            db_,
            ...cpu.match,
            // The 360° views don't overlap each other, so pairs within one frame never match.
            ...(pano ? ['--FeatureMatching.skip_image_pairs_in_same_frame', '1'] : []),
          ],
          { progress: true },
        );
        const gaps = matchesByGap(db_);
        if (gaps) addStats({ matchesByGap: gaps });
      });

      // 3. Structure from motion.
      await step('Sparse reconstruction', async () => {
        const sequential = useSequentialMatching(imageCount, photos.length, videos.length);
        const args = [
          '--database_path',
          db_,
          '--image_path',
          imagesDir,
          '--output_path',
          sparseDir,
        ];
        // Video frames: incremental mapping tends to split a long flight into fragments and keep
        // only the largest; global SfM solves all frames at once and places more of them. But it
        // can also join pieces in the wrong place (overlapping, flipped copies of the scene), so
        // its result is checked for breaks in each video's camera path and discarded if broken.
        const map = async (): Promise<'global' | 'incremental'> => {
          await rm(sparseDir, { recursive: true, force: true });
          await mkdir(sparseDir, { recursive: true });
          if (sequential) {
            try {
              const fixed = [
                ...(pano ? ['--GlobalMapper.refine_sensor_from_rig', '0'] : []),
                ...(allPano ? ['--GlobalMapper.ba_refine_focal_length', '0'] : []),
              ];
              await exec(colmap, ['global_mapper', ...args, ...fixed]);
              const model = await largestModel(sparseDir);
              const breaks = model ? findPathBreaks(await readPoses(model)) : [];
              if (model && !breaks.length) return 'global';
              if (model) {
                log.write(
                  `Global mapper joined pieces in the wrong place (${breaks.length} camera path ` +
                    `breaks, first ${breaks[0].from} -> ${breaks[0].to}); using incremental mapping.\n`,
                );
              }
            } catch (err) {
              if (err instanceof Cancelled) throw err;
              log.write('Global mapper failed, falling back to incremental mapping.\n');
            }
            await rm(sparseDir, { recursive: true, force: true });
            await mkdir(sparseDir, { recursive: true });
          }
          const fixed = [
            ...(pano ? ['--Mapper.ba_refine_sensor_from_rig', '0'] : []),
            ...(allPano ? ['--Mapper.ba_refine_focal_length', '0'] : []),
            // Fast turns leave video frames with few matches to the frames before them; accepting
            // weaker links kept 248 of 324 drone frames in one piece instead of 210, at the same
            // 0.95 px reprojection error.
            ...(sequential
              ? [
                  ...['--Mapper.abs_pose_min_num_inliers', '15'],
                  ...['--Mapper.abs_pose_min_inlier_ratio', '0.15'],
                  ...['--Mapper.init_min_num_inliers', '50'],
                ]
              : []),
          ];
          await exec(colmap, ['mapper', ...args, ...fixed], { progress: true });
          return 'incremental';
        };
        const quality = async () => {
          const model = await largestModel(sparseDir);
          const poses = model ? await readPoses(model) : new Map();
          return { poses, breaks: findPathBreaks(poses), placed: originalFramesIn(poses) };
        };

        let mapper = await map();
        let result = await quality();

        // Where the kept model lost stretches of a video (fast turns, quick moves) or its path
        // breaks, sample those moments at 4× the rate and map again with the extra frames.
        const sources = videos
          .filter((v) => !isSpherical(v.width, v.height))
          .map((v) => ({ id: v.id, path: join(mediaDir(job.project_id), v.filename) }));
        const added = sequential
          ? await addFramesAtGaps(
              { bin: ffmpegBin(), args: [] },
              exec,
              imagesDir,
              sources,
              settings.videoFps,
              result.poses,
              result.breaks,
            )
          : 0;
        if (added) {
          log.write(
            `Added ${added} extra frames where the model lost the camera; mapping again.\n`,
          );
          const extract = ['--database_path', db_, '--image_path', imagesDir];
          await exec(colmap, [
            'feature_extractor',
            ...extract,
            '--ImageReader.single_camera_per_folder',
            '1',
            ...cpu.extract,
          ]);
          await exec(colmap, ['sequential_matcher', '--database_path', db_, ...cpu.match]);
          await rm(sparseDir + '-first', { recursive: true, force: true });
          await rename(sparseDir, sparseDir + '-first');
          const retry = await map();
          const second = await quality();
          const better =
            second.breaks.length < result.breaks.length ||
            (second.breaks.length === result.breaks.length && second.placed >= result.placed);
          if (better) {
            mapper = retry;
            result = second;
            await rm(sparseDir + '-first', { recursive: true, force: true });
          } else {
            log.write('Extra frames did not help; keeping the first model.\n');
            await rm(sparseDir, { recursive: true, force: true });
            await rename(sparseDir + '-first', sparseDir);
          }
          addStats({
            images: imageCount + added,
            extraFrames: added,
            placedOriginal: result.placed,
          });
        }

        const sparse = await largestModel(sparseDir);
        if (!sparse) {
          throw new Error(
            'Sparse reconstruction failed: no images could be registered. Add more overlap.',
          );
        }
        // "1:23 into flight.mp4", from the frame number and the sampling rate.
        const describeFrame = (name: string) => {
          const f = parseFrame(name);
          const m = f && media.find((x) => x.id === f.mediaId);
          if (!f || !m) return name;
          const secs = Math.round((f.frame - 1) / settings.videoFps);
          return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} into ${m.original_name}`;
        };
        addStats({
          mapper,
          pathBreaks: result.breaks.length,
          pathBreakAt: result.breaks[0] ? describeFrame(result.breaks[0].from) : undefined,
        });
        addStats(await this.analyzeModel(colmap, sparse));
        addStats({ models: await countModels(sparseDir) });
      });

      // 4. Gravity alignment so models come out upright. Best effort: unaligned models still mesh fine.
      await step('Aligning orientation', async () => {
        await rm(alignedDir, { recursive: true, force: true });
        await mkdir(alignedDir, { recursive: true });
        try {
          await exec(colmap, [
            'model_orientation_aligner',
            '--image_path',
            imagesDir,
            '--input_path',
            (await largestModel(sparseDir))!,
            '--output_path',
            alignedDir,
            '--max_image_size',
            '1024',
            // 360° views are level by construction (cameras level the horizon with their gyro),
            // which pins gravity exactly; elsewhere, vanishing lines of walls and edges do.
            ...(pano ? ['--method', 'IMAGE-ORIENTATION'] : []),
          ]);
        } catch (err) {
          if (err instanceof Cancelled) throw err;
          await rm(alignedDir, { recursive: true, force: true });
          log.write('Orientation alignment failed; continuing with unaligned model\n');
        }
      });

      // 5. Multi-view stereo (CUDA).
      await step('Undistorting images', async () => {
        await rm(denseDir, { recursive: true, force: true });
        await exec(colmap, [
          'image_undistorter',
          '--image_path',
          imagesDir,
          '--input_path',
          (await model())!,
          '--output_path',
          denseDir,
          '--output_type',
          'COLMAP',
          '--max_image_size',
          size,
          '--num_patch_match_src_images',
          String(DENSE_SOURCES[settings.quality]),
        ]);
      });

      await step('Dense stereo', async () => {
        if (!colmap.gpu) {
          throw new Error(
            'Sparse model done, but dense stereo needs a CUDA GPU. For Docker, install the NVIDIA Container Toolkit, then start a new run.',
          );
        }
        // COLMAP skips views whose depth maps exist, so a resumed run starts part-way through.
        const done = await depthMapCounts(denseDir);
        if (done.total) setFraction((done.photometric + done.geometric) / (2 * done.total));
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
          // A photometric pass, then a geometric pass, over every view.
          {
            progress: multiPass(
              setFraction,
              2,
              done.total && done.photometric >= done.total ? 1 : 0,
            ),
          },
        );
      });

      await step('Fusing point cloud', async () => {
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
        const densePoints = await plyVertexCount(fused);
        if (densePoints !== null) addStats({ densePoints });
      });

      // 6. Surface reconstruction. Delaunay copes better with thin walls and textureless interiors.
      await step('Meshing', async () => {
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
        const rawMeshFaces = await plyVertexCount(rawMesh, 'face');
        if (rawMeshFaces !== null) addStats({ rawMeshFaces });
      });

      // 7. Blender: clean, orient, scale, and export STL/GLB/.blend.
      await step('Post-processing in Blender', async () => {
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
          fused,
          String(stlFaces(settings)),
        ]);
        await copyFile(rawMesh, join(outDir, 'mesh.ply'));
        try {
          const post = JSON.parse(await readFile(join(outDir, 'postprocess.json'), 'utf8'));
          addStats({
            meshFaces: post.faces,
            printableFaces: post.printableFaces,
            dimensionsMm: post.dimensionsMm,
          });
        } catch {
          // Stats are informational only.
        }
      });

      return collectOutputs(outDir);
    } finally {
      await new Promise((r) => log.end(r));
    }
  }

  /** Registered images, point count and reprojection error of a sparse model. */
  private async analyzeModel(colmap: ColmapCommand, model: string): Promise<JobStats> {
    const out = await new Promise<string>((resolve) => {
      execFile(
        colmap.bin,
        [...colmap.args, 'model_analyzer', '--path', model],
        { maxBuffer: 4 << 20 },
        (_e, stdout, stderr) => resolve(`${stdout}${stderr}`),
      );
    });
    const num = (re: RegExp) => {
      const m = out.match(re);
      return m ? Number(m[1]) : undefined;
    };
    return {
      trackLength: num(/Mean track length: ([\d.]+)/),
      registeredImages: num(/Registered images: (\d+)/),
      sparsePoints: num(/Points: (\d+)/),
      reprojectionError: num(/Mean reprojection error: ([\d.]+)/),
    };
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

/** Reads the vertex count from a PLY header without loading the file. */
interface PanoRig {
  /** Folder under images/ holding v0…v3 view folders. */
  prefix: string;
  /** Width and height of each square 90° view. */
  size: number;
}

/** A 90° view spans a quarter of the panorama's width; cap it to keep dense stereo affordable. */
const panoViewSize = (width: number) => Math.min(2400, Math.floor(width / PANO_VIEWS / 2) * 2);

/** Yaw of view `i` in degrees, clockwise seen from above, within ffmpeg's −180…180 range. */
const panoYaw = (i: number) => (((360 / PANO_VIEWS) * i + 180) % 360) - 180;

/**
 * Cuts each 360° frame into PANO_VIEWS level 90° pinhole views (`<out>/v<i>/<name>`), like COLMAP's
 * non-overlapping panorama rig. Views stop 45° below the horizon, so someone holding the camera
 * overhead on a stick stays out of frame.
 */
async function splitPanorama(
  ffmpeg: Command,
  exec: (cmd: Command, args: string[]) => Promise<unknown>,
  input: string,
  out: string,
  size: number,
  name: string,
  fps?: number,
) {
  const views = Array.from({ length: PANO_VIEWS }, (_, i) => i);
  for (const i of views) await mkdir(join(out, `v${i}`), { recursive: true });
  const graph =
    `[0:v]${fps ? `fps=${fps},` : ''}split=${PANO_VIEWS}${views.map((i) => `[s${i}]`).join('')};` +
    views
      .map(
        (i) =>
          `[s${i}]v360=input=e:output=flat:yaw=${panoYaw(i)}:h_fov=90:v_fov=90` +
          `:w=${size}:h=${size}:interp=cubic[v${i}]`,
      )
      .join(';');
  await exec(ffmpeg, [
    ...['-hide_banner', '-loglevel', 'error', '-i', input, '-filter_complex', graph],
    ...views.flatMap((i) => [
      ...['-map', `[v${i}]`, '-qscale:v', '2'],
      ...(fps ? [] : ['-frames:v', '1', '-update', '1']),
      join(out, `v${i}`, name),
    ]),
  ]);
}

/** COLMAP rig_configurator entry: view 0 is the reference; the rest are pure yaw rotations. */
function panoRigConfig(rig: PanoRig) {
  const f = rig.size / 2; // 90° field of view
  // One focal length, not PINHOLE's fx/fy: with every camera at one height, bundle adjustment
  // can otherwise trade fy against vertical scale and stretch rooms ~2× taller (seen in testing).
  const camera = {
    camera_model_name: 'SIMPLE_PINHOLE',
    camera_params: [f, rig.size / 2, rig.size / 2],
  };
  return {
    cameras: Array.from({ length: PANO_VIEWS }, (_, i) => {
      const prefix = { image_prefix: `${rig.prefix}/v${i}/`, ...camera };
      if (i === 0) return { ...prefix, ref_sensor: true };
      // cam_from_rig is a rotation of -yaw about the camera's (downward) y axis, as [w, x, y, z].
      const half = (panoYaw(i) * Math.PI) / 360;
      return {
        ...prefix,
        cam_from_rig_rotation: [Math.cos(half), 0, -Math.sin(half), 0],
        cam_from_rig_translation: [0, 0, 0],
      };
    }),
  };
}

/**
 * Verified matches between video frames 1, 2, 4 and 8 apart (the gaps COLMAP's sequential matcher
 * tries). If frames several apart still match strongly, the video was sampled more densely than
 * needed; weak neighbours mean it was sampled too sparsely.
 */
function matchesByGap(databasePath: string): GapMatches[] | undefined {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const frames = new Map<number, { folder: string; index: number }>();
    for (const r of db.prepare(`SELECT image_id, name FROM images`).all() as {
      image_id: number;
      name: string;
    }[]) {
      const m = r.name.match(/^(.*)\/frame-(\d+)\.jpg$/);
      if (m) frames.set(r.image_id, { folder: m[1], index: Number(m[2]) });
    }
    const byGap = new Map<number, number[]>(MATCH_GAPS.map((g) => [g, []]));
    const pairs = db.prepare(`SELECT pair_id, rows FROM two_view_geometries`).all() as {
      pair_id: number | bigint;
      rows: number;
    }[];
    for (const { pair_id, rows } of pairs) {
      const id = BigInt(pair_id);
      const a = frames.get(Number(id / 2147483647n));
      const b = frames.get(Number(id % 2147483647n));
      if (a && b && a.folder === b.folder) byGap.get(Math.abs(a.index - b.index))?.push(rows);
    }
    const result = [...byGap]
      .filter(([, list]) => list.length >= 5)
      .map(([gap, list]) => {
        const sorted = list.sort((x, y) => x - y);
        const at = (q: number) => sorted[Math.floor((sorted.length - 1) * q)];
        return { gap, median: at(0.5), low: at(0.2) };
      });
    return result.length ? result : undefined;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

async function countModels(sparseDir: string) {
  let n = 0;
  for (const name of await readdir(sparseDir)) {
    if (existsSync(join(sparseDir, name, 'images.bin'))) n++;
  }
  return n;
}

/** Frames sampled from videos, counting each 360° frame once rather than per view. */
async function videoFrameCount(imagesDir: string) {
  let n = 0;
  for (const name of await readdir(imagesDir)) {
    if (name.startsWith('video-')) n += await countFiles(join(imagesDir, name));
    else if (/^pano-\d+$/.test(name)) n += await countFiles(join(imagesDir, name, 'v0'));
  }
  return n;
}

/** Vertex count (or another element's count) from a PLY header. */
async function plyVertexCount(path: string, element = 'vertex'): Promise<number | null> {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const m = buf
        .subarray(0, bytesRead)
        .toString('latin1')
        .match(new RegExp(`element ${element} (\\d+)`));
      return m ? Number(m[1]) : null;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

/**
 * For tools that loop over the images several times, restarting their "i / n" counter each pass.
 * `startPass` lets a resumed run begin in a later pass.
 */
function multiPass(setFraction: (f: number) => void, passes: number, startPass = 0) {
  let pass = startPass;
  let last = 0;
  return (f: number) => {
    if (f < last - 0.5) pass++;
    last = f;
    setFraction((Math.min(pass, passes - 1) + f) / passes);
  };
}

/** Depth maps already computed in a dense workspace, per pass. */
async function depthMapCounts(denseDir: string) {
  const imagesDir = join(denseDir, 'images');
  const mapsDir = join(denseDir, 'stereo', 'depth_maps');
  const count = async (dir: string, suffix: string) =>
    existsSync(dir)
      ? (await readdir(dir, { recursive: true })).filter((f) => String(f).endsWith(suffix)).length
      : 0;
  return {
    total: await count(imagesDir, ''),
    photometric: await count(mapsDir, '.photometric.bin'),
    geometric: await count(mapsDir, '.geometric.bin'),
  };
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
// A dev-server reload brings new pipeline code. Swap it in unless the previous instance is mid-run,
// since that run's child processes and cancel handle live there.
const previous = holder[KEY] as unknown as { running?: unknown } | undefined;
if (!previous?.running) holder[KEY] = new Pipeline();
export const pipeline: Pipeline = holder[KEY]!;
