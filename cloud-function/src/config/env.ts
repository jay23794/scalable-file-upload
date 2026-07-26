import 'dotenv/config';

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 4000,
  backendBaseUrl: process.env.BACKEND_BASE_URL ?? 'http://localhost:3000',
  mlServiceUrl: process.env.ML_SERVICE_URL ?? 'http://localhost:5000',
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  ocrQueue: {
    name: process.env.OCR_QUEUE_NAME ?? 'ocr-queue',
    concurrency: process.env.WORKER_CONCURRENCY ? Number(process.env.WORKER_CONCURRENCY) : 5,
  },
};
