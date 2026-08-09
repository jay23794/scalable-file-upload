import 'dotenv/config';

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 5000,
  milvus: {
    uri: process.env.ZILLIZ_URI ?? '',
    token: process.env.ZILLIZ_TOKEN ?? '',
    collection: process.env.MILVUS_COLLECTION ?? 'document_chunks',
  },
  embedding: {
    model: process.env.EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    dim: process.env.EMBEDDING_DIM ? Number(process.env.EMBEDDING_DIM) : 384,
  },
};
