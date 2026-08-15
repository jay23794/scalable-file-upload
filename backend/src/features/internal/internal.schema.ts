import { z } from 'zod';

export const InternalSignedUrlSchema = z.object({
  path: z
    .string()
    .min(1, { message: 'path is required' })
    .refine((p) => p.startsWith('chunks/'), {
      message: 'path must start with chunks/',
    }),
  mode: z.enum(['upload', 'download', 'delete']),
});
export type InternalSignedUrlInput = z.infer<typeof InternalSignedUrlSchema>;
