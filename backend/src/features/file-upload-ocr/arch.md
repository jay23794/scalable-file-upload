# File Upload + OCR — Architecture

End-to-end architecture for the file-upload-ocr feature. Backend accepts uploads and enqueues jobs; a separate cloud-function worker consumes jobs, runs the OCR/ML pipeline, and reports status back.

---

## Components

| Component | Role | Port | Command |
|---|---|---|---|
| **Frontend (Angular)** | User picks file, gets a presigned URL, uploads directly to Supabase | 4200 | `cd frontend && npm start` |
| **Backend API (Express)** | Issues presigned URLs, records uploads, enqueues OCR jobs | 3000 | `cd backend && npm run dev` |
| **Redis** | Message broker (BullMQ queue `ocr-queue`) | 6379 | `docker run -d --name redis -p 6379:6379 redis:7-alpine` (first time) then `docker start redis` |
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
        │  Pipeline (each step reports progress):   │
        │    downloadFile      ← Supabase   (10%)   │
        │    detectFileType                 (25%)   │
        │    extractText       Tesseract /  (40%)   │
        │                      pdf-parse            │
        │    cleanText                      (60%)   │
        │    chunkText                      (70%)   │
        │    callMlService     → ML (stub)  (85%)   │
        │    storeMetadata     → log (stub) (95%)   │
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
   │                   │  insert Mongo    │                │                │
   │                   │  (status=pending)│                │                │
   │                   │──────────────────│                │                │
   │                   │  createSignedUrl │                │                │
   │                   │─────────────────▶│                │                │
   │                   │  signed URL      │                │                │
   │                   │◀─────────────────│                │                │
   │                   │  ocrQueue.add({..., downloadUrl})                  │
   │                   │───────────────────────────────────▶                │
   │  202 accepted     │                  │                │                │
   │◀──────────────────│                  │                │                │
   │                                                       │   bpop job     │
   │                                                       │───────────────▶│
   │                                                                        │
   │                                                    runPipeline(job.data)
   │                                                       downloadFile     │
   │                                                       (HTTP GET signed URL → Supabase)
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
  downloadUrl: string;   // Supabase signed URL, minted at enqueue, TTL 60 min
}
```

If this shape changes, update **both** files.

`downloadUrl` is a per-object signed URL generated by the backend right before `ocrQueue.add`. The worker fetches the file over plain HTTPS — **no Supabase SDK, no service-role key, no `SUPABASE_*` env vars** in the cloud-function. TTL is set in `backend/src/config/env.ts` (`signedUrl.downloadTtlSeconds`), currently 60 min so BullMQ retries and short queue delays don't expire it mid-flight. The sweeper's `reenqueue` path mints a fresh URL each time.

### `PipelineProgress` (progress payload)

Emitted by the worker via `job.updateProgress(...)` and consumed by the backend's `QueueEvents.on('progress')`. Defined in `cloud-function/src/pipeline/types.ts`:

```ts
interface PipelineProgress {
  step: 'download' | 'detect' | 'ocr' | 'clean' | 'chunk' | 'ml' | 'store';
  pct: number;
}
```

`runPipeline` accepts an optional `onProgress: (p: PipelineProgress) => void` callback so `handlers/process.ts` stays free of any BullMQ import — the worker injects `(p) => job.updateProgress(p)` at the call site.

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
- Worker calls `job.updateProgress({ step, pct })` → BullMQ publishes `progress`. Currently fired at 7 checkpoints (see `PipelineProgress` above).

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

## Recovery & Idempotency

Redis is a **fast transport, not the source of truth.** MongoDB is authoritative for upload state. If Redis loses jobs (crash, failover, or data-plane outage), the pipeline recovers itself — no manual re-upload needed.

### Recovery Sweeper Diagram

The sweeper runs a **two-stage filter**: a cheap DB scan flags candidates, then a per-record BullMQ state check decides what to actually do. This prevents false-positive re-enqueues when the queue simply has a deep backlog (a job waiting behind 10k others also has an old `updatedAt`, but it isn't stuck — it's just queued).

```
   ┌──────────────────────────────────────────────────────────┐
   │  Backend — Recovery Sweeper (cron / BullMQ repeatable)   │
   │  runs every 5 minutes                                    │
   └───────────────────────┬──────────────────────────────────┘
                           │
                           │  1. query MongoDB (cheap first pass)
                           ▼
   ┌──────────────────────────────────────────────────────────┐
   │  MongoDB — find({                                        │
   │    status ∈ [pending, ocr_processing, ml_processing],    │
   │    updatedAt < now - 10min                               │
   │  })                                                      │
   └───────────────────────┬──────────────────────────────────┘
                           │
                           │  2. candidates[] (stuck by clock only)
                           ▼
   ┌──────────────────────────────────────────────────────────┐
   │  For each candidate — ask BullMQ what's actually true:   │
   │                                                          │
   │    state = await ocrQueue.getJob(uploadId).getState()    │
   │                                                          │
   │  ┌────────────────────────────────────────────────────┐  │
   │  │ waiting / active / delayed / prioritized /         │  │
   │  │ waiting-children                                   │  │
   │  │   → HEALTHY. Job is in the backlog or being        │  │
   │  │     processed. Skip. (No re-add — the record's     │  │
   │  │     old updatedAt just reflects queue depth,       │  │
   │  │     not a lost job.)                               │  │
   │  ├────────────────────────────────────────────────────┤  │
   │  │ completed                                          │  │
   │  │   → RECONCILE. Job finished but the backend        │  │
   │  │     missed the event (e.g. was restarting).        │  │
   │  │     Upload.markReady(uploadId).                    │  │
   │  ├────────────────────────────────────────────────────┤  │
   │  │ failed                                             │  │
   │  │   → RECONCILE. Retries exhausted.                  │  │
   │  │     Upload.markFailed(uploadId).                   │  │
   │  ├────────────────────────────────────────────────────┤  │
   │  │ undefined  (job missing from Redis)                │  │
   │  │   → REENQUEUE. Redis lost it (crash, eviction).    │  │
   │  │                                                    │  │
   │  │     ocrQueue.add('process', jobData, {             │  │
   │  │       jobId: uploadId    ← idempotent              │  │
   │  │     })                                             │  │
   │  └────────────────────────────────────────────────────┘  │
   └───────────────────────┬──────────────────────────────────┘
                           │
                           │  3. job re-enters ocr-queue
                           │     (only when re-enqueued)
                           ▼
   ┌──────────────────────────────────────────────────────────┐
   │  OCR Worker (or ML Service) picks up the job             │
   │                                                          │
   │    status = await Mongo.getStatus(uploadId)              │
   │                                                          │
   │    if (status === 'ready')       → return (done)         │
   │    if (status === 'ocr_done')    → skip OCR,             │
   │                                    enqueue ml-queue      │
   │    if (status === 'pending')     → run full pipeline     │
   │                                                          │
   │  Workers re-check status → skip already-completed steps  │
   └──────────────────────────────────────────────────────────┘

              Rule: If it's not in MongoDB, it didn't happen.
              If it IS in MongoDB and hasn't advanced in 10 min,
              ask BullMQ before assuming it's lost.
