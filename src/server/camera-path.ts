import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from './tools';

/** Two consecutive video frames the model placed implausibly far apart or facing away. */
export interface PathBreak {
  from: string;
  to: string;
  /** Distance between the two cameras as a multiple of the median frame-to-frame distance. */
  step: number;
  /** Rotation between the two cameras in degrees. */
  turn: number;
}

interface Pose {
  centre: [number, number, number];
  /** World-from-camera rotation, row-major. */
  rotation: number[];
}

/**
 * Reads camera poses from a COLMAP images.bin: per image an id, cam_from_world quaternion (w,x,y,z)
 * and translation, camera id, null-terminated name, then its 2D points (24 bytes each).
 */
export async function readPoses(modelDir: string): Promise<Map<string, Pose>> {
  const buf = await readFile(join(modelDir, 'images.bin'));
  const poses = new Map<string, Pose>();
  let o = 0;
  const count = Number(buf.readBigUInt64LE(o));
  o += 8;
  for (let i = 0; i < count; i++) {
    o += 4; // image id
    const [w, x, y, z] = [0, 1, 2, 3].map((k) => buf.readDoubleLE(o + k * 8));
    const t = [0, 1, 2].map((k) => buf.readDoubleLE(o + 32 + k * 8));
    o += 56 + 4; // pose + camera id
    const end = buf.indexOf(0, o);
    const name = buf.toString('utf8', o, end);
    o = end + 1;
    o += 8 + Number(buf.readBigUInt64LE(o)) * 24;
    // R is cam_from_world; the camera centre is -Rᵀt and Rᵀ is world_from_cam.
    const r = [
      1 - 2 * (y * y + z * z),
      2 * (x * y - w * z),
      2 * (x * z + w * y),
      2 * (x * y + w * z),
      1 - 2 * (x * x + z * z),
      2 * (y * z - w * x),
      2 * (x * z - w * y),
      2 * (y * z + w * x),
      1 - 2 * (x * x + y * y),
    ];
    const rt = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
    const centre = [0, 1, 2].map(
      (row) => -(rt[row * 3] * t[0] + rt[row * 3 + 1] * t[1] + rt[row * 3 + 2] * t[2]),
    ) as [number, number, number];
    poses.set(name, { centre, rotation: rt });
  }
  return poses;
}

/**
 * Sampled video frames are "frame-00178.jpg"; extra frames added between them are
 * "frame-00178_25.jpg" (a quarter of the way to 179), which sorts between the two so COLMAP's
 * sequential matcher pairs it with its neighbours.
 */
const FRAME = /^(video-\d+|pano-\d+\/v0)\/frame-(\d+)(?:_(\d\d))?\.jpg$/;
const frameNumber = (m: RegExpExecArray) => Number(m[2]) + (m[3] ? Number(m[3]) / 100 : 0);

/**
 * Finds places where a video's camera path breaks: neighbouring frames (at most one frame apart)
 * that the model put far apart or turned more than 90°. A real camera can't do that in a fraction
 * of a second, so it means pieces of the reconstruction were joined in the wrong place, which
 * shows up as copies of the scene overlapping at odd angles.
 */
export function findPathBreaks(poses: Map<string, Pose>): PathBreak[] {
  const byVideo = new Map<string, { frame: number; name: string; pose: Pose }[]>();
  for (const [name, pose] of poses) {
    const m = FRAME.exec(name);
    if (!m) continue;
    const list = byVideo.get(m[1]) ?? [];
    list.push({ frame: frameNumber(m), name, pose });
    byVideo.set(m[1], list);
  }
  const pairs: { from: string; to: string; dist: number; turn: number }[] = [];
  const centres: [number, number, number][] = [];
  for (const list of byVideo.values()) {
    list.sort((a, b) => a.frame - b.frame);
    for (const f of list) centres.push(f.pose.centre);
    for (let i = 1; i < list.length; i++) {
      const [a, b] = [list[i - 1], list[i]];
      if (b.frame - a.frame > 2) continue;
      pairs.push({
        from: a.name,
        to: b.name,
        dist: Math.hypot(...a.pose.centre.map((v, k) => v - b.pose.centre[k])),
        turn: angleBetween(a.pose.rotation, b.pose.rotation),
      });
    }
  }
  if (pairs.length < 10) return [];
  const median = [...pairs.map((p) => p.dist)].sort((a, b) => a - b)[pairs.length >> 1] || 1e-9;
  // Fast flight legitimately covers several median steps; require a jump that is also a sizeable
  // part of the whole scene so hovering (tiny median) doesn't flag ordinary movement.
  const extent = Math.max(
    ...[0, 1, 2].map(
      (k) => Math.max(...centres.map((c) => c[k])) - Math.min(...centres.map((c) => c[k])),
    ),
  );
  return pairs
    .filter((p) => (p.dist > 25 * median && p.dist > 0.05 * extent) || p.turn > 90)
    .map((p) => ({ from: p.from, to: p.to, step: p.dist / median, turn: p.turn }));
}

