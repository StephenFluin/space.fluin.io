import { Component, computed, input, model, signal } from '@angular/core';
import type { FormValueControl } from '@angular/forms/signals';
import { formatCount, parseCount } from '../../shared/models';

/**
 * A text field for large counts that accepts "250000", "250,000", "250k" or "1.5M". Shows the
 * value as "250k" when not being edited. Unreadable or empty text sets the value to NaN, so the
 * form's validators report it.
 */
@Component({
  selector: 'app-count-input',
  template: `
    <input
      type="text"
      autocomplete="off"
      spellcheck="false"
      [id]="inputId()"
      [value]="text()"
      [attr.aria-invalid]="invalid()"
      [attr.aria-describedby]="describedBy() || null"
      (input)="type($any($event.target).value)"
      (blur)="tidy()"
    />
  `,
  styles: `
    :host {
      display: block;
    }
    input {
      width: 100%;
      box-sizing: border-box;
    }
  `,
})
export class CountInput implements FormValueControl<number> {
  readonly value = model(0);
  readonly invalid = input(false);
  readonly inputId = input.required<string>();
  readonly describedBy = input('');

  /** What's being typed; null shows the current value formatted. */
  protected readonly draft = signal<string | null>(null);
  protected readonly text = computed(() => {
    const v = this.value();
    return this.draft() ?? (Number.isNaN(v) ? '' : formatCount(v));
  });

  protected type(text: string) {
    this.draft.set(text);
    this.value.set(parseCount(text) ?? NaN);
  }

  /** Reformat on leaving the field, but keep unreadable text so it can be corrected. */
  protected tidy() {
    if (!Number.isNaN(this.value())) this.draft.set(null);
  }
}
