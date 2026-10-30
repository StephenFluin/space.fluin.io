import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    title: 'Projects · Space',
    loadComponent: () => import('./pages/projects-page').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/:id',
    title: 'Project · Space',
    loadComponent: () => import('./pages/project-page').then((m) => m.ProjectPage),
  },
  {
    path: 'projects/:id/jobs/:jobId/explore',
    title: '3D explorer · Space',
    loadComponent: () => import('./pages/explorer-page').then((m) => m.ExplorerPage),
  },
  { path: '**', redirectTo: '' },
];
