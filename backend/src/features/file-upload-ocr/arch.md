# File Upload + OCR — Architecture

End-to-end architecture for the file-upload-ocr feature. Backend accepts uploads and enqueues jobs; a separate cloud-function worker consumes jobs, runs the OCR/ML pipeline, and reports status back.

---

## Components

| Component | Role | Port | Command |
|---|---|---|---|
| **Frontend (Angular)** | User picks file, gets a presigned URL, uploads directly to Supabase | 4200 | `cd frontend && npm start` |
| **Backend API (Express)** | Issues presigned URLs, records uploads, enqueues OCR jobs | 3000 | `cd backend && npm run dev` |
| **Redis** | Message broker (BullMQ queue `ocr-queue`) | 6379 | `brew services start redis` |
| **Cloud Function — HTTP** | Health/introspection only | 4000 | `cd cloud-function && npm run dev` |
| **Cloud Function — Worker** | BullMQ consumer running the pipeline | — | `cd cloud-function && npm run worker` |
| **Supabase Storage** | File storage (external, managed) | — | — |
| **ML Service (future)** | Python embeddings/vector service | 5000 | (not yet built) |
| **Vector DB (future, e.g. Milvus)** | Stores embeddings | — | (not yet decided) |

---

## High-Level Diagram

```
                       ┌────────────────────┐
                       │  Frontend (Angular)│
                       │       :4200        │
                       └─────────┬──────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │  1. request presigned URL     │
                 │  2. POST completeUpload       │
                 ▼                               │
        ┌────────────────────┐                   │
        │  Backend API       │                   │
        │  Express :3000     │                   │
        │                    │                   │
        │  - presign         │        3. PUT file (direct upload)
        │  - complete        │◀──────────────────┘
        │  - enqueue job     │
        └─────────┬──────────┘                   
                  │                              ▼
                  │                    ┌──────────────────────┐
                  │                    │ Supabase Storage     │
                  │                    │ (bucket)             │
                  │                    └──────────────────────┘
                  │
                  │  4. ocrQueue.add('process', OcrJobData)
                  ▼
        ┌────────────────────┐
        │  Redis :6379       │
        │  queue: ocr-queue  │
        └─────────┬──────────┘
                  │
                  │  5. blocking pop (BullMQ Worker)
                  ▼
        ┌───────────────────────────────────────────┐
        │  Cloud Function — Worker (Node)           │
        │                                           │
        │  new Worker('ocr-queue', runPipeline,     │
        │             { concurrency: 5 })           │
        │                                           │
        │  Pipeline:                                │
        │    downloadFile      ← Supabase           │
        │    detectFileType                         │
        │    extractText (OCR)                      │
        │    cleanText                              │
        │    chunkText                              │
        │    callMlService     → ML service (5000)  │
        │    storeMetadata     → Postgres / Mongo   │
        │                                           │
        │  return meta   ─ BullMQ publishes         │
        │  throw err     ─ 'completed' / 'failed'   │
        │                  events to Redis          │
        └─────────┬─────────────────────────────────┘
                  │
                  │  6. BullMQ event stream (Redis)
                  ▼
        ┌────────────────────┐
        │  Redis :6379       │
        │  (event channel)   │
        └─────────┬──────────┘
                  │
                  │  7. QueueEvents subscription
                  ▼
        ┌────────────────────┐
        │  Backend API       │
        │  ocrQueueEvents    │
        │  .on('completed')  │
        │  .on('failed')     │
        │  .on('progress')   │
        └─────────┬──────────┘
                  │
                  │  8. push to client (socket / SSE)
                  ▼
        ┌────────────────────┐
        │  Frontend          │
        └────────────────────┘
```

---

## Upload → Processing Sequence

