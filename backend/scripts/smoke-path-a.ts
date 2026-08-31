// Path A regression test: does Mongo reach 'complete' with NO browser involved?
// That is the requirement the whole two-path design exists to satisfy.
//
// A fake worker stands in for the ml service, so this needs neither Supabase nor
// a Gemini key — Path A only ever sees the BullMQ return value. It does need a
// live Mongo and Redis.
//
// usage: ./node_modules/.bin/ts-node --transpile-only scripts/smoke-path-a.ts
//
// Mirrors the ml/scripts/smoke-*.ts convention: one-shot, outside the tsconfig
// include so `npm run build` ignores it, run with ts-node (never ts-node-dev,
// which is a watcher and never exits).
import { Worker } from 'bullmq';
import { connectMongo, disconnectMongo } from '../src/infra/mongo';
import { redisConnection } from '../src/infra/queue';
import { generateQueue } from '../src/infra/generateQueue';
import { env } from '../src/config/env';
import { startQueueEvents } from '../src/infra/queueEvents';
import { realTimeQueryProcessService } from '../src/infra/container';
import { QueryModelDoc } from '../src/features/real-time-query-process/real-time-query-process.model';

const GOOD = {
  text: 'The invoice total was $1,240.00 [source 1].',
  sources: [{ uploadId: 'upload-a', chunkIndex: 0, score: 0.91 }],
  totalTokens: 11,
  finishReason: 'stop',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(id: string, want: string, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const doc = await QueryModelDoc.findById(id);
    if (doc && doc.status === want) return doc;
    await sleep(150);
  }
  return QueryModelDoc.findById(id);
}

async function submit(query: string) {
  const { queryId } = await realTimeQueryProcessService.submitQuery({
    query, model: 'gemini', connectors: ['upload-a'], topK: 5,
  } as never);
  const row = await QueryModelDoc.findById(queryId);
  console.log(`  submitted ${queryId} → status=${row?.status}`);
  return queryId;
}

async function main() {
  await connectMongo();
  startQueueEvents();

  // Stands in for the ml generate worker. Returns whatever the test needs.
  let payload: unknown = GOOD;
  const fake = new Worker(env.generateQueue.name, async () => payload, {
    connection: redisConnection, concurrency: 1,
  });

  console.log('\n1. happy path — worker returns a valid GenerationResult');
  const id1 = await submit('What was the invoice total?');
  const doc1 = await waitForStatus(id1, 'complete');
  console.log(`  status=${doc1?.status}`);
  console.log(`  text="${doc1?.text}"`);
  console.log(`  sources=${JSON.stringify(doc1?.sources)}`);
  console.log(`  totalTokens=${doc1?.totalTokens} finishReason=${doc1?.finishReason}`);

  console.log('\n2. worker returns a malformed result — must NOT read as complete');
  payload = { text: 'oops', sources: [{ uploadId: 'u' }], totalTokens: 'x' };
  const id2 = await submit('malformed case');
  const doc2 = await waitForStatus(id2, 'failed');
  console.log(`  status=${doc2?.status}`);
  console.log(`  failedReason="${doc2?.failedReason}"`);

  console.log('\n3. worker throws — job fails after its attempts');
  payload = GOOD;
  await fake.close();
  const thrower = new Worker(env.generateQueue.name, async () => {
    throw new Error('LLM provider exploded');
  }, { connection: redisConnection, concurrency: 1 });
  const id3 = await submit('failing case');
  const doc3 = await waitForStatus(id3, 'failed', 20000);
  console.log(`  status=${doc3?.status}`);
  console.log(`  failedReason="${doc3?.failedReason}"`);
  await thrower.close();

  for (const id of [id1, id2, id3]) {
    await QueryModelDoc.findByIdAndDelete(id);
    await (await generateQueue.getJob(id))?.remove().catch(() => {});
    await redisConnection.del(`gen:${id}`);
  }

  await generateQueue.close();
  await disconnectMongo();
  await redisConnection.quit();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
