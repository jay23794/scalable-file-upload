import { getVectorStore } from '../../infra/vectorstore';
import { ChunkRow } from '../../infra/vectorstore/types';

export type { ChunkRow };

export async function upsertChunks(rows: ChunkRow[]): Promise<void> {
  if (rows.length === 0) return;
  await getVectorStore().upsert(rows);
}
