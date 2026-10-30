import { RenderMode, ServerRoute } from '@angular/ssr';

// Every page shows live data from the local API, so render in the browser.
export const serverRoutes: ServerRoute[] = [
  {
    path: '**',
    renderMode: RenderMode.Client,
  },
];
