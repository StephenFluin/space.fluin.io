/** Types shared by the browser app and the API in server.ts. */

export type ProjectKind = 'exterior' | 'interior';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type OutputKind = 'stl' | 'blend' | 'glb' | 'ply' | 'obj';

export type Quality = 'preview' | 'medium' | 'high';

export type Mesher = 'poisson' | 'delaunay';

export interface Project {
  id: number;
  name: string;
  kind: ProjectKind;
  notes: string;
  createdAt: string;
  mediaCount: number;
  photoCount: number;
  videoCount: number;
  /** Total length of all videos in seconds. */
  videoSeconds: number;
  latestJob: Job | null;
}

export interface Media {
  id: number;
  projectId: number;
  originalName: string;
  type: 'image' | 'video';
  size: number;
  /** Video length in seconds; null for photos or when it could not be read. */
  duration: number | null;
  /** Equirectangular 360° photo or video (2:1), split into PANO_VIEWS level views per frame. */
  spherical: boolean;
  createdAt: string;
}

/** Level 90° views cut from each 360° frame (front, right, back, left). */
export const PANO_VIEWS = 4;

/** Equirectangular panoramas are exactly 2:1; phone "panorama" shots are much wider. */
export const isSpherical = (width: number | null, height: number | null) =>
  !!width && !!height && width >= 2000 && Math.abs(width / height - 2) < 0.01;

/** Frames the pipeline will sample from `seconds` of video at `fps`. */
export const videoFrames = (seconds: number, fps: number) => Math.round(seconds * fps);

/** Images COLMAP will see for one upload: 360° frames count once per view. */
export function mediaImages(m: Pick<Media, 'type' | 'duration' | 'spherical'>, fps: number) {
  const frames = m.type === 'video' ? videoFrames(m.duration ?? 0, fps) : 1;
  return frames * (m.spherical ? PANO_VIEWS : 1);
}

export interface JobSettings {
  quality: Quality;
  mesher: Mesher;
  /** Frames per second sampled from each video. */
  videoFps: number;
  /** Longest side of the printed model in millimetres. */
  printSizeMm: number;
  /**
   * Triangles kept in the 3D view (explorer, model.glb and model.blend), or KEEP_ALL_FACES to keep
   * every triangle COLMAP produced.
   */
  targetFaces: number;
  /** Triangle cap for the printable model.stl. Runs from before it existed used `targetFaces`. */
  printFaces?: number;
}

/** `targetFaces` value meaning "don't decimate the 3D view". */
export const KEEP_ALL_FACES = 0;
export const MIN_TARGET_FACES = 10_000;
export const MAX_TARGET_FACES = 20_000_000;

/**
 * Reads a count typed as "250000", "250,000", "250k", "1.5M" or "10m". Returns null when empty
 * and NaN when it can't be read.
 */
export function parseCount(text: string): number | null {
  const t = text.replace(/[\s,_]/g, '');
  if (!t) return null;
  const m = /^(\d*\.?\d+)([km]?)$/i.exec(t);
  if (!m) return NaN;
  const scale = { '': 1, k: 1e3, m: 1e6 }[m[2].toLowerCase() as '' | 'k' | 'm'];
  return Math.round(Number(m[1]) * scale);
}

/** 250000 → "250k", 1500000 → "1.5M"; counts that don't round neatly keep all their digits. */
export function formatCount(n: number): string {
  if (n >= 1e6 && n % 1e5 === 0) return `${n / 1e6}M`;
  if (n >= 1e3 && n % 1e3 === 0) return `${n / 1e3}k`;
  return n.toLocaleString('en');
}
/** COLMAP meshes from real captures typically land between 2M and 10M triangles. */
const TYPICAL_RAW_FACES = 5_000_000;

/** Triangles to plan for in the GLB (estimates and file sizes). */
export const viewFaces = (s: Pick<JobSettings, 'targetFaces'>) =>
  s.targetFaces === KEEP_ALL_FACES ? TYPICAL_RAW_FACES : s.targetFaces;

