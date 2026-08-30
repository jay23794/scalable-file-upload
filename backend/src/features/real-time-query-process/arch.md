# Real-Time Query Process — Architecture

End-to-end architecture for the RAG (Retrieval-Augmented Generation) query system. Users ask natural-language questions against uploaded documents and connected data sources; responses stream back in real time over SSE.

---

## Feature Overview

A real-time AI query system that allows users to ask natural-language questions against uploaded documents and connected data sources.

Users can select:

- **AI model** (for example Gemini)
- **Connectors** such as uploaded documents
- **Multiple data sources**

The system uses **Retrieval-Augmented Generation (RAG)** to retrieve relevant document content and generate grounded responses. Responses are streamed back to users in real time over Server-Sent Events.

**Core design principle: the generation is owned by the server, not by the connection.** Once a query is submitted, it runs to completion and is persisted regardless of whether any browser is watching. The stream is a *view* onto that work, not the work itself.

---

## Components

| Component | Role | Port | Command |
|---|---|---|---|
| **Frontend (Angular)** | User picks model + connectors, submits query, renders streamed tokens | 4200 | `cd frontend && npm start` |
| **Backend API (Express)** | Orchestrator — validates query, persists, enqueues job, streams tokens back over SSE | 3000 | `cd backend && npm run dev` |
| **MongoDB** | Source of truth for queries + generated answers (`generating` → `complete` / `failed`) | 27017 | `brew services start mongodb-community` |
| **Redis** | Three roles: BullMQ `generate-queue`, Redis Stream token transport, response cache | 6379 | `docker start redis` |
| **ML Service** | Query embedding, vector search, LLM inference, token streaming | 5000 | see note below |
| **Vector Store** | Supabase (pgvector) — embeddings, text chunks, metadata (owned by ML service) | — | — (managed) |
| **LLM Provider** | Gemini / other — invoked by ML service with query + retrieved context | — | (external) |

> **Note:** this doc assumes a Python ML service on `:5000`. The repo currently ships a **Node** ML service at `ml/` on `:5100` (`ml/package.json`). Reconcile before implementation — either extend the existing Node service or stand up a separate `ml-service/`.

---

## High-Level Diagram

```
                            ┌──────────────────────────┐
                            │    Frontend (Angular)    │
                            │           :4200          │
                            └───┬──────────────────▲───┘
                                │                  │
             1. POST /query     │                  │  SSE (text/event-stream)
                {query, model,  │                  │  GET /query/:queryId/stream
                 connectors[]}  │                  │  Last-Event-ID: <stream id>
                → 202 {queryId} │                  │
                                ▼                  │
                            ┌──────────────────────┴───┐
                            │     Backend (Express)    │
                            │           :3000          │
                            │  validate · auth ·       │
                            │  resolve model +         │
                            │  connectors              │
                            └───┬──────────────────┬───┘
                                │                  │
              2. INSERT first   │                  │  3. THEN enqueue
                                ▼                  ▼
                     ┌─────────────────┐   ┌────────────────────┐
                     │     MongoDB     │   │  Redis — BullMQ    │
                     │  status:        │   │  generate-queue    │
                     │  'generating'   │   └─────────┬──────────┘
                     └─────────────────┘             │
                                            4. worker picks up job
                                                     ▼
                     ┌───────────────────────────────────────────┐
                     │              ML Service                   │
                     │                                           │
                     │   embedQuery     ← embedding       (15%)  │
                     │   vectorSearch   → top-K chunks    (35%)  │
                     │   buildContext   → text + metadata (50%)  │
                     │   invokeLLM      → Gemini, stream  (65%)  │
                     │   finalize       → return text    (100%)  │
                     └───┬───────────────────────────────┬───────┘
                         │                               │
              5. vector  │                               │
                 search  ▼                               │
              ┌────────────────────────┐                 │
              │  Vector Store          │                 │
              │  Supabase pgvector     │                 │
              └────────────────────────┘                 │
                                                         │
  ═══════════════ TWO INDEPENDENT PATHS ═════════════════╪═══════════════════
                                                         │
              ┌──────────────────────────────────────────┴────────────┐
              │                                                       │
  PATH A — DURABILITY (always runs)              PATH B — LIVE VIEW (best effort)
              │                                                       │
     worker returns final text                          XADD per token
              │                                                       │
              ▼                                                       ▼
   ┌────────────────────────┐                      ┌──────────────────────────┐
   │  BullMQ job completed  │                      │  Redis Stream            │
   └───────────┬────────────┘                      │  gen:{queryId}           │
               │                                   │  MAXLEN ~5000 · TTL 1h   │
               ▼                                   └────────────┬─────────────┘
   ┌────────────────────────┐                                   │
   │  Backend               │                          XRANGE (backlog)
   │  QueueEvents           │                        + XREAD BLOCK (tail)
   │  .on('completed')      │                                   │
   │  .on('failed')         │                                   ▼
   │                        │                      ┌──────────────────────────┐
   │  subscribed at boot —  │                      │  Backend SSE handler     │
   │  index.ts:46, NOT      │                      │  READ-ONLY               │
   │  per-request           │                      │  never writes to Mongo   │
   └───────────┬────────────┘                      └────────────┬─────────────┘
               │                                                │
               ▼                                                ▼
   ┌────────────────────────┐                      ┌──────────────────────────┐
   │       MongoDB          │                      │  Frontend                │
   │  status: 'complete'    │                      │  progressive token       │
   │  text · sources[]      │                      │  render                  │
   └────────────────────────┘                      └──────────────────────────┘
```

