import { env } from '../config/env';
import { MlServiceResult, TextChunk } from './types';

interface EmbedResponse {
  uploadId: string;
  chunkCount: number;
  dim: number;
  model: string;
}

export async function callMlService(
  uploadId: string,
  chunks: TextChunk[],
): Promise<MlServiceResult> {
  const url = `${env.mlServiceUrl}/embed`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId,
      chunks: chunks.map((c) => ({ index: c.index, text: c.content })),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ml /embed failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as EmbedResponse;
  return {
    chunkCount: data.chunkCount,
    dim: data.dim,
    model: data.model,
  };
}
