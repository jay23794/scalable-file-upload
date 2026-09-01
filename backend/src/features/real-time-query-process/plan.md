# Real-Time Query Process — Implementation Handoff (Stages 4–7)

Companion to [`arch.md`](./arch.md). Stages 1–6 are done — the whole backend is built. Only the
frontend is left. **Stage 7 is next.**

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
| `6d5d54e` | Stage 4 — generate worker, `llm.ts` adapter, `generation/` slice |
| `5fd30e4` | Stage 5 — Path A, `wireGenerateEvents` + `smoke-path-a.ts` |
| *(uncommitted)* | Stage 6 — Path B, `real-time-query-process.stream.ts` |

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

## 6. Stages 5–6 (BUILT) and Stage 7

### Stage 5 — Path A, durability (BUILT — `5fd30e4`)

`backend/src/infra/queueEvents.ts` gained `parseGenerationResult()`, `wireGenerateEvents()`, and a
third `QueueEvents` instance in `startQueueEvents()`. `wireOcrEvents` and `wireEmbedEvents` are
byte-identical — the change is purely additive.

Two deliberate differences from the OCR and embed handlers:

- **No Socket.IO emit.** The live view is SSE, and that handler tails Redis directly. Emitting here
  would be a second, competing delivery path for the same data.
- **No `resolveUploadId()` round trip.** `jobId === queryId === Mongo _id`, so the id in hand is
  already the one to write against.

**Unparseable return value fails the query** rather than falling back to "mark it done anyway" the
way the embed handler does. There, losing the return value costs a status detail; here the return
value *is* the answer, and a complete row with no text is an empty bubble that never resolves.

✅ **Verified** by `backend/scripts/smoke-path-a.ts` — a fake worker on `generate-queue` stands in
for the ml service, so it needs neither Supabase nor a Gemini key (it does need live Mongo + Redis):

1. valid result → row flips `generating` → `complete` with text, sources, tokens, finishReason,
   **with no browser open at any point**
2. malformed result → `failed`, not `complete`
3. worker throws → `failed` carrying the real `failedReason`

### Stage 6 — Path B, the SSE endpoint (BUILT — uncommitted)

`real-time-query-process.stream.ts`, wired as `GET /queries/:id/stream`. Strictly read-only — it
never writes to Mongo.

Built as specified: terminal short-circuit when `status !== 'generating'`, the four headers plus
`flushHeaders()`, cursor from `Last-Event-ID` defaulting to `'0'`, `redisConnection.duplicate()` for
the blocking `XREAD BLOCK 15000`, keepalive comments on idle reads, and teardown in **both**
`req.on('close')` and a `finally`.

Three details worth knowing, all beyond the original sketch:

- **`disconnect()`, not `quit()`, on teardown.** `quit()` waits for in-flight commands, and the
  in-flight command is an `XREAD` parked for up to 15s. `quit()` would hold the connection for the
  rest of the block window on every closed tab — the exact leak the teardown exists to prevent.
- **A finished query replays as `token` + `done`, not a bare `done`.** A client that opens the
  stream microseconds after completion would otherwise get a terminal frame with no text and render
  an empty message. Two frames keep it on one code path *and* give it something to draw.
- **After 4 consecutive idle reads (~60s) the handler re-checks Mongo.** If Path A has since
  finished the query, it closes the client out from the durable record. Without this, a stream that
  went permanently silent — worker died before writing a terminal event, or the stream hit its TTL —
  leaves the client tailing forever while holding a blocking Redis connection.

✅ **Verified** against a live backend with a hand-seeded stream (no ml worker needed):

| Case | Result |
|---|---|
| Live tail, `curl -N` | frames arrive 400ms apart, matching the seed cadence — not one buffered blob |
| `Last-Event-ID` resume | replays only entries after the cursor |
| Already-`complete` query | `token` + `done` in 0.01s, no tailing |
| Unknown id | `404` |
| Silent stream | `: keepalive` at 15/30/45s, then closes from Mongo at 60s |
| 3 tabs opened and abandoned | Redis `connected_clients` 7 → 11 → **7**. No leaked connections. |

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
