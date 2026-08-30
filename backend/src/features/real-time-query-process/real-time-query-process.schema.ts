import { z } from 'zod';

export const CreateQuerySchema = z.object({
  query: z.string().min(1, { message: 'query is required' }),
  model: z.enum(['gemini', 'gpt-4o', 'claude'], { message: 'model is not supported' }),
  connectors: z
    .array(z.string().min(1))
    .min(1, { message: 'at least one connector is required' }),
  topK: z.number().int().min(1).max(20).optional(),
});
export type CreateQueryInput = z.infer<typeof CreateQuerySchema>;
