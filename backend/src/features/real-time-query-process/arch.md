# Real-Time Query Process — Architecture

End-to-end architecture for the RAG (Retrieval-Augmented Generation) query system. Users ask natural-language questions against uploaded documents and connected data sources; responses stream back in real time over sockets.

---

## Feature Overview

A real-time AI query system that allows users to ask natural-language questions against uploaded documents and connected data sources.

Users can select:

- **AI model** (for example Gemini)
- **Connectors** such as uploaded documents
- **Multiple data sources**

The system uses **Retrieval-Augmented Generation (RAG)** to retrieve relevant document content and generate grounded responses. Responses are streamed back to users in real time using socket-based communication.

---

## Components

| Component | Role | Port | Command |
|---|---|---|---|
| **Frontend (Angular)** | User picks model + connectors, submits query, renders streamed tokens | 4200 | `cd frontend && npm start` |
| **Backend API (Express)** | Orchestrator — validates query, routes to ML service, streams response back over Socket.IO | 3000 | `cd backend && npm run dev` |
| **Redis** | Pub/sub transport for stream tokens between ML service and backend | 6379 | `docker start redis` |
| **ML Service (Python)** | Query embedding, Milvus search, LLM inference, token streaming | 5000 | `cd ml-service && uvicorn app:app` |
| **Milvus** | Vector DB — stores embeddings, text chunks, and metadata (owned by ML service) | 19530 | — |
| **LLM Provider** | Gemini / other — invoked by ML service with query + retrieved context | — | (external) |

---

## High-Level Diagram

```
                       ┌────────────────────┐
                       │  Frontend (Angular)│
                       │       :4200        │
                       └─────────┬──────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 │  1. POST /query               │
                 │     { query, model,           │
                 │       connectors[] }          │
                 │  2. WebSocket subscribe       │
                 │     room: query:${queryId}    │
                 ▼                               │
        ┌────────────────────┐                   │
        │  Backend API       │                   │
        │  Express :3000     │                   │
        │  + Socket.IO       │                   │
        │                    │                   │
        │  - validate query  │                   │
        │  - resolve model   │                   │
        │  - resolve         │                   │
        │    connectors      │                   │
        │  - build payload   │                   │
        │  - forward to ML   │                   │
        └─────────┬──────────┘                   │
                  │                              │
                  │  3. POST /infer (stream)     │
                  │     { queryId, query,        │
                  │       model, connectors }    │
                  ▼                              │
        ┌───────────────────────────────────────────┐
        │  ML Service (Python)                      │
        │                                           │
        │  Pipeline (each step reports progress):   │
        │    embedQuery      ← embedding    (15%)   │
        │      model                                │
        │    searchMilvus    → top-K chunks (35%)   │
        │    buildContext    → text + meta  (50%)   │
        │    invokeLLM       → Gemini /     (65%)   │
        │                      other, stream        │
        │    streamTokens    → publish per   (…)    │
        │                      token                │
        │    finalize        → completion   (100%)  │
        │                                           │
        │  Publishes tokens & events to Redis       │
        │  channel: query:${queryId}                │
        └─────────┬───────────────────────┬─────────┘
                  │                       │
                  │                       │  4. Milvus search
                  │                       ▼
                  │             ┌──────────────────────┐
                  │             │ Milvus               │
                  │             │ (vector DB)          │
                  │             │  • embeddings        │
                  │             │  • text chunks       │
                  │             │  • metadata          │
                  │             └──────────────────────┘
                  │
                  │  5. token / progress / done / error
                  ▼
        ┌────────────────────┐
        │  Redis :6379       │
        │  pub/sub channel:  │
        │  query:${queryId}  │
        └─────────┬──────────┘
                  │
                  │  6. Backend subscribes
                  ▼
        ┌────────────────────┐
        │  Backend API       │
        │  redis.subscribe   │
        │  .on('token')      │
        │  .on('progress')   │
        │  .on('done')       │
        │  .on('error')      │
        └─────────┬──────────┘
                  │
                  │  7. Socket.IO emit
                  │     to room: query:${queryId}
                  ▼
        ┌────────────────────┐
        │  Frontend          │
        │  progressive       │
        │  token render      │
        └────────────────────┘
```

---

## End-to-End Query Sequence