```

### Recovery sweeper

A scheduled job runs every **5 minutes** on the backend. Stage 1 finds candidates stuck by the clock; stage 2 asks BullMQ what actually happened to each job before acting:

```ts
// runs every 5m (cron / BullMQ repeatable)
const HEALTHY = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'];

const cutoff = new Date(Date.now() - 10 * 60 * 1000);
const candidates = await Upload.find({
  status: { $in: ['pending', 'ocr_processing', 'ml_processing'] },
  updatedAt: { $lt: cutoff },   // stage 1 — cheap in-memory / index scan
});

for (const upload of candidates) {
  const job   = await ocrQueue.getJob(upload.uploadId);
  const state = await job?.getState();   // stage 2 — ask the source of truth

  if (state && HEALTHY.includes(state)) continue;                  // in backlog / running — skip
  if (state === 'completed') { await Upload.markReady(upload.uploadId);  continue; }
  if (state === 'failed')    { await Upload.markFailed(upload.uploadId); continue; }

  // state is undefined → job was lost from Redis — re-enqueue
  await ocrQueue.add('process', buildJobData(upload), {
    jobId: upload.uploadId,   // ← idempotent
  });
}
```

### Why this is safe to replay

- **`jobId: uploadId`** — BullMQ dedupes by jobId. Even if the state check races, a duplicate `add` while the original is still queued is a no-op.
- **Stage-2 state check** — the sweeper never re-adds a job that BullMQ still knows about. A 10k-deep backlog produces silent, action-free sweeps; only truly-lost jobs get pushed back in.
- **Terminal-state reconciliation** — if a job completed or failed while the backend was down, the sweeper fixes the record's status instead of blindly re-enqueueing.
- **Workers re-check MongoDB status before doing work.** A replayed job whose upload is already `ocr_done` skips extraction and jumps straight to the ML enqueue step. Already `ready` → returns immediately.
- **Every pipeline step is idempotent** when keyed by `uploadId` (+ `chunkIndex` for Milvus writes). Re-running produces the same result.

### What this protects against

| Scenario | Recovery path |
|---|---|
| Redis restarts and loses in-flight jobs | Stage-2 sees `undefined` → sweeper re-enqueues from MongoDB within 5–10 min |
| Worker crashes after enqueueing to `ml-queue` but before updating Mongo | Next sweep: OCR job state is `completed` → status reconciled to `ocr_done`; ML job (if lost) re-enqueued |
| Backend down when `completed` / `failed` event fired | Stage-2 finds terminal state → reconciles status without re-running the pipeline |
| Deep queue backlog (10k jobs waiting) | Stage-2 sees `waiting` for every candidate → silent no-op sweep, no runaway re-adds |
| Retries exhausted (`attempts: 3`) → job in failed set | Stage-2 sees `failed` → status marked `failed`; manual retry via admin endpoint |
| Backend deploy while jobs in flight | Nothing lost — jobs continue on workers, events buffered in Redis, backend re-subscribes on boot |

### Rule of thumb

**If it's not in MongoDB, it didn't happen.** If it *is* in MongoDB but hasn't advanced in 10 minutes, **ask BullMQ before acting** — the queue is the source of truth for what the job is really doing.

---

## What's Wired

- **`extractText`** — real OCR: `pdf-parse` v2 for PDFs (`PDFParse.getText()` → `{ text, pages }`), `tesseract.js` for images (`{ text, confidence }`), utf-8 decode for plain text.
- **`downloadFile`** — real HTTP fetch of the signed URL from `job.data.downloadUrl` (`Buffer.from(await res.arrayBuffer())`). Cloud-function has zero Supabase config.
- **Pipeline progress** — `job.updateProgress({ step, pct })` fires at 7 checkpoints; backend `QueueEvents` forwards to Socket.IO room `upload:${uploadId}` as `ocr:progress`.
- **Socket.IO end-to-end** — backend emits `ocr:progress` / `ocr:completed` / `ocr:failed`. Frontend `SocketService` subscribes and re-emits `subscribe` on every `connect` so reconnects rejoin the room. On subscribe, backend replays a synthetic terminal event if the upload's status is already `ready` / `failed` (handles late-joining clients / fast pipelines).
- **MongoDB persistence** — `UploadRecord` is stored in Mongo via Mongoose. `_id` is the app-level UUID (no ObjectId), compound index on `{status, updatedAt}` powers the sweeper's stage-1 scan. Backend connects before `httpServer.listen` and disconnects on SIGINT/SIGTERM.
- **Recovery sweeper implemented** (`file-upload-ocr.sweeper.ts`) — runs every 5 min, `STUCK_THRESHOLD_MS` = 10 min, stage-2 BullMQ state check per candidate (`waiting/active/... → skip`, `completed → mark ready`, `failed → mark failed`, `unknown → reenqueue` with a fresh signed URL).
- **Graceful shutdown** — worker traps SIGINT/SIGTERM, drains in-flight jobs via `ocrWorker.close()` then `redisConnection.quit()`. Backend closes the HTTP server and disconnects Mongo.

## What's Not Wired Yet

- **`storeMetadata`** currently logs only — the *upload record* is in Mongo, but the *pipeline output* (chunks, embeddings summary, OCR text) is not persisted.
- **`callMlService`** returns stub embeddings — needs real HTTP call to Python service.
- **Vector storage** (Milvus or similar) — a `storeVectors` step will be added after `callMlService`.
- **Frontend poll fallback** — if a client is offline for the full lifetime of a job (past reconnect window and sweeper interval), the synthetic-replay branch covers most gaps, but a background `GET /uploads/:id` refresh on tab-focus would close the last window.

---

## Security Boundary

- **Backend** is the only holder of the Supabase service-role key. It mints per-object signed URLs (`SupabaseStorageService.createSignedDownloadUrl`) and attaches them to job payloads.
- **Cloud-function worker** has no Supabase credentials whatsoever. It reads a signed URL from `job.data.downloadUrl` and fetches with global `fetch`. Even if the worker container is compromised, the attacker gets access only to the specific files currently in queue payloads, only for the URL's remaining TTL.
- **Tradeoff of embedding the URL in the payload**: it lives in Redis for the job's retention window (`removeOnComplete: 1000`, `removeOnFail: 5000`). Anyone with Redis read access can see and use those URLs until they expire. Acceptable on a private single-tenant Redis; if that changes, migrate to mint-on-demand (worker calls a backend `/internal/signed-url` endpoint per job). Do **not** ship the service-role key to the worker as a shortcut — that grants access to every object, not just the one being processed.

---

## Future Scope

Two migration paths depending on load. Both preserve the current interfaces (`OcrJobData`, `PipelineJob`, `onProgress` callback) so the pipeline code doesn't have to be rewritten.

### Option A — Hybrid (BullMQ orchestration + AWS managed data plane)

**Target load**: ~5k users, files up to 100MB (300-500 page PDFs), ~100 uploads/hour peak.

Keep BullMQ as the orchestrator, swap only the data-plane components. The pipeline steps in `handlers/process.ts` stay identical.

```
                       ┌────────────────────┐
                       │  Frontend (Angular)│
                       │  S3 + CloudFront   │
                       └─────────┬──────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │  1. request presigned URL     │
                 │  2. POST /complete            │
                 │  3. WebSocket subscribe       │
                 ▼                               │
        ┌────────────────────────┐               │
        │  Backend API (Express) │               │
        │  ECS Fargate + ALB     │  3. PUT file  │
        │  + Socket.IO server    │◀──────────────┘
        │  - presign             │
        │  - /complete           │               ▼
        │    → insert MongoDB    │     ┌──────────────────────┐
        │      (status='pending')│     │ S3 (KMS-encrypted)   │
        │    → enqueue ocr-queue │     │ Lifecycle → Glacier  │
        └─────────┬──────────────┘     │ (30d)                │
                  │                    └──────────────────────┘
                  │  4. ocr-queue.add            ▲
                  ▼                              │
        ┌─────────────────────────┐              │
        │ ElastiCache Redis       │              │
        │ (Multi-AZ)              │              │
        │  • queue: ocr-queue     │              │
        │  • queue: ml-queue      │              │
        │  • event channels       │              │
        │  + DLQ per queue        │              │
        └─────────┬───────────────┘              │
                  │                              │
                  │  5. bpop ocr-queue           │
                  ▼                              │
        ┌───────────────────────────────────────────┐
        │  OCR Worker — ECS Fargate (autoscaled)    │
        │  target-tracking on ocr_queue_depth       │
        │                                           │
        │  runPipeline(job, onProgress):            │
        │    downloadFile  ← stream from S3  ───────┘         ┌────────────────┐
        │    detectFileType                                   │  AWS Textract  │
        │    extractText:                                     │  async API     │
        │      • pdf-parse   (text PDFs, free)                └────────────────┘
        │      • Textract    (scanned) ─────────────────────────────▲
        │    cleanText / chunkText                                  │
        │    callMlService  ── ml-queue.add({uploadId, chunks}) ─┐  │
        │    storeMetadata  ── MongoDB (status='ocr_done') ──┐   │  │
        │                                                    │   │  │
        └─────────┬──────────────────────────────────────────┘   │  │
                  │                                              │  │
                  │  6a. ocr-queue 'completed' event             │  │
                  ▼                                              │  │
        ┌────────────────────┐                                   │  │
        │ ElastiCache Redis  │◀──────────────────────────────────┘  │
        │ (event channel)    │                                      │
        └─────────┬──────────┘                                      │
                  │                                                 │
                  │  7. QueueEvents subscribers                     │
                  │     • ocr-queue.on('completed'|'failed'|        │
                  │                    'progress')                  │
                  │     • ml-queue .on('completed'|'failed')        │
                  ▼                                                 │
        ┌────────────────────────┐          ┌────────────────────┐  │
        │  Backend API           │─────────▶│ MongoDB            │  │
        │  QueueEvents +         │  update  │ UploadRecord       │  │
        │  Socket.IO emit        │◀─────────│ (status, progress, │  │
        │  upload:${id} room     │   read   │  chunk count,      │  │
        │                        │          │  ocr summary)      │  │
        └─────────┬──────────────┘          └────────────────────┘  │
                  │                                                 │
                  │  8. socket push events:                         │
                  │      • 'progress'   (from ocr-queue progress)   │
                  │      • 'ocr:done'   (from ocr-queue completed)  │
                  │      • 'ml:done'    (from ml-queue completed)   │
                  │      • 'failed'     (from either queue)         │
                  ▼                                                 │
        ┌────────────────────┐                                      │
        │  Frontend          │                                      │
        └────────────────────┘                                      │
                                                                    │
