import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { Job, OutputKind } from '../../shared/models';
import { Api, formatBytes, outputUrl } from '../api';

const OUTPUT_LABELS: Record<OutputKind, string> = {
  stl: 'STL for 3D printing',
  blend: 'Blender file',
  glb: 'glTF (GLB) model',
  ply: 'Raw mesh (PLY)',
  obj: 'OBJ model',
};

/** One reconstruction run: progress, log, downloads and a link into the explorer. */
@Component({
  selector: 'app-job-card',
  imports: [DatePipe, DecimalPipe, RouterLink],
  template: `
    @let j = job();
    <article class="card" [attr.aria-labelledby]="'job-' + j.id">
      <header>
        <h3 [id]="'job-' + j.id">Run #{{ j.id }}</h3>
        <span class="badge" [class]="j.status">{{ j.status }}</span>
        <span class="muted settings">
          {{ j.settings.quality }} quality · {{ j.settings.mesher }} mesh ·
          {{ j.settings.printSizeMm }} mm print
        </span>
      </header>

      @if (active()) {
        <p class="stage" aria-live="polite">
          {{ j.stage }} — {{ j.progress * 100 | number: '1.0-0' }}%
        </p>
        <progress
          [value]="j.progress"
          max="1"
          [attr.aria-label]="'Run ' + j.id + ' progress'"
        ></progress>
      }
      @if (j.status === 'failed' && j.error) {
        <p class="error" role="alert">{{ j.error }}</p>
      }

      <p class="muted times">
        Queued {{ j.createdAt + 'Z' | date: 'short' }}
        @if (duration(); as d) {
          · ran for {{ d }}
        }
      </p>

      @if (j.outputs.length) {
        <div class="outputs">
          @if (hasGlb()) {
            <a
              class="btn primary"
              [routerLink]="['/projects', j.projectId, 'jobs', j.id, 'explore']"
              >Explore in 3D</a
            >
          }
          <ul>
            @for (o of j.outputs; track o.file) {
              <li>
                <a [href]="url(o.file)" download>{{ labels[o.kind] }}</a>
                <span class="muted">{{ size(o.size) }}</span>
              </li>
            }
          </ul>
        </div>
      }

      <div class="actions">
        <button
          class="btn small"
          type="button"
          (click)="showLog.set(!showLog())"
          [attr.aria-expanded]="showLog()"
          [attr.aria-controls]="'log-' + j.id"
        >
          {{ showLog() ? 'Hide log' : 'Show log' }}
        </button>
        @if (active()) {
          <button class="btn small danger" type="button" (click)="cancel()">Cancel</button>
        } @else {
          <button class="btn small danger" type="button" (click)="remove()">Delete run</button>
        }
      </div>
      @if (showLog()) {
        <pre [id]="'log-' + j.id" class="log" tabindex="0" aria-label="Job log">{{
          log() || 'No output yet.'
        }}</pre>
      }
    </article>
  `,
  styles: `
    header {
      display: flex;
      gap: 0.6rem;
      align-items: center;
      flex-wrap: wrap;
    }
    h3 {
      margin: 0;
      font-size: 1.05rem;
    }
    .settings {
      font-size: 0.85rem;
    }
    .stage {
      margin: 0.75rem 0 0.25rem;
    }
    .times {
      font-size: 0.85rem;
      margin: 0.5rem 0;
    }
    .error {
      color: var(--danger);
    }
    .outputs {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      align-items: flex-start;
      margin: 0.75rem 0;
    }
    ul {
      margin: 0;
      padding-left: 1.1rem;
    }
    li span {
      margin-left: 0.4rem;
      font-size: 0.85rem;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
    }
    .log {
      margin: 0.75rem 0 0;
      max-height: 320px;
      overflow: auto;
      padding: 0.75rem;
      background: var(--surface-2);
      border-radius: 8px;
      font-size: 0.78rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
  `,
})
export class JobCard {
  private readonly api = inject(Api);
  readonly job = input.required<Job>();
  readonly changed = output<void>();

  protected readonly labels = OUTPUT_LABELS;
  protected readonly showLog = signal(false);
  protected readonly log = signal('');
  protected readonly active = computed(() => ['queued', 'running'].includes(this.job().status));
  protected readonly hasGlb = computed(() => this.job().outputs.some((o) => o.kind === 'glb'));
  protected readonly duration = computed(() => {
    const { startedAt, finishedAt } = this.job();
    if (!startedAt || !finishedAt) return '';
    const secs = (Date.parse(finishedAt + 'Z') - Date.parse(startedAt + 'Z')) / 1000;
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h ? `${h}h ${m}m` : m ? `${m}m` : `${Math.round(secs)}s`;
  });

  constructor() {
    // Refresh the log whenever it is open and the job has moved on (the parent polls the job).
    effect(() => {
      this.job().progress;
      this.job().status;
      if (this.showLog()) this.api.jobLog(this.job().id).subscribe((t) => this.log.set(t));
    });
  }

  protected url(file: string) {
    return outputUrl(this.job().id, file, true);
  }

  protected size(n: number) {
    return formatBytes(n);
  }

  protected cancel() {
    this.api.cancelJob(this.job().id).subscribe(() => this.changed.emit());
  }

  protected remove() {
    if (!confirm(`Delete run #${this.job().id} and its files?`)) return;
    this.api.deleteJob(this.job().id).subscribe(() => this.changed.emit());
  }
}