### Why the split matters

| | Path A — durability | Path B — live view |
|---|---|---|
| Trigger | BullMQ `completed` event | Redis Stream entries |
| Lives in | Backend process, subscribed since boot | Per-request SSE handler |
| Depends on a browser? | **No** | Yes |
| If it fails | Answer is lost → sweeper recovers | User sees no typing effect; answer still saved |
| Writes to Mongo? | **Yes — this is the only writer** | Never |

**User switches conversation mid-generation:** the SSE connection closes, Path B goes dark, and Path A is completely unaffected. The worker never knew a browser existed. When the job finishes, `QueueEvents` writes the answer to Mongo as usual.

**User returns:** the normal conversation fetch reads the finished message from Mongo. No stream needed. If generation is still running (`status === 'generating'`), the client reopens the SSE endpoint with the last stream ID it saw — the handler replays the backlog via `XRANGE`, then tails live.

**Never make persistence depend on a viewer.** If the SSE handler were the code that saved to Mongo, a user switching away would leave the message stuck in `generating` forever, and the Redis Stream would TTL the answer into oblivion.

### Why not merge the two paths

The obvious simplification is "let the SSE handler watch for the `done` event and save it." That's one path instead of two, and it fails for one reason: **the SSE handler is created by the browser's request and destroyed when the browser leaves.** The code that would do the saving isn't running at the moment there's something to save.

The fix that keeps it one path is to run a *permanent* stream consumer instead of a per-request one. That's strictly more work, not less — you would have to build:

- a background reader for **all** `gen:*` streams, plus discovery of new ones
- exactly-once semantics across backend replicas, or you double-write → consumer groups
- offset tracking that survives restarts
- handling for streams that never receive `done` because the worker died

BullMQ already provides every one of those, and the listener is already running (`startQueueEvents()`, `backend/src/index.ts:46`). Path A is the cheaper option, not the fancier one.

The deeper reason they don't merge: the stream is a **firehose of disposable fragments** with a TTL, while the job result is **one finished value** that must be retained. Making the disposable thing responsible for the durable thing is backwards.

### What's shared vs. what's per-message

A common misread: there is **one queue**, with **one job per message** — not one queue per message. Same as `ocr-queue`, which is a single queue that every upload flows through as a job.

**Created once, at boot (shared by everything):**
- the `generate-queue` BullMQ queue
- the `QueueEvents` listener that writes to Mongo

**Created per message:**
- 1 Mongo row — `{ queryId, status: 'generating' }`
- 1 BullMQ job on the shared queue
- 1 Redis Stream — `gen:{queryId}`
- 1 SSE connection — but only while the user is actually looking

Three queries in flight at once:

```
generate-queue  ──┬── job(query-1)  →  stream gen:query-1  →  mongo row query-1
   (ONE queue)    ├── job(query-2)  →  stream gen:query-2  →  mongo row query-2
                  └── job(query-3)  →  stream gen:query-3  →  mongo row query-3
```

Fully independent. The user's SSE connection attaches to whichever `queryId` they're currently viewing; nothing needs to know about the others. Scaling workers scales concurrent generations directly.

---

## End-to-End Query Sequence

