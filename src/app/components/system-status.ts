import { Component, inject } from '@angular/core';
import { Api } from '../api';

/** Shows which external photogrammetry tools the server can find. */
@Component({
  selector: 'app-system-status',
  template: `
    <section class="card" aria-labelledby="system-heading">
      <h2 id="system-heading">Reconstruction tools</h2>
      @if (status.value(); as s) {
        @if (!s.ready) {
          <p class="warn" role="status">
            Some required tools are missing. Uploads work, but reconstructions will fail until they
            are installed.
          </p>
        }
        <ul>
          @for (t of s.tools; track t.name) {
            <li>
              <span class="dot" [class.ok]="t.available" aria-hidden="true"></span>
              <strong>{{ t.name }}</strong>
              <span class="visually-hidden">{{ t.available ? 'available' : 'missing' }}</span>
              <span class="muted detail">{{ t.detail }}</span>
            </li>
          }
        </ul>
      } @else if (status.error()) {
        <p role="alert">Could not reach the API.</p>
      } @else {
        <p class="muted">Checking…</p>
      }
    </section>
  `,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.5rem;
    }
    li {
      display: grid;
      grid-template-columns: auto auto 1fr;
      gap: 0.5rem;
      align-items: baseline;
    }
    .dot {
      width: 0.65rem;
      height: 0.65rem;
      border-radius: 50%;
      background: var(--danger);
      display: inline-block;
    }
    .dot.ok {
      background: var(--ok);
    }
    .detail {
      font-size: 0.85rem;
      overflow-wrap: anywhere;
    }
    .warn {
      color: var(--warn);
    }
  `,
})
export class SystemStatus {
  protected readonly status = inject(Api).system();
}
