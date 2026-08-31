import { Queue, QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { ocrQueue, redisConnection } from './queue';
import { embedQueue } from './embedQueue';
import { getIo } from './io';
import { fileUploadOcrService, realTimeQueryProcessService } from './container';
import { PipelineSummary } from '../features/file-upload-ocr/types';
import { FinishReason, GenerationResult, SourceRef } from '../features/real-time-query-process/types';

let ocrQueueEvents: QueueEvents | undefined;
let embedQueueEvents: QueueEvents | undefined;
let generateQueueEvents: QueueEvents | undefined;

async function resolveUploadId(queue: Queue, jobId: string): Promise<string | undefined> {
  const job = await queue.getJob(jobId);
  return job?.data.uploadId;
}

export function parsePipelineSummary(raw: unknown): PipelineSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.chunkCount !== 'number' ||
    typeof r.model !== 'string' ||
    typeof r.dim !== 'number' ||
    (typeof r.storedAt !== 'string' && !(r.storedAt instanceof Date))
  ) {
    return undefined;
  }
  return {
    chunkCount: r.chunkCount,
    model: r.model,
    dim: r.dim,
    storedAt: r.storedAt instanceof Date ? r.storedAt : new Date(r.storedAt),
  };
}

const FINISH_REASONS: FinishReason[] = ['stop', 'length', 'cancelled'];

function parseSources(raw: unknown): SourceRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sources: SourceRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return undefined;
    const s = item as Record<string, unknown>;
    if (
      typeof s.uploadId !== 'string' ||
      typeof s.chunkIndex !== 'number' ||
      typeof s.score !== 'number'
    ) {
      return undefined;
    }
    sources.push({ uploadId: s.uploadId, chunkIndex: s.chunkIndex, score: s.score });
  }
  return sources;
}

/**
 * Runtime type guard over the generate worker's return value, mirroring
 * parsePipelineSummary. The value crossed a process boundary as JSON and
 * arrives here as `unknown` — the compile-time GenerationResult type says
 * nothing about what actually came back over Redis.
 */
export function parseGenerationResult(raw: unknown): GenerationResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  const sources = parseSources(r.sources);
  if (
    typeof r.text !== 'string' ||
    sources === undefined ||
    typeof r.totalTokens !== 'number' ||
    typeof r.finishReason !== 'string' ||
    !FINISH_REASONS.includes(r.finishReason as FinishReason)
  ) {
    return undefined;
  }

  return {
    text: r.text,
    sources,
    totalTokens: r.totalTokens,
    finishReason: r.finishReason as FinishReason,
  };
}

function wireOcrEvents(events: QueueEvents): void {
  events.on('active', async ({ jobId }) => {
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ocr_processing');
  });

  events.on('completed', async ({ jobId }) => {
    console.log(`[queue-events:ocr] job ${jobId} completed`);
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ml_processing');
    getIo().to(`upload:${uploadId}`).emit('ocr:progress', { step: 'embed', pct: 95 });
  });

  events.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events:ocr] job ${jobId} failed: ${failedReason}`);
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'failed');
    getIo().to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
  });

  events.on('progress', async ({ jobId, data }) => {
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    getIo().to(`upload:${uploadId}`).emit('ocr:progress', data);
  });
}

function wireEmbedEvents(events: QueueEvents): void {
  events.on('active', async ({ jobId }) => {
    const uploadId = await resolveUploadId(embedQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ml_processing');
  });

  events.on('completed', async ({ jobId, returnvalue }) => {
    console.log(`[queue-events:embed] job ${jobId} completed`, returnvalue);
    const uploadId = await resolveUploadId(embedQueue, jobId);
    if (!uploadId) return;
    const summary = parsePipelineSummary(returnvalue);
    if (summary) {
      await fileUploadOcrService.markReadyWithSummary(uploadId, summary);
    } else {
      console.warn(`[queue-events:embed] job ${jobId} completed with unparseable returnvalue; marking ready without summary`);
      await fileUploadOcrService.markStatus(uploadId, 'ready');
    }
    getIo().to(`upload:${uploadId}`).emit('ocr:completed', returnvalue);
  });

  events.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events:embed] job ${jobId} failed: ${failedReason}`);
    const uploadId = await resolveUploadId(embedQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'failed');
    getIo().to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
  });
}

// Path A — the durability path, and the ONLY writer of generation results to
// Mongo. It is subscribed at boot and knows nothing about browsers, which is
// what lets a user switch conversations mid-generation without stranding the
// message in 'generating' forever.
//
// Two deliberate differences from the OCR and embed handlers above:
//
// 1. No Socket.IO emit. This feature's live view is SSE, and that handler tails
//    the Redis stream directly. Emitting here would be a second, competing
//    delivery path for the same data.
// 2. No resolveUploadId() round trip. jobId === queryId === Mongo _id, so the
//    id in hand is already the one to write against.
function wireGenerateEvents(events: QueueEvents): void {
  events.on('completed', async ({ jobId, returnvalue }) => {
    console.log(`[queue-events:generate] job ${jobId} completed`);

    const result = parseGenerationResult(returnvalue);
    if (!result) {
      // Unlike the embed handler, there is no "mark it done anyway" fallback
      // here: the return value IS the answer. A query with no text is not
      // complete, so record it as failed rather than showing the user an
      // empty bubble that never resolves.
      console.error(
        `[queue-events:generate] job ${jobId} completed with unparseable returnvalue`,
      );
      await realTimeQueryProcessService.markFailed(
        jobId,
        'worker returned a malformed GenerationResult',
      );
      return;
    }

    const updated = await realTimeQueryProcessService.markComplete(jobId, result);
    if (!updated) {
      console.warn(`[queue-events:generate] no query row for job ${jobId}`);
    }
  });

  events.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events:generate] job ${jobId} failed: ${failedReason}`);
    const updated = await realTimeQueryProcessService.markFailed(
      jobId,
      failedReason ?? 'generation failed',
    );
    if (!updated) {
      console.warn(`[queue-events:generate] no query row for job ${jobId}`);
    }
  });
}

export function startQueueEvents(): {
  ocr: QueueEvents;
  embed: QueueEvents;
  generate: QueueEvents;
} {
  if (!ocrQueueEvents) {
    ocrQueueEvents = new QueueEvents(env.ocrQueue.name, { connection: redisConnection });
    wireOcrEvents(ocrQueueEvents);
  }
  if (!embedQueueEvents) {
    embedQueueEvents = new QueueEvents(env.embedQueue.name, { connection: redisConnection });
    wireEmbedEvents(embedQueueEvents);
  }
  if (!generateQueueEvents) {
    generateQueueEvents = new QueueEvents(env.generateQueue.name, { connection: redisConnection });
    wireGenerateEvents(generateQueueEvents);
  }
  return { ocr: ocrQueueEvents, embed: embedQueueEvents, generate: generateQueueEvents };
}
