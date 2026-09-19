import { z } from 'zod';

export const CreateQuerySchema = z.object({
  conversationId: z.uuid({ message: 'conversationId must be a valid conversation id' }),
  query: z.string().min(1, { message: 'query is required' }),
  model: z.enum(['gemini', 'gpt-4o', 'claude'], { message: 'model is not supported' }),
  connectors: z
    .array(z.string().min(1))
    .min(1, { message: 'at least one connector is required' }),
  topK: z.number().int().min(1).max(20).optional(),
});
export type CreateQueryInput = z.infer<typeof CreateQuerySchema>;

// Everything is optional: starting a fresh conversation needs no input at all.
// A client that has a name for it up front may send one.
export const StartConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
export type StartConversationInput = z.infer<typeof StartConversationSchema>;
