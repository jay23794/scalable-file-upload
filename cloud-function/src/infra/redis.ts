import IORedis from 'ioredis';
import { env } from '../config/env';

export const redisConnection = new IORedis(env.redis.url, {
  maxRetriesPerRequest: null,
});
