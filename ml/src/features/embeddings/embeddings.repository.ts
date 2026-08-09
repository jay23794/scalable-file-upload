import { RowData } from '@zilliz/milvus2-sdk-node';
import { env } from '../../config/env';
import { getMilvusClient } from '../../infra/milvus';

export interface ChunkRow {
  pk: string;
  upload_id: string;
  chunk_index: number;
  text: string;
  embedding: number[];
  created_at: number;
}

export async function upsertChunks(rows: ChunkRow[]): Promise<void> {
  if (rows.length === 0) return;
  const client = getMilvusClient();
  await client.upsert({
    collection_name: env.milvus.collection,
    data: rows as unknown as RowData[],
  });
}
