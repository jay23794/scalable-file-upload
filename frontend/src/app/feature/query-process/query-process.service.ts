import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import {
  ApiEnvelope,
  CreateQueryRequest,
  CreateQueryResponse,
  QueryRecord,
  StreamEvent,
  UploadSummary,
} from './query-process.types';

const API_BASE = 'http://localhost:3000/api/v1/real-time-query-process';
const UPLOADS_BASE = 'http://localhost:3000/api/v1/file-upload-ocr';

@Injectable({ providedIn: 'root' })
export class QueryProcessService {
  private http = inject(HttpClient);

  submit(body: CreateQueryRequest): Observable<ApiEnvelope<CreateQueryResponse>> {
    // 202 — the answer does not exist yet. Watch it over stream().
    return this.http.post<ApiEnvelope<CreateQueryResponse>>(`${API_BASE}/queries`, body);
  }

  list(): Observable<ApiEnvelope<QueryRecord[]>> {
    return this.http.get<ApiEnvelope<QueryRecord[]>>(`${API_BASE}/queries`);
  }

  getById(id: string): Observable<ApiEnvelope<QueryRecord>> {
    return this.http.get<ApiEnvelope<QueryRecord>>(`${API_BASE}/queries/${id}`);
  }

  /** Feeds the connector picker. Only 'ready' uploads have embeddings. */
  listUploads(): Observable<ApiEnvelope<UploadSummary[]>> {
    return this.http.get<ApiEnvelope<UploadSummary[]>>(`${UPLOADS_BASE}/uploads`);
  }

  /**
   * Tails one generation over SSE.
   *
   * Cold by design: nothing connects until subscribe, and unsubscribing closes
   * the EventSource. That matters because a closed connection is NOT a cancel
   * signal — generation continues server-side and Path A still persists the
   * answer, so navigating away costs nothing but the typing effect.
   *
   * Native EventSource cannot set Last-Event-ID by hand. The browser sends it
   * automatically on auto-reconnect, and a fresh open replays from cursor 0.
   * Both are correct at V1, so no fetch-based polyfill is needed.
   */
  stream(queryId: string): Observable<StreamEvent> {
    return new Observable<StreamEvent>((subscriber) => {
      const source = new EventSource(`${API_BASE}/queries/${queryId}/stream`);

      source.onmessage = (message: MessageEvent<string>) => {
        let event: StreamEvent;
        try {
          event = JSON.parse(message.data) as StreamEvent;
        } catch {
          console.warn('[query-process] dropped an unparseable stream frame');
          return;
        }

        subscriber.next(event);

        // Terminal events end the observable. 'error' completes rather than
        // errors: it is a generation that failed, not a transport failure, and
        // it carries a message the UI renders in the bubble.
        if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
          source.close();
          subscriber.complete();
        }
      };

      source.onerror = () => {
        // EventSource retries transient drops on its own, so only a CLOSED
        // socket is a real failure. The server ending the response after a
        // terminal event also lands here, but the handler above has already
        // completed and closed by then.
        if (source.readyState === EventSource.CLOSED) {
          subscriber.error(new Error('Connection to the server was lost'));
        }
      };

      return () => source.close();
    });
  }
}
