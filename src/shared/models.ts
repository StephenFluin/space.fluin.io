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
  latestJob: Job | null;
}

export interface Media {
  id: number;
  projectId: number;
  originalName: string;
  type: 'image' | 'video';
  size: number;
  createdAt: string;
}

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
