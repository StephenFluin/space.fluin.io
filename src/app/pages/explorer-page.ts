import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  numberAttribute,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { Api, outputUrl } from '../api';
import type { ModelViewer, ViewerMode } from './model-viewer';

/** Full-screen 3D explorer for a finished reconstruction. */
@Component({
  selector: 'app-explorer-page',
  imports: [RouterLink, DecimalPipe],
  host: {
    '(document:keydown)': 'viewer?.key($event, true)',
    '(document:keyup)': 'viewer?.key($event, false)',
  },
  template: `
    <div class="explorer">
      <div class="stage">
        <canvas
          #canvas
          role="img"
          [attr.aria-label]="'3D model of ' + (project.value()?.name ?? 'the scan')"
        ></canvas>
        @if (loading()) {
          <div class="overlay" role="status">
            Loading model… {{ loadProgress() * 100 | number: '1.0-0' }}%
          </div>
        }
        @if (error()) {
          <div class="overlay error" role="alert">{{ error() }}</div>
        }
        @if (mode() === 'walk' && !locked()) {
          <div class="overlay hint">Click the model to look around. Esc releases the mouse.</div>
        }
      </div>

      <aside class="panel" aria-label="Explorer controls">
        <nav aria-label="Breadcrumb">
          <a routerLink="/">Projects</a> /
          <a [routerLink]="['/projects', id()]">{{ project.value()?.name ?? 'Project' }}</a>
        </nav>
        <h1>Explore run #{{ jobId() }}</h1>

        <fieldset>
          <legend>Navigation</legend>
          <div class="seg">
            <button
              type="button"
              class="btn small"
              [attr.aria-pressed]="mode() === 'orbit'"
              (click)="setMode('orbit')"
            >
              Orbit
            </button>
            <button
              type="button"
              class="btn small"
              [attr.aria-pressed]="mode() === 'walk'"
              (click)="setMode('walk')"
            >
              Walk
            </button>
          </div>
          <p class="muted help">
            @if (mode() === 'orbit') {
              Drag to rotate, right-drag to pan, scroll to zoom. Arrow keys orbit too.
            } @else {
              W A S D or arrow keys to move, Q / E down / up, Shift to go faster.
            }
          </p>
          <button type="button" class="btn small" (click)="viewer?.resetCamera()">
            Reset view
          </button>
        </fieldset>

        <fieldset>
          <legend>Display</legend>
          <label class="check"
            ><input type="checkbox" [checked]="colours()" (change)="colours.set(!colours())" />
            Captured colours</label
          >
          <label class="check"
            ><input
              type="checkbox"
              [checked]="wireframe()"
              (change)="wireframe.set(!wireframe())"
            />
            Wireframe</label
          >
          <label class="check"
            ><input type="checkbox" [checked]="grid()" (change)="grid.set(!grid())" /> Ground
            grid</label
          >
          <div class="field">
            <label for="cut">Cut-away height</label>
            <input
              id="cut"
              type="range"
              min="0"
              max="1"
              step="0.01"
              [value]="cut()"
              (input)="cut.set(+$any($event.target).value)"
              [attr.aria-valuetext]="(cut() * 100 | number: '1.0-0') + '% of height'"
            />
            <span class="hint">Slide down to remove the roof or ceiling and look inside.</span>
          </div>
        </fieldset>

        <fieldset>
          <legend>Orientation</legend>
          <p class="muted help">If the model came out tilted, rotate it here (view only).</p>
          <div class="seg">
            <button type="button" class="btn small" (click)="viewer?.rotate('x')">
              Rotate X 90°
            </button>
            <button type="button" class="btn small" (click)="viewer?.rotate('z')">
              Rotate Z 90°
            </button>
          </div>
        </fieldset>

        @if (stats(); as s) {
          <dl class="stats">
            <dt>Triangles</dt>
            <dd>{{ s.triangles | number }}</dd>
            <dt>Size (print mm)</dt>
            <dd>
              {{ s.x | number: '1.0-0' }} × {{ s.y | number: '1.0-0' }} ×
              {{ s.z | number: '1.0-0' }}
            </dd>
          </dl>
        }

        @if (job.value(); as j) {
          <div class="downloads">
            @for (o of j.outputs; track o.file) {
              <a class="btn small" [href]="download(o.file)" download>{{ o.kind.toUpperCase() }}</a>
            }
          </div>
        }
      </aside>
    </div>
  `,
  styles: `
    .explorer {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      height: calc(100vh - 53px);
    }
    @media (max-width: 800px) {
      .explorer {
        grid-template-columns: 1fr;
        grid-template-rows: 60vh auto;
        height: auto;
      }
    }
    .stage {
      position: relative;
      background: #1b1f26;
      min-height: 300px;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      touch-action: none;
    }
    .overlay {
      position: absolute;
      inset: auto 1rem 1rem 1rem;
      padding: 0.6rem 0.9rem;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.75);
      color: #fff;
      width: fit-content;
    }
    .overlay.error {
      color: #ffb4ab;
    }
    .panel {
      overflow-y: auto;
      padding: 1rem 1.25rem;
      border-left: 1px solid var(--border);
      background: var(--surface);
      display: grid;
      gap: 1rem;
      align-content: start;
    }
    h1 {
      font-size: 1.2rem;
      margin: 0;
    }
    nav {
      font-size: 0.85rem;
    }
    fieldset {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem;
      margin: 0;
      display: grid;
      gap: 0.6rem;
    }
    legend {
      font-weight: 600;
      padding: 0 0.3rem;
    }
    .seg {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
    .seg [aria-pressed='true'] {
      background: var(--accent);
      color: var(--accent-text);
      border-color: var(--accent);
    }
    .help {
      margin: 0;
      font-size: 0.85rem;
    }
    .check {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    .stats {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.25rem 0.75rem;
      margin: 0;
      font-size: 0.9rem;
    }
    dt {
      color: var(--muted);
    }
    dd {
      margin: 0;
    }
    .downloads {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
    }
  `,
})
export class ExplorerPage {
  private readonly api = inject(Api);
  readonly id = input.required({ transform: numberAttribute });
  readonly jobId = input.required({ transform: numberAttribute });

