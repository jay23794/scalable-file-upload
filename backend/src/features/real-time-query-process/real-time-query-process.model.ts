import { Schema, model, HydratedDocument } from 'mongoose';
import { FinishReason, QueryModel, QueryRecord, QueryStatus, SourceRef } from './types';

const QUERY_STATUSES: QueryStatus[] = ['generating', 'complete', 'failed'];
const QUERY_MODELS: QueryModel[] = ['gemini', 'gpt-4o', 'claude'];
const FINISH_REASONS: FinishReason[] = ['stop', 'length', 'cancelled'];

interface QueryDoc extends Omit<QueryRecord, 'id'> {
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
    query: { type: String, required: true },
    model: { type: String, enum: QUERY_MODELS, required: true },
    connectors: { type: [String], required: true },
    topK: { type: Number, required: true },
    status: { type: String, enum: QUERY_STATUSES, required: true, index: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
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
  { _id: false, versionKey: false },
);

// Backs the generation sweeper's stage-1 scan when it lands.
QuerySchema.index({ status: 1, updatedAt: 1 });

export const QueryModelDoc = model<QueryDoc>('Query', QuerySchema);

export const toRecord = (doc: HydratedDocument<QueryDoc>): QueryRecord => ({
  id: doc._id,
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
