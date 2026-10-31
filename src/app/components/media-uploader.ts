import { Component, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Api } from '../api';

const ACCEPT = '.jpg,.jpeg,.png,.tif,.tiff,.bmp,.mp4,.mov,.m4v,.mkv,.avi,.webm';
/** Insta360 originals hold two unstitched fisheye images; the app needs the stitched 360° export. */
const RAW_360 = ['.insv', '.insp', '.lrv'];
const RAW_360_HELP =
  'Insta360 .insv/.insp files are unstitched originals. Export them from Insta360 Studio or the ' +
  'app as a 360° MP4 or JPG (no reframing), then upload the export.';

/** Drag-and-drop / file-picker upload of photos and videos into a project. */
@Component({
  selector: 'app-media-uploader',
  imports: [DecimalPipe],
  host: {
    '(dragover)': 'onDragOver($event)',
    '(dragleave)': 'dragging.set(false)',
    '(drop)': 'onDrop($event)',
    '[class.dragging]': 'dragging()',
  },
  template: `
    <div class="zone">
      <svg
        aria-hidden="true"
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
      </svg>
      <p>Drag photos and videos here, or</p>
      <label class="btn primary">
        Choose files
        <input
          class="visually-hidden"
          type="file"
          multiple
          [accept]="accept"
          (change)="onPick($event)"
          [disabled]="uploading()"
        />
      </label>
      <p class="muted hint">
        JPEG, PNG or TIFF photos (keep EXIF data) and MP4/MOV video. Convert HEIC to JPEG first.
      </p>
    </div>
    <div aria-live="polite">
      @if (uploading()) {
        <p>Uploading {{ count() }} files… {{ progress() * 100 | number: '1.0-0' }}%</p>
        <progress [value]="progress()" max="1" aria-label="Upload progress"></progress>
      } @else if (message()) {
        <p [class.error]="failed()">{{ message() }}</p>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      border: 2px dashed var(--border);
      border-radius: var(--radius);
      padding: 1.25rem;
    }
    :host(.dragging) {
      border-color: var(--accent);
      background: var(--surface-2);
    }
    .zone {
      display: grid;
      justify-items: center;
      gap: 0.5rem;
      text-align: center;
    }
    .zone p {
      margin: 0;
    }
    .hint {
      font-size: 0.85rem;
    }
    .btn:focus-within {
      outline: 3px solid var(--focus);
      outline-offset: 2px;
    }
    .error {
      color: var(--danger);
    }
  `,
})
export class MediaUploader {
  private readonly api = inject(Api);
  readonly projectId = input.required<number>();
  readonly uploaded = output<void>();

  protected readonly accept = ACCEPT;
  protected readonly dragging = signal(false);
  protected readonly uploading = signal(false);
  protected readonly progress = signal(0);
  protected readonly count = signal(0);
  protected readonly message = signal('');
  protected readonly failed = signal(false);

  protected onDragOver(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(true);
  }

  protected onDrop(e: DragEvent) {
    e.preventDefault();
    this.dragging.set(false);
    this.send([...(e.dataTransfer?.files ?? [])]);
  }

  protected onPick(e: Event) {
    const el = e.target as HTMLInputElement;
    this.send([...(el.files ?? [])]);
    el.value = '';
  }

  private send(files: File[]) {
    const exts = ACCEPT.split(',');
    const ok = files.filter((f) => exts.some((x) => f.name.toLowerCase().endsWith(x)));
    const skipped = files.length - ok.length;
    const raw = files.some((f) => RAW_360.some((x) => f.name.toLowerCase().endsWith(x)));
    if (!ok.length) {
      this.failed.set(true);
      this.message.set(raw ? RAW_360_HELP : 'None of those files are supported photos or videos.');
      return;
    }
    this.uploading.set(true);
    this.progress.set(0);
    this.count.set(ok.length);
    this.api.upload(this.projectId(), ok).subscribe({
      next: (e) => {
        if ('progress' in e) {
          this.progress.set(e.progress);
          return;
        }
        this.failed.set(false);
        this.message.set(
          `Uploaded ${e.done.length} files.` +
            (skipped ? ` Skipped ${skipped} unsupported files.` : '') +
            (raw ? ` ${RAW_360_HELP}` : ''),
        );
        this.uploaded.emit();
      },
      error: () => {
        this.uploading.set(false);
        this.failed.set(true);
        this.message.set('Upload failed.');
      },
      complete: () => this.uploading.set(false),
    });
  }
}
