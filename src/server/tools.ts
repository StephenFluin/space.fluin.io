import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './db';
import { promisify } from 'node:util';
import type { SystemStatus, ToolStatus } from '../shared/models';

const run = promisify(execFile);

/** A resolved external program: the executable plus any fixed leading args (e.g. a docker wrapper). */
export interface Command {
  bin: string;
  args: string[];
}

/** COLMAP plus whether it can use CUDA, which dense stereo (patch_match_stereo) requires. */
export interface ColmapCommand extends Command {
  gpu: boolean;
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

let dockerGpuCache: { ok: boolean; at: number } | null = null;

/** Whether containers can reach the GPU (NVIDIA Container Toolkit). Re-checked every minute. */
async function dockerGpuAvailable(image: string): Promise<boolean> {
  if (dockerGpuCache && Date.now() - dockerGpuCache.at < 60_000) return dockerGpuCache.ok;
  let ok = false;
  try {
    await run('docker', ['run', '--rm', '--gpus', 'all', '--entrypoint', 'true', image], {
      timeout: 60_000,
    });
    ok = true;
  } catch {
    ok = false;
  }
  dockerGpuCache = { ok, at: Date.now() };
  return ok;
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
export async function colmapCommand(
  mountDir: string,
  containerName?: string,
): Promise<ColmapCommand | null> {
  const hostGpu = async () => (await versionOf('nvidia-smi', ['-L'])) !== null;
  const explicit = process.env['COLMAP_BIN'];
  if (explicit) return { bin: explicit, args: [], gpu: await hostGpu() };
  const local = await which('colmap');
  if (local) return { bin: local, args: [], gpu: await hostGpu() };
  if ((await which('docker')) && (await dockerImagePresent(COLMAP_IMAGE))) {
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const gpu = await dockerGpuAvailable(COLMAP_IMAGE);
    return {
      gpu,
      bin: 'docker',
      args: [
        'run',
        '--rm',
        ...(gpu ? ['--gpus', 'all'] : []),
        ...(containerName ? ['--name', containerName] : []),
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

/** Containers are namespaced per data directory so separate installs never touch each other's. */
const CONTAINER_PREFIX = `space-${createHash('sha1').update(DATA_DIR).digest('hex').slice(0, 8)}-job-`;

/** Docker container name for a job, so it can be found and stopped from any server process. */
export const jobContainerName = (jobId: number) => `${CONTAINER_PREFIX}${jobId}`;

/** Force-removes a container; a no-op if it doesn't exist or docker isn't installed. */
export async function removeContainer(name: string): Promise<void> {
  await run('docker', ['rm', '-f', name]).catch(() => undefined);
}

/** Job ids of this data directory's running containers. */
export async function jobContainers(): Promise<number[]> {
  try {
    const { stdout } = await run('docker', [
      'ps',
      '--filter',
      `name=^${CONTAINER_PREFIX}`,
      '--format',
      '{{.Names}}',
    ]);
    return stdout
      .split('\n')
      .map((n) => Number(n.trim().slice(CONTAINER_PREFIX.length)))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

export const blenderBin = () => process.env['BLENDER_BIN'] ?? 'blender';
export const ffmpegBin = () => process.env['FFMPEG_BIN'] ?? 'ffmpeg';
export const ffprobeBin = () => process.env['FFPROBE_BIN'] ?? 'ffprobe';

/** Length of a video in seconds, or null if ffprobe can't read it. */
export async function videoDuration(path: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      ffprobeBin(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
      { timeout: 30_000 },
    );
    const seconds = parseFloat(stdout);
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

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
        ? `docker image ${COLMAP_IMAGE}` +
          (colmap.gpu
            ? ' with GPU'
            : ' without GPU access: install the NVIDIA Container Toolkit for dense reconstruction')
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
    ready: tools.slice(0, 2).every((t) => t.available) && colmap?.gpu === true,
  };
}
