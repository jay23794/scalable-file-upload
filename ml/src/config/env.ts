import 'dotenv/config';

type VectorStoreDriver = 'milvus' | 'supabase';

const driver = (process.env.VECTOR_STORE ?? 'milvus') as VectorStoreDriver;

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
};
