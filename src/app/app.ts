import { Component } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet, RouterLink],
  selector: 'app-root',
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header">
      <div class="bar">
        <a routerLink="/" class="brand">
          <svg
            aria-hidden="true"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M12 2 3 7v10l9 5 9-5V7z" />
            <path d="m3 7 9 5 9-5M12 12v10" />
          </svg>
          Space
        </a>
        <span class="tagline">Photogrammetry for home scans</span>
      </div>
    </header>
    <main id="main" tabindex="-1">
      <router-outlet />
    </main>
  `,
  styles: `
    .site-header {
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    /* Same width and gutter as .page so the logo lines up with page headings. */
    .bar {
      display: flex;
      align-items: baseline;
      gap: 1rem;
      max-width: 1200px;
      margin: 0 auto;
      padding: 0.75rem 1.5rem;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      font-weight: 700;
      font-size: 1.15rem;
      color: var(--text);
      text-decoration: none;
      align-self: center;
    }
    .tagline {
      color: var(--muted);
      font-size: 0.9rem;
    }
    main {
      display: block;
      outline: none;
    }
  `,
})
export class App {}
