import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const FRAME = /^(video-\d+|pano-\d+\/v0)\/frame-(\d+)\.jpg$/;

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
    list.push({ frame: Number(m[2]), name, pose });
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

/** "video-12/frame-00178.jpg" → { mediaId: 12, frame: 178 } (frames are numbered from 1). */
export function parseFrame(name: string) {
  const m = FRAME.exec(name);
  return m ? { mediaId: Number(/\d+/.exec(m[1])![0]), frame: Number(m[2]) } : null;
}

function angleBetween(a: number[], b: number[]) {
  // trace(Aᵀ B) = Σ a_ij b_ij for the relative rotation.
  const trace = a.reduce((n, v, i) => n + v * b[i], 0);
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}
