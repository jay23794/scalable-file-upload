// Contracts shared with the backend. The producer side of GenerateJobData is
// backend/src/infra/generateQueue.ts; StreamEvent, SourceRef, GenerationResult
// and FinishReason are declared in
// backend/src/features/real-time-query-process/types.ts. If any shape here
// changes, change it there in the same commit — they cross a process boundary
// as JSON and nothing typechecks the seam.

export interface GenerateJobData {
  /** Also the Mongo _id, the BullMQ jobId, and the gen:{...} stream suffix. */
  queryId: string;
  query: string;
  model: string;
  connectors: string[];
  /** The backend always sets this; defaulted here so a hand-enqueued job works. */
  topK?: number;
}

export type FinishReason = 'stop' | 'length' | 'cancelled';

export interface SourceRef {
  uploadId: string;
  chunkIndex: number;
  score: number;
}

// The job return value. Travels back over BullMQ, not over the stream — this is
// the one finished value Path A persists, while the stream is a firehose of
// disposable fragments under a TTL.
export interface GenerationResult {
  text: string;
  sources: SourceRef[];
  totalTokens: number;
  finishReason: FinishReason;
}

// Written with XADD gen:${queryId} and forwarded verbatim by the backend's
// read-only SSE handler.
export type StreamEvent =
  | { type: 'progress'; step: 'embed' | 'search' | 'context' | 'llm'; pct: number }
  | { type: 'token'; text: string; index: number }
  | { type: 'restart' }
  | { type: 'done'; totalTokens: number; sources: SourceRef[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
