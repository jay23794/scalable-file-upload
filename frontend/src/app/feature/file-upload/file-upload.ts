import { ChangeDetectorRef, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpEventType } from '@angular/common/http';
import { MatCardModule } from '@angular/material/card';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatDividerModule } from '@angular/material/divider';
import { FileUploadService } from './file-upload.service';
import { UploadItem, UploadRecord } from './file-upload.types';

let nextClientId = 0;
const makeClientId = () => `u_${Date.now()}_${++nextClientId}`;

@Component({
  selector: 'app-file-upload',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatProgressBarModule,
    MatDividerModule,
  ],
  templateUrl: './file-upload.html',
  styleUrl: './file-upload.scss',
})
export class FileUpload implements OnInit {
  private api = inject(FileUploadService);
  private cdr = inject(ChangeDetectorRef);

  items: UploadItem[] = [];
  uploaded: UploadRecord[] = [];
  listLoading = false;

  ngOnInit(): void {
    this.refreshList();
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const newItems: UploadItem[] = Array.from(input.files).map((file) => ({
      clientId: makeClientId(),
      file,
      progress: 0,
      status: 'pending',
    }));
    this.items = [...this.items, ...newItems];
    input.value = '';

    newItems.forEach((item) => this.uploadItem(item.clientId, item.file));
  }

  removeItem(clientId: string) {
    this.items = this.items.filter((it) => it.clientId !== clientId);
  }

  refreshList() {
    this.listLoading = true;
    this.api.list().subscribe({
      next: (res) => {
        this.uploaded = res.data ?? [];
        this.listLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.listLoading = false;
        this.cdr.detectChanges();
      },
    });
  }

  openDownload(record: UploadRecord) {
    this.api.getById(record.id).subscribe({
      next: (res) => {
        const url = res.data?.downloadUrl;
        if (url) window.open(url, '_blank');
      },
    });
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  private patchItem(clientId: string, changes: Partial<UploadItem>) {
    this.items = this.items.map((it) =>
      it.clientId === clientId ? { ...it, ...changes } : it,
    );
    this.cdr.detectChanges();
  }

  private uploadItem(clientId: string, file: File) {
    this.patchItem(clientId, { status: 'uploading', progress: 0 });

    this.api
      .presign({
        filename: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
      })
      .subscribe({
        next: (res) => {
          const presigned = res.data;
          this.putToSignedUrl(clientId, file, presigned.uploadUrl, presigned.path);
        },
        error: (err) => {
          this.patchItem(clientId, {
            status: 'error',
            error: err?.error?.error ?? 'Failed to presign',
          });
        },
      });
  }

  private putToSignedUrl(clientId: string, file: File, url: string, path: string) {
    this.api.uploadToSignedUrl(url, file).subscribe({
      next: (event) => {
        if (event.type === HttpEventType.UploadProgress) {
          const total = event.total ?? file.size;
          const percent = total ? Math.round((100 * event.loaded) / total) : 0;
          this.patchItem(clientId, { progress: percent });
        }
        if (event.type === HttpEventType.Response) {
          this.notifyComplete(clientId, file, path);
        }
      },
      error: (err) => {
        this.patchItem(clientId, {
          status: 'error',
          error: err?.message ?? 'Upload failed',
        });
      },
    });
  }

  private notifyComplete(clientId: string, file: File, path: string) {
    this.api
      .complete({
        path,
        filename: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
      })
      .subscribe({
        next: (res) => {
          this.patchItem(clientId, {
            status: 'completed',
            progress: 100,
            recordId: res.data.id,
          });
          this.refreshList();
        },
        error: (err) => {
          this.patchItem(clientId, {
            status: 'error',
            error: err?.error?.error ?? 'Failed to register upload',
          });
        },
      });
  }
}
