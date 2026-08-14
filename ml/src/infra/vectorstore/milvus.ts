import { ConsistencyLevelEnum, DataType, MilvusClient, RowData } from '@zilliz/milvus2-sdk-node';
import { env } from '../../config/env';
import { ChunkRow, VectorStore, VectorStoreSample } from './types';

let clientInstance: MilvusClient | null = null;

function getClient(): MilvusClient {
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

export const milvusStore: VectorStore = {
  name: 'milvus',

  async init(): Promise<void> {
    const client = getClient();
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
  },

  async upsert(rows: ChunkRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = getClient();
    const res = await client.upsert({
      collection_name: env.milvus.collection,
      data: rows as unknown as RowData[],
    });
    const code = res?.status?.error_code;
    if (code && code !== 'Success') {
      throw new Error(
        `milvus upsert failed: ${code} ${res.status.reason ?? ''} ` +
          `(collection=${env.milvus.collection}, rows=${rows.length})`
      );
    }
    const affected = Number(res?.upsert_cnt ?? 0);
    console.log(
      `[milvus] upsert ok collection=${env.milvus.collection} rows=${rows.length} affected=${affected}`
    );
  },

  async count(uploadId?: string): Promise<number> {
    const client = getClient();
    const res = await client.query({
      collection_name: env.milvus.collection,
      filter: uploadId ? `upload_id == "${uploadId}"` : '',
      output_fields: ['count(*)'],
      consistency_level: ConsistencyLevelEnum.Strong,
    });
    const row = res?.data?.[0] as Record<string, unknown> | undefined;
    return Number(row?.['count(*)'] ?? 0);
  },

  async sample(limit: number): Promise<VectorStoreSample[]> {
    const client = getClient();
    const res = await client.query({
      collection_name: env.milvus.collection,
      filter: 'pk != ""',
      output_fields: ['pk', 'upload_id', 'chunk_index'],
      limit,
      consistency_level: ConsistencyLevelEnum.Strong,
    });
    return (res?.data ?? []).map((r) => ({
      pk: String(r.pk),
      upload_id: String(r.upload_id),
      chunk_index: Number(r.chunk_index),
    }));
  },
};
