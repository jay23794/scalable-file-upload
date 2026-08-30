// End-to-end retrieval check: embed a question with the same model used at
// ingestion, then search the configured vector store.
//
// usage: smoke-search.ts "<question>" [uploadId ...]
//   with no uploadIds  → searches everything (filter disabled)
//   with uploadIds     → the narrow-filter case, which is the one most likely
//                        to under-return if HNSW iterative scan is not enabled

import { encode } from '../src/infra/embedder';
import { vectorStore } from '../src/infra/vectorstore';

const TOP_K = Number(process.env.QUERY_TOPK_DEFAULT ?? 5);

async function main() {
  const question = process.argv[2];
  const uploadIds = process.argv.slice(3);
  if (!question) {
    console.error('usage: smoke-search.ts "<question>" [uploadId ...]');
    process.exit(1);
  }

  await vectorStore.init();
  console.log(`store: ${vectorStore.name}`);
  console.log(`total chunks: ${await vectorStore.count()}`);
  console.log(
    `filter: ${uploadIds.length ? uploadIds.join(', ') : '(none — searching everything)'}`
  );

  const t0 = Date.now();
  const [embedding] = await encode([question]);
  const tEmbed = Date.now() - t0;

  const t1 = Date.now();
  const hits = await vectorStore.search({ embedding, uploadIds, topK: TOP_K });
  const tSearch = Date.now() - t1;

  console.log(`\nembed: ${tEmbed}ms (includes model load) · search: ${tSearch}ms`);
  console.log(`asked for topK=${TOP_K}, got ${hits.length} hit(s)\n`);

  if (hits.length < TOP_K) {
    console.warn(
      `WARNING: fewer hits than topK. Either the filtered set is smaller than ` +
        `${TOP_K} chunks, or HNSW post-filtering dropped candidates — check that ` +
        `ml/sql/supabase_search.sql applied with the iterative_scan setting.\n`
    );
  }

  hits.forEach((h, i) => {
    const preview = h.text.replace(/\s+/g, ' ').slice(0, 140);
    console.log(`${i + 1}. score=${h.score.toFixed(4)}  ${h.upload_id}#${h.chunk_index}`);
    console.log(`   ${preview}${h.text.length > 140 ? '…' : ''}`);
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