```
Frontend         Backend            ML Service        Milvus         LLM
   │                │                    │              │             │
   │  WS connect    │                    │              │             │
   │───────────────▶│                    │              │             │
   │                                                                  │
   │  POST /query   │                                                 │
   │───────────────▶│                                                 │
   │                │  validate + resolve                             │
   │                │  connectors/model                               │
   │                │                                                 │
   │  { queryId }   │                                                 │
   │◀───────────────│                                                 │
   │                                                                  │
   │  WS subscribe  │                                                 │
   │  room:queryId  │                                                 │
   │───────────────▶│                                                 │
   │                │  POST /infer (stream)                           │
   │                │───────────────────▶│                            │
   │                │                    │  embedQuery                │
   │                │                    │                            │
   │                │                    │  search(topK)              │
   │                │                    │───────────▶│               │
   │                │                    │  hits[]    │               │
   │                │                    │◀───────────│               │
   │                │                    │                            │
   │                │                    │  buildContext              │
   │                │                    │                            │
   │                │                    │  invoke(query + ctx)       │
   │                │                    │───────────────────────────▶│
   │                │                    │                            │
   │                │                    │◀─── token stream ──────────│
   │                │                    │                            │
   │                │  publish 'token' on Redis                       │
   │                │◀───────────────────│                            │
   │  socket 'token'│                                                 │
   │◀───────────────│                                                 │
   │  (repeat per token)                                              │
   │                                                                  │
   │                │                    │  finalize                  │
   │                │◀── 'done' event ───│                            │
   │  socket 'done' │                                                 │
   │◀───────────────│                                                 │
```

---

## Contracts

### `QueryRequest` (frontend → backend)

```ts
interface QueryRequest {
  query: string;
  model: 'gemini' | 'gpt-4o' | 'claude';
  connectors: string[];   // uploadIds or connector IDs
}
```

### `InferPayload` (backend → ML service)

```ts
interface InferPayload {
  queryId: string;
  query: string;
  model: string;
  connectors: string[];
  topK?: number;          // default 5
}
```

### `StreamEvent` (ML service → Redis → backend → socket)

Published by the ML service on channel `query:${queryId}` and re-emitted by the backend to the Socket.IO room of the same name.

```ts
type StreamEvent =
  | { type: 'progress'; step: 'embed' | 'search' | 'context' | 'llm'; pct: number }
  | { type: 'token'; text: string; index: number }
  | { type: 'done'; totalTokens: number; sources: SourceRef[] }
  | { type: 'error'; message: string };

interface SourceRef {
  uploadId: string;
  chunkIndex: number;
  score: number;
}
```

### Socket rooms

- On query submit, the backend returns `{ queryId }`.
- Client emits `socket.emit('subscribe', { queryId })` → backend calls `socket.join('query:' + queryId)`.
- Backend emits `token`, `progress`, `done`, `error` into that room.

---

## Environment Variables

| Var | Backend | ML Service | Notes |
|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | `redis://localhost:6379` | Must point to the same Redis |
| `ML_SERVICE_URL` | `http://localhost:5000` | — | Backend calls this |
| `MILVUS_URI` | — | `http://localhost:19530` | ML-service only |
| `LLM_API_KEY` | — | (from Secrets Manager in prod) | ML-service only |
| `QUERY_TOPK_DEFAULT` | `5` | `5` | Must agree |
| `PORT` | `3000` | `5000` | Independent |

---

## Real-Time Communication Flow

Socket communication supports:

- **Query progress updates** — `embed → search → context → llm`
- **Token-level streaming** — each LLM token published individually
- **Partial response rendering** — frontend appends tokens as they arrive
- **Final completion notification** — includes source references for citations

Benefits:

- Reduced perceived latency
- Improved user interaction
- Support for long-running inference

---

## Ownership Boundaries

| Owner | Responsibilities |
|---|---|
| **Frontend** | Query composition, model/connector selection, token rendering, socket lifecycle |
| **Backend** | Validation, auth, connector resolution, model routing, socket fan-out. **Only component that talks to the frontend.** |
| **ML Service** | Embedding, Milvus search, LLM invocation, token streaming. **Only component that reads/writes Milvus.** |
| **Milvus** | Owned by ML service. Backend never queries it directly. |
| **Redis** | Pub/sub transport for stream events between ML service and backend. |

This clear separation avoids race conditions and lets each service scale independently.

---

## Scaling

Two independent dials:

1. **Backend instances** — scale on WebSocket connection count and request rate.
2. **ML service instances** — scale on inference concurrency (GPU-bound for embeddings, network-bound for LLM API).

Rule of thumb:

- Many idle sockets + light inference → scale backend.
- Heavy inference + few concurrent users → scale ML service.

Because Redis pub/sub is the transport, a token published by any ML-service instance is delivered to any backend instance holding the client socket — no sticky sessions needed for the ML side. Sticky sessions **are** required at the load balancer for the WebSocket connection itself.

