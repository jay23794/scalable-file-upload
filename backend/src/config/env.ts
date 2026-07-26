import 'dotenv/config';

const required = (key: string, value: string | undefined): string => {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  supabase: {
    url: required('SUPABASE_URL', process.env.SUPABASE_URL),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
    bucket: required('SUPABASE_BUCKET', process.env.SUPABASE_BUCKET),
  },
  signedUrl: {
    downloadTtlSeconds: 60 * 10,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  ocrQueue: {
    name: process.env.OCR_QUEUE_NAME ?? 'ocr-queue',
  },
};
