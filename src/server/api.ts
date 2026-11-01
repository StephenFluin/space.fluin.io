import express, { type Request, type Response } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { open, rm, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  KEEP_ALL_FACES,
  MAX_TARGET_FACES,
  MIN_TARGET_FACES,
  STAGES,
  estimateStageSeconds,
  isSpherical,
  type Calibration,
  type EstimateInput,
  type Job,
  type JobSettings,
  type Media,
  type Mesher,
  type Project,
  type ProjectKind,
  type Quality,
} from '../shared/models';
import {
  getDb,
  jobDir,
  mediaDir,
  projectDir,
  type JobRow,
  type MediaRow,
  type ProjectRow,
} from './db';
import { pipeline } from './pipeline';
import { thumbnail } from './thumbnails';
import { mediaInfo, systemStatus } from './tools';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.avi', '.webm']);
const OUTPUT_FILES = new Set(['model.stl', 'model.blend', 'model.glb', 'mesh.ply']);

const toJob = (r: JobRow): Job => ({
  id: r.id,
  projectId: r.project_id,
  status: r.status,
  stage: r.stage,
  progress: r.progress,
  settings: JSON.parse(r.settings),
  outputs: JSON.parse(r.outputs),
  stages: JSON.parse(r.stages ?? '[]'),
  stats: JSON.parse(r.stats ?? '{}'),
  attempts: r.attempts ?? 0,
  error: r.error,
  createdAt: r.created_at,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

const toMedia = (r: MediaRow): Media => ({
  id: r.id,
  projectId: r.project_id,
  originalName: r.original_name,
  type: r.type,
  size: r.size,
  duration: r.duration && r.duration > 0 ? r.duration : null,
  spherical: isSpherical(r.width, r.height),
  createdAt: r.created_at,
});

/** Probes pixel size (and video length) of uploads not probed yet, including older uploads. */
async function fillMediaInfo(projectId?: number) {
  const rows = getDb()
    .prepare(
      `SELECT * FROM media WHERE width IS NULL` +
        (projectId === undefined ? '' : ` AND project_id = ${Number(projectId)}`),
    )
    .all() as unknown as MediaRow[];
  for (const m of rows) {
    const info = await mediaInfo(join(mediaDir(m.project_id), m.filename));
    const duration = m.type === 'video' ? (info.duration ?? -1) : null;
    // -1 marks unreadable values so files aren't probed on every request.
    getDb()
      .prepare(`UPDATE media SET duration = ?, width = ?, height = ? WHERE id = ?`)
      .run(duration, info.width ?? -1, info.height ?? -1, m.id);
  }
}

function toProject(r: ProjectRow): Project {
  const db = getDb();
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(type = 'image') AS photos,
              SUM(type = 'video') AS videos,
              SUM(CASE WHEN type = 'video' AND duration > 0 THEN duration ELSE 0 END) AS seconds
       FROM media WHERE project_id = ?`,
    )
    .get(r.id) as {
    n: number;
    photos: number | null;
    videos: number | null;
    seconds: number | null;
  };
  const job = db
    .prepare(`SELECT * FROM jobs WHERE project_id = ? ORDER BY id DESC LIMIT 1`)
    .get(r.id) as JobRow | undefined;
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    notes: r.notes,
    createdAt: r.created_at,
    mediaCount: counts.n,
    photoCount: counts.photos ?? 0,
    videoCount: counts.videos ?? 0,
    videoSeconds: counts.seconds ?? 0,
    latestJob: job ? toJob(job) : null,
  };
}

const getProject = (id: number) =>
  getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRow | undefined;
const getJob = (id: number) =>
  getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;

const isKind = (v: unknown): v is ProjectKind => v === 'exterior' || v === 'interior';
const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : fallback;
};

function parseSettings(kind: ProjectKind, body: Partial<JobSettings> = {}): JobSettings {
  const d = DEFAULT_SETTINGS[kind];
  const qualities: Quality[] = ['preview', 'medium', 'high'];
  const meshers: Mesher[] = ['poisson', 'delaunay'];
  return {
    quality: qualities.includes(body.quality as Quality) ? (body.quality as Quality) : d.quality,
    mesher: meshers.includes(body.mesher as Mesher) ? (body.mesher as Mesher) : d.mesher,
    videoFps: clamp(body.videoFps, 0.1, 10, d.videoFps),
    printSizeMm: clamp(body.printSizeMm, 10, 1000, d.printSizeMm),
    targetFaces:
      Number(body.targetFaces) === KEEP_ALL_FACES
        ? KEEP_ALL_FACES
        : Math.round(clamp(body.targetFaces, MIN_TARGET_FACES, MAX_TARGET_FACES, d.targetFaces)),
    printFaces: Math.round(
      clamp(body.printFaces, MIN_TARGET_FACES, MAX_TARGET_FACES, d.printFaces ?? d.targetFaces),
    ),
    flatten: typeof body.flatten === 'boolean' ? body.flatten : d.flatten,
  };
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = mediaDir(Number(req.params['id']));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) =>
      cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 20 * 1024 ** 3 },
  fileFilter: (_req, file, cb) => {
    const ext = extname(file.originalname).toLowerCase();
    cb(null, IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext));
  },
});

const notFound = (res: Response) => res.status(404).json({ error: 'Not found' });
const id = (req: Request, key = 'id') => Number(req.params[key]);

export function createApi() {
  const api = express.Router();
  api.use(express.json());

  // Resume anything queued before the last shutdown. Deferred to the first request so
  // build-time route extraction, which imports this file, never opens the database.
  let resumed = false;
  api.use((_req, _res, next) => {
    if (!resumed) {
      resumed = true;
      pipeline.enqueue();
    }
    next();
  });

  /**
   * Per step, how much slower or faster than the built-in estimate this machine really is: the
   * median of actual ÷ estimated over the step's 20 most recent recorded timings.
   */
  api.get('/calibration', (_req, res) => {
    const db = getDb();
    const median = (xs: number[]) => {
      const sorted = xs.filter((r) => Number.isFinite(r) && r > 0).sort((a, b) => a - b);
      return sorted.length
        ? Math.min(Math.max(sorted[Math.floor(sorted.length / 2)], 0.05), 50)
        : null;
    };
    const body: Calibration = { factors: {}, byQuality: {}, runs: 0 };
    const runs = new Set<number>();
    for (const { name } of STAGES) {
      const samples = (
        db
          .prepare(
            `SELECT job_id, seconds, inputs FROM stage_samples WHERE stage = ? ORDER BY id DESC LIMIT 50`,
          )
          .all(name) as { job_id: number; seconds: number; inputs: string }[]
      ).map((sm) => {
        runs.add(sm.job_id);
        const inputs = JSON.parse(sm.inputs) as EstimateInput;
        return { quality: inputs.quality, ratio: sm.seconds / estimateStageSeconds(inputs)[name] };
      });
      const all = median(samples.slice(0, 20).map((sm) => sm.ratio));
      if (all !== null) body.factors[name] = all;
      for (const quality of ['preview', 'medium', 'high'] as const) {
        const q = median(
          samples
            .filter((sm) => sm.quality === quality)
            .slice(0, 20)
            .map((sm) => sm.ratio),
        );
        if (q !== null) (body.byQuality[quality] ??= {})[name] = q;
      }
    }
    body.runs = runs.size;
    res.json(body);
  });

  api.get('/system', async (_req, res) => {
    res.json(await systemStatus());
  });

  // --- projects ---
  api.get('/projects', async (_req, res) => {
    await fillMediaInfo();
    const rows = getDb()
      .prepare(`SELECT * FROM projects ORDER BY id DESC`)
      .all() as unknown as ProjectRow[];
    res.json(rows.map(toProject));
  });

  api.post('/projects', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const kind = req.body?.kind;
    if (!name || !isKind(kind)) {
      res.status(400).json({ error: 'name and kind (exterior | interior) are required' });
      return;
    }
    const notes = String(req.body?.notes ?? '');
    const r = getDb()
      .prepare(`INSERT INTO projects (name, kind, notes) VALUES (?, ?, ?)`)
      .run(name, kind, notes);
    res.status(201).json(toProject(getProject(Number(r.lastInsertRowid))!));
  });

  api.get('/projects/:id', async (req, res) => {
    await fillMediaInfo(id(req));
    const p = getProject(id(req));
    if (!p) return void notFound(res);
    res.json(toProject(p));
  });

  api.patch('/projects/:id', (req, res) => {
    const p = getProject(id(req));
    if (!p) return void notFound(res);
    const name =
      typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : p.name;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : p.notes;
    const kind = isKind(req.body?.kind) ? req.body.kind : p.kind;
    getDb()
      .prepare(`UPDATE projects SET name = ?, notes = ?, kind = ? WHERE id = ?`)
      .run(name, notes, kind, p.id);
    res.json(toProject(getProject(p.id)!));
  });

  api.delete('/projects/:id', async (req, res) => {
    const p = getProject(id(req));
    if (!p) return void notFound(res);
    const active = getDb()
      .prepare(`SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running')`)
      .all(p.id) as { id: number }[];
    for (const j of active) pipeline.cancel(j.id);
    getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(p.id);
    await rm(projectDir(p.id), { recursive: true, force: true });
    res.status(204).end();
  });

  // --- media ---
  api.get('/projects/:id/media', async (req, res) => {
    await fillMediaInfo(id(req));
    const rows = getDb()
      .prepare(`SELECT * FROM media WHERE project_id = ? ORDER BY id`)
      .all(id(req)) as unknown as MediaRow[];
    res.json(rows.map(toMedia));
  });

  api.post(
    '/projects/:id/media',
    (req, res, next) => (getProject(id(req)) ? next() : notFound(res)),
    upload.array('files'),
    async (req, res) => {
      const files = (req.files ?? []) as Express.Multer.File[];
      const insert = getDb().prepare(
        `INSERT INTO media (project_id, filename, original_name, type, size) VALUES (?, ?, ?, ?, ?)`,
      );
      const created = files.map((f) => {
        const type = VIDEO_EXT.has(extname(f.originalname).toLowerCase()) ? 'video' : 'image';
        const r = insert.run(id(req), f.filename, f.originalname, type, f.size);
        return toMedia(
          getDb()
            .prepare(`SELECT * FROM media WHERE id = ?`)
            .get(Number(r.lastInsertRowid)) as unknown as MediaRow,
        );
      });
      await fillMediaInfo(id(req));
      res
        .status(201)
        .json(
          created.map((m) =>
            toMedia(
              getDb().prepare(`SELECT * FROM media WHERE id = ?`).get(m.id) as unknown as MediaRow,
            ),
          ),
        );
    },
  );

  api.get('/media/:id/file', (req, res) => {
    const m = getDb().prepare(`SELECT * FROM media WHERE id = ?`).get(id(req)) as
      MediaRow | undefined;
    if (!m) return void notFound(res);
    res.sendFile(join(mediaDir(m.project_id), m.filename), { maxAge: '1d' });
  });

  api.get('/media/:id/thumb', async (req, res) => {
    const m = getDb().prepare(`SELECT * FROM media WHERE id = ?`).get(id(req)) as
      MediaRow | undefined;
    if (!m) return void notFound(res);
    try {
      res.sendFile(await thumbnail(m), { maxAge: '7d' });
    } catch {
      res.status(422).json({ error: 'Could not create a preview of this file' });
    }
  });

  api.delete('/media/:id', async (req, res) => {
    const m = getDb().prepare(`SELECT * FROM media WHERE id = ?`).get(id(req)) as
      MediaRow | undefined;
    if (!m) return void notFound(res);
    getDb().prepare(`DELETE FROM media WHERE id = ?`).run(m.id);
    await unlink(join(mediaDir(m.project_id), m.filename)).catch(() => undefined);
    await unlink(join(projectDir(m.project_id), 'thumbs', `${m.id}.jpg`)).catch(() => undefined);
    res.status(204).end();
  });

  // --- jobs ---
  api.get('/projects/:id/jobs', (req, res) => {
    const rows = getDb()
      .prepare(`SELECT * FROM jobs WHERE project_id = ? ORDER BY id DESC`)
      .all(id(req)) as unknown as JobRow[];
    res.json(rows.map(toJob));
  });

  api.post('/projects/:id/jobs', (req, res) => {
    const p = getProject(id(req));
    if (!p) return void notFound(res);
    const settings = parseSettings(p.kind, req.body);
    const r = getDb()
      .prepare(`INSERT INTO jobs (project_id, settings, stage) VALUES (?, ?, 'Queued')`)
      .run(p.id, JSON.stringify(settings));
    pipeline.enqueue();
    res.status(201).json(toJob(getJob(Number(r.lastInsertRowid))!));
  });

  api.get('/jobs/:id', (req, res) => {
    const j = getJob(id(req));
    if (!j) return void notFound(res);
    res.json(toJob(j));
  });

  api.post('/jobs/:id/cancel', (req, res) => {
    const j = getJob(id(req));
    if (!j) return void notFound(res);
    res.json({ cancelled: pipeline.cancel(j.id) });
  });

  api.delete('/jobs/:id', async (req, res) => {
    const j = getJob(id(req));
    if (!j) return void notFound(res);
    if (j.status === 'running' || j.status === 'queued') {
      res.status(409).json({ error: 'Cancel the job before deleting it' });
      return;
    }
    getDb().prepare(`DELETE FROM jobs WHERE id = ?`).run(j.id);
    await rm(jobDir(j.project_id, j.id), { recursive: true, force: true });
    res.status(204).end();
  });

  /** Tail of the job log (last 64 KB). */
  api.get('/jobs/:id/log', async (req, res) => {
    const j = getJob(id(req));
    if (!j) return void notFound(res);
    const path = join(jobDir(j.project_id, j.id), 'job.log');
    if (!existsSync(path)) return void res.type('text/plain').send('');
    const { size } = await stat(path);
    const len = Math.min(size, 64 * 1024);
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      res.type('text/plain').send(buf.toString('utf8'));
    } finally {
      await fh.close();
    }
  });

  api.get('/jobs/:id/files/:file', (req, res) => {
    const j = getJob(id(req));
    const file = req.params['file'];
    if (!j || !OUTPUT_FILES.has(file)) return void notFound(res);
    const path = join(jobDir(j.project_id, j.id), 'output', file);
    if (!existsSync(path)) return void notFound(res);
    const project = getProject(j.project_id);
    const base = (project?.name ?? 'model').replace(/[^\w.-]+/g, '-');
    if (req.query['download'] !== undefined) res.attachment(`${base}-job${j.id}${extname(file)}`);
    res.sendFile(path);
  });

  api.use('/{*splat}', (_req, res) => notFound(res));
  return api;
}
