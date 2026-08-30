import 'dotenv/config';

const required = (key: string, value: string | undefined): string => {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 5000,
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    table: process.env.SUPABASE_TABLE ?? 'document_chunks',
  },
  embedding: {
    model: process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    dim: process.env.EMBEDDING_DIM ? Number(process.env.EMBEDDING_DIM) : 384,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  embedQueue: {
    name: process.env.EMBED_QUEUE_NAME ?? 'embed-queue',
    concurrency: process.env.EMBED_WORKER_CONCURRENCY
      ? Number(process.env.EMBED_WORKER_CONCURRENCY)
      : 2,
  },
  generateQueue: {
    name: process.env.GENERATE_QUEUE_NAME ?? 'generate-queue',
    concurrency: process.env.GENERATE_WORKER_CONCURRENCY
      ? Number(process.env.GENERATE_WORKER_CONCURRENCY)
      : 2,
  },
  genStream: {
    // Retention for gen:{queryId}. ttlSeconds must agree with the backend, which
    // reads the same stream; maxLen is a local write-side cap only.
    ttlSeconds: process.env.GEN_STREAM_TTL_SEC ? Number(process.env.GEN_STREAM_TTL_SEC) : 3600,
    maxLen: 5000,
  },
  query: {
    topKDefault: process.env.QUERY_TOPK_DEFAULT ? Number(process.env.QUERY_TOPK_DEFAULT) : 5,
  },
  llm: {
    provider: 'gemini' as const,
    // Deliberately NOT via required(). That helper throws at import time, and
    // config/env.ts is imported by the embed worker too — a machine with no
    // Gemini key must still be able to run ingestion. The provider validates
    // this lazily, on first use.
    apiKey: process.env.LLM_API_KEY ?? '',
    model: process.env.LLM_MODEL ?? 'gemini-2.0-flash',
    maxOutputTokens: process.env.LLM_MAX_OUTPUT_TOKENS
      ? Number(process.env.LLM_MAX_OUTPUT_TOKENS)
      : 2048,
    // Wall-clock ceiling on one generation. BullMQ v5 has no per-job timeout
    // option (it was a Bull v3 feature), so the worker enforces this itself with
    // an AbortController. Together with maxOutputTokens this is what keeps an
    // abandoned query cheap while the cancel endpoint stays deferred.
    jobTimeoutMs: process.env.LLM_JOB_TIMEOUT_MS ? Number(process.env.LLM_JOB_TIMEOUT_MS) : 120_000,
  },
  backendBaseUrl: process.env.BACKEND_BASE_URL ?? 'http://localhost:3000',
  internalServiceToken: required('INTERNAL_SERVICE_TOKEN', process.env.INTERNAL_SERVICE_TOKEN),
};
