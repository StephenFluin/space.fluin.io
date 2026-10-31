import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  EstimateInput,
  JobSettings,
  JobStats,
  JobStatus,
  ProjectKind,
  StageTiming,
} from '../shared/models';

/** Root folder for the database, uploaded media and reconstruction workspaces. */
export const DATA_DIR = resolve(process.env['SPACE_DATA_DIR'] ?? 'data');

// Kept on globalThis so dev-server reloads of server.ts reuse the open connection.
const KEY = Symbol.for('space.fluin.io/db');
const holder = globalThis as unknown as Record<symbol, DatabaseSync | undefined>;

let migrated = false;

/** Server restarts a run may survive before it is failed. */
const MAX_ATTEMPTS = 3;

/** Adds columns introduced after the first release. Idempotent. */
function migrate(db: DatabaseSync) {
  migrated = true;
  const jobColumns = (db.prepare(`PRAGMA table_info(jobs)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!jobColumns.includes('worker_pid')) db.exec(`ALTER TABLE jobs ADD COLUMN worker_pid INTEGER`);
  if (!jobColumns.includes('cancel_requested')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0`);
  }
  if (!jobColumns.includes('stages'))
    db.exec(`ALTER TABLE jobs ADD COLUMN stages TEXT NOT NULL DEFAULT '[]'`);
  if (!jobColumns.includes('stats'))
    db.exec(`ALTER TABLE jobs ADD COLUMN stats TEXT NOT NULL DEFAULT '{}'`);

  const mediaColumns = (db.prepare(`PRAGMA table_info(media)`).all() as { name: string }[]).map(
    (c) => c.name,
  );
  if (!mediaColumns.includes('duration')) db.exec(`ALTER TABLE media ADD COLUMN duration REAL`);
  if (!mediaColumns.includes('width')) {
    db.exec(`ALTER TABLE media ADD COLUMN width INTEGER`);
    db.exec(`ALTER TABLE media ADD COLUMN height INTEGER`);
  }
  if (!jobColumns.includes('attempts')) {
    db.exec(`ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
  }

  // One row per completed step, kept even when the run is deleted, to calibrate time estimates.
  const hasSamples = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stage_samples'`)
    .get();
  if (!hasSamples) {
    db.exec(`
      CREATE TABLE stage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL,
        stage TEXT NOT NULL,
        seconds REAL NOT NULL,
        inputs TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX stage_samples_stage ON stage_samples (stage, id);
    `);
    backfillSamples(db);
  }
}

/** Seeds stage_samples from runs finished before samples were recorded. */
function backfillSamples(db: DatabaseSync) {
  const jobs = db
    .prepare(`SELECT id, settings, stats, stages FROM jobs WHERE status = 'done'`)
    .all() as { id: number; settings: string; stats: string; stages: string }[];
  const insert = db.prepare(
    `INSERT INTO stage_samples (job_id, stage, seconds, inputs) VALUES (?, ?, ?, ?)`,
  );
  for (const job of jobs) {
    const stats = JSON.parse(job.stats) as JobStats;
    const settings = JSON.parse(job.settings) as JobSettings;
    if (!stats.images) continue;
    const inputs: EstimateInput = {
      images: stats.images,
      photos: stats.photos ?? 0,
      videos: stats.videos ?? 0,
      quality: settings.quality,
      targetFaces: settings.targetFaces,
      // Runs before this was recorded used COLMAP's default of 20.
      denseSources: stats.denseSources ?? 20,
    };
    for (const t of JSON.parse(job.stages) as StageTiming[]) {
      if (!t.finishedAt || t.interrupted) continue;
      const seconds = (Date.parse(t.finishedAt) - Date.parse(t.startedAt)) / 1000;
      insert.run(job.id, t.name, seconds, JSON.stringify(inputs));
    }
  }
}

/** Opens the database lazily so the build-time route extraction never touches disk. */
export function getDb(): DatabaseSync {
  const existing = holder[KEY];
  if (existing) {
    // A dev-server reload keeps the connection but may bring new migrations.
    if (!migrated) migrate(existing);
    return existing;
  }
  mkdirSync(DATA_DIR, { recursive: true });
  const db = (holder[KEY] = new DatabaseSync(join(DATA_DIR, 'space.db')));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('exterior', 'interior')),
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('image', 'video')),
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT '',
      progress REAL NOT NULL DEFAULT 0,
      settings TEXT NOT NULL DEFAULT '{}',
      outputs TEXT NOT NULL DEFAULT '[]',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );
  `);
  migrate(db);

  // Several servers (e.g. a dev server and a production build) may share this database, so only
  // touch running jobs whose worker process is gone. Those are queued again and resume from their
  // last finished step; a run that keeps getting interrupted is failed instead of looping forever.
  const running = db
    .prepare(`SELECT id, worker_pid, attempts, stages FROM jobs WHERE status = 'running'`)
    .all() as { id: number; worker_pid: number | null; attempts: number; stages: string }[];
  for (const job of running) {
    if (job.worker_pid && isAlive(job.worker_pid)) continue;
    const stages = JSON.parse(job.stages) as StageTiming[];
    for (const t of stages) {
      if (!t.finishedAt) {
        t.finishedAt = new Date().toISOString();
        t.interrupted = true;
      }
    }
    if (job.attempts >= MAX_ATTEMPTS) {
      db.prepare(
        `UPDATE jobs SET status = 'failed', stages = ?, finished_at = datetime('now'),
           error = 'Interrupted by server restarts ${MAX_ATTEMPTS} times; start a new run'
         WHERE id = ?`,
      ).run(JSON.stringify(stages), job.id);
    } else {
      db.prepare(
        `UPDATE jobs SET status = 'queued', worker_pid = NULL, cancel_requested = 0, stages = ?
         WHERE id = ?`,
      ).run(JSON.stringify(stages), job.id);
    }
  }
  return db;
}

/** Whether another process with this pid is running. */
export function isAlive(pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProjectRow {
  id: number;
  name: string;
  kind: ProjectKind;
  notes: string;
  created_at: string;
}

export interface MediaRow {
  id: number;
  project_id: number;
  filename: string;
  original_name: string;
  type: 'image' | 'video';
  size: number;
  duration: number | null;
  width: number | null;
  height: number | null;
  created_at: string;
}

export interface JobRow {
  id: number;
  project_id: number;
  status: JobStatus;
  stage: string;
  progress: number;
  settings: string;
  outputs: string;
  error: string | null;
  worker_pid: number | null;
  cancel_requested: number;
  stages: string;
  stats: string;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const projectDir = (projectId: number) => join(DATA_DIR, 'projects', String(projectId));
export const mediaDir = (projectId: number) => join(projectDir(projectId), 'media');
export const jobDir = (projectId: number, jobId: number) =>
  join(projectDir(projectId), 'jobs', String(jobId));
