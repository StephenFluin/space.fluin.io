import { Component, DOCUMENT, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormField, form, maxLength, required, submit } from '@angular/forms/signals';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ProjectKind } from '../../shared/models';
import { Api } from '../api';
import { SystemStatus } from '../components/system-status';

@Component({
  selector: 'app-projects-page',
  imports: [RouterLink, DatePipe, DecimalPipe, FormField, SystemStatus],
  template: `
    <div class="page layout">
      <section aria-labelledby="projects-heading">
        <h1 id="projects-heading">Projects</h1>
        @if (projects.isLoading() && !projects.value().length) {
          <p class="muted">Loading…</p>
        } @else if (!projects.value().length) {
          <p class="muted">
            No projects yet. Create one for the exterior (drone) and one for each interior space.
          </p>
        }
        <ul class="grid">
          @for (p of projects.value(); track p.id) {
            <li class="card project">
              <h2>
                <a [routerLink]="['/projects', p.id]">{{ p.name }}</a>
              </h2>
              <p class="meta">
                <span class="badge">{{ p.kind === 'exterior' ? 'Exterior' : 'Interior' }}</span>
                {{ p.mediaCount }} {{ p.mediaCount === 1 ? 'file' : 'files' }}
              </p>
              @if (p.latestJob; as j) {
                <p class="meta">
                  Latest run: <span class="badge" [class]="j.status">{{ j.status }}</span>
                  @if (j.status === 'running') {
                    {{ j.stage }} ({{ j.progress * 100 | number: '1.0-0' }}%)
                  }
                </p>
              }
              <p class="muted small">Created {{ p.createdAt + 'Z' | date: 'mediumDate' }}</p>
            </li>
          }
        </ul>
      </section>

      <aside class="side">
        <section class="card" aria-labelledby="new-heading">
          <h2 id="new-heading">New project</h2>
          <form (submit)="create($event)" novalidate>
            <div class="field">
              <label for="name">Name</label>
              <input
                id="name"
                [formField]="newForm.name"
                autocomplete="off"
                [attr.aria-invalid]="showErrors() && newForm.name().invalid()"
                aria-describedby="name-error"
              />
              <span id="name-error" class="error" aria-live="polite">
                @if (showErrors() && newForm.name().invalid()) {
                  @for (e of newForm.name().errors(); track e.kind) {
                    {{ e.message }}
                  }
                }
              </span>
            </div>
            <fieldset class="field">
              <legend>Capture type</legend>
              <label class="radio">
                <input type="radio" value="exterior" [formField]="newForm.kind" />
                Exterior — drone photos/video orbiting the house
              </label>
              <label class="radio">
                <input type="radio" value="interior" [formField]="newForm.kind" />
                Interior — handheld walk-through of rooms
              </label>
            </fieldset>
            <div class="field">
              <label for="notes">Notes <span class="muted">(optional)</span></label>
              <textarea id="notes" rows="2" [formField]="newForm.notes"></textarea>
            </div>
            @if (createError()) {
              <p class="error" role="alert">{{ createError() }}</p>
            }
            <button class="btn primary" type="submit" [disabled]="newForm().submitting()">
              Create project
            </button>
          </form>
        </section>
        <app-system-status />
      </aside>
    </div>
  `,
  styles: `
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 360px;
      gap: 1.5rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .layout {
        grid-template-columns: 1fr;
      }
    }
    .grid {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 1rem;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    }
    .project h2 {
      font-size: 1.1rem;
      margin-bottom: 0.4rem;
    }
    .meta {
      margin: 0.25rem 0;
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
    }
    .small {
      font-size: 0.85rem;
      margin: 0.25rem 0 0;
    }
    .side {
      display: grid;
      gap: 1.5rem;
    }
    form {
      display: grid;
      gap: 1rem;
    }
    fieldset {
      border: 0;
      padding: 0;
      margin: 0;
    }
    legend {
      font-weight: 600;
      font-size: 0.9rem;
      margin-bottom: 0.3rem;
    }
    .radio {
      display: flex;
      gap: 0.5rem;
      align-items: flex-start;
      font-weight: 400 !important;
    }
    .radio input {
      min-height: auto;
      margin-top: 0.3rem;
    }
    .error {
      color: var(--danger);
    }
  `,
})
export class ProjectsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);

  protected readonly projects = this.api.projects();
  protected readonly showErrors = signal(false);
  protected readonly createError = signal('');

  private readonly model = signal<{ name: string; kind: ProjectKind; notes: string }>({
    name: '',
    kind: 'exterior',
    notes: '',
  });
  protected readonly newForm = form(this.model, (p) => {
    required(p.name, { message: 'Give the project a name' });
    maxLength(p.name, 120, { message: 'Keep the name under 120 characters' });
  });

  protected async create(event: Event) {
    event.preventDefault();
    this.showErrors.set(true);
    this.createError.set('');
    await submit(this.newForm, async () => {
      try {
        const project = await firstValueFrom(this.api.createProject(this.model()));
        await this.router.navigate(['/projects', project.id]);
      } catch {
        this.createError.set('Could not create the project.');
      }
      return undefined;
    });
    if (this.newForm().invalid()) this.document.getElementById('name')?.focus();
  }
}
