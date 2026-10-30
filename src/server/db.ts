import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JobStatus, ProjectKind } from '../shared/models';

/** Root folder for the database, uploaded media and reconstruction workspaces. */
export const DATA_DIR = resolve(process.env['SPACE_DATA_DIR'] ?? 'data');

// Kept on globalThis so dev-server reloads of server.ts reuse the open connection.
const KEY = Symbol.for('space.fluin.io/db');
const holder = globalThis as unknown as Record<symbol, DatabaseSync | undefined>;

/** Opens the database lazily so the build-time route extraction never touches disk. */
export function getDb(): DatabaseSync {
  const existing = holder[KEY];
  if (existing) return existing;
  mkdirSync(DATA_DIR, { recursive: true });
  const db = (holder[KEY] = new DatabaseSync(join(DATA_DIR, 'space.db')));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

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
  // A running job belonged to a previous server process; queued jobs are picked up again.
  db.prepare(
    `UPDATE jobs SET status = 'failed', error = 'Interrupted by server restart', finished_at = datetime('now')
     WHERE status = 'running'`,
  ).run();
  return db;
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
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export const projectDir = (projectId: number) => join(DATA_DIR, 'projects', String(projectId));
export const mediaDir = (projectId: number) => join(projectDir(projectId), 'media');
export const jobDir = (projectId: number, jobId: number) =>
  join(projectDir(projectId), 'jobs', String(jobId));
