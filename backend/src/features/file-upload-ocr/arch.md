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
| **ML Service** | Node/Express embeddings service (Xenova MiniLM-L6-v2, 384-dim), writes to a pluggable vector store | 5100 (avoids macOS AirPlay's :5000) | `cd ml && npm run dev` |
| **Vector Store** | **Supabase (pgvector)** — table `document_chunks`, HNSW cosine index. Milvus/Zilliz retained as a pluggable fallback via `VECTOR_STORE` env. | — | — (managed) |

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
        │    stageChunks       → Storage    (82%)   │
        │    enqueueEmbedJob   → embed-q    (90%)   │
        │    storeMetadata     → summary    (95%)   │
        │                                           │
        │  return meta   ─ BullMQ publishes         │
        │  throw err     ─ 'completed' / 'failed'   │
        │                  events to Redis          │
        │                                           │
        │  (ml embed happens async on embed-queue,  │
        │   see "cf → ml Transport" design section) │
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
   │                                                       stageChunks      │
   │                                                       (PUT chunks JSON → Storage via backend-minted signed URL)
   │                                                       enqueueEmbedJob  │
   │                                                       (embedQueue.add → ml consumes async)
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
  step: 'download' | 'detect' | 'ocr' | 'clean' | 'chunk' | 'stage' | 'enqueue' | 'store';
  pct: number;
}
// Note: backend also synthesizes `{ step: 'embed', pct: 95 }` on ocr-queue completed
// (before the ml worker picks up the embed job) and forwards it to the socket room.
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

| Var | Backend | Cloud-function | ml | Notes |
|---|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | `redis://localhost:6379` | `redis://localhost:6379` | All three must point to the same Redis |
| `OCR_QUEUE_NAME` | `ocr-queue` | `ocr-queue` | — | Must match |
| `EMBED_QUEUE_NAME` | `embed-queue` | `embed-queue` | `embed-queue` | Must match |
| `WORKER_CONCURRENCY` | — | `5` | — | Cloud-function OCR workers |
| `EMBED_WORKER_CONCURRENCY` | — | — | `2` | ml embed workers per process |
| `PORT` | `3000` | `4000` | `5100` | Independent (ml avoids macOS AirPlay squatting :5000) |
| `BACKEND_BASE_URL` | — | `http://localhost:3000` | `http://localhost:3000` | Where cf/ml call `/internal/signed-url` |
| `INTERNAL_SERVICE_TOKEN` | required | required | required | Shared bearer for backend ↔ cf/ml. Rotate per env. |
| `CHUNKS_DOWNLOAD_TTL_SECONDS` | `1800` | — | — | TTL for chunks/ signed download URLs (30 min default) |
| `SUPABASE_URL` | Supabase project URL | — | Supabase project URL | Backend needs it for file storage; ml needs it for pgvector |
| `SUPABASE_SERVICE_ROLE_KEY` | required | — | required | Server-side only, bypasses RLS. **ml never accesses Storage — only pgvector**. |
| `SUPABASE_BUCKET` | required | — | — | Bucket for uploaded files and staged chunks (chunks live under `chunks/` prefix) |
| `VECTOR_STORE` | — | — | `supabase` (default) or `milvus` | ml only — picks which adapter to boot |
| `SUPABASE_TABLE` | — | — | `document_chunks` | Table must exist — run `ml/sql/supabase_init.sql` once |
| `ZILLIZ_URI` | — | — | Zilliz Serverless endpoint | Only when `VECTOR_STORE=milvus` |
| `ZILLIZ_TOKEN` | — | — | Zilliz API token | Only when `VECTOR_STORE=milvus` — never leaves the ml container |
| `MILVUS_COLLECTION` | — | — | `document_chunks` | Auto-created by ml on boot when using the milvus adapter |
| `EMBEDDING_MODEL` | — | — | `Xenova/all-MiniLM-L6-v2` | HuggingFace id; ONNX weights pre-baked into ml image |
| `EMBEDDING_DIM` | — | — | `384` | Must match the model output dim |

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
   │  Worker picks up the re-enqueued job                     │
   │                                                          │
   │  BullMQ jobId = uploadId dedupe:                         │
   │    - if the "original" job still exists in the queue,    │
   │      the re-add is a silent no-op                        │
   │    - if not, the re-added job runs; upserts to Mongo     │
   │      + vector store are idempotent (keyed by uploadId    │
   │      and uploadId:chunkIndex)                            │
   └──────────────────────────────────────────────────────────┘

              Rule: If it's not in MongoDB, it didn't happen.
              If it IS in MongoDB and hasn't advanced in 10 min,
              ask BullMQ before assuming it's lost.
