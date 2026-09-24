import { Job, Worker } from 'bullmq';

import { env } from '../../config/env';
import { redisConnection } from '../../infra/queue';
import { ScrapeJobData } from '../../infra/scrapeQueue';

/**
 * Consumes `scrape-queue`: one job per run and site.
 *
 * Unlike every other queue in this project, these jobs do not compute -- they
 * start work on Apify and WAIT for it, for minutes. That shapes the settings
 * below, and it is why concurrency here is about waiting rather than CPU.
 */

let worker: Worker<ScrapeJobData> | undefined;

/**
 * STEP 1: prove the queue -> worker link.
 *
 * Reads the job and logs it. Nothing else yet -- no Apify call, no Mongo
 * write, so the run document is left untouched and no money can be spent.
 * Steps 2-5 fill this in: resume check, start, poll, collect, ingest.
 */
async function handleScrapeJob(job: Job<ScrapeJobData>): Promise<void> {
  const { runId, site, searchTerms, resultsWanted } = job.data;

  console.log(
    `[scrape-worker] picked up job ${job.id} ` +
      `(attempt ${job.attemptsMade + 1}/${job.opts.attempts ?? 1})`,
  );
  console.log(
    `[scrape-worker]   run=${runId} site=${site} ` +
      `terms=${JSON.stringify(searchTerms)} cap=${resultsWanted}`,
  );
}

export function startScrapeWorker(): Worker<ScrapeJobData> {
  if (worker) return worker;

  worker = new Worker<ScrapeJobData>(env.findJob.queueName, handleScrapeJob, {
    connection: redisConnection,
    concurrency: env.findJob.workerConcurrency,
    autorun: false,
  });

  worker.on('completed', (job) => {
    console.log(`[scrape-worker] completed ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[scrape-worker] failed ${job?.id}: ${err.message}`);
  });

  // `run()` resolves only when the worker closes, so it is deliberately not
  // awaited here.
  void worker.run().catch((err) => {
    console.error('[scrape-worker] stopped unexpectedly:', err);
  });

  console.log(
    `[scrape-worker] listening on "${env.findJob.queueName}" ` +
      `concurrency=${env.findJob.workerConcurrency}`,
  );
  return worker;
}

/**
 * Drain and stop.
 *
 * `close()` lets jobs that are already running finish. Killing a polling job
 * without draining would leave an Apify run nobody ever collects -- work we
 * paid for and then abandoned.
 */
export async function stopScrapeWorker(): Promise<void> {
  if (!worker) return;
  console.log('[scrape-worker] draining...');
  await worker.close();
  worker = undefined;
  console.log('[scrape-worker] stopped');
}
