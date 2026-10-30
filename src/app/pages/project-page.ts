import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  numberAttribute,
  signal,
} from '@angular/core';
import { NgOptimizedImage } from '@angular/common';
import { FormField, form, max, min, required, submit } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_SETTINGS, type JobSettings } from '../../shared/models';
import { Api, formatBytes, mediaUrl } from '../api';
import { JobCard } from '../components/job-card';
import { MediaUploader } from '../components/media-uploader';

const PREVIEW_LIMIT = 48;

@Component({
  selector: 'app-project-page',
  imports: [RouterLink, NgOptimizedImage, FormField, JobCard, MediaUploader],
  template: `
    <div class="page">
      <nav aria-label="Breadcrumb">
        <a routerLink="/">Projects</a> /
        <span aria-current="page">{{ project.value()?.name ?? '…' }}</span>
      </nav>

      @if (project.error()) {
        <p role="alert">Project not found. <a routerLink="/">Back to projects</a></p>
      } @else if (project.value(); as p) {
        <header class="head">
          <div>
            <h1>{{ p.name }}</h1>
            <span class="badge">{{ p.kind === 'exterior' ? 'Exterior' : 'Interior' }}</span>
            @if (p.notes) {
              <p class="muted">{{ p.notes }}</p>
            }
          </div>
          <button class="btn danger" type="button" (click)="deleteProject()">Delete project</button>
        </header>

        <div class="layout">
          <section class="card" aria-labelledby="media-heading">
            <h2 id="media-heading">
              Capture
              <span class="muted count"
                >{{ photoCount() }} photos · {{ videoCount() }} videos · {{ totalSize() }}</span
              >
            </h2>
            <details class="tips">
              <summary>
                Capture tips for {{ p.kind === 'exterior' ? 'drone exteriors' : 'interiors' }}
              </summary>
              @if (p.kind === 'exterior') {
                <ul>
                  <li>
                    Fly 2–3 orbits at different heights (e.g. 45° and 70° gimbal pitch), plus a
                    top-down grid for the roof.
                  </li>
                  <li>
                    Keep 70–80% overlap between photos. In video, fly slowly; 1 fps sampling is
                    usually plenty.
                  </li>
                  <li>
                    Shoot in overcast light to avoid hard shadows and blown highlights. Lock
                    exposure if you can.
                  </li>
                </ul>
              } @else {
                <ul>
                  <li>
                    Walk slowly along the walls, pointing the camera across the room; don't pivot on
                    the spot.
                  </li>
                  <li>
                    Turn on every light. Plain walls lack texture, so include furniture and trim in
                    each frame.
                  </li>
                  <li>
                    Film through doorways when moving between rooms so the rooms link up into one
                    model.
                  </li>
                  <li>
                    Avoid mirrors, windows straight into the sun, and people or pets moving through
                    the shot.
                  </li>
                </ul>
              }
            </details>
            <app-media-uploader [projectId]="id()" (uploaded)="refreshMedia()" />
            @if (media.value().length) {
              <ul class="media" aria-label="Uploaded files">
                @for (m of visibleMedia(); track m.id) {
                  <li>
                    <div class="thumb">
                      @if (m.type === 'image') {
                        <img [ngSrc]="mediaSrc(m.id)" fill sizes="120px" alt="" />
                      } @else {
                        <svg
                          aria-hidden="true"
                          width="36"
                          height="36"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                        >
                          <rect x="2" y="5" width="15" height="14" rx="2" />
                          <path d="m17 10 5-3v10l-5-3z" />
                        </svg>
                      }
                    </div>
                    <span class="name" [title]="m.originalName">{{ m.originalName }}</span>
                    <button
                      class="btn small danger remove"
                      type="button"
                      (click)="deleteMedia(m.id)"
                      [attr.aria-label]="'Remove ' + m.originalName"
                    >
                      ✕
                    </button>
                  </li>
                }
              </ul>
              @if (media.value().length > previewLimit && !showAll()) {
                <button class="btn small" type="button" (click)="showAll.set(true)">
                  Show all {{ media.value().length }} files
                </button>
              }
            }
          </section>

          <section class="card" aria-labelledby="run-heading">
            <h2 id="run-heading">Reconstruct</h2>
            <form (submit)="start($event)" novalidate class="settings">
              <div class="field">
                <label for="quality">Quality</label>
                <select
                  id="quality"
                  [formField]="settingsForm.quality"
                  aria-describedby="quality-hint"
                >
                  <option value="preview">Preview (fast, ~1000 px)</option>
                  <option value="medium">Medium (~2000 px)</option>
                  <option value="high">High (full resolution, slow)</option>
                </select>
                <span id="quality-hint" class="hint">Image size used for dense stereo.</span>
              </div>
              <div class="field">
                <label for="mesher">Surface method</label>
                <select
                  id="mesher"
                  [formField]="settingsForm.mesher"
                  aria-describedby="mesher-hint"
                >
                  <option value="poisson">Poisson (smooth, closed)</option>
                  <option value="delaunay">Delaunay (sharp walls, interiors)</option>
                </select>
                <span id="mesher-hint" class="hint"
                  >Poisson suits exteriors; Delaunay keeps thin walls.</span
                >
              </div>
              <div class="field">
                <label for="fps">Video frames per second</label>
                <input id="fps" type="number" step="0.5" [formField]="settingsForm.videoFps" />
              </div>
              <div class="field">
                <label for="print">Print size, longest side (mm)</label>
                <input id="print" type="number" step="10" [formField]="settingsForm.printSizeMm" />
              </div>
              <div class="field">
                <label for="faces">Target triangles</label>
                <input
                  id="faces"
                  type="number"
                  step="50000"
                  [formField]="settingsForm.targetFaces"
                />
              </div>
              @if (settingsForm().invalid()) {
                <p class="error" role="alert">Check the settings: values are out of range.</p>
              }
              <button
                class="btn primary"
                type="submit"
                [disabled]="!media.value().length || settingsForm().submitting()"
              >
                Start reconstruction
              </button>
              @if (!media.value().length) {
                <p class="hint muted">Upload photos or a video first.</p>
              }
            </form>
          </section>
        </div>

        <section aria-labelledby="runs-heading" class="runs">
          <h2 id="runs-heading">Runs</h2>
          @for (j of jobs.value(); track j.id) {
            <app-job-card [job]="j" (changed)="jobs.reload()" />
          } @empty {
            <p class="muted">No runs yet.</p>
          }
        </section>
      } @else {
        <p class="muted">Loading…</p>
      }
    </div>
  `,
  styles: `
    nav {
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .head {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
      align-items: flex-start;
      margin-bottom: 1.5rem;
    }
    .head h1 {
      display: inline;
      margin-right: 0.6rem;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 1.5rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .count {
      font-size: 0.9rem;
      font-weight: 400;
    }
    .tips {
      margin-bottom: 1rem;
    }
    .tips summary {
      cursor: pointer;
      font-weight: 600;
    }
    .media {
      list-style: none;
      padding: 0;
      margin: 1rem 0;
      display: grid;
      gap: 0.6rem;
      grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    }
    .media li {
      position: relative;
      display: grid;
      gap: 0.25rem;
    }
    .thumb {
      position: relative;
      aspect-ratio: 4 / 3;
      border-radius: 6px;
      overflow: hidden;
      background: var(--surface-2);
      display: grid;
      place-items: center;
      color: var(--muted);
    }
    .thumb img {
      object-fit: cover;
    }
    .name {
      font-size: 0.75rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .remove {
      position: absolute;
      top: 0.25rem;
      right: 0.25rem;
      min-height: 1.75rem;
      padding: 0 0.45rem;
      background: var(--surface);
    }
    .settings {
      display: grid;
      gap: 0.9rem;
    }
    .error {
      color: var(--danger);
    }
    .runs {
      margin-top: 2rem;
      display: grid;
      gap: 1rem;
    }
  `,
})
export class ProjectPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  readonly id = input.required({ transform: numberAttribute });

  protected readonly project = this.api.project(this.id);
  protected readonly media = this.api.media(this.id);
  protected readonly jobs = this.api.jobs(this.id);
  protected readonly previewLimit = PREVIEW_LIMIT;
  protected readonly showAll = signal(false);

  protected readonly photoCount = computed(
    () => this.media.value().filter((m) => m.type === 'image').length,
  );
  protected readonly videoCount = computed(
    () => this.media.value().filter((m) => m.type === 'video').length,
  );
  protected readonly totalSize = computed(() =>
    formatBytes(this.media.value().reduce((n, m) => n + m.size, 0)),
  );
  protected readonly visibleMedia = computed(() =>
    this.showAll() ? this.media.value() : this.media.value().slice(0, PREVIEW_LIMIT),
  );
  private readonly hasActiveJob = computed(() =>
    this.jobs.value().some((j) => j.status === 'queued' || j.status === 'running'),
  );

  /** Settings start from the defaults for the project kind and reset when the kind is known. */
  private readonly settings = linkedSignal<JobSettings>(() =>
    structuredClone(DEFAULT_SETTINGS[this.project.value()?.kind ?? 'exterior']),
  );
  protected readonly settingsForm = form(this.settings, (s) => {
    required(s.videoFps);
    min(s.videoFps, 0.1);
    max(s.videoFps, 10);
    min(s.printSizeMm, 10);
    max(s.printSizeMm, 1000);
    min(s.targetFaces, 10_000);
    max(s.targetFaces, 5_000_000);
  });

  constructor() {
    // Poll while a run is in progress.
    effect((onCleanup) => {
      if (!this.hasActiveJob()) return;
      const timer = setInterval(() => this.jobs.reload(), 2000);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected mediaSrc(id: number) {
    return mediaUrl(id);
  }

  protected refreshMedia() {
    this.media.reload();
  }

  protected deleteMedia(id: number) {
    this.api.deleteMedia(id).subscribe(() => this.media.reload());
  }

  protected async start(event: Event) {
    event.preventDefault();
    await submit(this.settingsForm, async () => {
      await firstValueFrom(this.api.startJob(this.id(), this.settings()));
      this.jobs.reload();
      return undefined;
    });
  }

  protected async deleteProject() {
    const p = this.project.value();
    if (
      !p ||
      !confirm(`Delete "${p.name}" with all uploads and reconstructions? This cannot be undone.`)
    )
      return;
    await firstValueFrom(this.api.deleteProject(p.id));
    await this.router.navigate(['/']);
  }
}
