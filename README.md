# scalable-file-upload

Monorepo demonstrating a scalable async file-upload → OCR → embeddings pipeline. Angular frontend, Node/Express backend, plus two supporting services (cloud-function worker for OCR, ml service for embeddings + vector store).

## Structure

```
.
├── frontend/            # Angular app (upload UI + Socket.IO status)
├── backend/             # Express API + BullMQ producer + QueueEvents + sweeper
├── cloud-function/      # OCR pipeline — BullMQ consumer on `ocr-queue`
├── ml/                  # Embeddings service — BullMQ consumer on `embed-queue`
├── docker-compose.yml
├── dev.sh               # local dev launcher (starts all services)
├── .gitignore
└── README.md
```

## Features

| Feature | Description | Services involved | Docs |
|---|---|---|---|
| **File Upload + OCR + Embeddings** | User uploads a file (PDF / image / text) directly to Supabase Storage via a backend-minted signed URL. Backend records the upload in Mongo and enqueues an `ocr-queue` job. Cloud-function worker consumes it: downloads → detects type → extracts text (Tesseract for images, pdf-parse for PDFs) → cleans → chunks → stages chunks JSON back to Storage → enqueues an `embed-queue` job. ML service consumes that: downloads chunks (in-band signed-URL refresh on expiry) → encodes with `Xenova/all-MiniLM-L6-v2` (384-dim ONNX) → upserts to pgvector (Supabase). Backend fans progress + terminal events over Socket.IO room `upload:${uploadId}`. Recovery sweeper runs every 5 min to reconcile stuck records against both queues. | frontend · backend · cloud-function · ml · redis · mongo · supabase (storage + pgvector) | [arch](./backend/src/features/file-upload-ocr/arch.md) · [explain](./backend/src/features/file-upload-ocr/explain.md) |

## Development

**Local (native + Docker Redis)** — one command starts everything:

```bash
./dev.sh                  # start all services (redis in docker, everything else native)
./dev.sh --no-infra       # skip docker redis (if you already have one running)
```

Requires Mongo running natively: `brew services start mongodb-community`.

Per-service (if you prefer):

```bash
cd frontend       && npm install && npm start        # → :4200
cd backend        && npm install && npm run dev      # → :3000
cd cloud-function && npm install && npm run dev      # → :4000  (health + ocr-queue worker)
cd ml             && npm install && npm run dev      # → :5100  (health + debug + embed-queue worker)
```

## Docker

```bash
docker compose up --build
```

| Service | URL |
|---|---|
| Frontend | http://localhost:4200 |
| Backend | http://localhost:3000 |
| Cloud function (health) | http://localhost:4000/health |
| ML (health) | http://localhost:5100/healthz |
