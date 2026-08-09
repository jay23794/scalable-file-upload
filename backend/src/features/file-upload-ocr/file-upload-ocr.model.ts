import { Schema, model, HydratedDocument } from 'mongoose';
import { PipelineSummary, UploadRecord, UploadStatus } from './types';

const UPLOAD_STATUSES: UploadStatus[] = [
  'pending',
  'ocr_processing',
  'ml_processing',
  'ready',
  'failed',
];

interface UploadDoc extends Omit<UploadRecord, 'id'> {
  _id: string;
}

const PipelineSummarySchema = new Schema<PipelineSummary>(
  {
    chunkCount: { type: Number, required: true },
    model:      { type: String, required: true },
    dim:        { type: Number, required: true },
    storedAt:   { type: Date,   required: true },
  },
  { _id: false },
);

const UploadSchema = new Schema<UploadDoc>(
  {
    _id: { type: String, required: true },
    path: { type: String, required: true },
    filename: { type: String, required: true },
    size: { type: Number, required: true },
    mimeType: { type: String, required: true },
    status: { type: String, enum: UPLOAD_STATUSES, required: true, index: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    pipelineSummary: { type: PipelineSummarySchema, required: false },
  },
  { _id: false, versionKey: false },
);

UploadSchema.index({ status: 1, updatedAt: 1 });

export const UploadModel = model<UploadDoc>('Upload', UploadSchema);

export const toRecord = (doc: HydratedDocument<UploadDoc>): UploadRecord => ({
  id: doc._id,
  path: doc.path,
  filename: doc.filename,
  size: doc.size,
  mimeType: doc.mimeType,
  status: doc.status,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  pipelineSummary: doc.pipelineSummary,
});
