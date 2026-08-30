# Real-Time Query Process — Implementation Handoff (Stages 4–7)

Companion to [`arch.md`](./arch.md). Stages 1–4 are done; this document carries everything a fresh
session needs to finish the feature. **Stage 5 is next.**

**Read `arch.md` first** — it is the source of truth for the design. This file records what was
built, what was decided along the way, and what is left.

---

## 1. Decisions already locked

| Decision | Choice | Why it is not up for revisiting |
|---|---|---|
| Vector store | **Supabase pgvector only** | Milvus adapter, `VECTOR_STORE` switch, and `ZILLIZ_*` env vars were deleted in `fd3b4d2`. |
| LLM | **Gemini** via `@google/genai`, behind an adapter | `arch.md` names it; adapter keeps `gpt-4o`/`claude` a one-file addition. |
| Where generation runs | **The existing Node `ml/` service** | Query embeddings must come from the same `Xenova/all-MiniLM-L6-v2` instance as ingestion, or retrieval returns noise. A separate Python service would have to re-establish that parity. |
| Scope | **V1 only** | Cancel endpoint, sweeper, caching, precise `Last-Event-ID`, progress bar, and citation panel stay deferred — see `arch.md` "Deferred". |

---

## 2. What is already built

| Commit | Contents |
|---|---|
| `9eecd07` | Stages 1–2 — contracts, `generate-queue`, Mongo persistence, `POST /queries` |
| `5af7f0a` | Stage 3 — `VectorStore.search()` + `match_document_chunks` SQL function |
| `fd3b4d2` | ml restructure, DI, Milvus removal |
| *(uncommitted)* | Stage 4 — generate worker, `llm.ts` adapter, `generation/` slice |

### Backend — working and verified against a live server

```
backend/src/features/real-time-query-process/
├── types.ts                              QueryStatus, QueryRecord, SourceRef,
│                                         GenerationResult, StreamEvent
├── real-time-query-process.schema.ts     CreateQuerySchema (zod)
├── real-time-query-process.model.ts      Mongoose "Query" model → collection `queries`
├── real-time-query-process.repository.ts create/findById/list/markComplete/markFailed
├── real-time-query-process.service.ts    submitQuery() + read/write methods
├── real-time-query-process.controller.ts create (202) / list / getById
└── real-time-query-process.routes.ts     POST /queries, GET /queries, GET /queries/:id

backend/src/infra/generateQueue.ts        GenerateJobData + the BullMQ queue
backend/src/config/env.ts                 + generateQueue, genStream, query blocks
backend/src/infra/container.ts            + realTimeQueryProcessService
backend/src/index.ts                      + mounts /api/v1/real-time-query-process
```

Verified live: `POST` → `202 {queryId}`, Mongo row `generating`, job on `generate-queue` with
`jobId === queryId`, validation rejects bad model / empty connectors, `GET` by id and list work,
404 on unknown id.

### ML — restructured, typechecks, boots

```
ml/src/
├── index.ts                    bootstrap + lifecycle only (98 lines)
├── config/env.ts               no more VECTOR_STORE / milvus blocks
├── utils/apiResponse.ts        mirrors backend
├── features/embeddings/
│   ├── embeddings.controller.ts   uses container + envelope
│   ├── embeddings.service.ts      class EmbeddingsService(embedder, repo)
│   ├── embeddings.repository.ts   class EmbeddingsRepository(store)
│   ├── embeddings.routes.ts       POST /embed — debug escape hatch, nothing calls it
│   ├── embeddings.schema.ts
│   ├── embeddings.worker.ts       job logic + Worker + startEmbedWorker/stopEmbedWorker
│   └── types.ts                   EmbedJobData, EmbedJobResult
└── infra/
    ├── container.ts            composition root
    ├── embedder.ts             + Embedder interface + injectable `embedder` singleton
    ├── vectorstore.ts          types + Supabase impl, incl. search()
    └── backendClient · readiness · redis · supabaseErrors

ml/sql/supabase_search.sql      match_document_chunks — VERIFIED against pgvector 0.8.6
ml/scripts/smoke-search.ts      embed a question → search → print ranked hits
```

---

## 3. Blockers — neither is caused by our changes

