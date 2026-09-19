import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { env } from '../../config/env';
import { RealTimeQueryProcessRepository } from './repository/real-time-query-process.repository';
import { CreateQueryInput } from './real-time-query-process.schema';
import { GenerateJobData } from '../../infra/generateQueue';
import { ConversationRepository } from './repository/conversation.repository';
import { StartConversationInput } from './real-time-query-process.schema';
import {
  ConversationNotFoundError,
  ConversationRecord,
  DEFAULT_CONVERSATION_TITLE,
  GenerationResult,
  QueryRecord,
} from './types';

export interface SubmitQueryResult {
  queryId: string;
}

export class RealTimeQueryProcessService {
  constructor(
    private _repo: RealTimeQueryProcessRepository,
    private _conversations: ConversationRepository,
    private _generateQueue: Queue<GenerateJobData>,
  ) {}

  // Starts a fresh conversation. The id is minted here, before any I/O, so the
  // caller holds the value every turn will be filed under.
  async startConversation(input: StartConversationInput): Promise<ConversationRecord> {
    return this._conversations.create({
      id: randomUUID(),
      title: input.title ?? DEFAULT_CONVERSATION_TITLE,
    });
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return this._conversations.list();
  }

  async getConversation(id: string): Promise<ConversationRecord | undefined> {
    return this._conversations.findById(id);
  }

  // The transcript: every turn in the conversation, oldest first.
  async listConversationQueries(conversationId: string): Promise<QueryRecord[]> {
    return this._repo.listByConversation(conversationId);
  }

  async submitQuery(input: CreateQueryInput): Promise<SubmitQueryResult> {
    const queryId = randomUUID();

    // Check the conversation exists before writing anything. A turn filed under
    // an id that was never started is unreachable — the transcript fetch keys
    // on conversationId, so nothing would ever read it back.
    if (!(await this._conversations.exists(input.conversationId))) {
      throw new ConversationNotFoundError(input.conversationId);
    }

    // Resolve the default here, not in the worker, so the row records the topK
    // that was actually used. Otherwise changing QUERY_TOPK_DEFAULT silently
    // rewrites the history of every past query.
    const topK = input.topK ?? env.query.topKDefault;

    // Insert BEFORE enqueue — never in parallel. If the job were enqueued
    // first, a fast worker could finish before the Mongo row exists and the
    // 'completed' handler would have nothing to update.
    await this._repo.create({
      id: queryId,
      conversationId: input.conversationId,
      query: input.query,
      model: input.model,
      connectors: input.connectors,
      topK,
      status: 'generating',
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

  // Called only by the QueueEvents handlers (Path A) — the sole Mongo writer
  // for generation results. The SSE handler must never call these.
  async markComplete(id: string, result: GenerationResult): Promise<QueryRecord | undefined> {
    return this._repo.markComplete(id, result);
  }

  async markFailed(id: string, reason: string): Promise<QueryRecord | undefined> {
    return this._repo.markFailed(id, reason);
  }
}