```

### Recovery sweeper

A scheduled job runs every **5 minutes** on the backend. Stage 1 finds candidates stuck by the clock; stage 2 picks **which queue to ask** based on the record's status, then asks BullMQ what actually happened before acting:

```ts
// runs every 5m
const HEALTHY = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'];

const cutoff = new Date(Date.now() - 10 * 60 * 1000);
const candidates = await Upload.find({
  status: { $in: ['pending', 'ocr_processing', 'ml_processing'] },
  updatedAt: { $lt: cutoff },   // stage 1 — cheap in-memory / index scan
});

for (const upload of candidates) {
  const queue = upload.status === 'ml_processing' ? 'embed' : 'ocr';
  const state = await service.getJobState(upload.id, queue);   // stage 2

  if (state && HEALTHY.includes(state)) continue;

  if (queue === 'ocr') {
    // ocr-queue reconciliation
    if (state === 'completed') { await service.markStatus(upload.id, 'ml_processing'); continue; }
    if (state === 'failed')    { await service.markStatus(upload.id, 'failed');        continue; }
    await service.reenqueueOcr(upload);   // undefined → lost, re-enqueue
  } else {
    // embed-queue reconciliation
    if (state === 'completed') {
      const summary = parsePipelineSummary(await service.getJobReturnValue(upload.id, 'embed'));
      if (summary) await service.markReadyWithSummary(upload.id, summary);
      else         await service.markStatus(upload.id, 'ready');
      continue;
    }
    if (state === 'failed')    { await service.markStatus(upload.id, 'failed'); continue; }
    await service.reenqueueEmbed(upload);   // re-mints chunks/${uploadId}.json signed URL
  }
}
```

### Why this is safe to replay

- **`jobId: uploadId`** — BullMQ dedupes by jobId. Even if the state check races, a duplicate `add` while the original is still queued is a no-op.
- **Stage-2 state check** — the sweeper never re-adds a job that BullMQ still knows about. A 10k-deep backlog produces silent, action-free sweeps; only truly-lost jobs get pushed back in.
- **Terminal-state reconciliation** — if a job completed or failed while the backend was down, the sweeper fixes the record's status instead of blindly re-enqueueing.
- **BullMQ `jobId: uploadId` dedup** catches most double-enqueue races — a duplicate `add` while the original is still queued or in-flight is a no-op. Terminal-state reconciliation runs first in the sweeper, so a completed job is never re-enqueued.
- **Every pipeline step is idempotent** when keyed by `uploadId` (+ `chunkIndex` for vector-store writes). Re-running produces the same result.

### What this protects against

| Scenario | Recovery path |
|---|---|
| Redis restarts and loses in-flight jobs (ocr-queue) | Stage-2 sees `undefined` → sweeper re-enqueues from MongoDB within 5–10 min (`reenqueueOcr` mints fresh download URL) |
| Redis restarts and loses in-flight jobs (embed-queue) | Sweeper `reenqueueEmbed` re-mints signed URL for `chunks/${uploadId}.json` and re-adds. If the chunks file itself is gone, ml throws `CHUNKS_MISSING` (permanent) → next sweep marks failed. |
| Worker crashes after CF enqueues embed job but before ocr-queue completed event fires | Stage-2 finds ocr-queue state=`completed` → transitions upload to `ml_processing`; embed job continues normally |
| Backend down when `completed` / `failed` event fired | Stage-2 (on either queue) finds terminal state → reconciles status without re-running the pipeline |
| Deep queue backlog (10k jobs waiting) | Stage-2 sees `waiting` for every candidate → silent no-op sweep, no runaway re-adds |
| Retries exhausted (`attempts: 3` ocr, `5` embed) → job in failed set | Stage-2 sees `failed` → status marked `failed`; manual retry via admin endpoint |
| Signed URL expires between enqueue and ml pickup | ml classifies Supabase's expired-signature error → calls backend to re-mint → retries download once **in-band** (no BullMQ attempt consumed) |
| Backend deploy while jobs in flight | Nothing lost — jobs continue on workers, events buffered in Redis, backend re-subscribes to both queues on boot |

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
- **Transport worker→ml — async BullMQ `embed-queue` with claim-check payload** (see [Design Decision](#design-decision-cf--ml-transport-sync-http--async-bullmq)):
  - CF pipeline ends with `stage` (PUT chunks JSON to Supabase Storage via backend-minted signed upload URL) and `enqueue` (add job to `embed-queue` with `{ uploadId, chunksPath, chunksSignedUrl }`).
  - ml consumes the embed job, downloads chunks via `chunksSignedUrl`, embeds, upserts to the vector store, deletes the staged chunks file, and returns `{ chunkCount, dim, model, storedAt }` as the pipeline summary.
  - `embed-queue`: `attempts: 5`, exp backoff (~32s cap), `removeOnComplete: 1000`, `removeOnFail: 5000`.
  - Permanent failures (`CHUNKS_MISSING`, `INVALID_INPUT`) are marked with `permanent: true` and surfaced via BullMQ `UnrecoverableError` → no retries wasted.
- **Backend `/internal/signed-url`** (`backend/src/features/internal/`) — bearer-token auth (`INTERNAL_SERVICE_TOKEN`), accepts `{ path, mode: 'upload' | 'download' | 'delete' }`, enforces `chunks/` path prefix. Sole surface through which cf and ml touch Supabase Storage.
- **ml signed-URL fallback** (`ml/src/infra/supabaseErrors.ts` + `backendClient.ts`) — on chunks download failure, ml calls `classifyStorageError` and, only if the response is Supabase's expired-signature error, calls backend to re-mint a fresh URL and retries the download **in-band** (does not consume a BullMQ attempt). Any other 4xx/5xx throws normally.
- **`ml` microservice** (`ml/`) — split into two processes: HTTP server on :5100 (`GET /healthz`, `GET /debug/count[?upload_id=]`, `GET /debug/sample?limit=`, retained `POST /embed` for debug) and BullMQ Worker on `embed-queue` (`npm run worker`). Uses `@xenova/transformers` to run `Xenova/all-MiniLM-L6-v2` locally (384-dim, ONNX, CPU-only). Model + vector store warm up before the worker starts consuming (`autorun: false`).
- **Pluggable vector store** — `ml/src/infra/vectorstore/` exposes a `VectorStore` interface (`init`, `upsert`, `count`, `sample`) with two adapters, selected at boot via `VECTOR_STORE`:
  - **Supabase (`supabase`, default)** — Postgres + pgvector. Table `document_chunks` (schema in `ml/sql/supabase_init.sql`: `pk text pk`, `upload_id`, `chunk_index`, `text`, `embedding vector(384)`, `created_at`; HNSW cosine index on `embedding`, btree on `upload_id`). Auth via `SUPABASE_SERVICE_ROLE_KEY` (bypasses RLS). `init()` verifies table reachability; schema itself is managed as a SQL migration, not created programmatically.
  - **Milvus / Zilliz (`milvus`)** — retained as a pluggable fallback. Collection `document_chunks` auto-created on first boot via `ensureCollection` (`pk`, `upload_id`, `chunk_index`, `text`, `embedding FloatVector(384)`, `created_at`; `AUTOINDEX` on embedding, `COSINE` metric). Upsert response's `error_code` is inspected — failures throw instead of silently succeeding.
  - Upserts in both adapters are keyed by `pk = "${uploadId}:${chunkIndex}"` → BullMQ retries produce overwrites, not duplicates.
  - Debug endpoints use strong consistency (Milvus `ConsistencyLevelEnum.Strong`; Supabase reads from primary) so counts always reflect the latest state, bypassing dashboard/preview lag.
- **Backend `QueueEvents` for both queues** (`backend/src/infra/queueEvents.ts`) — separate subscribers for `ocr-queue` and `embed-queue`. Mongo status transitions: `pending → ocr_processing (ocr active) → ml_processing (ocr completed / embed active) → ready (embed completed) | failed`. On ocr-queue completed, backend emits `ocr:progress {step:'embed', pct:95}`; on embed-queue completed, emits `ocr:completed` with the full summary. Frontend event contract (`ocr:progress` / `ocr:completed` / `ocr:failed`) unchanged.
- **Sweeper for both queues** (`file-upload-ocr.sweeper.ts`) — branches on `record.status`: `ml_processing → check embed-queue`, else `check ocr-queue`. Split reconciliation: an OCR job stuck at `completed` advances to `ml_processing`; an embed job stuck at `completed` marks ready with summary. Reenqueue paths for both queues (embed reenqueue re-mints a signed URL from the deterministic `chunks/${uploadId}.json` path).

## What's Not Wired Yet

- **Search endpoint on `ml`** (`POST /search`) — needed once the chatbot work starts. Same vector-store adapter + same encoder, deferred until then. Will add a `search(vector, limit)` method to the `VectorStore` interface (Supabase RPC using `<=>` cosine distance; Milvus `client.search`).
- **Chatbot / RAG layer** — not started. Will call ml `/search` then hand top-k chunks to an LLM (Claude/OpenAI).
- **Frontend poll fallback** — if a client is offline for the full lifetime of a job (past reconnect window and sweeper interval), the synthetic-replay branch covers most gaps, but a background `GET /uploads/:id` refresh on tab-focus would close the last window.
- **Chunks-bucket lifecycle policy** — orphan chunk files (e.g. from an embed job that failed all 5 attempts and left the file undeleted) currently linger. A Supabase Storage lifecycle rule on the `chunks/` prefix (delete after 24h) would clean these up automatically. Small volume today; wire when it matters.

---

## Design Decision: cf → ml Transport (Sync HTTP → Async BullMQ)

**Status**: **implemented**. The migration is live — CF stages chunks to Supabase Storage and enqueues to `embed-queue`; ml consumes and upserts. Sync `POST /embed` remains on ml as a debug escape hatch but is not part of the main flow.

### Why move off sync HTTP

1. **OCR worker slot blocking** — the CF worker task is held for the full duration of ml encode + upsert. On a 500MB doc producing hundreds of chunks, embed can take 30s–2min. During that window the worker slot is unavailable for other OCR jobs, so **ml latency directly caps OCR throughput**.
2. **Failure blast radius** — a transient ml hiccup fails the entire OCR job. BullMQ then retries the whole pipeline (download → detect → OCR → clean → chunk → embed) even though only the last step failed. Wasteful and slow, especially for large scanned PDFs where the OCR step is the expensive one.
3. **No independent scaling** — ml sits behind sync HTTP with no queue-depth signal. Can't autoscale ml on backlog; can only guess from request rate.
4. **No natural backpressure** — if ml slows down, CF workers accumulate open HTTP connections instead of jobs accumulating in a queue where they can be measured, drained, and prioritized.

### Target architecture

```
CF worker (ocr-queue consumer)
  download → detect → ocr → clean → chunk
  → upload chunks JSON to Supabase Storage: chunks/${uploadId}.json
  → embed-queue.add({ uploadId, chunksPath, signedUrl })
  → ocr-queue job completed

