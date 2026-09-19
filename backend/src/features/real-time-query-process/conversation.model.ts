import { Schema, model } from 'mongoose';
import { ConversationRecord } from './types';

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
