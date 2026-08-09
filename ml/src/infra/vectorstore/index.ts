import { env } from '../../config/env';
import { milvusStore } from './milvus';
import { supabaseStore } from './supabase';
import { VectorStore } from './types';

let storeInstance: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!storeInstance) {
    switch (env.vectorStore.driver) {
      case 'milvus':
        storeInstance = milvusStore;
        break;
      case 'supabase':
        storeInstance = supabaseStore;
        break;
      default:
        throw new Error(
          `unknown VECTOR_STORE driver: '${env.vectorStore.driver}' (expected 'milvus' or 'supabase')`
        );
    }
  }
  return storeInstance;
}

export type { ChunkRow, VectorStore } from './types';
