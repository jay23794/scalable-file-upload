import 'dotenv/config';

const required = (key: string, value: string | undefined): string => {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 4000,
  backendBaseUrl: process.env.BACKEND_BASE_URL ?? 'http://localhost:3000',
  internalServiceToken: required('INTERNAL_SERVICE_TOKEN', process.env.INTERNAL_SERVICE_TOKEN),
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  ocrQueue: {
    name: process.env.OCR_QUEUE_NAME ?? 'ocr-queue',
    concurrency: process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 5,
  },
  embedQueue: {
    name: process.env.EMBED_QUEUE_NAME ?? 'embed-queue',
  },
};