**Supabase project is gone.** `cfanhasbmwmwguzadpyt.supabase.co` returns NXDOMAIN (confirmed via
`8.8.8.8`, while `supabase.co` itself resolves). This also breaks the **existing** embed pipeline —
any upload today fails at the embed step. To restore: create a project, update `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in `ml/.env` **and** `backend/.env`, then run **both**
`ml/sql/supabase_init.sql` and `ml/sql/supabase_search.sql` in the SQL editor.

**No Gemini key.** `LLM_API_KEY` is not set anywhere yet.

**Neither blocks building Stage 4.** The DI seam added in `fd3b4d2` makes the generation pipeline
testable with stubs — see §7.

Dead env vars still in `ml/.env` (gitignored, harmless, nothing reads them):
`VECTOR_STORE`, `ZILLIZ_URI`, `ZILLIZ_TOKEN`, `MILVUS_COLLECTION`.

---

## 4. Invariants — do not break these

1. **The SSE handler never writes to Mongo.** `QueueEvents` is the only writer. This is the entire
   reason the design has two paths; collapsing them means a user switching tabs leaves a message
   stuck in `generating` forever.
2. **Insert before enqueue, never in parallel** (`service.submitQuery`). A fast worker can otherwise
   finish before the row exists and the `completed` handler has nothing to update.
3. **`generate-queue` uses `attempts: 2` and time-based retention.** Do not copy
   `removeOnComplete: 1000` from `embedQueue` — here the job return value *is* the answer, and
   count-based pruning during an outage deletes user data. Reasons are commented in
   `infra/generateQueue.ts`.
4. **`jobId === queryId === Mongo _id === gen:{queryId} stream suffix.** One id, four systems.
5. **Do not mount `compression`** in `backend/src/index.ts` — it buffers SSE into one blob. None is
   mounted today; keep it that way.
6. **Query and ingestion embeddings must use the same `Embedder`.** Both go through
   `ml/src/infra/embedder.ts`.

---

## 5. Stage 4 — the generate worker (BUILT)

```
ml/src/infra/llm.ts                        LlmProvider + Gemini impl (@google/genai)
ml/src/features/generation/
├── types.ts                  GenerateJobData, GenerationResult, StreamEvent, SourceRef
├── generation.repository.ts  GenerationRepository(store) — owns search()
├── generation.service.ts     GenerationService(embedder, repo, llm) + buildContext()
├── generation.stream.ts      resetStream/publish — the only writer to gen:{queryId}
└── generation.worker.ts      runGenerateJob + Worker + start/stopGenerateWorker

ml/src/config/env.ts          + generateQueue, genStream, query, llm blocks
ml/src/infra/container.ts     + generationService
ml/src/index.ts               + startGenerateWorker() / stopGenerateWorker()
ml/scripts/smoke-generate.ts  5 stub-driven checks, no network, no model load
```

`search()` was deleted from `EmbeddingsRepository` in the same change — ingestion writes and never
reads, so it was dead code there.

### Two deviations from the original Stage 4 sketch

**`LlmProvider.stream()` yields `LlmChunk`, not `string`.** The sketched `AsyncIterable<string>`
cannot satisfy `GenerationResult.finishReason`: nothing in a stream of plain strings distinguishes a
clean stop from a `MAX_TOKENS` truncation, and inferring it from output length guesses wrong. The
terminal chunk therefore carries optional `finishReason` and `outputTokens`. `totalTokens` is the
provider's own count when it reports one, falling back to the number of fragments emitted.

**The job timeout is enforced in the worker, not by BullMQ.** BullMQ v5 has no per-job `timeout`
option — that was Bull v3. `runGenerateJob` uses an `AbortController` (`LLM_JOB_TIMEOUT_MS`, default
120s) whose signal is passed down into the Gemini request, so a hung provider call is actually
cancelled rather than merely abandoned.

### Verified

- `tsc --noEmit` clean across `ml/src`.
- `scripts/smoke-generate.ts` — progress order `embed → search → context → llm`, contiguous token
  indices, assembled text, `[source N]` markers with matching `SourceRef`s, the character cap
  dropping over-budget chunks *and* their citations, `finishReason: 'length'` on truncation, and a
  zero-hit query claiming no sources.
- Against live Redis: `XRANGE gen:{id}` shows `progress → token… → done`, `TTL` = 3600.
- End-to-end on `generate-queue` with a real enqueued job: the worker consumed it, embedded the
  query, failed at Supabase (the dead project — see §3), published `{type:'error'}`, retried once,
  and on the retry `resetStream()` + `{type:'restart'}` left only the second attempt's events in the
  stream. BullMQ ended at `state=failed attemptsMade=2`.