/** "video-12/frame-00178_25.jpg" → { mediaId: 12, frame: 178.25 } (frames are numbered from 1). */
export function parseFrame(name: string) {
  const m = FRAME.exec(name);
  return m ? { mediaId: Number(/\d+/.exec(m[1])![0]), frame: frameNumber(m) } : null;
}

/** Originally sampled video frames (not extras) placed in a model. */
export function originalFramesIn(poses: Map<string, unknown>) {
  let n = 0;
  for (const name of poses.keys()) if (FRAME.exec(name)?.[3] === undefined) n++;
  return n;
}

/** Extra frames per original frame in a gap: sampled at 4× the rate. */
const DENSITY = 4;

/**
 * Samples extra frames where a model lost the camera: stretches of each video whose frames
 * weren't placed, and the frames either side of each path break. Those are usually fast turns
 * or quick moves, where neighbouring frames at the normal rate share too little to link up.
 * Adds at most as many frames as the video already has. Returns how many were added.
 */
export async function addFramesAtGaps(
  ffmpeg: Command,
  exec: (cmd: Command, args: string[]) => Promise<unknown>,
  imagesDir: string,
  videos: { id: number; path: string }[],
  fps: number,
  poses: Map<string, unknown>,
  breaks: PathBreak[],
): Promise<number> {
  let added = 0;
  for (const video of videos) {
    const folder = `video-${video.id}`;
    const files = (await readdir(join(imagesDir, folder))).filter((f) =>
      /^frame-\d+\.jpg$/.test(f),
    );
    const total = files.length;
    if (total < 10) continue;
    const hasExtras = (await readdir(join(imagesDir, folder))).some((f) => f.includes('_'));
    if (hasExtras) continue; // already densified, e.g. a resumed run
    const placed = new Set<number>();
    for (const name of poses.keys()) {
      const f = parseFrame(name);
      if (f?.mediaId === video.id && Number.isInteger(f.frame)) placed.add(f.frame);
    }
    if (!placed.size) continue;
    // Frames to densify around: unplaced ones, and both ends of each break.
    const wanted = new Set<number>();
    for (let k = 1; k <= total; k++) if (!placed.has(k)) wanted.add(k);
    for (const b of breaks) {
      for (const name of [b.from, b.to]) {
        const f = parseFrame(name);
        if (f?.mediaId === video.id) wanted.add(Math.floor(f.frame));
      }
    }
    if (wanted.size < Math.max(3, total * 0.03)) continue;
    // Merge into runs, widened by one frame each side so extras link to placed frames.
    const runs: [number, number][] = [];
    for (const k of [...wanted].sort((a, b) => a - b)) {
      const last = runs.at(-1);
      if (last && k <= last[1] + 2) last[1] = k;
      else runs.push([k, k]);
    }
    let budget = total;
    for (const [a, b] of runs) {
      const from = Math.max(1, a - 1);
      const to = Math.min(total, b + 1);
      if (to <= from || budget <= 0) continue;
      const tmp = join(imagesDir, '..', `extra-${video.id}-${from}`);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp);
      await exec(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        String((from - 1) / fps),
        '-to',
        String((to - 1) / fps),
        '-i',
        video.path,
        '-vf',
        `fps=${fps * DENSITY},scale='min(3840,iw)':-2`,
        '-qscale:v',
        '2',
        join(tmp, '%05d.jpg'),
      ]);
      for (const out of (await readdir(tmp)).sort()) {
        const frame = from + (Number(out.slice(0, 5)) - 1) / DENSITY;
        const whole = Math.floor(frame);
        const part = Math.round((frame - whole) * 100);
        if (part === 0 || frame >= to || budget <= 0) continue;
        const name = `frame-${String(whole).padStart(5, '0')}_${String(part).padStart(2, '0')}.jpg`;
        await rename(join(tmp, out), join(imagesDir, folder, name));
        added++;
        budget--;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  }
  return added;
}

function angleBetween(a: number[], b: number[]) {
  // trace(Aᵀ B) = Σ a_ij b_ij for the relative rotation.
  const trace = a.reduce((n, v, i) => n + v * b[i], 0);
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}
