import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JobStatus, ProjectKind } from '../shared/models';

/** Root folder for the database, uploaded media and reconstruction workspaces. */
export const DATA_DIR = resolve(process.env['SPACE_DATA_DIR'] ?? 'data');

// Kept on globalThis so dev-server reloads of server.ts reuse the open connection.
const KEY = Symbol.for('space.fluin.io/db');
const holder = globalThis as unknown as Record<symbol, DatabaseSync | undefined>;

let migrated = false;

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
  // fail running jobs whose worker process is gone. Queued jobs are picked up again.
  const running = db.prepare(`SELECT id, worker_pid FROM jobs WHERE status = 'running'`).all() as {
    id: number;
    worker_pid: number | null;
  }[];
  for (const job of running) {
    if (job.worker_pid && isAlive(job.worker_pid)) continue;
    db.prepare(
      `UPDATE jobs SET status = 'failed', error = 'Interrupted by server restart', finished_at = datetime('now')
       WHERE id = ?`,
    ).run(job.id);
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
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const projectDir = (projectId: number) => join(DATA_DIR, 'projects', String(projectId));
export const mediaDir = (projectId: number) => join(projectDir(projectId), 'media');
export const jobDir = (projectId: number, jobId: number) =>
  join(projectDir(projectId), 'jobs', String(jobId));