```
Frontend            Backend            Supabase          Redis           Worker
   │                   │                  │                │                │
   │  POST /presign    │                  │                │                │
   │──────────────────▶│                  │                │                │
   │  { presignedUrl } │                  │                │                │
   │◀──────────────────│                  │                │                │
   │                                                                        │
   │  PUT file (direct) │                                                   │
   │─────────────────────────────────────▶│                                 │
   │                                                                        │
   │  POST /complete   │                  │                │                │
   │──────────────────▶│                  │                │                │
   │                   │  ocrQueue.add()  │                │                │
   │                   │───────────────────────────────────▶                │
   │  202 accepted     │                  │                │                │
   │◀──────────────────│                  │                │                │
   │                                                       │   bpop job     │
   │                                                       │───────────────▶│
   │                                                                        │
   │                                                    runPipeline(job.data)
   │                                                       downloadFile     │
   │                                                       detectFileType   │
   │                                                       extractText      │
   │                                                       cleanText        │
   │                                                       chunkText        │
   │                                                       callMlService    │
   │                                                       storeMetadata    │
   │                                                                        │
   │                                                       │  return meta   │
   │                                                       │◀───────────────│
   │                                                       │                │
   │                                                       │  BullMQ emits  │
   │                                                       │  'completed'   │
   │                                                       │  to Redis      │
   │                                                       │                │
   │                   │◀── QueueEvents 'completed' ───────│                │
   │  socket push      │                                                    │
   │◀──────────────────│                                                    │
```

---

## Contracts

### `OcrJobData` (queue payload)

Same shape on both sides:

- `backend/src/infra/queue.ts` — declared, used by producer
- `cloud-function/src/pipeline/types.ts` — duplicated, used by consumer

```ts
interface OcrJobData {
  uploadId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
}
```

If this shape changes, update **both** files.

### Queue configuration

Set in `backend/src/infra/queue.ts`:

```ts
new Queue<OcrJobData>('ocr-queue', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});
```

Retries and backoff are handled by BullMQ automatically — the worker only needs to throw on failure.

---

## Environment Variables

Both services must agree on the following:

| Var | Backend default | Cloud-function default | Notes |
|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | `redis://localhost:6379` | Must point to the same Redis |
| `OCR_QUEUE_NAME` | `ocr-queue` | `ocr-queue` | Must match exactly |
| `WORKER_CONCURRENCY` | — | `5` | Cloud-function only |
| `PORT` | `3000` | `4000` | Independent |

---

## Scaling

Two dials:

1. **Concurrency per worker** — `WORKER_CONCURRENCY` env var (in-flight jobs per Node process).
2. **Number of worker processes** — run `npm run worker` multiple times, or use PM2:

   ```bash
   pm2 start dist/worker.js -i 4 --name ocr-worker
   ```

   Total in-flight = `processes × concurrency`.

Rule of thumb:
- I/O-bound pipeline (Supabase, ML API, DB) → bump concurrency (5–20).
- CPU-bound pipeline (OCR, heavy parsing) → add processes (~= CPU cores).

---

## Status Propagation (BullMQ QueueEvents)

The worker does not HTTP-POST status back. Instead:

- Worker returns `meta` → BullMQ publishes a `completed` event into Redis.
- Worker throws → BullMQ publishes `failed`.
- Worker calls `job.updateProgress(pct)` → BullMQ publishes `progress`.

Backend subscribes via `QueueEvents` (`backend/src/infra/queueEvents.ts`):

```ts
import { QueueEvents } from 'bullmq';

const events = new QueueEvents('ocr-queue', { connection });

events.on('completed', ({ jobId, returnvalue }) => { /* push to client */ });
events.on('failed',    ({ jobId, failedReason }) => { /* push to client */ });
events.on('progress',  ({ jobId, data })         => { /* push to client */ });
```

No HTTP callback URLs, no shared secrets, no retries needed on the status path — Redis is the single transport for both jobs and status.

---

## Failure Model

| What fails | What happens |
|---|---|
| Worker crashes mid-job | BullMQ marks job as stalled, retries up to `attempts` (3) with exponential backoff |
| `runPipeline` throws | Worker catches, BullMQ publishes `failed` event, retries per policy |
| Redis unavailable | Backend `ocrQueue.add()` throws → upload complete returns 500; worker sits idle until Redis returns |
| Cloud-function down entirely | Jobs pile up in Redis; processed when worker starts |
| Backend `QueueEvents` subscriber down | Events are still emitted; on reconnect, BullMQ replays events based on last-read position. Missed live events for offline clients still need a fallback (polling job state, or reading job records from DB). |

---

## What's Not Wired Yet

- **`storeMetadata`** currently logs only — needs Postgres/Mongo persistence.
- **`callMlService`** returns stub embeddings — needs real HTTP call to Python service.
- **`QueueEvents` subscribers** log to console — need to be wired into the socket layer to push updates to the frontend.
- **Vector storage** (Milvus or similar) — a `storeVectors` step will be added after `callMlService`.
- **Graceful shutdown** — worker should trap SIGINT/SIGTERM and close cleanly (Step 8).
