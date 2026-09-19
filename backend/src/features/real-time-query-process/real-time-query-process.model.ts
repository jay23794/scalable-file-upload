import { Schema, model } from 'mongoose';
import { ConversationRecord, FinishReason, QueryModel, QueryRecord, QueryStatus, SourceRef } from './types';

const QUERY_STATUSES: QueryStatus[] = ['generating', 'complete', 'failed'];
const QUERY_MODELS: QueryModel[] = ['gemini', 'gpt-4o', 'claude'];
const FINISH_REASONS: FinishReason[] = ['stop', 'length', 'cancelled'];

export interface QueryDoc extends Omit<QueryRecord, 'id'> {
  _id: string;
}

const SourceRefSchema = new Schema<SourceRef>(
  {
    uploadId:   { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    score:      { type: Number, required: true },
  },
  { _id: false },
);

const QuerySchema = new Schema<QueryDoc>(
  {
    _id: { type: String, required: true },
    conversationId: { type: String, required: true },
    query: { type: String, required: true },
    model: { type: String, enum: QUERY_MODELS, required: true },
    connectors: { type: [String], required: true },
    topK: { type: Number, required: true },
    status: { type: String, enum: QUERY_STATUSES, required: true, index: true },
    // Written only by the QueueEvents 'completed' handler (Path A).
    text: { type: String, required: false },
    // `default: undefined` suppresses Mongoose's automatic [] for array paths.
    // An empty array would read as "retrieval found nothing" on a row that has
    // not been generated yet.
    sources: { type: [SourceRefSchema], required: false, default: undefined },
    totalTokens: { type: Number, required: false },
    finishReason: { type: String, enum: FINISH_REASONS, required: false },
    // Written only by the QueueEvents 'failed' handler.
    failedReason: { type: String, required: false },
  },
  // `timestamps: true` owns createdAt/updatedAt — set together on insert and
  // bumped on every findByIdAndUpdate. Any future write that must NOT look
  // like fresh activity (the sweeper touching a row) needs `timestamps: false`,
  // or it will keep resetting itself out of the stage-1 scan below.
  { _id: false, versionKey: false, timestamps: true },
);

// Backs the generation sweeper's stage-1 scan when it lands.
QuerySchema.index({ status: 1, updatedAt: 1 });
// Backs the conversation fetch — every turn in one conversation, oldest first.
QuerySchema.index({ conversationId: 1, createdAt: 1 });

export const QueryModelDoc = model<QueryDoc>('Query', QuerySchema);

// Accepts both a hydrated document (from create) and a lean POJO (from the
// read paths) — HydratedDocument<QueryDoc> is structurally a QueryDoc.
export const toRecord = (doc: QueryDoc): QueryRecord => ({
  id: doc._id,
  conversationId: doc.conversationId,
  query: doc.query,
  model: doc.model,
  connectors: doc.connectors,
  topK: doc.topK,
  status: doc.status,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  text: doc.text,
  sources: doc.sources,
  totalTokens: doc.totalTokens,
  finishReason: doc.finishReason,
  failedReason: doc.failedReason,
});

// ---------------------------------------------------------------------------
// Conversation — the container a query row is filed under via conversationId.
// ---------------------------------------------------------------------------

export interface ConversationDoc extends Omit<ConversationRecord, 'id'> {
  _id: string;
}

const ConversationSchema = new Schema<ConversationDoc>(
  {
    _id: { type: String, required: true },
    title: { type: String, required: true },
  },
  { _id: false, versionKey: false, timestamps: true },
);

// Backs the conversation list — newest first.
ConversationSchema.index({ updatedAt: -1 });

export const ConversationModelDoc = model<ConversationDoc>('Conversation', ConversationSchema);

export const toConversationRecord = (doc: ConversationDoc): ConversationRecord => ({
  id: doc._id,
  title: doc.title,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
});