ml worker (embed-queue consumer)
  → fetch chunks JSON via signedUrl (fallback: re-mint via backend if expired)
  → encode + upsert to vector store
  → delete chunks JSON
  → embed-queue job completed
```

### Payload strategy — claim check via Supabase Storage

For 500MB × 4 uploads, a single doc can produce hundreds of chunks with a total chunks-JSON payload of several MB. **Redis is not a payload store** — cramming multi-MB JSON into job data inflates memory, slows every queue op, and breaks introspection tools.

**Claim-check pattern**: CF uploads chunks JSON to a dedicated `chunks/` prefix in Supabase Storage. The queue job carries a small pointer: `{ uploadId, chunksPath, signedUrl }`. ml downloads it, embeds, then deletes it. Redis only ever carries KB-sized job data regardless of doc size.

### Signed-URL strategy — URL in queue, mint-on-demand fallback

ml must not hold the Supabase service-role key (see [Security Boundary](#security-boundary)). Chunks are downloaded via signed URL, with a hybrid strategy to handle URL expiry mid-queue:

1. CF requests a signed URL from backend (`POST /internal/signed-url`, service-token auth) with a generous TTL (30 min). URL goes in the queue payload.
2. ml uses the URL directly. **Happy path: no extra backend hop.**
3. On download failure, ml **classifies the error**:
   - Supabase-specific expired-signature error → call `POST /internal/signed-url` for a fresh URL, retry download once in-band. Does **not** consume a BullMQ retry attempt.
   - Any other 403 / 404 / network error → throw, let BullMQ retry per policy.

**Error classification is critical**: a genuinely missing object must not trigger an infinite re-mint loop. ml parses the Supabase error body and only re-mints on the expiry-specific error code. One place, well-tested (`parseSupabaseStorageError` helper), so the retry logic doesn't drift.

### Retry & error handling policy

**embed-queue configuration**:
- `attempts: 5` — higher than ocr-queue's 3 because embed has more transient failure modes: signed-URL expiry, model warm-up, vector-store rate limits.
- `backoff: { type: 'exponential', delay: 2000 }` — caps around ~32s at attempt 5.
- `removeOnComplete: 1000`, `removeOnFail: 5000` (mirrors ocr-queue).

**Failure taxonomy**:

| Failure | Retryable? | Handling |
|---|---|---|
| Signed URL expired | in-band | ml re-mints via backend, retries download; **does not consume a BullMQ attempt** |
| Chunks file 404 / deleted | no | throw with `CHUNKS_MISSING` → fail permanent, alert |
| Vector store transient (5xx, rate limit) | yes, up to 5 | throw → BullMQ backoff + retry |
| Vector store auth failure (401/403) | no | throw with `CREDS_INVALID` → fail permanent, page ops |
| Model encode failure | yes, up to 5 | throw → BullMQ backoff + retry (may be transient OOM / GC pressure) |
| Chunk validation (empty, malformed) | no | throw with `INVALID_INPUT` → fail permanent |

**Terminal reconciliation**: backend widens `QueueEvents` to subscribe to `embed-queue`. Mongo status transitions become:

```
pending → ocr_processing → ocr_done → embedding → ready | failed
```

The sweeper is extended to check both queues per candidate — stage-2 state check runs against whichever queue the record's current status implies is active (`ocr_processing` → `ocr-queue`, `embedding` → `embed-queue`).

**Cleanup**: on `embed-queue completed`, ml deletes the staged chunks file. On terminal `failed` after all retries, the sweeper deletes it during reconciliation. Files are left in place while a job is still retryable so re-mints have something to fetch.

### Tradeoffs accepted

- **More moving parts** — second queue, second worker set, second progress source, more state transitions in Mongo. Bought with scaling + failure isolation.
- **Extra I/O per job** — CF writes chunks to Storage; ml reads them back. For sub-MB payloads this is slower than the sync HTTP path. Worth it only because worst-case payloads are multi-MB and the failure/scaling wins are significant.
- **Signed-URL error classification is fiddly** — two failure modes look identical to a naive HTTP client. Requires the `parseSupabaseStorageError` helper to stay reliable; without it, retry storms are one bug away.

### Alternatives considered (not chosen)

- **Long-TTL signed URL, no re-mint** — simplest, but TTL must exceed `retention + max_retries × max_backoff + buffer`. Bigger leak window and doesn't survive multi-hour queue delays.
- **Pure mint-on-demand (no URL in payload)** — cleanest security story but adds one backend HTTP call per embed job unconditionally. Loses the happy-path optimization.
- **Give ml Supabase Storage read/delete creds scoped to the `chunks/` prefix** — removes the signed-URL dance entirely, but widens ml's blast radius. Kept as a future option if signed-URL overhead ever becomes measurable.

---

## Security Boundary

- **Backend** is the only holder of the Supabase service-role key. It mints per-object signed URLs (`SupabaseStorageService.createSignedDownloadUrl`) and attaches them to job payloads.
- **Cloud-function worker** has no Supabase credentials whatsoever. It reads a signed URL from `job.data.downloadUrl` and fetches with global `fetch`. Even if the worker container is compromised, the attacker gets access only to the specific files currently in queue payloads, only for the URL's remaining TTL.
- **ml service** is the only holder of vector-store credentials — currently `SUPABASE_SERVICE_ROLE_KEY` (Postgres admin, bypasses RLS); when `VECTOR_STORE=milvus`, `ZILLIZ_TOKEN` instead. Neither backend nor worker can talk to the vector store directly — they must go through the ml HTTP surface. Compromising the worker gives an attacker the ability to enqueue embed requests, not to read or wipe the vector store.
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
Historical note — Pattern 1 (Sync) was the initial implementation:
  Worker → POST /embed on ML Service → wait for 200 OK → storeMetadata.
  Migrated to the async embed-queue + claim-check pattern (drawn above)
  once we started sizing for 500MB × 4-file uploads. See the
  "cf → ml Transport" design decision earlier in this doc for the full
  rationale. The sync POST /embed endpoint is retained on ml only as a
  debug escape hatch, not part of the main flow.
────────────────────────────────────────────────────────────────────
```

