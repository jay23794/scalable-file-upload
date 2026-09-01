import { Request, Response } from 'express';
import { redisConnection } from '../../infra/queue';
import { realTimeQueryProcessService } from '../../infra/container';
import { QueryRecord, StreamEvent } from './types';

// Path B — the live view. STRICTLY READ-ONLY.
//
// This handler must never write to Mongo. QueueEvents (Path A) is the only
// writer, and that separation is the entire reason the design has two paths:
// this code is created by the browser's request and destroyed when the browser
// leaves, so it is not running at the moment there is something to save. A user
// switching tabs would otherwise strand the message in 'generating' forever.

// How long a single XREAD parks before we emit a comment frame. Proxies and
// load balancers drop idle connections; the keepalive is what stops them.
const BLOCK_MS = 15_000;

// After this many consecutive idle reads (~1 min), re-check Mongo. Covers the
// case where the stream went quiet permanently — the worker died without
// writing a terminal event, or the stream was evicted by its TTL. Without it a
// client tails a stream with nothing left to say until it gives up, holding a
// blocking Redis connection the whole time.
const IDLE_READS_BEFORE_RECHECK = 4;

function writeSseHeaders(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    // no-transform matters as much as no-cache: it tells intermediaries not to
    // re-encode or buffer the body.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Defeats nginx / Cloud Run response buffering, which would otherwise hold
    // the whole stream and deliver it as one blob at the end.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
}

function writeEvent(res: Response, event: StreamEvent, id?: string): void {
  // The Redis entry ID becomes the SSE event id, which the browser sends back
  // as Last-Event-ID when it auto-reconnects.
  if (id) res.write(`id: ${id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Replays a finished query as stream frames.
 *
 * The client stays on one code path this way — it renders tokens and waits for
 * a terminal event, whether the answer arrived live or was read from Mongo. The
 * text goes out as a single `token` frame rather than being left implicit,
 * because a client that opened the stream microseconds after completion would
 * otherwise receive a bare `done` and render an empty message.
 */
function writeTerminalFrames(res: Response, record: QueryRecord): void {
  if (record.status === 'complete') {
    if (record.text) writeEvent(res, { type: 'token', text: record.text, index: 0 });
    writeEvent(res, {
      type: 'done',
      totalTokens: record.totalTokens ?? 0,
      sources: record.sources ?? [],
    });
    return;
  }
  writeEvent(res, { type: 'error', message: record.failedReason ?? 'generation failed' });
}

function isTerminal(event: StreamEvent): boolean {
  return event.type === 'done' || event.type === 'error' || event.type === 'cancelled';
}

export const stream = async (req: Request, res: Response) => {
  const id = req.params.id;

  const record = await realTimeQueryProcessService.getQuery(id);
  if (!record) {
    return res.status(404).json({ success: false, error: 'Query not found' });
  }

  writeSseHeaders(res);

  // Nothing left to say — do not open a blocking read on a stream that will
  // never produce another entry.
  if (record.status !== 'generating') {
    writeTerminalFrames(res, record);
    return res.end();
  }

  // A blocking XREAD monopolises its connection for the whole BLOCK window, so
  // it must never run on the shared client — that would stall every queue
  // operation in the process behind one idle browser tab.
  const sub = redisConnection.duplicate();

  let closed = false;
  const teardown = () => {
    if (closed) return;
    closed = true;
    // disconnect(), not quit(): quit() waits for in-flight commands, and the
    // in-flight command here is an XREAD parked for up to BLOCK_MS. Leaking one
    // blocking connection per abandoned tab is a real exhaustion path.
    sub.disconnect();
  };

  // Both paths are required. 'close' fires when the browser goes away mid-read;
  // the finally covers every normal and error exit.
  req.on('close', teardown);

  const key = `gen:${id}`;
  const header = req.headers['last-event-id'];
  // Cursor '0' replays the whole backlog. That is cheap and correct at V1 — the
  // stream is capped at MAXLEN ~5000 and expires after an hour.
  let cursor = typeof header === 'string' && header.length > 0 ? header : '0';
  let idleReads = 0;

  try {
    while (!closed) {
      const reply = (await sub.xread('BLOCK', BLOCK_MS, 'STREAMS', key, cursor)) as
        | [string, [string, string[]][]][]
        | null;

      if (closed) break;

      if (!reply) {
        res.write(': keepalive\n\n');
        if (++idleReads < IDLE_READS_BEFORE_RECHECK) continue;

        idleReads = 0;
        const latest = await realTimeQueryProcessService.getQuery(id);
        if (latest && latest.status !== 'generating') {
          // Path A finished the job but the stream never carried a terminal
          // event. Close the client out from the durable record instead.
          writeTerminalFrames(res, latest);
          break;
        }
        continue;
      }

      idleReads = 0;
      let done = false;

      for (const [, entries] of reply) {
        for (const [entryId, fields] of entries) {
          cursor = entryId;

          // Entries are written as: XADD <key> * data <json>
          const dataIndex = fields.indexOf('data');
          if (dataIndex === -1 || dataIndex + 1 >= fields.length) continue;

          let event: StreamEvent;
          try {
            event = JSON.parse(fields[dataIndex + 1]) as StreamEvent;
          } catch {
            console.warn(`[query-stream] ${key} entry ${entryId} is not valid JSON; skipping`);
            continue;
          }

          writeEvent(res, event, entryId);
          if (isTerminal(event)) done = true;
        }
      }

      if (done) break;
    }
  } catch (err) {
    // A teardown mid-XREAD rejects the pending command. That is the expected
    // way this loop ends when the client leaves, not an error worth reporting.
    if (!closed) {
      console.error(`[query-stream] ${key} read failed:`, (err as Error).message);
      writeEvent(res, { type: 'error', message: 'stream read failed' });
    }
  } finally {
    teardown();
    res.end();
  }
};
