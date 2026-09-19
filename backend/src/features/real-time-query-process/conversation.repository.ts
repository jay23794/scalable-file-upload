import { ConversationModelDoc, toConversationRecord } from './conversation.model';
import { ConversationRecord, NewConversationRecord } from './types';

export class ConversationRepository {
  async create(record: NewConversationRecord): Promise<ConversationRecord> {
    const { id, ...rest } = record;
    const doc = await ConversationModelDoc.create({ _id: id, ...rest });
    return toConversationRecord(doc);
  }

  // Newest first — backed by the { updatedAt: -1 } index.
  async list(): Promise<ConversationRecord[]> {
    const docs = await ConversationModelDoc.find().sort({ updatedAt: -1 }).lean();
    return docs.map(toConversationRecord);
  }

  async findById(id: string): Promise<ConversationRecord | undefined> {
    const doc = await ConversationModelDoc.findById(id).lean();
    return doc ? toConversationRecord(doc) : undefined;
  }

  async exists(id: string): Promise<boolean> {
    return (await ConversationModelDoc.exists({ _id: id })) !== null;
  }
}
