import { DataType, MilvusClient } from '@zilliz/milvus2-sdk-node';
import { env } from '../config/env';

let clientInstance: MilvusClient | null = null;

export function getMilvusClient(): MilvusClient {
  if (!clientInstance) {
    if (!env.milvus.uri || !env.milvus.token) {
      throw new Error('ZILLIZ_URI and ZILLIZ_TOKEN must be set');
    }
    clientInstance = new MilvusClient({
      address: env.milvus.uri,
      token: env.milvus.token,
    });
  }
  return clientInstance;
}

export async function ensureCollection(): Promise<void> {
  const client = getMilvusClient();
  const name = env.milvus.collection;

  const has = await client.hasCollection({ collection_name: name });
  if (has.value) {
    await client.loadCollection({ collection_name: name });
    return;
  }

  await client.createCollection({
    collection_name: name,
    fields: [
      { name: 'pk',          data_type: DataType.VarChar,     is_primary_key: true, max_length: 128 },
      { name: 'upload_id',   data_type: DataType.VarChar,     max_length: 64 },
      { name: 'chunk_index', data_type: DataType.Int64 },
      { name: 'text',        data_type: DataType.VarChar,     max_length: 8192 },
      { name: 'embedding',   data_type: DataType.FloatVector, dim: env.embedding.dim },
      { name: 'created_at',  data_type: DataType.Int64 },
    ],
  });

  await client.createIndex({
    collection_name: name,
    field_name: 'embedding',
    index_name: 'embedding_idx',
    index_type: 'AUTOINDEX',
    metric_type: 'COSINE',
  });

  await client.loadCollection({ collection_name: name });
}
