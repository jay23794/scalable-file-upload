import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  ApiEnvelope,
  CompleteRequest,
  PresignRequest,
  PresignResponse,
  UploadRecord,
} from './file-upload.types';

const API_BASE = 'http://localhost:3000/api/v1/file-upload-ocr';

@Injectable({ providedIn: 'root' })
export class FileUploadService {
  private http = inject(HttpClient);

  presign(body: PresignRequest): Observable<ApiEnvelope<PresignResponse>> {
    return this.http.post<ApiEnvelope<PresignResponse>>(`${API_BASE}/upload/presign`, body);
  }

  uploadToSignedUrl(url: string, file: File): Observable<HttpEvent<unknown>> {
    return this.http.put(url, file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      reportProgress: true,
      observe: 'events',
    });
  }

  complete(body: CompleteRequest): Observable<ApiEnvelope<UploadRecord>> {
    return this.http.post<ApiEnvelope<UploadRecord>>(`${API_BASE}/upload/complete`, body);
  }

  list(): Observable<ApiEnvelope<UploadRecord[]>> {
    return this.http.get<ApiEnvelope<UploadRecord[]>>(`${API_BASE}/uploads`);
  }

  getById(id: string): Observable<ApiEnvelope<UploadRecord>> {
    return this.http.get<ApiEnvelope<UploadRecord>>(`${API_BASE}/uploads/${id}`);
  }

  remove(id: string): Observable<void> {
    return this.http.delete<void>(`${API_BASE}/uploads/${id}`);
  }
}
