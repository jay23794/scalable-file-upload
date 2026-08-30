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
    downloadTtlSeconds: 60 * 60,
    chunksDownloadTtlSeconds: process.env.CHUNKS_DOWNLOAD_TTL_SECONDS
      ? Number(process.env.CHUNKS_DOWNLOAD_TTL_SECONDS)
      : 30 * 60,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  ocrQueue: {
    name: process.env.OCR_QUEUE_NAME ?? 'ocr-queue',
  },
  embedQueue: {
    name: process.env.EMBED_QUEUE_NAME ?? 'embed-queue',
  },
  generateQueue: {
    name: process.env.GENERATE_QUEUE_NAME ?? 'generate-queue',
  },
  genStream: {
    // Redis Stream retention for gen:{queryId}. Must agree with the ml service.
    ttlSeconds: process.env.GEN_STREAM_TTL_SEC ? Number(process.env.GEN_STREAM_TTL_SEC) : 3600,
  },
  query: {
    topKDefault: process.env.QUERY_TOPK_DEFAULT ? Number(process.env.QUERY_TOPK_DEFAULT) : 5,
  },
  mongo: {
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/feature',
  },
  internalServiceToken: required('INTERNAL_SERVICE_TOKEN', process.env.INTERNAL_SERVICE_TOKEN),
};
