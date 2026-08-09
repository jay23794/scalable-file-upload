import { env } from '../config/env';

type FeatureExtractor = (
  texts: string | string[],
  options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      const pipe = await pipeline('feature-extraction', env.embedding.model);
      return pipe as unknown as FeatureExtractor;
    })();
  }
  return extractorPromise;
}

export async function warmup(): Promise<void> {
  await getExtractor();
}

export async function encode(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });

  const dim = env.embedding.dim;
  const flat = output.data;
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    vectors.push(Array.from(flat.subarray(i * dim, (i + 1) * dim)));
  }
  return vectors;
}
