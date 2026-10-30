import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SystemStatus, ToolStatus } from '../shared/models';

const run = promisify(execFile);

/** A resolved external program: the executable plus any fixed leading args (e.g. a docker wrapper). */
export interface Command {
  bin: string;
  args: string[];
}

const COLMAP_IMAGE = process.env['COLMAP_DOCKER_IMAGE'] ?? 'colmap/colmap:latest';

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await run('which', [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function dockerImagePresent(image: string): Promise<boolean> {
  try {
    await run('docker', ['image', 'inspect', image]);
    return true;
  } catch {
    return false;
  }
}

/**
 * COLMAP is resolved in this order: COLMAP_BIN, a `colmap` on PATH, then the official
 * docker image (needs the NVIDIA container toolkit for dense reconstruction).
 * Docker mounts the job directory at the same path so all paths stay valid inside the container.
 */
export async function colmapCommand(mountDir: string): Promise<Command | null> {
  const explicit = process.env['COLMAP_BIN'];
  if (explicit) return { bin: explicit, args: [] };
  const local = await which('colmap');
  if (local) return { bin: local, args: [] };
  if ((await which('docker')) && (await dockerImagePresent(COLMAP_IMAGE))) {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    return {
      bin: 'docker',
      args: [
        'run',
        '--rm',
        '--gpus',
        'all',
        '--user',
        `${uid}:${gid}`,
        '-v',
        `${mountDir}:${mountDir}`,
        '-w',
        mountDir,
        COLMAP_IMAGE,
        'colmap',
      ],
    };
  }
  return null;
}

export const blenderBin = () => process.env['BLENDER_BIN'] ?? 'blender';
export const ffmpegBin = () => process.env['FFMPEG_BIN'] ?? 'ffmpeg';

async function versionOf(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 20_000 });
    return (stdout || stderr).split('\n')[0].trim();
  } catch {
    return null;
  }
}

export async function systemStatus(): Promise<SystemStatus> {
  const tools: ToolStatus[] = [];

  const colmap = await colmapCommand('/tmp');
  tools.push({
    name: 'COLMAP',
    available: colmap !== null,
    detail: colmap
      ? colmap.bin === 'docker'
        ? `docker image ${COLMAP_IMAGE}`
        : colmap.bin
      : `Not found. Install colmap, set COLMAP_BIN, or run: docker pull ${COLMAP_IMAGE}`,
  });

  const blender = await versionOf(blenderBin(), ['--version']);
  tools.push({
    name: 'Blender',
    available: blender !== null,
    detail: blender ?? 'Not found. Install Blender 4.2+ or set BLENDER_BIN',
  });

  const ffmpeg = await versionOf(ffmpegBin(), ['-version']);
  tools.push({
    name: 'FFmpeg',
    available: ffmpeg !== null,
    detail: ffmpeg ?? 'Not found. Install ffmpeg or set FFMPEG_BIN (needed for videos)',
  });

  const gpu = await versionOf('nvidia-smi', ['-L']);
  tools.push({
    name: 'CUDA GPU',
    available: gpu !== null,
    detail: gpu ?? 'No NVIDIA GPU detected; COLMAP dense stereo requires CUDA',
  });

  return {
    tools,
    ready: tools.slice(0, 2).every((t) => t.available),
  };
}