── ML Service (separate Fargate deployment) ────────────────────────┼──
                                                                    │
        ┌──────────────────────────────────────────────┐            │
        │  ML Service — ECS Fargate (Python)           │            │
        │  autoscaled on ml_queue_depth                │            │
        │                                              │            │
        │  BullMQ Worker on ml-queue:                  │            │
        │    receive { uploadId, chunks }              │            │
        │    → compute embeddings                      │            │
        │    → write vectors to Milvus  ───────────────┼──▶ ┌────────────────┐
        │    → return meta (BullMQ 'completed' event)  │    │ Milvus         │
        └──────────────────────────────────────────────┘    │ (vector DB —   │
                          │                                 │  ML-owned;     │
                          │  ml-queue 'completed'           │  keyed by      │
                          │  event via BullMQ QueueEvents   │  uploadId +    │
                          ▼                                 │  chunk index)  │
                    ElastiCache Redis                       └────────────────┘
                    (event channel — flows into
                     Backend QueueEvents at step 7)

Ownership boundaries:
  - Backend:      /presign, /complete, Socket.IO. Sole writer of MongoDB status.
                  Sole authority for FE communication.
  - OCR Worker:   OCR + cleaning + chunking. Enqueues to ml-queue.
                  Writes OCR-result summary to MongoDB. Never touches Milvus.
  - ML Service:   Embeddings + Milvus writes. Sole writer to vector store.
                  Signals completion via ml-queue BullMQ event stream.

