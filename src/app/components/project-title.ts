import {
  Component,
  ElementRef,
  afterNextRender,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormField, form, maxLength, required, submit } from '@angular/forms/signals';
import { firstValueFrom } from 'rxjs';
import { Api } from '../api';

/** Project heading that can be renamed in place. */
@Component({
  selector: 'app-project-title',
  imports: [FormField],
  template: `
    @if (editing()) {
      <h1 class="visually-hidden">{{ name() }}</h1>
      <form (submit)="save($event)" novalidate class="rename">
        <label for="project-name" class="visually-hidden">Project name</label>
        <input
          #nameInput
          id="project-name"
          autocomplete="off"
          [formField]="nameForm.name"
          [attr.aria-invalid]="nameForm.name().invalid()"
          aria-describedby="project-name-error"
          (keydown.escape)="cancel()"
        />
        <button class="btn primary small" type="submit" [disabled]="nameForm().submitting()">
          Save
        </button>
        <button class="btn small" type="button" (click)="cancel()">Cancel</button>
        <span id="project-name-error" class="error" aria-live="polite">
          @if (nameForm.name().invalid()) {
            @for (e of nameForm.name().errors(); track e.kind) {
              {{ e.message }}
            }
          }
          {{ saveError() }}
        </span>
      </form>
    } @else {
      <h1>{{ name() }}</h1>
      <button #renameButton class="btn small" type="button" (click)="edit()">Rename</button>
    }
  `,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
    }
    h1 {
      margin: 0;
    }
    .rename {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    input {
      font: inherit;
      font-size: 1.5rem;
      font-weight: 700;
      padding: 0.2rem 0.5rem;
      border-radius: 8px;
      border: 1px solid var(--muted);
      background: var(--surface);
      color: var(--text);
      min-width: min(24rem, 100%);
    }
    .error {
      color: var(--danger);
      font-size: 0.85rem;
      flex-basis: 100%;
    }
  `,
})
export class ProjectTitle {
  private readonly api = inject(Api);
  private readonly injector = inject(Injector);

  readonly projectId = input.required<number>();
  readonly name = input.required<string>();
  readonly renamed = output<void>();

  protected readonly editing = signal(false);
  protected readonly saveError = signal('');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly renameButton = viewChild<ElementRef<HTMLButtonElement>>('renameButton');

  private readonly model = signal({ name: '' });
  protected readonly nameForm = form(this.model, (p) => {
    required(p.name, { message: 'Give the project a name' });
    maxLength(p.name, 120, { message: 'Keep the name under 120 characters' });
  });

  protected edit() {
    this.model.set({ name: this.name() });
    this.saveError.set('');
    this.editing.set(true);
    afterNextRender(() => this.nameInput()?.nativeElement.select(), { injector: this.injector });
  }

  protected cancel() {
    this.close();
  }

  protected async save(event: Event) {
    event.preventDefault();
    this.saveError.set('');
    await submit(this.nameForm, async () => {
      const name = this.model().name.trim();
      if (name !== this.name()) {
        try {
          await firstValueFrom(this.api.updateProject(this.projectId(), { name }));
          this.renamed.emit();
        } catch {
          this.saveError.set('Could not rename the project.');
          return undefined;
        }
      }
      this.close();
      return undefined;
    });
  }

  /** Leave edit mode and put focus back on the Rename button. */
  private close() {
    this.editing.set(false);
    afterNextRender(() => this.renameButton()?.nativeElement.focus(), { injector: this.injector });
  }
}
