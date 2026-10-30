import { HttpClient, HttpEventType, httpResource } from '@angular/common/http';
import { Service, inject } from '@angular/core';
import { Observable, filter, map } from 'rxjs';
import type { Job, JobSettings, Media, Project, ProjectKind, SystemStatus } from '../shared/models';

export type UploadEvent = { progress: number } | { done: Media[] };

/** Thin client for the REST API defined in src/server/api.ts. */
@Service()
export class Api {
  private readonly http = inject(HttpClient);

  system = () => httpResource<SystemStatus>(() => '/api/system');
  projects = () => httpResource<Project[]>(() => '/api/projects', { defaultValue: [] });
  project = (id: () => number) => httpResource<Project>(() => `/api/projects/${id()}`);
  media = (id: () => number) =>
    httpResource<Media[]>(() => `/api/projects/${id()}/media`, { defaultValue: [] });
  jobs = (id: () => number) =>
    httpResource<Job[]>(() => `/api/projects/${id()}/jobs`, { defaultValue: [] });
  job = (id: () => number) => httpResource<Job>(() => `/api/jobs/${id()}`);

  createProject(body: { name: string; kind: ProjectKind; notes: string }) {
    return this.http.post<Project>('/api/projects', body);
  }

  deleteProject(id: number) {
    return this.http.delete<void>(`/api/projects/${id}`);
  }

  upload(projectId: number, files: File[]): Observable<UploadEvent> {
    const body = new FormData();
    for (const f of files) body.append('files', f, f.name);
    return this.http
      .post<Media[]>(`/api/projects/${projectId}/media`, body, {
        reportProgress: true,
        observe: 'events',
      })
      .pipe(
        filter((e) => e.type === HttpEventType.UploadProgress || e.type === HttpEventType.Response),
        map((e): UploadEvent =>
          e.type === HttpEventType.Response
            ? { done: e.body ?? [] }
            : { progress: e.total ? e.loaded / e.total : 0 },
        ),
      );
  }

  deleteMedia(id: number) {
    return this.http.delete<void>(`/api/media/${id}`);
  }

  startJob(projectId: number, settings: JobSettings) {
    return this.http.post<Job>(`/api/projects/${projectId}/jobs`, settings);
  }

  cancelJob(id: number) {
    return this.http.post<{ cancelled: boolean }>(`/api/jobs/${id}/cancel`, {});
  }

  deleteJob(id: number) {
    return this.http.delete<void>(`/api/jobs/${id}`);
  }

  jobLog(id: number) {
    return this.http.get(`/api/jobs/${id}/log`, { responseType: 'text' });
  }
}

export const mediaUrl = (id: number) => `/api/media/${id}/file`;
export const outputUrl = (jobId: number, file: string, download = false) =>
  `/api/jobs/${jobId}/files/${file}${download ? '?download' : ''}`;

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
