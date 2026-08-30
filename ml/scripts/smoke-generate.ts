// Stage 4 verification without live infrastructure.
//
// Exercises the full generation pipeline — embed → search → context → llm —
// against stubs, so it needs no Supabase project, no Gemini key, and no ONNX
// model load. This is what the dependency injection in fd3b4d2 bought.
//
// usage: ./node_modules/.bin/ts-node --transpile-only scripts/smoke-generate.ts
//
// For the live path instead, run the ml service with LLM_API_KEY set, enqueue a
// query via the backend's POST /api/v1/real-time-query-process/queries, then:
//   redis-cli XRANGE gen:{queryId} - +     → progress · token… · done
//   redis-cli TTL    gen:{queryId}         → ≈ 3600

import { Embedder } from '../src/infra/embedder';
import { LlmChunk, LlmProvider } from '../src/infra/llm';
import { VectorStore } from '../src/infra/vectorstore';
import { GenerationRepository } from '../src/features/generation/generation.repository';
import { GenerationService, buildContext } from '../src/features/generation/generation.service';
import { StreamEvent } from '../src/features/generation/types';

const fakeStore: VectorStore = {
  name: 'supabase',
  init: async () => {},
  upsert: async () => {},
  count: async () => 0,
  sample: async () => [],
  search: async ({ topK }) =>
    Array.from({ length: Math.min(topK, 2) }, (_, i) => ({
      pk: `upload-a:${i}`,
      upload_id: 'upload-a',
      chunk_index: i,
      text: `Chunk ${i}: the invoice total was $1,240.00 and it was issued on 12 March.`,
      score: 0.9 - i * 0.05,
    })),
};

const fakeEmbedder: Embedder = {
  encode: async (texts: string[]) => texts.map(() => Array(384).fill(0.1)),
};

const fakeLlm: LlmProvider = {
  name: 'fake',
  async *stream(): AsyncIterable<LlmChunk> {
    yield { text: 'The invoice total' };
    yield { text: ' was $1,240.00 [source 1].' };
    yield { text: '', finishReason: 'stop', outputTokens: 11 };
  },
};

// A provider that hits the token cap — the case that must surface as
// finishReason 'length' rather than being reported as a clean answer.
const truncatingLlm: LlmProvider = {
  name: 'fake-truncating',
  async *stream(): AsyncIterable<LlmChunk> {
    yield { text: 'The invoice total was' };
    yield { text: '', finishReason: 'length', outputTokens: 2048 };
  },
};

function assert(cond: boolean, label: string): void {
  if (!cond) throw new Error(`FAILED: ${label}`);
  console.log(`  ok — ${label}`);
}

async function main() {
  const repo = new GenerationRepository(fakeStore);
  const svc = new GenerationService(fakeEmbedder, repo, fakeLlm);

  const events: StreamEvent[] = [];
  const onEvent = async (e: StreamEvent) => {
    events.push(e);
  };

  console.log('\n1. happy path');
  const result = await svc.run(
    {
      queryId: 'query-1',
      query: 'What was the invoice total?',
      model: 'gemini',
      connectors: ['upload-a'],
      topK: 5,
    },
    onEvent,
  );

  const steps = events.filter((e) => e.type === 'progress').map((e) => e.step);
  const tokens = events.filter((e) => e.type === 'token');

  assert(
    JSON.stringify(steps) === JSON.stringify(['embed', 'search', 'context', 'llm']),
    `progress order: ${steps.join(' → ')}`,
  );
  assert(tokens.length === 2, `2 token events, indices ${tokens.map((t) => t.index).join(',')}`);
  assert(
    tokens.every((t, i) => t.index === i),
    'token indices are contiguous from 0',
  );
  assert(
    result.text === 'The invoice total was $1,240.00 [source 1].',
    `assembled text: "${result.text}"`,
  );
  assert(result.sources.length === 2, `${result.sources.length} sources returned`);
  assert(result.totalTokens === 11, `totalTokens from provider usage: ${result.totalTokens}`);
  assert(result.finishReason === 'stop', `finishReason: ${result.finishReason}`);

  console.log('\n2. context is built with [source N] markers');
  const hits = await fakeStore.search({ embedding: [], uploadIds: [], topK: 5 });
  const { block, sources } = buildContext(hits);
  assert(block.includes('[source 1]') && block.includes('[source 2]'), 'markers present');
  assert(
    sources.length === hits.length,
    'every cited block has a matching SourceRef',
  );

  console.log('\n3. oversized chunks are dropped, and so are their citations');
  const huge = Array.from({ length: 5 }, (_, i) => ({
    pk: `u:${i}`,
    upload_id: 'u',
    chunk_index: i,
    text: 'x'.repeat(5_000),
    score: 0.9 - i * 0.01,
  }));
  const capped = buildContext(huge);
  assert(capped.block.length <= 12_000, `context capped at ${capped.block.length} chars`);
  assert(
    capped.sources.length === capped.block.split('[source ').length - 1,
    `${capped.sources.length} sources for ${capped.block.split('[source ').length - 1} blocks`,
  );

  console.log('\n4. truncation surfaces as finishReason "length"');
  const truncated = await new GenerationService(fakeEmbedder, repo, truncatingLlm).run(
    { queryId: 'query-2', query: 'q', model: 'gemini', connectors: [], topK: 5 },
    async () => {},
  );
  assert(truncated.finishReason === 'length', `finishReason: ${truncated.finishReason}`);

  console.log('\n5. no retrieval hits still produces a grounded refusal prompt');
  const emptyStore: VectorStore = { ...fakeStore, search: async () => [] };
  const emptyResult = await new GenerationService(
    fakeEmbedder,
    new GenerationRepository(emptyStore),
    fakeLlm,
  ).run({ queryId: 'query-3', query: 'q', model: 'gemini', connectors: [], topK: 5 }, async () => {});
  assert(emptyResult.sources.length === 0, 'no sources claimed when nothing was retrieved');
  assert(emptyResult.text.length > 0, 'the model still answers');

  console.log('\nall checks passed\n');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n', err.message ?? err, '\n');
    process.exit(1);
  });