  protected readonly project = this.api.project(this.id);
  protected readonly job = this.api.job(this.jobId);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  protected viewer?: ModelViewer;

  protected readonly mode = signal<ViewerMode>('orbit');
  protected readonly locked = signal(false);
  protected readonly loading = signal(true);
  protected readonly loadProgress = signal(0);
  protected readonly error = signal('');
  protected readonly colours = signal(true);
  protected readonly wireframe = signal(false);
  protected readonly grid = signal(true);
  protected readonly cut = signal(1);
  protected readonly stats = signal<{ triangles: number; x: number; y: number; z: number } | null>(
    null,
  );

  private readonly modelUrl = computed(() => {
    const j = this.job.value();
    return j?.outputs.some((o) => o.file === 'model.glb') ? outputUrl(j.id, 'model.glb') : null;
  });

  constructor() {
    const ready = signal(false);
    const destroyRef = inject(DestroyRef);

    afterNextRender(async () => {
      // three.js only loads in the browser, in this lazy chunk.
      const viewer = await import('./model-viewer');
      this.viewer = new viewer.ModelViewer(this.canvas().nativeElement, {
        onLock: (l) => this.locked.set(l),
      });
      destroyRef.onDestroy(() => this.viewer?.dispose());
      ready.set(true);
    });

    effect(() => {
      const url = this.modelUrl();
      if (!ready() || !this.viewer) return;
      if (!url) {
        if (this.job.value()) {
          this.loading.set(false);
          this.error.set('This run has no viewable model yet.');
        }
        return;
      }
      this.loading.set(true);
      this.viewer
        .load(url, (p) => this.loadProgress.set(p))
        .then((stats) => {
          this.stats.set(stats);
          this.loading.set(false);
        })
        .catch(() => {
          this.loading.set(false);
          this.error.set('Could not load the model.');
        });
    });

    effect(() => this.ready(ready) && this.viewer!.setColours(this.colours()));
    effect(() => this.ready(ready) && this.viewer!.setWireframe(this.wireframe()));
    effect(() => this.ready(ready) && this.viewer!.setGrid(this.grid()));
    effect(() => this.ready(ready) && this.viewer!.setCut(this.cut()));
    effect(() => this.ready(ready) && this.viewer!.setMode(this.mode()));
  }

  private ready(flag: () => boolean) {
    return flag() && !!this.viewer;
  }

  protected setMode(mode: ViewerMode) {
    this.mode.set(mode);
  }

  protected download(file: string) {
    return outputUrl(this.jobId(), file, true);
  }
}
