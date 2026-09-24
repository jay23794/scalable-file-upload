import { Job, Worker } from 'bullmq';

import { env } from '../../config/env';
import { redisConnection } from '../../infra/queue';
import { ScrapeJobData } from '../../infra/scrapeQueue';
import { resolveProvider } from './providers';
import { JobSearchQuery, ProviderRunState, ScrapeProvider } from './providers/types';

/** Consumes `scrape-queue`: one job per run and site. These jobs do not
 *  compute -- they start work on Apify and wait for it, for minutes. */

let worker: Worker<ScrapeJobData> | undefined;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[scrape-worker] ${msg}`);

function queryFrom(data: ScrapeJobData): JobSearchQuery {
  return {
    searchTerms: data.searchTerms,
    location: data.location,
    isRemote: data.isRemote,
    resultsWanted: data.resultsWanted,
    hoursOld: data.hoursOld,
    jobType: data.jobType,
  };
}

/**
 * Poll until the run finishes, or OUR deadline expires.
 *
 * BullMQ v5 has no per-job timeout, so the loop carries its own. The deadline
 * sits above the actor's own timeout, so Apify gives up first and we get a
 * real error instead of abandoning a run we paid for.
 */
async function pollUntilDone(
  provider: ScrapeProvider,
  apifyRunId: string,
): Promise<ProviderRunState> {
  const deadline = Date.now() + env.findJob.pollDeadlineMs;

  while (Date.now() < deadline) {
    const state = await provider.check(apifyRunId);
    if (state.state !== 'running') return state;
    log(`  still running, checking again in ${env.findJob.pollIntervalMs}ms`);
    await sleep(env.findJob.pollIntervalMs);
  }

  throw new Error(`Poll deadline exceeded for ${apifyRunId}`);
}

async function handleScrapeJob(job: Job<ScrapeJobData>): Promise<void> {
  const { runId, site } = job.data;
  log(`job ${job.id} run=${runId} site=${site}`);

  // Turns the site string off the queue into the code that scrapes it.
  const provider = resolveProvider(site);

  // 1. START -- returns as soon as Apify accepts it. The billable call.
  const handle = await provider.start(site, queryFrom(job.data));
  log(`  started Apify run ${handle.apifyRunId} (dataset ${handle.datasetId})`);

  // 2. POLL -- for minutes.
  const state = await pollUntilDone(provider, handle.apifyRunId);
  if (state.state === 'failed') {
    throw new Error(`Apify run failed: ${state.error?.code} ${state.error?.message}`);
  }

  // 3. COLLECT
  const batch = await provider.collect(site, handle);
  log(`  collected ${batch.rows.length} rows (cost=${state.costUsd ?? 'n/a'})`);

  // TODO next step: hand these to the service to store in Mongo.
  console.dir(batch.rows.slice(0, 2), { depth: 4 });
}

export function startScrapeWorker(): Worker<ScrapeJobData> {
  if (worker) return worker;

  worker = new Worker<ScrapeJobData>(env.findJob.queueName, handleScrapeJob, {
    connection: redisConnection,
    concurrency: env.findJob.workerConcurrency,
    // Started only after Mongo connects.
    autorun: false,
  });

  worker.on('completed', (job) => log(`completed ${job.id}`));
  worker.on('failed', (job, err) => console.error(`[scrape-worker] failed ${job?.id}: ${err.message}`));

  void worker.run().catch((err) => console.error('[scrape-worker] stopped unexpectedly:', err));

  log(`listening on "${env.findJob.queueName}" concurrency=${env.findJob.workerConcurrency}`);
  return worker;
}

/** `close()` lets running jobs finish rather than abandoning an Apify run. */
export async function stopScrapeWorker(): Promise<void> {
  if (!worker) return;
  log('draining...');
  await worker.close();
  worker = undefined;
  log('stopped');
}
