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
  createdAt: string;
}

/** Frames the pipeline will sample from `seconds` of video at `fps`. */
export const videoFrames = (seconds: number, fps: number) => Math.round(seconds * fps);

export interface JobSettings {
  quality: Quality;
  mesher: Mesher;
  /** Frames per second sampled from each video. */
  videoFps: number;
  /** Longest side of the printed model in millimetres. */
  printSizeMm: number;
  /** Target triangle count of the decimated mesh used for STL/GLB. */
  targetFaces: number;
}

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

/** Facts gathered while a run progresses; every field appears once its step has run. */
export interface JobStats {
  images?: number;
  photos?: number;
  videos?: number;
  videoFrames?: number;
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

export const DEFAULT_SETTINGS: Record<ProjectKind, JobSettings> = {
  exterior: {
    quality: 'medium',
    mesher: 'poisson',
    videoFps: 1,
    printSizeMm: 150,
    targetFaces: 500_000,
  },
  interior: {
    quality: 'medium',
    mesher: 'delaunay',
    videoFps: 2,
    printSizeMm: 200,
    targetFaces: 1_000_000,
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
    'Sparse reconstruction': 5 + 0.1 * n * Math.max(1, n / 150),
    'Aligning orientation': 4 + 0.02 * n,
    'Undistorting images': 2 + 0.02 * n * mp,
    // Two passes (photometric + geometric) over every view, each matched against `sources` views.
    // Measured runs grew far slower than pixel count between presets, so scale by image side.
    'Dense stereo': 0.6 * n * 2 * sources * side,
    'Fusing point cloud': 2 + 0.05 * n * mp,
    Meshing: 10 + 0.8 * n * mp,
    'Post-processing in Blender': 15 + (i.targetFaces / 1_000_000) * 70,
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
