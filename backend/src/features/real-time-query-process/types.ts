export type QueryStatus = 'generating' | 'complete' | 'failed';

export type QueryModel = 'gemini' | 'gpt-4o' | 'claude';

export type FinishReason = 'stop' | 'length' | 'cancelled';

export interface SourceRef {
  uploadId: string;
  chunkIndex: number;
  score: number;
}

// Job return value from the ml generate worker, delivered to the backend over
// BullMQ (not over the Redis Stream). This is what makes Path A durable — the
// stream is a firehose of disposable fragments, this is the one finished value.
export interface GenerationResult {
  text: string;
  sources: SourceRef[];
  totalTokens: number;
  finishReason: FinishReason;
}

// One row = one turn: the user's question and the assistant's answer together.
// `id` doubles as the message id — there is no separate messageId.
export interface QueryRecord {
  id: string;
  conversationId: string;
  query: string;
  model: QueryModel;
  connectors: string[];
  topK: number;
  status: QueryStatus;
  createdAt: Date;
  updatedAt: Date;
  // Populated on 'complete' by the QueueEvents handler — the only Mongo writer.
  text?: string;
  sources?: SourceRef[];
  totalTokens?: number;
  finishReason?: FinishReason;
  // Populated on 'failed'.
  failedReason?: string;
}

// What a caller supplies to create a row. createdAt/updatedAt are omitted
// because the schema's `timestamps: true` stamps them on write.
export type NewQueryRecord = Omit<QueryRecord, 'createdAt' | 'updatedAt'>;

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export type NewConversationRecord = Omit<ConversationRecord, 'createdAt' | 'updatedAt'>;

// Used when the client starts a conversation without naming it. A domain fact,
// not a validation detail — the row always has a title.
export const DEFAULT_CONVERSATION_TITLE = 'New conversation';

// Thrown by submitQuery when the target conversation does not exist, so the
// controller can answer 404 instead of writing a message that belongs nowhere.
export class ConversationNotFoundError extends Error {
  constructor(public conversationId: string) {
    super(`Conversation ${conversationId} not found`);
    this.name = 'ConversationNotFoundError';
  }
}

// Statuses the sweeper would treat as candidates. Only one today, but kept in
// the same shape as IN_FLIGHT_STATUSES in file-upload-ocr/types.ts.
export const IN_FLIGHT_QUERY_STATUSES: QueryStatus[] = ['generating'];

// Written by the ml worker with XADD gen:${queryId} and forwarded verbatim by
// the backend's read-only SSE handler. Each SSE frame carries the Redis entry
// ID as `id:`, which the client sends back as Last-Event-ID on reconnect.
export type StreamEvent =
  | { type: 'progress'; step: 'embed' | 'search' | 'context' | 'llm'; pct: number }
  | { type: 'token'; text: string; index: number }
  | { type: 'restart' }
  | { type: 'done'; totalTokens: number; sources: SourceRef[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };
