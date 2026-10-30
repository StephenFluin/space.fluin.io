import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaDir, projectDir, type MediaRow } from './db';
import { ffmpegBin } from './tools';

const MAX_PARALLEL = 4;
let active = 0;
const waiting: (() => void)[] = [];
const pending = new Map<number, Promise<string>>();

/**
 * Returns the path of a small JPEG preview of a photo or video, generating and caching it on
 * first request. Originals can be 50+ MB, far too heavy for a thumbnail grid.
 */
export function thumbnail(m: MediaRow): Promise<string> {
  const out = join(projectDir(m.project_id), 'thumbs', `${m.id}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  let job = pending.get(m.id);
  if (!job) {
    job = generate(m, out).finally(() => pending.delete(m.id));
    pending.set(m.id, job);
  }
  return job;
}

async function generate(m: MediaRow, out: string): Promise<string> {
  await mkdir(join(projectDir(m.project_id), 'thumbs'), { recursive: true });
  if (active >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    const src = join(mediaDir(m.project_id), m.filename);
    // For videos, grab a frame a second in to skip black lead-in frames.
    const seek = m.type === 'video' ? ['-ss', '1'] : [];
    await new Promise<void>((resolve, reject) =>
      execFile(
        ffmpegBin(),
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          ...seek,
          '-i',
          src,
          '-frames:v',
          '1',
          '-vf',
          'scale=360:-2',
          '-q:v',
          '4',
          out,
        ],
        { timeout: 60_000 },
        (err) => (err ? reject(err) : resolve()),
      ),
    );
    return out;
  } finally {
    active--;
    waiting.shift()?.();
  }
}
