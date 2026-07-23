import { z } from 'zod';

export const FileUploadSchema = z.object({
  filename: z.string().min(1, { message: 'filename is required' }),
  size: z.number().int().nonnegative({ message: 'size must be a non-negative integer' }),
  mimeType: z.string().min(1, { message: 'mimeType is required' }),
});

export type FileUploadInput = z.infer<typeof FileUploadSchema>;
