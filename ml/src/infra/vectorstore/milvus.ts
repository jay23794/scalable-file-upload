import { ConsistencyLevelEnum, DataType, MilvusClient, RowData } from '@zilliz/milvus2-sdk-node';
import { env } from '../../config/env';
import { ChunkRow, SearchHit, SearchInput, VectorStore, VectorStoreSample } from './types';

// Milvus filter expressions are strings, so upload IDs are interpolated. They
// originate in a user request, so reject anything that could break out of the
// quoted literal rather than trying to escape it — our IDs are UUIDs.
const ID_PATTERN = /^[A-Za-z0-9_:-]+$/;

function buildUploadIdFilter(uploadIds: string[]): string {
  if (uploadIds.length === 0) return '';
  for (const id of uploadIds) {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`milvus search: unsafe upload_id '${id}'`);
    }
  }
  return `upload_id in [${uploadIds.map((id) => `"${id}"`).join(', ')}]`;
}

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

  async search({ embedding, uploadIds, topK }: SearchInput): Promise<SearchHit[]> {
    const client = getClient();
    const res = await client.search({
      collection_name: env.milvus.collection,
      data: [embedding],
      limit: topK,
      filter: buildUploadIdFilter(uploadIds),
      output_fields: ['pk', 'upload_id', 'chunk_index', 'text'],
      metric_type: 'COSINE',
    });

    const code = res?.status?.error_code;
    if (code && code !== 'Success') {
      throw new Error(
        `milvus search failed: ${code} ${res.status.reason ?? ''} ` +
          `(collection=${env.milvus.collection}, topK=${topK})`
      );
    }

    // COSINE metric returns similarity directly, matching the SQL function's
    // 1 - (embedding <=> query) — no conversion needed.
    return (res?.results ?? []).map((r) => ({
      pk: String(r.pk),
      upload_id: String(r.upload_id),
      chunk_index: Number(r.chunk_index),
      text: String(r.text),
      score: Number(r.score),
    }));
  },
};
