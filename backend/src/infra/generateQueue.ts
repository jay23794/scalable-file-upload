import { Queue } from 'bullmq';
import { redisConnection } from './queue';
import { env } from '../config/env';

export interface GenerateJobData {
  queryId: string; // also the Mongo _id, the BullMQ jobId, and the gen:{...} stream suffix
  query: string;
  model: string;
  connectors: string[];
  topK: number;
}

export const generateQueue = new Queue<GenerateJobData>(env.generateQueue.name, {
  connection: redisConnection,
  // Deliberately different from ocrQueue / embedQueue on two counts:
  //
  // 1. attempts is low. A half-streamed answer is not cleanly resumable — if
  //    the LLM dies at token 300 and BullMQ retries, the worker restarts at
  //    token 1 and XADDs into the same stream, so an attached viewer sees the
  //    answer start over. The worker resets the stream on retry to cope, but
  //    that is damage control, not a reason to retry often.
  //
  // 2. Retention is time-based, not count-based. embedQueue uses
  //    removeOnComplete: 1000; copying that here is a trap. The return value of
  //    this job IS the generated answer — if the backend is down when a job
  //    completes and 1000 further jobs finish before it comes back, the answer
  //    is pruned and gone. Age-based retention outlives any realistic outage.
  defaultJobOptions: {
    attempts: 2,
    removeOnComplete: { age: 24 * 3600, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});