/** Triangles kept in the STL. */
export const stlFaces = (s: Pick<JobSettings, 'targetFaces' | 'printFaces' | 'printSizeMm'>) =>
  s.printFaces ??
  (s.targetFaces === KEEP_ALL_FACES ? recommendedFaces(s.printSizeMm) : s.targetFaces);

/**
 * Pipeline steps in order, with the share of total run time each typically takes
 * (measured on GPU runs: dense stereo dominates). Drives the progress bar and ETA.
 */
export const STAGES = [
  { name: 'Preparing images', weight: 0.01 },
  { name: 'Extracting features', weight: 0.02 },
  { name: 'Matching features', weight: 0.03 },
  { name: 'Sparse reconstruction', weight: 0.03 },
  { name: 'Aligning orientation', weight: 0.01 },
  { name: 'Undistorting images', weight: 0.01 },
  { name: 'Dense stereo', weight: 0.78 },
  { name: 'Fusing point cloud', weight: 0.02 },
  { name: 'Meshing', weight: 0.03 },
  { name: 'Post-processing in Blender', weight: 0.06 },
] as const;

export type StageName = (typeof STAGES)[number]['name'];

export interface StageTiming {
  name: StageName;
  /** ISO timestamps. */
  startedAt: string;
  finishedAt: string | null;
  /** The server stopped during this attempt; the step ran again when the run resumed. */
  interrupted?: boolean;
}

/** Frame gaps the sequential matcher tries, and so the gaps we can measure overlap at. */
export const MATCH_GAPS = [1, 2, 4, 8];

export interface GapMatches {
  gap: number;
  /** Median and 20th-percentile verified matches between frames `gap` apart. */
  median: number;
  low: number;
}

/** Facts gathered while a run progresses; every field appears once its step has run. */
export interface JobStats {
  images?: number;
  photos?: number;
  videos?: number;
  videoFrames?: number;
  /** 360° photos and videos in the run; each of their frames became PANO_VIEWS views. */
  spherical?: number;
  gpu?: boolean;
  /** Source views per depth map used for dense stereo. */
  denseSources?: number;
  registeredImages?: number;
  sparsePoints?: number;
  reprojectionError?: number;
  densePoints?: number;
  meshFaces?: number;
  printableFaces?: number;
  dimensionsMm?: [number, number, number];
  /** Widest input image in pixels (a 360° view counts at its view size). */
  sourceWidth?: number;
  /** Separate models the mapper produced; only the largest is used. */
  models?: number;
  /** Average number of images each sparse point was seen in. */
  trackLength?: number;
  /** Verified matches between video frames 1, 2, 4 and 8 apart. */
  matchesByGap?: GapMatches[];
  /** Triangles in COLMAP's mesh before Blender decimated it to the target. */
  rawMeshFaces?: number;
  /** Which structure-from-motion solver produced the kept model. */
  mapper?: 'global' | 'incremental';
  /**
   * Places where neighbouring video frames ended up far apart or facing away in the model, meaning
   * pieces were joined in the wrong place. `pathBreakAt` names the first one.
   */
  pathBreaks?: number;
  pathBreakAt?: string;
  /** Frames sampled at 4× the rate where the first model lost the camera (included in images). */
  extraFrames?: number;
  /** Of the originally sampled images (not extras), how many the kept model placed. */
  placedOriginal?: number;
}

export interface JobOutput {
  kind: OutputKind;
  file: string;
  size: number;
}