| Layer | Now (dev) | Hybrid (prod) | Trigger to migrate |
|---|---|---|---|
| Queue transport | Redis (Docker) | **ElastiCache Redis** (Multi-AZ) | Any real production traffic |
| Worker runtime | `npm run worker` on VPS | **ECS Fargate** tasks, autoscale on queue depth | >4 concurrent jobs sustained |
| OCR — text PDFs | `pdf-parse` | `pdf-parse` (unchanged, ~free) | — |
| OCR — scanned PDFs / images | `tesseract.js` | **AWS Textract** async API (`StartDocumentAnalysis`) | Quality complaints, or files >20 pages |
| ML / embeddings | Node ml service on VPS, BullMQ worker on `embed-queue` (Xenova MiniLM-L6-v2, 384-dim) | **In-house ML Service** on ECS Fargate (larger model or Python) — same queue shape, same claim-check pattern | Latency or model-quality limits of the Xenova ONNX runtime |
| Vector store | Supabase pgvector (default) / Milvus (fallback) — owned by ml, worker never touches it | **Milvus / OpenSearch / Pinecone** — same `VectorStore` interface, swap the adapter | Scale or query-latency ceiling on pgvector |
| ML → backend signalling | `embed-queue` `QueueEvents` `completed`/`failed` → backend markReady + Socket.IO fan-out | Same (BullMQ QueueEvents continues to work on ElastiCache) | — |
| Chunks payload transport | Claim check: `chunks/${uploadId}.json` in Supabase Storage; queue carries signed URL | Claim check: `chunks/${uploadId}.json` in **S3**; queue carries signed URL (same pattern) | With S3 migration |

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