```
Frontend      Backend      Redis(queue)   ML Worker   VectorStore    LLM
   │             │              │             │            │          │
   │ POST /query │              │             │            │          │
   │────────────▶│              │             │            │          │
   │             │ INSERT Mongo status='generating'        │          │
   │             │              │             │            │          │
   │             │ enqueue job  │             │            │          │
   │             │─────────────▶│             │            │          │
   │202 {queryId}│              │             │            │          │
   │◀────────────│              │             │            │          │
   │             │              │             │            │          │
   │ GET /stream │              │             │            │          │
   │────────────▶│              │             │            │          │
   │             │              │ job picked  │            │          │
   │             │              │────────────▶│            │          │
   │             │              │             │ embedQuery │          │
   │             │              │             │ search     │          │
   │             │              │             │───────────▶│          │
   │             │              │             │◀── hits[] ─│          │
   │             │              │             │ buildContext          │
   │             │              │             │ invoke(q+ctx)         │
   │             │              │             │──────────────────────▶│
   │             │              │             │◀──── token stream ────│
   │             │      XADD gen:{queryId}    │            │          │
   │             │◀── XREAD ─────────────────-│            │          │
   │ SSE: token  │              │             │            │          │
   │◀────────────│              │             │            │          │
   │  (repeat per token)        │             │            │          │
   │             │              │             │            │          │
   │             │   job completed — returns final text    │          │
   │             │◀─────────────│◀────────────│            │          │
   │             │ QueueEvents → UPDATE Mongo status='complete'       │
   │ SSE: done   │              │             │            │          │
   │◀────────────│              │             │            │          │
```

---

## Cancellation and Recovery

```
CANCEL — explicit intent only, never on disconnect
  FE ──POST /query/:queryId/cancel──▶ Backend ──SET gen:{queryId}:cancel──▶ Redis
                                                                             │
                                              worker checks between tokens ◀──┘
                                                          │
                                    abort LLM · XADD 'cancelled' · Mongo status='cancelled'

RECOVERY — backend was down when the job completed
  Sweeper (every 5 min, mirrors file-upload-ocr.sweeper.ts)
    ──▶ find queries stuck in 'generating' older than 10 min
    ──▶ read getJobState / getJobReturnValue from BullMQ
    ──▶ reconcile Mongo (complete / failed / re-enqueue)
```

A closed SSE connection is **not** a cancel signal. Only an explicit `POST /cancel` stops generation. The cost is that an abandoned query runs to completion — cap it with a max-token limit and a job timeout.

---

## Ordering and Retry Rules

**1. Insert before enqueue — never in parallel.**
If the job is enqueued first, a fast worker can complete before the Mongo row exists, and the `completed` handler will have nothing to update.

**2. Keep `attempts` low (1–2) for `generate-queue`.**
Unlike `ocr-queue` / `embed-queue` (`attempts: 5`), a half-streamed answer is not cleanly resumable. If the LLM dies at token 300 and BullMQ retries, the worker restarts at token 1 and `XADD`s into the same stream — an attached viewer sees 300 tokens, then the answer starting over.

**3. Reset the stream on retry.**
When `job.attemptsMade > 0`, `DEL gen:{queryId}` at job start and emit a `restart` event so the client clears its buffer.

**4. Use time-based job retention, not count-based.**
`embedQueue` uses `removeOnComplete: 1000` (`backend/src/infra/embedQueue.ts:14`). Copying that here is a trap: the return value survives only the last 1000 completed jobs. Deploy the backend during a busy period and jobs that finished while it was down can be pruned before the sweeper runs — nothing left to reconcile from, and the answer is gone.

```ts
export const generateQueue = new Queue<GenerateJobData>(env.generateQueue.name, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 2,                                          // see rule 2
    removeOnComplete: { age: 24 * 3600, count: 10_000 },  // outlive any realistic outage
    removeOnFail:     { age: 7 * 24 * 3600 },
  },
});
```

Retention matters far more here than on `embed-queue`. There, losing the return value costs you a status detail. Here, it costs you **the answer itself**.

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

Response: `202 { queryId }` — returned immediately, before generation starts.

### `GenerateJobData` (backend → `generate-queue` → ML worker)

```ts
interface GenerateJobData {
  queryId: string;        // also the Mongo _id and the Redis Stream key suffix
  query: string;
  model: string;
  connectors: string[];
  topK?: number;          // default 5
}
```

### `GenerationResult` (ML worker job return value → backend `QueueEvents`)

This is what makes Path A durable — it travels over BullMQ, not over the stream.