Observability : Sentry (exceptions) + Datadog / CloudWatch (metrics + logs)
Security      : KMS-encrypted S3, IAM roles on Fargate, VPC-only ElastiCache + Milvus
Secrets       : AWS Secrets Manager / SSM Parameter Store

────────────────────────────────────────────────────────────────────
Alternative — Pattern 1 (Sync) — simpler starting point:
  Replace the ml-queue with a direct HTTP call:
    Worker → POST /embed on ML Service → wait for 200 OK → storeMetadata
  Pros:  one queue, one completion event, easier to reason about.
  Cons:  worker task blocked during embedding compute (30s-2min on big docs).
  Migrate to the async ml-queue pattern (as drawn above) when ML compute
  time starts bottlenecking OCR worker capacity.
────────────────────────────────────────────────────────────────────
```

| Layer | Now (dev) | Hybrid (prod) | Trigger to migrate |
|---|---|---|---|
| Queue transport | Redis (Docker) | **ElastiCache Redis** (Multi-AZ) | Any real production traffic |
| Worker runtime | `npm run worker` on VPS | **ECS Fargate** tasks, autoscale on queue depth | >4 concurrent jobs sustained |
| OCR — text PDFs | `pdf-parse` | `pdf-parse` (unchanged, ~free) | — |
| OCR — scanned PDFs / images | `tesseract.js` | **AWS Textract** async API (`StartDocumentAnalysis`) | Quality complaints, or files >20 pages |
| ML / embeddings | stub `callMlService` | **In-house ML Service** on ECS Fargate (Python) — computes embeddings and writes to Milvus directly | When real embeddings are needed |
| Vector store | — | **Milvus** — owned by the ML service, worker never touches it | With the ML service |
| ML → backend signalling | — | ML service **publishes `ml:done` on Redis pub/sub**; backend listens and pushes to Socket.IO | Same rollout as ML service |

| File storage | Supabase Storage | **S3** with lifecycle → Glacier after 30d | Storage cost >$100/month |
| Status push | Socket.IO on backend | Socket.IO on backend (unchanged; single source of truth for FE) | — |

**Why keep BullMQ**: retries, DLQ semantics, delayed jobs, priority queues, job introspection — building this on raw SQS is weeks of work. BullMQ handles it in one library.

**Why Fargate, not Lambda**: Lambda's 15-minute execution cap kills OCR on large scanned PDFs. Fargate has no hard limit and autoscales on custom CloudWatch metrics (queue depth).

**Why `pdf-parse` before Textract**: most PDFs have embedded text and don't need OCR. Detecting text-vs-scanned first and only falling back to Textract for scanned pages cuts OCR spend by ~10x.

**Non-functional additions required for prod**:
- **DLQ + alerting** on failed-job depth (Datadog / CloudWatch alarm)
- **Idempotent job IDs** derived from `uploadId` so retries don't double-process
- **Streaming** downloads instead of buffering 100MB into RAM
- **Textract async API** for anything >10 pages (don't block a task on sync OCR)
- **Observability**: Sentry for exceptions, Datadog for `ocr_queue_depth` + p95 job duration
- **Security**: KMS-encrypted S3, IAM roles on Fargate tasks, VPC-only ElastiCache, PII redaction on OCR output before persist
- **Cost controls**: reserved Fargate capacity, Textract async pricing, CloudWatch budget alarms

### Option B — Full AWS Managed (drop BullMQ)

**Target load**: 50k+ users, sustained bursty load, multi-region, dedicated ops team.

Rewrite the transport layer around AWS-native primitives. Pipeline logic can still live in the same TypeScript, packaged as Lambda or Fargate.

```
                       ┌────────────────────┐
                       │  Frontend (Angular)│
                       │  S3 + CloudFront   │
                       └─────────┬──────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │  1. request presigned URL     │
                 │  2. POST completeUpload       │
                 │  3. WebSocket $connect        │
                 ▼                               │
        ┌────────────────────────┐               │
        │  API Gateway           │               │
        │  (REST + WebSocket)    │               │
        └─────────┬──────────────┘               │
                  │                              │
                  │  4. Lambda invocation        │
                  ▼                              │
        ┌────────────────────────┐               │
        │  Lambda (backend)      │  3. PUT file  │
        │  - presign             │◀──────────────┘
        │  - complete            │
        │  - enqueue → SQS       │               ▼
        │  - store conn in DDB   │      ┌──────────────────────┐
        └─────────┬──────────────┘      │ S3 (KMS-encrypted)   │
                  │                     │ Lifecycle → Glacier  │
                  │  5. SendMessage     └──────────────────────┘
                  ▼                                 ▲
        ┌────────────────────┐                     │
        │ SQS Standard Queue │                     │
        │ + DLQ (maxReceive) │                     │
        └─────────┬──────────┘                     │
                  │                                │
                  │  6. Event source trigger       │
                  ▼                                │
        ┌───────────────────────────────────────────┐
        │  Worker runtime (pick one):               │
        │  • Lambda (jobs < 15 min)                 │
        │  • ECS Fargate (long-running jobs)        │
        │  • Step Functions (fan-out per page)      │
        │                                           │       ┌────────────────┐
        │  runPipeline steps:                       │       │  AWS Textract  │
        │    downloadFile   ← stream from S3 ───────┘       │  async API     │
        │    detectFileType                         │──────▶└────────────────┘
        │    extractText  ──────────────────────────┼──┐
        │    cleanText / chunkText                  │  │    ┌────────────────┐
        │    callMlService ─────────────────────────┼──┼───▶│  Bedrock       │
        │    storeMetadata ─────────────────────────┼──┼──┐ │  InvokeModel   │
        │    storeVectors  ─────────────────────────┼──┘  │ └────────────────┘
        └─────────┬─────────────────────────────────┘     │
                  │                                       │ ┌────────────────┐
                  │  7. PutEvents (ocr.completed / failed │▶│ DynamoDB /     │
                  │      / progress) on completion        │ │ Aurora         │
                  ▼                                       │ └────────────────┘
        ┌────────────────────┐                            │
        │  EventBridge Bus   │                            │ ┌────────────────┐
        └─────────┬──────────┘                            └▶│ OpenSearch     │
                  │                                         │ Serverless     │
                  │  8. Rule → Lambda                       │ (knn vectors)  │
                  ▼                                         └────────────────┘
        ┌────────────────────┐
        │  Push Lambda       │
        │  - lookup conn IDs │
        │    in DynamoDB     │
        │  - PostToConnection│
        │    via API Gw MgmtAPI
        └─────────┬──────────┘
                  │
                  │  9. WebSocket push
                  ▼
        ┌────────────────────┐
        │  Frontend          │
        └────────────────────┘

