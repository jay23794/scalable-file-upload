# Production File Upload + OCR + ML Pipeline (Interview Explanation)

## Goal

Keep the backend lightweight while supporting large file uploads and heavy AI processing. Nothing blocks the user, nothing blocks the API.

---

## 1. Upload — file never touches the backend

The Angular frontend first asks the Express backend for a pre-signed S3 URL. The backend generates the URL, creates a unique `uploadId`, and returns both to the client.

The frontend then uploads the file **directly to S3**. This means:

- Backend bandwidth stays low
- Large files (and multipart uploads) work naturally
- No memory pressure on the backend

---

## 2. Register upload — backend enqueues an OCR job

Once the upload finishes, the frontend calls `POST /complete`. The backend:

1. Validates the upload
2. Inserts an `UploadRecord` in MongoDB with `status: pending`
3. Enqueues a job into the **BullMQ `ocr-queue`** (stored in Redis)
4. Immediately returns 202 to the client

The API is fast and non-blocking. OCR and ML work happens elsewhere.

---

## 3. OCR Worker — a separate ECS Fargate service

The OCR Worker is a **BullMQ `Worker` on `ocr-queue`**, running as its own Fargate service. It:

1. Streams the file directly from S3
2. Detects the file type
   - Text-based PDF → `pdf-parse` (fast, free)
   - Scanned PDF / image → **AWS Textract**
3. Cleans the extracted text and splits it into chunks
4. Updates MongoDB (`ocr_done`, chunk count, summary)
5. **Enqueues a new job into `ml-queue`** with the chunks

The OCR worker never generates embeddings itself — Single Responsibility. It just hands off to the next queue.

---

## 4. ML Service — another independent ECS Fargate service (Python)

The ML Service is a **BullMQ `Worker` on `ml-queue`**. It:

1. Computes vector embeddings for each chunk
2. Writes vectors directly into **Milvus**
3. Returns from the worker function (BullMQ auto-publishes `completed`)

**Milvus is owned entirely by the ML service.** The backend and OCR worker never touch it. Clean ownership = easier to scale and maintain each piece independently.

---

## 5. Status flow — nobody "talks back"

Every service only writes **forward**: to the next queue, or by returning from a worker. Nobody makes callbacks to the backend or the frontend.

Progress reaches the user via BullMQ events, not direct calls:

- OCR Worker calls `job.updateProgress({...})` and returns → BullMQ publishes `progress` / `completed` events to Redis.
- ML Service does the same on `ml-queue`.
- Backend has two `QueueEvents` subscribers — one on each queue — listening for `progress`, `completed`, `failed`.
- When an event fires, the backend updates MongoDB **and** emits a Socket.IO event to the room `upload:${uploadId}`.
- Frontend joined that room after upload, so it receives real-time updates: `"OCR Started"` → `"50%"` → `"OCR Finished"` → `"Embedding Started"` → `"Processing Complete"`.

---

## 6. Ownership boundaries (the important part)

| Component | Owns | Never touches |
|---|---|---|
| **Backend** | MongoDB status, Socket.IO fan-out, API layer | Milvus, OCR logic, embedding logic |
| **OCR Worker** | Text extraction, chunking, enqueueing to `ml-queue` | Milvus, frontend, MongoDB write beyond OCR summary |
| **ML Service** | Embeddings, Milvus writes | MongoDB, frontend, OCR logic |

Two rules fall out of this:

- **Only the backend talks to the frontend.** Workers never emit sockets or call frontend APIs.
- **Only the ML service writes to Milvus.** No race conditions on the vector store.

---

## 7. Why this scales

Each component is independent, so we scale the bottleneck — not the whole system:

- OCR slow? → Add more OCR worker tasks on Fargate.
- Embedding slow? → Add more ML service tasks.
- Backend only handles API + sockets + orchestration → doesn't need heavy CPU, scales on connection count.

BullMQ handles retries, backoff, and DLQ for us. Redis is the single transport for both jobs and status events.

---

## TL;DR

- Frontend → S3 (direct, presigned)
- Frontend → Backend (`/complete`) → **`ocr-queue`**
- OCR Worker consumes `ocr-queue` → **`ml-queue`**
- ML Service consumes `ml-queue` → **Milvus**
- Backend listens to events on **both** queues → pushes updates to frontend via Socket.IO
- Nobody calls anyone — everything is queues + events