export interface Job {
  id: number;
  projectId: number;
  status: JobStatus;
  stage: string;
  progress: number;
  settings: JobSettings;
  outputs: JobOutput[];
  stages: StageTiming[];
  stats: JobStats;
  /** How many times a worker has started this run; above 1 means it resumed after a restart. */
  attempts: number;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ToolStatus {
  name: string;
  available: boolean;
  detail: string;
}

export interface SystemStatus {
  tools: ToolStatus[];
  ready: boolean;
}

export const DEFAULT_SETTINGS: Record<ProjectKind, Required<JobSettings>> = {
  exterior: {
    quality: 'medium',
    mesher: 'poisson',
    videoFps: 1,
    printSizeMm: 250,
    targetFaces: 500_000,
    printFaces: 1_000_000,
  },
  interior: {
    quality: 'medium',
    mesher: 'delaunay',
    videoFps: 2,
    printSizeMm: 250,
    targetFaces: 1_000_000,
    printFaces: 1_000_000,
  },
};

/** Longest image side used for dense stereo, per quality preset. */
export const DENSE_SIZE: Record<Quality, number> = { preview: 1000, medium: 2000, high: 3200 };

/** Neighbouring views each depth map is matched against; dense stereo time scales with this. */
export const DENSE_SOURCES: Record<Quality, number> = { preview: 8, medium: 12, high: 20 };

/** Video-heavy and large captures use sequential matching; exhaustive matching is O(n²). */
export const useSequentialMatching = (images: number, photos: number, videos: number) =>
  (videos > 0 && photos < images / 2) || images > 400;

/** What a run's duration depends on. Stored with every timing sample so estimates can be refit. */
export interface EstimateInput {
  images: number;
  photos: number;
  videos: number;
  quality: Quality;
  targetFaces: number;
  /** Defaults to the current DENSE_SOURCES for the quality. */
  denseSources?: number;
}

/**
 * Baseline seconds per step on an RTX-class GPU. Real timings recorded on this machine correct
 * each step separately (see Calibration), since e.g. GPU-bound dense stereo and CPU-bound
 * matching scale very differently between machines.
 */
export function estimateStageSeconds(i: EstimateInput): Record<StageName, number> {
  const n = Math.max(i.images, 0);
  const side = DENSE_SIZE[i.quality] / 1000;
  const mp = side ** 2;
  const sources = i.denseSources ?? DENSE_SOURCES[i.quality];
  const pairs = useSequentialMatching(n, i.photos, i.videos) ? n * 10 : (n * (n - 1)) / 2;
  return {
    'Preparing images': 1 + 0.1 * (n - i.photos),
    'Extracting features': 5 + 0.1 * n,
    'Matching features': 5 + 0.02 * pairs,
    'Sparse reconstruction': 5 + 0.003 * n * n,
    'Aligning orientation': 4 + 0.02 * n,
    'Undistorting images': 2 + 0.02 * n * mp,
    // Two passes (photometric + geometric) over every view, each matched against `sources` views.
    // Measured runs grew far slower than pixel count between presets, so scale by image side.
    'Dense stereo': 0.6 * n * 2 * sources * side,
    'Fusing point cloud': 2 + 0.05 * n * mp,
    Meshing: 10 + 0.8 * n * mp,
    'Post-processing in Blender': 15 + (viewFaces(i) / 1_000_000) * 70,
  };
}

/** Calibrated seconds per step for this machine. */
export function calibratedStageSeconds(
  i: EstimateInput,
  calibration?: Calibration | null,
): Record<StageName, number> {
  const base = estimateStageSeconds(i);
  for (const name of Object.keys(base) as StageName[]) {
    base[name] *= calibration?.byQuality[i.quality]?.[name] ?? calibration?.factors[name] ?? 1;
  }
  return base;
}

export const sumSeconds = (stages: Record<StageName, number>) =>
  Object.values(stages).reduce((a, b) => a + b, 0);

/**
 * Triangles worth keeping for a print: about two per 0.4 mm nozzle-width cell over the model's
 * footprint. More detail than this can't be printed, only viewed.
 */
export function recommendedFaces(printSizeMm: number): number {
  const raw = 2 * (printSizeMm / 0.4) ** 2;
  const nice = [50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000];
  return nice.reduce((best, n) => (Math.abs(n - raw) < Math.abs(best - raw) ? n : best));
}

/** Binary STL is 50 bytes per triangle; GLB with colours averages about 30. */
export const estimatedStlBytes = (faces: number) => 84 + faces * 50;
export const estimatedGlbBytes = (faces: number) => faces * 30;

export interface Calibration {
  /** Per step: median of actual ÷ estimated seconds over recent runs on this machine. */
  factors: Partial<Record<StageName, number>>;
  /** The same, from runs at one quality preset only; preferred when present. */
  byQuality: Partial<Record<Quality, Partial<Record<StageName, number>>>>;
  /** Distinct runs the factors are based on. */
  runs: number;
}
