# File Upload + OCR Pipeline (Interview Explanation)

## Goal

Keep the API lightweight while supporting large file uploads and background OCR + embedding work. Nothing blocks the user, nothing blocks the API, and each stage of the pipeline can be scaled independently.

---

## 1. Upload — file never touches the backend

The Angular frontend asks the Express backend for a pre-signed **Supabase Storage** URL. The backend generates the URL for a unique path and returns it. The frontend then PUTs the file **directly to storage**.

- Backend bandwidth stays low
- Large files work naturally
- No memory pressure on the backend

---

## 2. Register upload — backend enqueues an OCR job

Once the upload finishes, the frontend calls `POST /upload/complete`. The backend:

1. Inserts an `UploadRecord` in **MongoDB** with `status: 'pending'`
2. Mints a short-lived signed **download URL** for the stored object
3. Enqueues a job into the **BullMQ `ocr-queue`** (Redis) with `jobId = uploadId` so we can look the job up later by upload
4. Returns the record to the client

The API is fast and non-blocking. All heavy work happens elsewhere.

---

## 3. OCR Worker (`cloud-function`) — separate process

A standalone Node process (`cloud-function/`) runs a **BullMQ `Worker` on `ocr-queue`**. It runs the OCR half of the pipeline in one job:

```
download → detect → ocr → clean → chunk → stage → enqueue → store
```

At each step it calls `job.updateProgress({ step, pct })`, which BullMQ publishes as a `progress` event on Redis.

The last two "real work" steps are the handoff to embedding:

- **stage** — writes the chunk array as JSON to Supabase Storage at `chunks/${uploadId}.json`. Cloud-function does not hold Supabase credentials directly; it asks the backend for a short-lived signed upload URL via `POST /internal/signed-url` (authenticated with an internal service token), then PUTs the JSON to that URL.
- **enqueue** — pushes an `embed` job into a **second BullMQ queue, `embed-queue`**, with `jobId = uploadId` and payload `{ uploadId, chunksPath, chunksSignedUrl }`.

`storeMetadata` just logs a summary of the OCR job. The OCR worker never talks to the ml service directly and never writes vectors.

---

## 4. Embedding Worker (`ml`) — separate process

The `ml/` service is **also a BullMQ Worker**, consuming `embed-queue`. It runs alongside a small HTTP surface used only for health and debugging (`/healthz`, `/debug/count`, `/debug/sample`); embedding is not exposed as an HTTP endpoint — the queue is the only entry point.

For each embed job the worker:

1. Downloads the staged chunk JSON from the signed URL. If the URL has expired, it calls back to the backend (`POST /internal/signed-url` with mode `download`) to mint a fresh one and retries once.
2. Validates the payload with Zod. Malformed payloads throw a `permanent` error, which is wrapped as a BullMQ `UnrecoverableError` so BullMQ won't retry.
3. Encodes each chunk with a local ONNX model (`Xenova/all-MiniLM-L6-v2`, 384-dim) and upserts the vectors into the configured vector store (Supabase pgvector by default; Milvus/Zilliz as a pluggable fallback via `VECTOR_STORE`). Upsert key is `${uploadId}:${chunkIndex}` so retries overwrite instead of duplicating.
4. Deletes the staged chunks blob (`POST /internal/signed-url` with mode `delete`) — best effort; a warning is logged on failure.
5. Returns a `PipelineSummary` `{ chunkCount, model, dim, storedAt }` as the job's return value.

The ml worker never talks to Mongo, Socket.IO, or the frontend.

---

## 5. Status flow — sockets driven by BullMQ QueueEvents

Nobody calls back to the backend or the frontend. Workers only write **forward**: they update job progress and return. Status reaches the user via events on both queues, not direct calls.

The backend runs **two `QueueEvents` subscribers** in `infra/queueEvents.ts` — one on `ocr-queue`, one on `embed-queue`.

**`ocr-queue` events:**
- `active` → Mongo `ocr_processing`
- `progress` → Socket.IO `ocr:progress` to room `upload:${uploadId}`
- `completed` → Mongo `ml_processing` (the record is not yet ready — embedding still has to run) and a synthetic `ocr:progress { step: 'embed', pct: 95 }` is emitted so the UI keeps moving
- `failed` → Mongo `failed`, Socket.IO `ocr:failed`

**`embed-queue` events:**
- `active` → Mongo `ml_processing`
- `completed` → parse the return value as `PipelineSummary`; on success write it via `markReadyWithSummary` (Mongo `ready` + summary attached), otherwise fall back to plain `ready`. Emit Socket.IO `ocr:completed` with the return value.
- `failed` → Mongo `failed`, Socket.IO `ocr:failed`

The frontend joined `upload:${uploadId}` right after `/upload/complete`, so it receives live progress across the OCR phase and a completion / failure event once embedding is done.

On (re)subscribe the backend also **replays terminal state** — if the upload is already `ready` or `failed` when a client joins the room, it emits a synthetic `ocr:completed` / `ocr:failed` (marked `replayed: true`) so a reconnecting client doesn't hang.

---

## 6. Status transitions

The Mongo `UploadRecord.status` field walks through:

```
pending → ocr_processing → ml_processing → ready
                                        ↘ failed
```

Every transition is written by the backend's QueueEvents subscribers, never by the workers. `IN_FLIGHT_STATUSES` (`pending | ocr_processing | ml_processing`) is what the sweeper considers "stuck-eligible."

