import { mintChunksUploadUrl, mintChunksDownloadUrl } from '../infra/backendClient';
import { TextChunk } from './types';

export interface StagedChunks {
  chunksPath: string;
  chunksSignedUrl: string;
}

interface ChunksPayload {
  uploadId: string;
  chunks: Array<{ index: number; text: string; tokens: number }>;
}

export async function stageChunks(
  uploadId: string,
  chunks: TextChunk[],
): Promise<StagedChunks> {
  const chunksPath = `chunks/${uploadId}.json`;

  const upload = await mintChunksUploadUrl(chunksPath);

  const payload: ChunksPayload = {
    uploadId,
    chunks: chunks.map((c) => ({ index: c.index, text: c.content, tokens: c.tokens })),
  };

  const putRes = await fetch(upload.url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '');
    throw new Error(`stageChunks PUT failed: ${putRes.status} ${body}`);
  }

  const download = await mintChunksDownloadUrl(chunksPath);

  return { chunksPath, chunksSignedUrl: download.url };
}
