# File Upload + OCR Pipeline (Interview Explanation)

## Goal

Keep the API lightweight while supporting large file uploads and background OCR work. Nothing blocks the user, nothing blocks the API.

---

## 1. Upload — file never touches the backend

The Angular frontend asks the Express backend for a pre-signed **Supabase Storage** URL. The backend generates the URL for a unique path and returns it. The frontend then PUTs the file **directly to storage**.

- Backend bandwidth stays low
- Large files work naturally
- No memory pressure on the backend

---

## 2. Register upload — backend enqueues an OCR job

Once the upload finishes, the frontend calls `POST /complete`. The backend:

1. Inserts an `UploadRecord` in **MongoDB** with `status: 'pending'`
2. Mints a short-lived signed **download URL** for the stored object
3. Enqueues a job into the **BullMQ `ocr-queue`** (Redis) with `jobId = uploadId` so we can look the job up later by upload
4. Returns the record to the client

The API is fast and non-blocking. All OCR work happens elsewhere.

---

## 3. OCR Worker (`cloud-function`) — separate process

A standalone Node process (`cloud-function/`) runs a **BullMQ `Worker` on `ocr-queue`**. It runs the pipeline in one job:

```
download → detect → ocr → clean → chunk → store
```

At each step it calls `job.updateProgress({ step, pct })`, which BullMQ publishes as a `progress` event on Redis. `storeMetadata` currently just logs the summary.

---

## 4. Status flow — sockets driven by BullMQ QueueEvents

Nobody calls back to the backend or the frontend. Workers only write **forward**: they update job progress and return. Status reaches the user via events, not direct calls.

- OCR worker calls `job.updateProgress(...)` and eventually returns → BullMQ publishes `active` / `progress` / `completed` / `failed` events on Redis.
- Backend has a `QueueEvents` subscriber on **`ocr-queue`** (`infra/queueEvents.ts`) listening for those events.
- On each event the backend:
  - Updates the MongoDB status (`active → ocr_processing`, `completed → ready`, `failed → failed`)
  - Emits a Socket.IO event to the room `upload:${uploadId}` (`ocr:progress`, `ocr:completed`, `ocr:failed`)
- The frontend joined that room right after `/complete`, so it receives live updates: step name + percentage as the pipeline advances, and a completion / failure event at the end.

On (re)subscribe the backend also **replays terminal state** — if the upload is already `ready` or `failed` when a client joins the room, it emits a synthetic `ocr:completed` / `ocr:failed` so a reconnecting client doesn't hang.

---

## 5. Sweeper — reconcile stuck uploads

Because status lives in Mongo but the source of truth is BullMQ, they can drift (backend restart in the middle of a job, missed event, etc.). A periodic **sweeper** (`file-upload-ocr.sweeper.ts`) runs every 5 min and, for uploads still in-flight past a 10 min threshold:

- If BullMQ says the job is healthy (`waiting`/`active`/`delayed`/...): leave it alone
- If BullMQ says `completed`: mark Mongo `ready`
- If BullMQ says `failed`: mark Mongo `failed`
- Otherwise (job vanished): **re-enqueue** it

This keeps the two stores in sync without any manual intervention.

---

## 6. Ownership boundaries

| Component | Owns | Never touches |
|---|---|---|
| **Backend (Express)** | MongoDB status, Socket.IO fan-out, API layer, sweeper | Storage object bytes, OCR logic |
| **OCR Worker (`cloud-function`)** | Full pipeline (download, detect, extract, clean, chunk, store) | Frontend, Socket.IO, direct DB writes |

Two rules fall out of this:

- **Only the backend talks to the frontend.** The worker never emits sockets or calls a frontend/backend API.
- **Workers report status by BullMQ events**, not direct calls. Backend translates those into Mongo writes + Socket.IO emits.

---

## 7. What's Wired Today

- Presigned upload against **Supabase Storage**
- `POST /complete` → Mongo `UploadRecord` + `ocr-queue` enqueue (`jobId = uploadId`)
- `cloud-function` worker executes the pipeline: `download → detect → ocr → clean → chunk → store`
- Per-step `job.updateProgress({ step, pct })`
- Backend `QueueEvents` on `ocr-queue` (`active` / `progress` / `completed` / `failed`)
- Mongo status transitions: `pending → ocr_processing → ready | failed`
- Socket.IO server on the same HTTP port; rooms `upload:${uploadId}`
- Terminal-state **replay** on late subscribe
- Frontend `SocketService` + progress UI in `file-upload` component
- Stuck-upload **sweeper** (every 5 min, 10 min threshold)

---

## 8. Why this scales

Each component is independent, so we scale the bottleneck — not the whole system:

- OCR slow? → Add more `cloud-function` worker instances.
- Backend only handles API + sockets + orchestration → doesn't need heavy CPU, scales on connection count.

BullMQ handles retries, backoff, and DLQ for us. Redis is the single transport for both jobs and status events.

---

## TL;DR

- Frontend → **Supabase Storage** (direct, presigned)
- Frontend → Backend (`/complete`) → **MongoDB** + **`ocr-queue`**
- `cloud-function` Worker consumes `ocr-queue` and runs the pipeline
- Backend listens to `ocr-queue` `QueueEvents` → updates Mongo + pushes updates to the frontend via **Socket.IO** room `upload:${uploadId}`
- A **sweeper** reconciles Mongo status against BullMQ job state
