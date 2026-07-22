import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', redirectTo: 'file-upload', pathMatch: 'full' },
  {
    path: 'file-upload',
    loadComponent: () =>
      import('./feature/file-upload/file-upload').then(m => m.FileUpload)
  },
  {
    path: 'query-process',
    loadComponent: () =>
      import('./feature/query-process/query-process').then(m => m.QueryProcess)
  }
];
