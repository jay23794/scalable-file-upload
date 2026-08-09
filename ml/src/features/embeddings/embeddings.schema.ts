import { z } from 'zod';

export const embedRequestSchema = z.object({
  uploadId: z.string().min(1).max(64),
  chunks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        text: z.string().min(1).max(8192),
      })
    )
    .min(1),
});

export type EmbedRequest = z.infer<typeof embedRequestSchema>;

export interface EmbedResponse {
  uploadId: string;
  chunkCount: number;
  dim: number;
  model: string;
}