```ts
interface GenerationResult {
  text: string;               // full answer, assembled in the worker
  sources: SourceRef[];
  totalTokens: number;
  finishReason: 'stop' | 'length' | 'cancelled';
}
```

### `StreamEvent` (ML worker → Redis Stream → backend → SSE)

Written with `XADD gen:${queryId}` and forwarded verbatim by the backend's read-only SSE handler. Each SSE frame carries the Redis entry ID as `id:`, which the client sends back as `Last-Event-ID` on reconnect.

```ts
type StreamEvent =
  | { type: 'progress'; step: 'embed' | 'search' | 'context' | 'llm'; pct: number }
  | { type: 'token'; text: string; index: number }
  | { type: 'restart' }                                    // retry cleared the buffer
  | { type: 'done'; totalTokens: number; sources: SourceRef[] }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

interface SourceRef {
  uploadId: string;
  chunkIndex: number;
  score: number;
}
```

### SSE endpoint

```
GET /query/:queryId/stream
Headers: Content-Type: text/event-stream
         Cache-Control: no-cache, no-transform
         X-Accel-Buffering: no          ← defeat nginx / Cloud Run buffering
```

- Cursor comes from the `Last-Event-ID` header, defaulting to `0` (full replay).
- Blocking `XREAD` needs its own connection — use `redis.duplicate()`.
- Emit `: keepalive\n\n` on idle to survive proxy timeouts.
- **Do not mount `compression` on this route** — it buffers the stream into a single blob.
- If Mongo already says `status === 'complete'`, don't open a stream at all; return the stored text.

---

## Environment Variables

| Var | Backend | ML Service | Notes |
|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | `redis://localhost:6379` | Must point to the same Redis |
| `MONGO_URI` | `mongodb://localhost:27017` | — | Backend is the only Mongo writer |
| `GENERATE_QUEUE_NAME` | `generate-queue` | `generate-queue` | Must agree |
| `GEN_STREAM_TTL_SEC` | `3600` | `3600` | Redis Stream retention |
| `SUPABASE_URL` | — | Supabase project URL | ML-service only — pgvector, never Storage |
| `SUPABASE_SERVICE_ROLE_KEY` | — | (from Secrets Manager in prod) | ML-service only |
| `LLM_API_KEY` | — | (from Secrets Manager in prod) | ML-service only |
| `QUERY_TOPK_DEFAULT` | `5` | `5` | Must agree |
| `PORT` | `3000` | `5000` | Independent |

---

## Real-Time Communication Flow

SSE communication supports:

- **Query progress updates** — `embed → search → context → llm`
- **Token-level streaming** — each LLM token appended to the Redis Stream individually
- **Partial response rendering** — frontend appends tokens as they arrive
- **Resume after detach** — `Last-Event-ID` replays everything missed while disconnected
- **Final completion notification** — includes source references for citations

Benefits:

- Reduced perceived latency
- Cancellation is explicit, so switching views never destroys work
- Support for long-running inference

### Why SSE over Socket.IO here

The upload pipeline uses Socket.IO because those events are *unsolicited* — a worker finishes minutes later, outside any request. Query generation is different: one request in, one ordered token stream out.

- `Last-Event-ID` is native to SSE and pairs directly with Redis Stream entry IDs. Socket.IO rooms don't buffer, so anything emitted while detached is simply lost.
- SSE streams are request-scoped and clean up on their own — no room join/leave bookkeeping.
- Any backend replica can serve a reattach, because the state lives in Redis, not in the process.

Revisit this if the feature becomes conversational (bidirectional mid-stream control, tool-approval round trips, multi-turn over one connection) — that's where WebSocket wins.

---

## Ownership Boundaries

| Owner | Responsibilities |
|---|---|
| **Frontend** | Query composition, model/connector selection, token rendering, SSE lifecycle |
| **Backend** | Validation, auth, connector resolution, model routing, job enqueue, SSE fan-out. **Only component that talks to the frontend. Only component that writes MongoDB.** |
| **ML Service** | Embedding, vector search, LLM invocation, token streaming into Redis. **Only component that reads/writes the vector store. Never touches MongoDB.** |
| **Vector Store** | Owned by ML service. Backend never queries it directly. |
| **Redis** | BullMQ `generate-queue` (durability), Redis Streams (token transport), response cache |
| **MongoDB** | Source of truth for query history and final answers |

This clear separation avoids race conditions and lets each service scale independently.

---

## Caching

Redis also fronts the retrieval path, keyed by content rather than by user:

- **Result cache** — `sha1(query + connectors + topK)` → hits, TTL 5–15 min.
- **Query-embedding cache** — `sha1(query)` → `float[384]`, longer TTL. Survives ML restarts, which matters because model reload is slow.
- **Rate limiting** — per user, so one client can't saturate the embedder.

A completed answer is cached from the assembled `GenerationResult`, not from the live stream. On a cache hit, return it as one plain JSON response — instant beats simulated typing.

---

## Scaling

Two independent dials:

1. **Backend instances** — scale on SSE connection count and request rate.
2. **ML worker instances** — scale on `generate-queue` depth (GPU-bound for embeddings, network-bound for LLM API).

Rule of thumb:

- Many idle streams + light inference → scale backend.
- Deep queue + few concurrent users → scale ML workers.

**No sticky sessions required.** Because generation state lives in Redis (queue + stream) rather than in any process, a client reattaching to a different backend replica reads the same stream and gets the same tokens. This is a direct benefit of SSE + Redis Streams over in-process Socket.IO rooms, which would have needed the Redis adapter and sticky routing.

---

## Error Handling and Reliability

### What actually guarantees the write

`QueueEvents` is **at-most-once delivery**. It's a live Redis subscription, so if the backend is restarting or deploying at the instant a job finishes, that notification is gone and nothing replays it. It is the fast path, not the guarantee.

Reliability comes from three layers:

| Layer | Role | Reliable? |
|---|---|---|
| **BullMQ job hash in Redis** (`returnvalue`) | The durable record — the worker's output, persisted by BullMQ | ✅ The real source of truth |
| **`QueueEvents` `completed`** | Fast notification that the record changed | ❌ Lossy — misses events while backend is down |
| **Sweeper** | Periodic pull that reads the durable record and reconciles Mongo | ✅ Catches whatever the notification dropped |

This is the same reasoning already written into `file-upload-ocr.sweeper.ts:7`. The difference is the stakes: for uploads a missed event costs a status field, for queries it costs the generated answer — which is why job retention (Ordering and Retry Rules, rule 4) is a correctness concern here rather than a tuning knob.

### Mechanisms

- **Request validation** — schema-checked at the backend before enqueue
- **Timeout handling** — per-job timeout; worker fails the job, `QueueEvents` marks Mongo `failed`
- **Retry logic** — embedding + vector search retried inside the worker; the LLM call is **not** retried mid-stream (see Ordering and Retry Rules)
- **Graceful reconnection** — client reopens SSE with `Last-Event-ID`; backend replays from the Redis Stream backlog
- **Sweeper fallback** — periodic reconciliation of queries stuck in `generating`, mirroring `file-upload-ocr.sweeper.ts`
- **Error propagation** — any pipeline failure surfaces as an `error` StreamEvent *and* a Mongo `failed` status

---

## Failure Model

| What fails | What happens |
|---|---|
| **User switches conversation** | SSE closes. Generation continues, completes, and is saved by `QueueEvents`. No data loss. |
| **Client disconnects / reloads** | Same as above. On return, read from Mongo if complete, or reattach via `Last-Event-ID` if still generating. |
| Backend crashes mid-stream | SSE drops. Job keeps running. On restart, `QueueEvents` resubscribes; the sweeper reconciles anything missed while down. |
| ML worker crashes mid-inference | BullMQ marks the job failed after its attempts; `QueueEvents` sets Mongo `failed`; user can retry. |
| Vector store unavailable | Worker retries, then fails the job → `error` event + Mongo `failed`. |
| LLM provider rate-limits | Worker fails the job with a retry-after hint surfaced in the `error` event. |
| Redis Stream evicted (TTL / MAXLEN) | Live view degrades — the client stops seeing tokens. The answer still lands in Mongo via Path A and appears on next fetch. |
| Redis entirely unavailable | Queue and stream both down; queries cannot be accepted. Fail fast at `POST /query` rather than accepting work that can't be tracked. |

---

## What's Wired

*(nothing yet — this is the target architecture)*

## What's Not Wired Yet

### V1 — the minimum that satisfies the requirement

Four pieces. This is still Path A and Path B, because the split is inherent to having a separate worker process — not because it's elaborate.

