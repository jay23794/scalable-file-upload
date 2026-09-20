import { Queue } from 'bullmq';

import { env } from '../config/env';
import { redisConnection } from './queue';

/** One job per run and site. Each site is a different actor, and a retry must
 *  not re-pay for sites that already worked. */
export interface ScrapeJobData {
  runId: string;
  site: string;
  searchTerms: string[];
  location?: string;
  isRemote?: boolean;
  resultsWanted: number;
  hoursOld?: number;
  jobType?: string;
}

/**
 * `${runId}~${site}` -- stops the same site being queued twice for one run, the
 * same way `jobId = uploadId` does in file-upload-ocr.
 *
 * NOT `:` as first planned: BullMQ v5 rejects a custom job id containing a
 * colon, because that is its own Redis key separator. `~` appears in neither a
 * uuid nor a site name (config validates those against
 * /^[a-z0-9][a-z0-9_-]*$/), so the two halves stay unambiguous.
 */
export const scrapeJobId = (runId: string, site: string): string => `${runId}~${site}`;

export const scrapeQueue = new Queue<ScrapeJobData>(env.findJob.queueName, {
  connection: redisConnection,
  defaultJobOptions: {
    // A retry resumes the existing Apify run rather than starting a second
    // one, so these attempts cost nothing extra.
    attempts: 3,
    // Nothing to wait out here -- no board is blocking us; this is for Apify
    // API hiccups.
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 86_400 },
    // A week is long enough to work out why an actor went bad.
    removeOnFail: { age: 7 * 86_400 },
  },
});
