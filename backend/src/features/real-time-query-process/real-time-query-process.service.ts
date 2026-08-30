import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { env } from '../../config/env';
import { RealTimeQueryProcessRepository } from './real-time-query-process.repository';
import { CreateQueryInput } from './real-time-query-process.schema';
import { GenerateJobData } from '../../infra/generateQueue';
import { GenerationResult, QueryRecord } from './types';

export interface SubmitQueryResult {
  queryId: string;
}

export class RealTimeQueryProcessService {
  constructor(
    private _repo: RealTimeQueryProcessRepository,
    private _generateQueue: Queue<GenerateJobData>,
  ) {}

  async submitQuery(input: CreateQueryInput): Promise<SubmitQueryResult> {
    const now = new Date();
    const queryId = randomUUID();
    // Resolve the default here, not in the worker, so the row records the topK
    // that was actually used. Otherwise changing QUERY_TOPK_DEFAULT silently
    // rewrites the history of every past query.
    const topK = input.topK ?? env.query.topKDefault;

    // Insert BEFORE enqueue — never in parallel. If the job were enqueued
    // first, a fast worker could finish before the Mongo row exists and the
    // 'completed' handler would have nothing to update.
    await this._repo.create({
      id: queryId,
      query: input.query,
      model: input.model,
      connectors: input.connectors,
      topK,
      status: 'generating',
      createdAt: now,
      updatedAt: now,
    });

    try {
      // jobId = queryId makes the enqueue idempotent and lets QueueEvents
      // resolve the query without a getJob() round trip.
      await this._generateQueue.add(
        'generate',
        { queryId, query: input.query, model: input.model, connectors: input.connectors, topK },
        { jobId: queryId },
      );
    } catch (err) {
      // Redis is down. Fail fast rather than leaving a row stuck in
      // 'generating' with no job behind it for the sweeper to find.
      await this._repo.markFailed(queryId, `enqueue failed: ${(err as Error).message}`);
      throw err;
    }

    return { queryId };
  }

  async getQuery(id: string): Promise<QueryRecord | undefined> {
    return this._repo.findById(id);
  }

  async listQueries(): Promise<QueryRecord[]> {
    return this._repo.list();
  }

  // Called only by the QueueEvents handlers (Path A) — the sole Mongo writer
  // for generation results. The SSE handler must never call these.
  async markComplete(id: string, result: GenerationResult): Promise<QueryRecord | undefined> {
    return this._repo.markComplete(id, result);
  }

  async markFailed(id: string, reason: string): Promise<QueryRecord | undefined> {
    return this._repo.markFailed(id, reason);
  }
}