1. **`POST /query` endpoint** — validate, resolve connectors, insert Mongo row (`generating`), enqueue, return `202 { queryId }`
2. **`generate-queue`** — BullMQ queue definition + `GenerateJobData` contract + retention config
3. **ML worker** — embed → vector search → LLM stream, `XADD` per token, return final text as the job return value
4. **`QueueEvents` wiring** — `wireGenerateEvents` in `backend/src/infra/queueEvents.ts`, alongside the existing OCR/embed handlers → **Path A**
5. **SSE endpoint** — `GET /query/:queryId/stream`, read stream from cursor `0`, read-only → **Path B**
6. **Frontend query UI** — model picker, connector multi-select, progressive token render, reattach on revisit

### Deferred — add when it earns its place

| Item | Why it can wait |
|---|---|
| **Generation sweeper** | Covers "backend was down at the exact moment a job completed." Rare. The pattern already exists in `file-upload-ocr.sweeper.ts` — copy it when it bites. Retention (rule 4) is what buys you the time to defer this. |
| **Cancel endpoint** | With a max-token cap, an abandoned generation is cheap. Add when token spend is measurable. |
| **`Last-Event-ID` precision** | Replaying from cursor `0` is nearly free and correct. Exact-offset resume is polish. |
| **Progress % events** | Cosmetic. Ship without; add if the UI wants a progress bar. |
| **Response / embedding cache** | Pure optimization. No traffic yet to justify it. |
| **Separate sync `/search` endpoint** | Only if the product needs search *without* a generated answer. |
| **Shared retrieval module** | Becomes necessary the moment there's a second caller. Until then the worker owns it. |
| **Source-citation panel** | Render `SourceRef[]` from the `done` event as clickable citations. |
| **Auth propagation** | Pass user identity into the ML worker so connector ACLs are enforced at query time. Required before multi-tenant. |

> **Scope note:** the complexity here is the price of one product decision — *generation survives the user switching conversations*. Drop that requirement and the whole design collapses to a single synchronous HTTP call with a streamed response: no queue, no Mongo-first insert, no stream buffer. Worth confirming the requirement is real before building against it.

---

## Future Scope

### Prod deployment target

```
                       ┌────────────────────┐
                       │  Frontend (Angular)│
                       │  S3 + CloudFront   │
                       └─────────┬──────────┘
                                 │
                                 │  HTTPS + SSE (no sticky sessions needed)
                                 ▼
        ┌────────────────────────┐
        │  Backend API           │
        │  ECS Fargate + ALB     │
        │  autoscale on CPU +    │
        │  active SSE streams    │
        └────┬──────────────┬────┘
             │              │
   enqueue   │              │  XREAD  ·  QueueEvents
             ▼              ▼
        ┌─────────────────────────┐        ┌────────────────────┐
        │  ElastiCache Redis      │        │  DocumentDB /      │
        │  (Multi-AZ)             │        │  MongoDB Atlas     │
        │  • generate-queue       │        │  queries + answers │
        │  • gen:{queryId} stream │        └────────────────────┘
        │  • response cache       │                  ▲
        └───────────┬─────────────┘                  │
                    │                         written only by
        job pull    │                         backend QueueEvents
                    ▼
        ┌───────────────────────────────────────────┐
        │  ML Worker — ECS Fargate                  │
        │  autoscaled on generate-queue depth       │
        │                                           │
        │    embedQuery  ← embedding model          │
        │    vectorSearch                           │
        │    invokeLLM   ← Gemini / Bedrock         │
        │    XADD tokens → Redis Stream             │
        │    return final text → BullMQ             │
        └─────────────────────┬─────────────────────┘
                              │
                              ▼
                    ┌────────────────────┐
                    │ Vector Store       │
                    │ (VPC-only)         │
                    │ owned by ML svc    │
                    └────────────────────┘

Observability : Sentry (exceptions) + Datadog / CloudWatch (latency, token/sec,
                queue depth, stuck-'generating' count)
Security      : VPC-only vector store + ElastiCache, IAM roles on Fargate,
                LLM keys in Secrets Manager, ACL enforced on connector list
```

### Enhancements to consider

- **Response caching** — hash (query, model, connectors) → cached answer for identical repeat queries (short TTL).
- **Reranker** — after top-K retrieval, run a cross-encoder reranker before the LLM to lift answer quality.
- **Multi-model fan-out** — "compare" mode where the same query hits N models and results render side-by-side.
- **Multiple subscribers per query** — the same `gen:{queryId}` stream can serve several clients (shared query in a team workspace) with no extra work, since readers are stateless.
- **Priority lanes** — separate queues or BullMQ priorities so interactive queries jump ahead of batch/backfill work.