---

## 7. Sweeper — reconcile stuck uploads

Because status lives in Mongo but the source of truth is BullMQ, they can drift (backend restart in the middle of a job, missed event, etc.). A periodic **sweeper** (`file-upload-ocr.sweeper.ts`) runs every 5 min and, for uploads still in-flight past a 10 min threshold, picks the right queue based on the record's status (`ml_processing` → `embed`, otherwise `ocr`) and reconciles:

- If BullMQ says the job is healthy (`waiting`/`active`/`delayed`/`waiting-children`/`prioritized`): leave it alone.
- If the OCR job is `completed`: promote Mongo to `ml_processing`.
- If the embed job is `completed`: parse its return value and write `ready` (with summary if parseable).
- If either job is `failed`: mark Mongo `failed`.
- Otherwise (job vanished): **re-enqueue** on the appropriate queue via `reenqueueOcr` / `reenqueueEmbed` (the embed re-enqueue mints a fresh chunks download URL first).

This keeps Mongo and BullMQ in sync without any manual intervention.

---

## 8. Ownership boundaries

| Component | Owns | Never touches |
|---|---|---|
| **Backend (Express)** | MongoDB status, Socket.IO fan-out, API layer, sweeper, `/internal/signed-url` (Supabase credential holder) | Storage object bytes, OCR logic, embedding, vector store |
| **OCR Worker (`cloud-function`)** | OCR pipeline (download, detect, extract, clean, chunk), staging chunks to storage, enqueueing embed jobs | Frontend, Socket.IO, direct DB writes, embedding, vector store, direct Supabase credentials |
| **ML Worker (`ml`)** | `embed-queue` consumer, text → 384-dim embedding, vector-store writes via the pluggable adapter, cleaning up staged chunks after success | Frontend, Socket.IO, MongoDB, OCR, direct Supabase credentials |

Three rules fall out of this:

- **Only the backend talks to the frontend.** Neither worker emits sockets or calls a frontend/backend API (except the internal signed-url helper).
- **Only the backend holds Supabase Storage credentials.** Workers get short-lived signed URLs via `POST /internal/signed-url`.
- **Workers report status by BullMQ events**, not direct calls. Backend translates those into Mongo writes + Socket.IO emits.

---

## 9. What's wired today

- Presigned upload against **Supabase Storage**
- `POST /upload/complete` → Mongo `UploadRecord` + `ocr-queue` enqueue (`jobId = uploadId`)
- `cloud-function` worker executes: `download → detect → ocr → clean → chunk → stage → enqueue → store`
- `POST /internal/signed-url` (bearer-token auth) mints upload / download / delete URLs for the `chunks/${uploadId}.json` blob
- `ml` worker on `embed-queue` consumes staged chunks, embeds with `Xenova/all-MiniLM-L6-v2` (384-dim), upserts vectors, deletes staged blob
- Per-step `job.updateProgress({ step, pct })` on the OCR job
- Backend `QueueEvents` on **both** `ocr-queue` and `embed-queue`
- Mongo status transitions: `pending → ocr_processing → ml_processing → ready | failed`
- Socket.IO server on the same HTTP port; rooms `upload:${uploadId}`
- Terminal-state **replay** on late subscribe
- Frontend `SocketService` + progress UI in `file-upload` component
- Stuck-upload **sweeper** (every 5 min, 10 min threshold) covering both queues
- **`ml` microservice** on :5100 — `GET /healthz`, `GET /debug/count`, `GET /debug/sample` (embedding is queue-only, no HTTP endpoint)
- **Pluggable vector store** — `VectorStore` interface with Supabase (pgvector, default) and Milvus/Zilliz adapters, switched via `VECTOR_STORE` env; upsert keyed by `${uploadId}:${chunkIndex}`
- `UnrecoverableError` on malformed embed payloads so BullMQ skips retries
- Signed-URL refresh: if the ml worker's chunks URL is expired at fetch time, it re-mints via the backend and retries once

---

## 10. Why this scales

Each stage is a separate process consuming its own queue, so we scale the bottleneck — not the whole system:

- OCR slow? → Add more `cloud-function` worker instances.
- Embedding slow? → Add more `ml` worker instances (independent of OCR concurrency).
- Backend only handles API + sockets + orchestration → doesn't need heavy CPU, scales on connection count.

BullMQ handles retries, backoff, and DLQ for us. Redis is the single transport for jobs and status events across both queues.

---

## TL;DR

- Frontend → **Supabase Storage** (direct, presigned)
- Frontend → Backend (`/upload/complete`) → **MongoDB** + **`ocr-queue`**
- `cloud-function` Worker consumes `ocr-queue`, runs the OCR pipeline, stages chunks to Supabase (via `/internal/signed-url`), and enqueues an **`embed-queue`** job
- `ml` Worker consumes `embed-queue`, downloads the staged chunks, encodes them, and upserts vectors into the active store (**Supabase pgvector** by default; Milvus/Zilliz as a pluggable fallback)
- Backend listens to `QueueEvents` on **both** queues → updates Mongo (`pending → ocr_processing → ml_processing → ready | failed`) + pushes updates to the frontend via **Socket.IO** room `upload:${uploadId}`
- A **sweeper** reconciles Mongo status against BullMQ job state on both queues
