import { TextChunk } from './types';

const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_OVERLAP = 50;

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): TextChunk[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: TextChunk[] = [];

  let index = 0;
  let cursor = 0;
  while (cursor < words.length) {
    const slice = words.slice(cursor, cursor + chunkSize);
    chunks.push({
      index,
      content: slice.join(' '),
      tokens: slice.length,
    });
    index += 1;
    cursor += chunkSize - overlap;
  }

  return chunks;
}
