import { env } from '../config/env';
import { MlServiceResult, TextChunk } from './types';

export async function callMlService(chunks: TextChunk[]): Promise<MlServiceResult> {
  void env.mlServiceUrl;

  const embeddings = chunks.map(() => Array.from({ length: 8 }, () => Math.random()));
  return {
    embeddings,
    model: 'stub-embedding-model',
  };
}
