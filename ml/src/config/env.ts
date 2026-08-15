import 'dotenv/config';

type VectorStoreDriver = 'milvus' | 'supabase';

const driver = (process.env.VECTOR_STORE ?? 'milvus') as VectorStoreDriver;

const required = (key: string, value: string | undefined): string => {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 5000,
  vectorStore: {
    driver,
  },
  milvus: {
    uri: process.env.ZILLIZ_URI ?? '',
    token: process.env.ZILLIZ_TOKEN ?? '',
    collection: process.env.MILVUS_COLLECTION ?? 'document_chunks',
  },
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
  backendBaseUrl: process.env.BACKEND_BASE_URL ?? 'http://localhost:3000',
  internalServiceToken: required('INTERNAL_SERVICE_TOKEN', process.env.INTERNAL_SERVICE_TOKEN),
};
