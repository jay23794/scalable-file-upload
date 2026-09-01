// Mirrors backend/src/features/real-time-query-process/types.ts. These cross the
// wire as JSON — if the backend contract changes, change it here in the same
// commit, because nothing typechecks the seam.

export type QueryStatus = 'generating' | 'complete' | 'failed';

export type QueryModel = 'gemini' | 'gpt-4o' | 'claude';

export type FinishReason = 'stop' | 'length' | 'cancelled';

export interface SourceRef {
  uploadId: string;
  chunkIndex: number;
  score: number;
}

export interface QueryRecord {
  id: string;
  query: string;
  model: QueryModel;
  connectors: string[];
  topK: number;
  status: QueryStatus;
  createdAt: string;
  updatedAt: string;
  text?: string;
  sources?: SourceRef[];
  totalTokens?: number;
  finishReason?: FinishReason;
  failedReason?: string;
}

// Written by the ml worker into gen:{queryId} and forwarded verbatim by the
// backend's read-only SSE handler.
export type StreamEvent =
  | { type: 'progress'; step: 'embed' | 'search' | 'context' | 'llm'; pct: number }
  | { type: 'token'; text: string; index: number }
  | { type: 'restart' }
  | { type: 'done'; totalTokens: number; sources: SourceRef[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export interface CreateQueryRequest {
  query: string;
  model: QueryModel;
  connectors: string[];
  topK?: number;
}

export interface CreateQueryResponse {
  queryId: string;
}

/**
 * The subset of an upload record the connector picker needs. Declared here
 * rather than imported from file-upload.types.ts, which does not carry `status`
 * — and the status is the whole point, since only 'ready' uploads have
 * embeddings to search.
 */
export interface UploadSummary {
  id: string;
  filename: string;
  status: 'pending' | 'ocr_processing' | 'ml_processing' | 'ready' | 'failed';
}

export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data: T;
}
