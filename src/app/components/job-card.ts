import {
  Component,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { DatePipe, DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  KEEP_ALL_FACES,
  PANO_VIEWS,
  formatCount,
  stlFaces,
  STAGES,
  calibratedStageSeconds,
  type Calibration,
  type Job,
  type OutputKind,
} from '../../shared/models';
import { runAdvice } from '../../shared/advice';
import { Api, formatBytes, formatDuration, outputUrl, parseTime } from '../api';

const OUTPUT_LABELS: Record<OutputKind, string> = {
  stl: 'STL',
  blend: 'Blender',
  glb: 'glTF',
  ply: 'Raw PLY',
  obj: 'OBJ',
};

const OUTPUT_HINTS: Record<OutputKind, string> = {
  stl: 'watertight solid for slicers',
  blend: 'coloured scan + printable mesh',
  glb: 'coloured mesh for viewers',
  ply: 'unprocessed COLMAP mesh',
  obj: 'mesh',
};

const STATUS_LABELS: Record<Job['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

type StepState = 'done' | 'current' | 'failed' | 'pending' | 'skipped';

/** One reconstruction run: step-by-step progress with ETA, run facts, downloads and the log. */
@Component({
  selector: 'app-job-card',
  imports: [DatePipe, DecimalPipe, PercentPipe, RouterLink],
  template: `
    @let j = job();
    <article class="card" [class.highlight]="highlight()" [attr.aria-labelledby]="'job-' + j.id">
      <header class="top">
        <div class="title">
          <h3 [id]="'job-' + j.id" tabindex="-1">Run #{{ j.id }}</h3>
          <span class="badge" [class]="j.status">{{ statusLabel() }}</span>
        </div>
        <p class="when muted">
          @if (j.startedAt) {
            Started {{ parse(j.startedAt) | date: 'MMM d, h:mm a' }}
          } @else {
            Queued {{ parse(j.createdAt) | date: 'MMM d, h:mm a' }}
          }
          @if (elapsed(); as e) {
            · {{ active() ? 'running for' : 'took' }} {{ e }}
          }
        </p>
      </header>
      <p class="settings muted">
        {{ qualityLabel() }} quality ·
        {{ j.settings.mesher === 'poisson' ? 'Poisson' : 'Delaunay' }} mesh ·
        {{ j.settings.videoFps }} fps video · {{ j.settings.printSizeMm }} mm print ·
        {{ j.settings.targetFaces === keepAll ? 'all' : short(j.settings.targetFaces) }}
        triangles in 3D · {{ short(stlFaces(j.settings)) }} in STL{{
          j.settings.flatten ? ' · flat walls' : ''
        }}
      </p>

      @if (active()) {
        <div class="progress" aria-live="polite">
          <div class="progress-text">
            <span>
              <strong>Step {{ currentStep() }} of {{ steps.length }}</strong> · {{ j.stage }}
            </span>
            <span>{{ j.progress * 100 | number: '1.0-0' }}%</span>
          </div>
          <progress
            [value]="j.progress"
            max="1"
            [attr.aria-label]="'Run ' + j.id + ' progress'"
          ></progress>
          <p class="eta muted">
            @if (j.status === 'queued') {
              Waiting for the run ahead of it to finish.
            } @else if (eta(); as e) {
              About {{ e.remaining }} left · done around {{ e.at | date: 'h:mm a' }}
            } @else {
              Estimating time remaining…
            }
          </p>
        </div>
      }

      @if (j.attempts > 1) {
        <p class="muted resumed">
          Resumed after
          {{ j.attempts - 1 === 1 ? 'a server restart' : j.attempts - 1 + ' server restarts' }};
          finished steps were kept.
        </p>
      }

      @if (j.status === 'failed' && j.error) {
        <p class="error" role="alert">
          <strong>Failed during {{ j.stage }}:</strong> {{ j.error }}
        </p>
      }

      @if (j.outputs.length) {
        <div class="outputs">
          @if (hasGlb()) {
            <a
              class="btn primary"
              [routerLink]="['/projects', j.projectId, 'jobs', j.id, 'explore']"
            >
              Explore in 3D
            </a>
          }
          @for (o of j.outputs; track o.file) {
            <a class="btn download" [href]="url(o.file)" download [title]="hints[o.kind]">
              <span>{{ labels[o.kind] }}</span>
              <span class="muted">{{ size(o.size) }}</span>
            </a>
          }
        </div>
      }

      @if (advice().length) {
        <details class="report" [open]="initiallyExpanded()">
          <summary>
            Run report
            <span class="muted">
              · {{ tips() }} {{ tips() === 1 ? 'suggestion' : 'suggestions' }} for next time
            </span>
          </summary>
          <ul>
            @for (a of advice(); track a.title) {
              <li [class]="a.tone">
                <span class="icon" aria-hidden="true">{{ adviceIcons[a.tone] }}</span>
                <span class="visually-hidden">{{ toneLabels[a.tone] }}:</span>
                <span>
                  <strong>{{ a.title }}.</strong>
                  {{ a.detail }}
                </span>
              </li>
            }
          </ul>
        </details>
      }

      @if (expanded()) {
        <div class="body">
          <div>
            <h4 [id]="'steps-' + j.id">
              Steps <span class="muted">{{ doneCount() }} of {{ steps.length }} complete</span>
            </h4>
            <ol class="steps">
              @for (s of stepRows(); track s.name) {
                <li [class]="s.state" [attr.aria-current]="s.state === 'current' ? 'step' : null">
                  <span class="icon" aria-hidden="true">{{ icons[s.state] }}</span>
                  <span class="step-name">
                    {{ s.name }}<span class="visually-hidden">, {{ s.state }}</span>
                  </span>
                  <span class="step-time muted">{{ s.time }}</span>
                </li>
              }
            </ol>
          </div>

          <div>
            <h4 [id]="'facts-' + j.id">Details</h4>
            <dl class="facts">
              @if (j.stats.images !== undefined) {
                <dt>Input</dt>
                <dd>
                  {{ j.stats.images | number }} images
                  @if (j.stats.videos) {
                    <span class="muted">
                      ({{ j.stats.photos }} photos + {{ j.stats.videoFrames | number }} frames from
                      {{ j.stats.videos }} {{ j.stats.videos === 1 ? 'video' : 'videos'
                      }}{{
                        j.stats.extraFrames
                          ? ', + ' +
                            j.stats.extraFrames +
                            ' extra frames where the camera moved fast'
                          : ''
                      }})
                    </span>
                  }
                  @if (j.stats.spherical) {
                    <span class="muted"> · each 360° frame split into {{ panoViews }} views </span>
                  }
                </dd>
              } @else {
                <dt>Input</dt>
                <dd class="muted">Recorded once the run starts.</dd>
              }
              @if (j.stats.registeredImages !== undefined) {
                <dt>Cameras placed</dt>
                <dd>
                  {{ j.stats.registeredImages | number }} of {{ j.stats.images | number }}
                  <span class="muted">({{ registeredPct() | number: '1.0-0' }}%)</span>
                  @if (j.stats.extraFrames && j.stats.placedOriginal !== undefined) {
                    <span class="muted">
                      · {{ j.stats.placedOriginal | number }} of
                      {{ (j.stats.images ?? 0) - j.stats.extraFrames | number }} original frames
                    </span>
                  }
                </dd>
              }
              @if (j.stats.sparsePoints !== undefined) {
                <dt>Sparse points</dt>
                <dd>
                  {{ j.stats.sparsePoints | number }}
                  @if (j.stats.reprojectionError !== undefined) {
                    <span class="muted"
                      >· {{ j.stats.reprojectionError | number: '1.2-2' }} px error</span
                    >
                  }
                </dd>
              }
              @if (j.stats.densePoints !== undefined) {
                <dt>Dense points</dt>
                <dd>{{ j.stats.densePoints | number }}</dd>
              }
              @if (j.stats.meshFaces !== undefined) {
                <dt>Mesh</dt>
                <dd>
                  {{ j.stats.meshFaces | number }} triangles
                  <span class="muted">· printable {{ j.stats.printableFaces | number }}</span>
                </dd>
              }
              @if (j.stats.flatPlanes !== undefined) {
                <dt>Flattened</dt>
                <dd>
                  {{ j.stats.flatPlanes }} flat surfaces
                  <span class="muted">· {{ j.stats.flatShare ?? 0 | percent }} of the mesh</span>
                </dd>
              }
              @if (j.stats.dimensionsMm; as d) {
                <dt>Print size</dt>
                <dd>
                  {{ d[0] | number: '1.0-0' }} × {{ d[1] | number: '1.0-0' }} ×
                  {{ d[2] | number: '1.0-0' }} mm
                </dd>
              }
              @if (j.stats.gpu !== undefined) {
                <dt>Hardware</dt>
                <dd>{{ j.stats.gpu ? 'CUDA GPU' : 'CPU only' }}</dd>
              }
            </dl>
          </div>
        </div>
      }

      <div class="actions">
        <button
          class="btn small"
          type="button"
          (click)="expanded.set(!expanded())"
          [attr.aria-expanded]="expanded()"
        >
          {{ expanded() ? 'Hide details' : 'Show details' }}
        </button>
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
          <button class="btn small danger" type="button" (click)="cancel()">Cancel run</button>
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
    .card {
      display: grid;
      gap: 0.75rem;
    }
    .card.highlight {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent);
      animation: arrive 1.6s ease-out;
    }
    @keyframes arrive {
      from {
        box-shadow: 0 0 0 6px var(--accent);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .card.highlight {
        animation: none;
      }
    }
    h3:focus {
      outline: none;
    }
    h3:focus-visible {
      outline: 2px solid var(--focus);
      outline-offset: 2px;
    }
    .top {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem 1rem;
      flex-wrap: wrap;
      align-items: baseline;
    }
    .title {
      display: flex;
      gap: 0.6rem;
      align-items: center;
    }
    h3 {
      margin: 0;
      font-size: 1.1rem;
    }
    h4 {
      margin: 0 0 0.5rem;
      font-size: 0.95rem;
    }
    h4 .muted {
      font-weight: 400;
      font-size: 0.85rem;
      margin-left: 0.3rem;
    }
    p {
      margin: 0;
    }
    .when,
    .resumed,
    .settings,
    .eta {
      font-size: 0.85rem;
    }
    .progress {
      display: grid;
      gap: 0.3rem;
    }
    .progress-text {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
    }
    progress {
      height: 0.75rem;
    }
    .error {
      color: var(--danger);
    }
    .outputs {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .report {
      margin-top: 0.75rem;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 0.5rem 0.75rem;
    }
    .report summary {
      cursor: pointer;
      font-weight: 600;
    }
    .report summary .muted {
      font-weight: 400;
    }
    .report ul {
      list-style: none;
      padding: 0;
      margin: 0.5rem 0 0.25rem;
      display: grid;
      gap: 0.5rem;
    }
    .report li {
      display: grid;
      grid-template-columns: 1.25rem 1fr;
      gap: 0.4rem;
      line-height: 1.45;
    }
    .report .icon {
      font-weight: 700;
      text-align: center;
    }
    .report .good .icon {
      color: var(--ok);
    }
    .report .warn .icon {
      color: var(--warn);
    }
    .report .tip .icon {
      color: var(--accent);
    }
    .download .muted {
      font-weight: 400;
      font-size: 0.8rem;
    }
    .body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 1.5rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--border);
    }
    @media (max-width: 700px) {
      .body {
        grid-template-columns: 1fr;
      }
    }
    .steps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.15rem;
      font-size: 0.9rem;
    }
    .steps li {
      display: grid;
      grid-template-columns: 1.3rem 1fr auto;
      align-items: baseline;
      padding: 0.15rem 0.4rem;
      border-radius: 6px;
    }
    .steps li.done .icon {
      color: var(--ok);
    }
    .steps li.failed {
      color: var(--danger);
    }
    .steps li.current {
      background: var(--surface-2);
      font-weight: 600;
    }
    .steps li.current .icon {
      color: var(--accent);
    }
    .steps li.pending,
    .steps li.skipped {
      color: var(--muted);
    }
    .step-time {
      font-size: 0.8rem;
      font-variant-numeric: tabular-nums;
    }
    .facts {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.3rem 1rem;
      margin: 0;
      font-size: 0.9rem;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
    }
    .actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .log {
      margin: 0;
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
  protected readonly panoViews = PANO_VIEWS;
  private readonly api = inject(Api);
  readonly job = input.required<Job>();
  /** The newest run starts expanded; older runs collapse to a summary. */
  readonly initiallyExpanded = input(false);
  /** Marks the run the user just started, so it stands out after the page scrolls to it. */
  readonly highlight = input(false);
  /** Per-step timing corrections for this machine, for the ETA. */
  readonly calibration = input<Calibration | undefined>(undefined);
  readonly changed = output<void>();

  protected readonly labels = OUTPUT_LABELS;
  protected readonly hints = OUTPUT_HINTS;
  protected readonly icons: Record<StepState, string> = {
    done: '✓',
    failed: '✕',
    current: '●',
    skipped: '–',
    pending: '○',
  };
  protected readonly steps = STAGES;
  protected readonly parse = parseTime;
  protected readonly expanded = linkedSignal(() => this.initiallyExpanded());
  protected readonly showLog = signal(false);
  protected readonly log = signal('');
  /** Ticks every second while the run is active so durations and the ETA stay live. */
  private readonly now = signal(Date.now());

  protected readonly active = computed(() => ['queued', 'running'].includes(this.job().status));
  /** Post-run advice; only for runs that got far enough to measure something. */
  protected readonly advice = computed(() =>
    this.job().status === 'done' || this.job().status === 'failed' ? runAdvice(this.job()) : [],
  );
  protected readonly tips = computed(() => this.advice().filter((a) => a.tone !== 'good').length);
  protected readonly keepAll = KEEP_ALL_FACES;
  protected readonly short = formatCount;
  protected readonly stlFaces = stlFaces;
  protected readonly adviceIcons = { good: '✓', warn: '!', tip: '→' } as const;
  protected readonly toneLabels = { good: 'Good', warn: 'Problem', tip: 'Suggestion' } as const;
  protected readonly hasGlb = computed(() => this.job().outputs.some((o) => o.kind === 'glb'));
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.job().status]);
  protected readonly qualityLabel = computed(() => {
    const q = this.job().settings.quality;
    return q[0].toUpperCase() + q.slice(1);
  });
  protected readonly registeredPct = computed(() => {
    const { registeredImages = 0, images = 0 } = this.job().stats;
    return images ? (registeredImages / images) * 100 : 0;
  });

  protected readonly elapsed = computed(() => {
    const { startedAt, finishedAt } = this.job();
    if (!startedAt) return '';
    const end = finishedAt ? parseTime(finishedAt).getTime() : this.now();
    return formatDuration(end - parseTime(startedAt).getTime());
  });

  private readonly stageIndex = computed(() =>
    STAGES.findIndex((s) => s.name === this.job().stage),
  );
  protected readonly currentStep = computed(() => Math.max(this.stageIndex(), 0) + 1);

  /** Calibrated expected seconds per step, once the run knows how many images it has. */
  private readonly expected = computed(() => {
    const { stats, settings } = this.job();
    if (!stats.images) return null;
    return calibratedStageSeconds(
      {
        images: stats.images,
        photos: stats.photos ?? 0,
        videos: stats.videos ?? 0,
        quality: settings.quality,
        targetFaces: settings.targetFaces,
        denseSources: stats.denseSources,
      },
      this.calibration(),
    );
  });

  protected readonly stepRows = computed(() => {
    const j = this.job();
    const now = this.now();
    const idx = this.stageIndex();
    const expected = this.expected();
    return STAGES.map((s, i) => {
      // A step interrupted by a restart has several attempts; show their total.
      const attempts = j.stages.filter((t) => t.name === s.name);
      let state: StepState = 'pending';
      if (j.status === 'done') state = attempts.length || !j.stages.length ? 'done' : 'skipped';
      else if (i < idx) state = 'done';
      else if (i === idx && j.status === 'running') state = 'current';
      else if (i === idx && j.status === 'failed') state = 'failed';
      let ms = 0;
      for (const t of attempts) {
        const end = t.finishedAt
          ? parseTime(t.finishedAt).getTime()
          : state === 'current'
            ? now
            : null;
        if (end !== null) ms += end - parseTime(t.startedAt).getTime();
      }
      let time = attempts.length ? formatDuration(ms) : '';
      if (state === 'pending' && expected && this.active()) {
        time = `~${formatDuration(expected[s.name] * 1000)}`;
      }
      return { name: s.name, state, time };
    });
  });

  protected readonly doneCount = computed(
    () => this.stepRows().filter((s) => s.state === 'done').length,
  );

  /**
   * Remaining time: the current step from its observed pace once it has made some progress
   * (else its calibrated estimate), plus calibrated estimates for the steps after it.
   */
  protected readonly eta = computed(() => {
    const j = this.job();
    if (j.status !== 'running' || !j.startedAt) return null;
    const now = this.now();
    const idx = this.stageIndex();
    const expected = this.expected();
    if (idx < 0 || !expected) return null;
    const before = STAGES.slice(0, idx).reduce((n, s) => n + s.weight, 0);
    const fraction = Math.min(Math.max((j.progress - before) / STAGES[idx].weight, 0), 1);
    const timing = j.stages.filter((t) => t.name === j.stage).at(-1);
    const stageMs = timing ? now - parseTime(timing.startedAt).getTime() : 0;

    const currentMs =
      fraction > 0.05 && stageMs > 10_000
        ? (stageMs * (1 - fraction)) / fraction
        : Math.max(expected[STAGES[idx].name] * 1000 - stageMs, 0);
    const laterMs = STAGES.slice(idx + 1).reduce((n, s) => n + expected[s.name] * 1000, 0);
    const remainingMs = currentMs + laterMs;
    return { remaining: formatDuration(remainingMs), at: new Date(now + remainingMs) };
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.active()) return;
      const timer = setInterval(() => this.now.set(Date.now()), 1000);
      onCleanup(() => clearInterval(timer));
    });

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
    if (!confirm(`Cancel run #${this.job().id}?`)) return;
    this.api.cancelJob(this.job().id).subscribe(() => this.changed.emit());
  }

  protected remove() {
    if (!confirm(`Delete run #${this.job().id} and its files?`)) return;
    this.api.deleteJob(this.job().id).subscribe(() => this.changed.emit());
  }
}