The happy path past the search step is unverifiable until Supabase and `LLM_API_KEY` are restored.

## 6. Stages 5–7

### Stage 5 — Path A (durability)

`backend/src/infra/queueEvents.ts` — add `wireGenerateEvents()` and a third `QueueEvents` instance
in `startQueueEvents()`, beside the existing OCR and embed handlers.

- Add `parseGenerationResult(raw: unknown)` — a runtime type guard mirroring the existing
  `parsePipelineSummary`. The return value crosses a process boundary as JSON and arrives `unknown`.
- `.on('completed')` → `realTimeQueryProcessService.markComplete(jobId, result)`
- `.on('failed')` → `markFailed(jobId, failedReason)`
- **No Socket.IO emit** — unlike the OCR handlers. This feature's live view is SSE, and the SSE
  handler reads Redis directly.

✅ **Verify:** Mongo flips `generating` → `complete` with text and sources **with no browser open at
any point**. That is the requirement the whole design exists for.

### Stage 6 — Path B (the SSE endpoint)

New file `real-time-query-process.stream.ts`, wired as `GET /queries/:id/stream`. Strictly read-only.

1. Load the record. If `status !== 'generating'`, emit one terminal frame from stored Mongo data and
   close — do not tail a stream with nothing left to say. Emitting a `done`-shaped frame (rather than
   plain JSON) keeps the client on a single code path.
2. Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`,
   `Connection: keep-alive`, `X-Accel-Buffering: no`, then `res.flushHeaders()`.
3. Cursor from the `Last-Event-ID` header, default `'0'` (full replay — cheap and correct at V1).
4. **`redisConnection.duplicate()`** — a blocking `XREAD` monopolises its connection and must never
   use the shared one from `infra/queue.ts`.
5. Loop `XREAD BLOCK 15000 STREAMS gen:{id} <cursor>`: write `id: <entryId>\ndata: <json>\n\n` per
   entry, advance the cursor; on an empty read write `: keepalive\n\n`; exit on
   `done` / `error` / `cancelled`.
6. **Tear down the duplicate connection in both `req.on('close')` and a `finally`.** A leaked
   blocking connection per abandoned browser tab is a real exhaustion path.

✅ **Verify:** `curl -N .../queries/{id}/stream` prints frames progressively. Kill it mid-stream and
confirm Mongo still reaches `complete`.

### Stage 7 — frontend

`frontend/src/app/feature/query-process/` — currently a stub whose "bot" is a `setTimeout` echo.

- `query-process.types.ts` — mirror the backend contracts
- `query-process.service.ts` — mirror `file-upload.service.ts`; base
  `http://localhost:3000/api/v1/real-time-query-process`. `submit()`, `list()`, `getById()`, and
  `stream(queryId): Observable<StreamEvent>` wrapping native `EventSource`, closing on unsubscribe
- `query-process.ts` — replace the fake bot: load history on init → POST → append a streaming bubble
  → open `EventSource` → append tokens → finalize on `done` with sources. Unsubscribe in
  `ngOnDestroy`
- Model picker + connector multi-select fed by `GET /api/v1/file-upload-ocr/uploads`, filtered to
  `status === 'ready'` — only those have embeddings

> Native `EventSource` cannot set `Last-Event-ID` manually; the browser sends it automatically on
> auto-reconnect, and a fresh open replays from cursor `0`. No fetch-based polyfill needed at V1.

The `/query-process` route and `provideHttpClient()` already exist — no wiring changes.

**Default the connector picker to a narrow selection**, not select-all. Retrieval precision degrades
sharply as the candidate pool grows; scoping is the main quality lever the user has.

✅ **Verify:** ask a question, watch tokens render, then **navigate away mid-generation and come
back** — the answer is complete, read from Mongo. That round trip is the acceptance test for the
whole feature.

---

## 7. How to verify without live infrastructure

Both techniques were used during Stages 1–3 and work.

**Unit-test services with stubs** — this is what the DI refactor bought. Runs in ~0.2s, no network,
no model load:

