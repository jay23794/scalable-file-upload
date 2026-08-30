import { GenerationResult, QueryRecord } from './types';
import { QueryModelDoc, toRecord } from './real-time-query-process.model';

export class RealTimeQueryProcessRepository {
  async create(record: QueryRecord): Promise<QueryRecord> {
    const { id, ...rest } = record;
    const doc = await QueryModelDoc.create({ _id: id, ...rest });
    return toRecord(doc);
  }

  async findById(id: string): Promise<QueryRecord | undefined> {
    const doc = await QueryModelDoc.findById(id);
    return doc ? toRecord(doc) : undefined;
  }

  async list(): Promise<QueryRecord[]> {
    const docs = await QueryModelDoc.find().sort({ createdAt: -1 });
    return docs.map(toRecord);
  }

  async markComplete(id: string, result: GenerationResult): Promise<QueryRecord | undefined> {
    const doc = await QueryModelDoc.findByIdAndUpdate(
      id,
      {
        $set: {
          status: 'complete',
          text: result.text,
          sources: result.sources,
          totalTokens: result.totalTokens,
          finishReason: result.finishReason,
          updatedAt: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
    return doc ? toRecord(doc) : undefined;
  }

  async markFailed(id: string, reason: string): Promise<QueryRecord | undefined> {
    const doc = await QueryModelDoc.findByIdAndUpdate(
      id,
      { $set: { status: 'failed', failedReason: reason, updatedAt: new Date() } },
      { returnDocument: 'after' },
    );
    return doc ? toRecord(doc) : undefined;
  }
}
