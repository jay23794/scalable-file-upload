import { IN_FLIGHT_STATUSES, PipelineSummary, UploadRecord, UploadStatus } from './types';
import { UploadModel, toRecord } from './file-upload-ocr.model';

export class FileUploadOcrRepository {
  async create(record: UploadRecord): Promise<UploadRecord> {
    const { id, ...rest } = record;
    const doc = await UploadModel.create({ _id: id, ...rest });
    return toRecord(doc);
  }

  async findById(id: string): Promise<UploadRecord | undefined> {
    const doc = await UploadModel.findById(id);
    return doc ? toRecord(doc) : undefined;
  }

  async list(): Promise<UploadRecord[]> {
    const docs = await UploadModel.find().sort({ createdAt: -1 });
    return docs.map(toRecord);
  }

  async delete(id: string): Promise<boolean> {
    const res = await UploadModel.deleteOne({ _id: id });
    return res.deletedCount === 1;
  }

  async updateStatus(id: string, status: UploadStatus): Promise<UploadRecord | undefined> {
    const doc = await UploadModel.findByIdAndUpdate(
      id,
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return doc ? toRecord(doc) : undefined;
  }

  async markReadyWithSummary(
    id: string,
    summary: PipelineSummary,
  ): Promise<UploadRecord | undefined> {
    const doc = await UploadModel.findByIdAndUpdate(
      id,
      { $set: { status: 'ready', pipelineSummary: summary, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return doc ? toRecord(doc) : undefined;
  }

  async findStuck(olderThan: Date): Promise<UploadRecord[]> {
    const docs = await UploadModel.find({
      status: { $in: IN_FLIGHT_STATUSES },
      updatedAt: { $lt: olderThan },
    });
    return docs.map(toRecord);
  }
}