```ts
const fakeStore: VectorStore = { name: 'supabase', init: async () => {},
  upsert: async () => {}, count: async () => 0, sample: async () => [],
  search: async () => [{ pk: 'u:0', upload_id: 'u', chunk_index: 0,
                         text: 'ctx', score: 0.9 }] };
const fakeEmbedder = { encode: async (t: string[]) => t.map(() => Array(384).fill(0.1)) };
const fakeLlm = { name: 'fake', async *stream() { yield 'Hello'; yield ' world'; } };

const svc = new GenerationService(fakeEmbedder, new GenerationRepository(fakeStore), fakeLlm);
```

Put the script in `ml/scripts/` (files outside the tsconfig `include` fail to compile) and run with
`./node_modules/.bin/ts-node --transpile-only scripts/<name>.ts`.

**Test SQL against a real pgvector** — how `supabase_search.sql` was validated:

```bash
docker run -d --name pgvec-test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=vectest \
  -p 55432:5432 pgvector/pgvector:pg16
docker cp ml/sql/supabase_init.sql   pgvec-test:/tmp/init.sql
docker cp ml/sql/supabase_search.sql pgvec-test:/tmp/search.sql
docker exec pgvec-test psql -U postgres -d vectest -v ON_ERROR_STOP=1 -f /tmp/init.sql
docker exec pgvec-test psql -U postgres -d vectest -v ON_ERROR_STOP=1 -f /tmp/search.sql
# NOTE: docker exec needs -i to forward stdin for heredocs
docker rm -f pgvec-test
```

---

## 8. Gotchas found the hard way

- **HNSW post-filtering.** pgvector applies `WHERE upload_id = ANY(...)` *after* the index scan.
  Filtering to 1 document out of 50 with `match_count 5` returned **1 row** without iterative scan.
  `supabase_search.sql` sets `hnsw.iterative_scan = 'strict_order'`, which returns results identical
  to an exact brute-force scan in ~5.5ms. `relaxed_order` returns approximate membership *and*
  order — measurably wrong ranking — so it was rejected.
- **Mongoose defaults array paths to `[]`** even when `required: false`. `sources` on the Query model
  needs `default: undefined`, or a `generating` row claims "retrieval found nothing".
- **Supabase RPC vector params** — pass `JSON.stringify(embedding)`, not a bare array. pgvector's text
  input format is exactly `"[0.1,0.2,…]"`; a bare array leaves PostgREST guessing at a `json → vector`
  cast. **Still unverified against a live project** — first thing `smoke-search.ts` will exercise.
- **`docker exec` needs `-i`** to forward stdin, or heredocs to `psql` silently do nothing.
- **`ts-node-dev` is a file watcher** — it never exits. Use `ts-node` for one-shot scripts.
- **`parsed.error.flatten()` is deprecated in zod v4.** Used consistently across all controllers in
  both services; if it gets cleaned up, do all of them at once rather than diverging in one file.

---

## 9. Environment variables to add

| Var | backend/.env | ml/.env | Default |
|---|---|---|---|
| `GENERATE_QUEUE_NAME` | ✓ | ✓ | `generate-queue` (must agree) |
| `GEN_STREAM_TTL_SEC` | ✓ | ✓ | `3600` |
| `QUERY_TOPK_DEFAULT` | ✓ | ✓ | `5` |
| `LLM_API_KEY` | — | ✓ | *(validated at job time, not boot)* |
| `LLM_MODEL` | — | ✓ | `gemini-2.0-flash` |
| `LLM_MAX_OUTPUT_TOKENS` | — | ✓ | `2048` |
| `GENERATE_WORKER_CONCURRENCY` | — | ✓ | `2` |
| `LLM_JOB_TIMEOUT_MS` | — | ✓ | `120000` — added in Stage 4; BullMQ has no job timeout |

All of these are set in `ml/.env` already. `docker-compose.yml` needs no changes — defaults hold and `ml` already loads `ml/.env` via `env_file`.

---

## 10. When it is all working

Update the docs — this repo keeps them beside the code and they are currently ahead of reality:

- **`arch.md` → "What's Wired"** still says *"nothing yet"*. Fill it in.
- **`arch.md:35`** — the note claiming a Python ML service on `:5000`. Reality: Node on `5100`
  natively, `5000` in-container. `file-upload-ocr/arch.md` explains why (macOS AirPlay squats 5000).
- **`file-upload-ocr/arch.md`** — "Chatbot / RAG layer" currently says *in progress*; mark it wired.
- **Delete this file** once Stages 4–7 are merged. It is a handoff note, not permanent documentation.
