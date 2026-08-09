import { encode } from '../src/infra/embedder';

async function main() {
  const t0 = Date.now();
  const vectors = await encode(['the quick brown fox', 'jumps over the lazy dog']);
  const ms = Date.now() - t0;

  console.log(`vectors: ${vectors.length}`);
  console.log(`dim: ${vectors[0].length}`);
  console.log(`first 5 values [0]: ${vectors[0].slice(0, 5).map((n) => n.toFixed(4)).join(', ')}`);
  console.log(`first 5 values [1]: ${vectors[1].slice(0, 5).map((n) => n.toFixed(4)).join(', ')}`);
  console.log(`elapsed: ${ms}ms (includes model load + download on first run)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