---

## Error Handling and Reliability

To ensure system reliability, the architecture includes:

- **Request validation** — schema-checked at the backend before ML dispatch
- **Timeout handling** — per-inference timeout; backend emits `error` if ML service exceeds SLA
- **Retry logic** — embedding + Milvus search are retried transparently; LLM calls are **not** retried (side-effect free but expensive)
- **Graceful socket reconnection** — client resubscribes to `query:${queryId}`; backend replays buffered tokens from Redis if within TTL
- **Error response propagation** — any pipeline failure surfaces as a single `error` StreamEvent

---

## Failure Model

| What fails | What happens |
|---|---|
| Backend crashes mid-stream | Socket disconnects; client reconnects, resubscribes, backend replays from Redis buffer if within TTL |
| ML service crashes mid-inference | Backend inference request errors; `error` event pushed to socket; user can retry |
| Milvus unavailable | ML service returns 503; backend emits `error`; retryable |
| LLM provider rate-limits | ML service returns 429; backend surfaces as `error` with retry-after hint |
| Redis unavailable | Streaming path broken; backend falls back to buffering the full ML response and pushing on completion (degraded UX, still works) |
| Client disconnects mid-stream | ML service keeps generating; tokens buffered in Redis until TTL; client can resume by resubscribing |

---

## What's Wired

*(nothing yet — this is the target architecture)*

## What's Not Wired Yet

- **`POST /query` endpoint** — validation, connector resolution, `queryId` allocation
- **ML service `/infer` endpoint** — embedding + Milvus search + LLM streaming
- **Redis pub/sub bridge** — backend subscriber that fans out to Socket.IO rooms
- **Socket.IO room protocol** — `query:${queryId}` subscribe/unsubscribe
- **Frontend query UI** — model picker, connector multi-select, progressive token render
- **Source-citation panel** — render `SourceRef[]` from the `done` event as clickable citations
- **Auth propagation** — pass user identity into ML service so connector ACLs are enforced at the Milvus query
- **Query history persistence** — store queries + responses in MongoDB for replay / analytics

---

## Future Scope

### Prod deployment target

```
                       ┌────────────────────┐
                       │  Frontend (Angular)│
                       │  S3 + CloudFront   │
                       └─────────┬──────────┘
                                 │
                                 │  WebSocket (sticky via ALB)
                                 ▼
        ┌────────────────────────┐
        │  Backend API           │
        │  ECS Fargate + ALB     │
        │  + Socket.IO server    │
        │  autoscale on CPU +    │
        │  active connections    │
        └─────────┬──────────────┘
                  │
                  │  HTTP (internal VPC)
                  ▼
        ┌───────────────────────────────────────────┐
        │  ML Service — ECS Fargate (Python)        │
        │  autoscaled on inference queue depth      │
        │                                           │
        │    embedQuery  ← embedding model          │
        │    searchMilvus                           │
        │    invokeLLM   ← Gemini / Bedrock         │
        │    streamTokens → Redis pub/sub           │
        └─────────┬───────────────────┬─────────────┘
                  │                   │
                  ▼                   ▼
        ┌────────────────────┐  ┌────────────────────┐
        │ ElastiCache Redis  │  │ Milvus             │
        │ (Multi-AZ)         │  │ (VPC-only)         │
        │ pub/sub channels   │  │ owned by ML svc    │
        └─────────┬──────────┘  └────────────────────┘
                  │
                  │  subscribe query:${queryId}
                  ▼
        ┌────────────────────┐
        │  Backend API       │
        │  Socket.IO emit    │
        │  → room query:${id}│
        └────────────────────┘

Observability : Sentry (exceptions) + Datadog / CloudWatch (latency, token/sec)
Security      : VPC-only Milvus + ElastiCache, IAM roles on Fargate,
                LLM keys in Secrets Manager, ACL enforced on connector list
```

### Enhancements to consider

- **Query queue for burst absorption** — if concurrent queries exceed ML capacity, enqueue on a `query-queue` (BullMQ, same pattern as `ocr-queue`) instead of dropping.
- **Response caching** — hash (query, model, connectors) → cached response for identical repeat queries (short TTL).
- **Reranker** — after Milvus top-K, run a cross-encoder reranker before LLM to lift answer quality.
- **Multi-model fan-out** — allow "compare" mode where the same query hits N models and results render side-by-side.
- **Streaming to multiple subscribers** — same `queryId` room can serve multiple clients (shared query in a team workspace).
