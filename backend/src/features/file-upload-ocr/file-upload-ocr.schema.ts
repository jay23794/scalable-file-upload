import { z } from 'zod';

export const PresignUploadSchema = z.object({
  filename: z.string().min(1, { message: 'filename is required' }),
  size: z.number().int().nonnegative({ message: 'size must be a non-negative integer' }),
  mimeType: z.string().min(1, { message: 'mimeType is required' }),
});
export type PresignUploadInput = z.infer<typeof PresignUploadSchema>;

export const CompleteUploadSchema = z.object({
  path: z.string().min(1, { message: 'path is required' }),
  filename: z.string().min(1, { message: 'filename is required' }),
  size: z.number().int().nonnegative({ message: 'size must be a non-negative integer' }),
  mimeType: z.string().min(1, { message: 'mimeType is required' }),
});
export type CompleteUploadInput = z.infer<typeof CompleteUploadSchema>;
