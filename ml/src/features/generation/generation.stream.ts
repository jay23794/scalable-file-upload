import { env } from '../../config/env';
import { redisConnection } from '../../infra/redis';
import { StreamEvent } from './types';

// The only writer to gen:{queryId}. The backend's SSE handler is the only
// reader, and it is strictly read-only — no Mongo write ever happens on the
// stream path, which is why a user closing a tab cannot strand a query.

export const streamKey = (queryId: string): string => `gen:${queryId}`;

/**
 * Clears a stream before a retry re-runs the job. Without this an attached
 * viewer sees 300 tokens and then the answer starting over from token 1.
 */
export async function resetStream(queryId: string): Promise<void> {
  await redisConnection.del(streamKey(queryId));
}

/**
 * Appends one event and re-arms the TTL.
 *
 * MAXLEN ~ is approximate on purpose: exact trimming makes Redis walk the
 * stream on every XADD, and this runs once per token fragment.
 *
 * EXPIRE rides along in the same pipeline rather than being set once at stream
 * creation, so the TTL slides forward while generation is in flight — a long
 * answer must not have its own backlog expire underneath it.
 */
export async function publish(queryId: string, event: StreamEvent): Promise<void> {
  const key = streamKey(queryId);
  await redisConnection
    .multi()
    .xadd(key, 'MAXLEN', '~', String(env.genStream.maxLen), '*', 'data', JSON.stringify(event))
    .expire(key, env.genStream.ttlSeconds)
    .exec();
}
