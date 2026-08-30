import { Worker } from 'bullmq';
import { env } from '../../config/env';
import { redisConnection } from '../../infra/redis';
import { generationService } from '../../infra/container';
import { publish, resetStream } from './generation.stream';
import { GenerateJobData, GenerationResult } from './types';

export type { GenerateJobData, GenerationResult };

/**
 * Runs one job and mirrors it onto the Redis Stream.
 *
 * The two outputs are deliberately different in kind: the stream is a firehose
 * of disposable fragments under a TTL, while the *return value* is the finished
 * answer. Path A (the backend's QueueEvents handler) persists the return value,
 * so this function must return it even when nobody is watching the stream.
 */
export async function runGenerateJob(
  data: GenerateJobData,
  attemptsMade: number,
): Promise<GenerationResult> {
  if (attemptsMade > 0) {
    // A retry replays the whole answer. Clear the backlog and tell any attached
    // viewer to drop what it has buffered.
    await resetStream(data.queryId);
    await publish(data.queryId, { type: 'restart' });
  }

  // BullMQ v5 has no per-job timeout option, so the ceiling is enforced here and
  // pushed down into the provider's HTTP request via the abort signal. An
  // abandoned query runs to completion by design — a closed SSE connection is
  // not a cancel signal — so this and maxOutputTokens are what bound the spend.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.llm.jobTimeoutMs);

  try {
    const result = await generationService.run(
      data,
      (event) => publish(data.queryId, event),
      controller.signal,
    );

    await publish(data.queryId, {
      type: 'done',
      totalTokens: result.totalTokens,
      sources: result.sources,
    });

    return result;
  } catch (err) {
    const message = controller.signal.aborted
      ? `generation timed out after ${env.llm.jobTimeoutMs}ms`
      : (err as Error).message;

    // Publish before rethrowing: once BullMQ marks the job failed the worker is
    // done with it, and a viewer attached to the stream would otherwise hang on
    // a stream that never terminates.
    await publish(data.queryId, { type: 'error', message });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Worker wiring
//
// Same shape as embeddings.worker.ts — the feature owns its background work and
// index.ts only decides when to start it.
//
// Note there is no UnrecoverableError branch here, unlike the embed worker.
// generate-queue runs attempts: 2, and the failure modes are transient by
// nature (LLM rate limits, vector-store blips); short-circuiting the single
// remaining attempt would buy nothing.
// ---------------------------------------------------------------------------

export const generateWorker = new Worker<GenerateJobData, GenerationResult>(
  env.generateQueue.name,
  async (job) => runGenerateJob(job.data, job.attemptsMade),
  {
    connection: redisConnection,
    concurrency: env.generateQueue.concurrency,
    // Started explicitly by startGenerateWorker() once the model and vector
    // store are ready — never on import.
    autorun: false,
  },
);

generateWorker.on('completed', (job) => {
  console.log(`[ml] generate job ${job.id} completed`);
});

generateWorker.on('failed', (job, err) => {
  console.error(`[ml] generate job ${job?.id} failed:`, err.message);
});

generateWorker.on('error', (err) => {
  console.error('[ml] generate worker error:', err);
});

export function startGenerateWorker(): void {
  generateWorker.run();
  console.log(
    `[ml] generate worker listening on "${env.generateQueue.name}" with concurrency ${env.generateQueue.concurrency} (model: ${env.llm.model})`,
  );
}

export async function stopGenerateWorker(): Promise<void> {
  await generateWorker.close();
}