Observability : CloudWatch Logs + Metrics, X-Ray distributed tracing
Secrets       : AWS Secrets Manager
IAM           : Least-privilege roles per Lambda / Fargate task
```

| Concern | Current implementation | AWS-managed replacement |
|---|---|---|
| Job queue | BullMQ `Queue` (`backend/src/infra/queue.ts`) | **SQS** standard queue + DLQ |
| Job events (`completed`/`failed`/`progress`) | BullMQ `QueueEvents` | **EventBridge** rules + SNS fan-out, or **AppSync subscriptions** |
| Worker runtime | Node BullMQ `Worker` (`cloud-function/src/worker.ts`) | **ECS Fargate** for long jobs, or **Lambda** for short (<15min) jobs, or **Step Functions** for >15min fan-out |
| Retries / backoff | BullMQ `defaultJobOptions` | SQS `maxReceiveCount` + Lambda destinations, or Step Functions retry state |
| Presign / metadata API | Express on `:3000` | **API Gateway** + Lambda, or ECS Fargate behind ALB |
| Status push to frontend | Socket.IO on Express | **API Gateway WebSocket** + Lambda + DynamoDB connection table |
| Metadata store | Postgres/Mongo (planned) | **DynamoDB** (single-digit ms) or **RDS Aurora Serverless** |
| Object storage | Supabase Storage | **S3** with presigned URLs (same pattern as today) |
| OCR | Tesseract / pdf-parse | **AWS Textract** (sync `AnalyzeDocument` or async `StartDocumentAnalysis`) |
| Embeddings / ML | Python service (planned) | **Bedrock** (`InvokeModel` for embeddings) or **SageMaker** endpoint |
| Vector storage | Milvus (planned) | **OpenSearch Serverless** with `knn` vectors, or **Pinecone** (managed, non-AWS) |
| Config / secrets | `.env` files | **Systems Manager Parameter Store** or **Secrets Manager** |
| Observability | `console.log` | **CloudWatch Logs**, **X-Ray** tracing, **CloudWatch Metrics** |

**Trigger to migrate**: >100 sustained jobs/min, multi-region requirement, or when Redis HA + Fargate ops burden exceeds the AWS bill delta.

**Cost floor**: ~$0 fixed (scale-to-zero), but variable cost grows fast — Textract at $1.50 per 1000 pages, DynamoDB read/write units, egress fees.

**Trade-offs vs Hybrid**:
- ✅ True scale-to-zero, multi-region built-in, DLQ / retry native, no worker VM to babysit
- ❌ Vendor lock-in (SQS/EventBridge/Textract APIs are AWS-only)
- ❌ Local dev requires LocalStack or full AWS credentials — no more `docker start redis`
- ❌ Debugging distributed Lambda + Step Functions is materially harder than tailing a Node process
