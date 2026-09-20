# Find Job — Implementation Plan

**Read `arch.md` first** — it is the source of truth for the design and the reasons behind it. This
file is the build order: what to write, in what sequence, and how to know each stage works.

Nothing is built yet. Stages 1–3 need no Apify account and cost nothing.

---

## 1. Decisions already locked

| Decision | Choice | Why it is not up for revisiting |
|---|---|---|
| Who scrapes | **Apify**, not our own scraper | At 1–2 runs/day the fixed cost of proxies plus scraper maintenance beats per-result billing. See `arch.md` "Why Apify". |
| Where it runs | **Inside `backend`**, no new service | Nothing here is CPU-heavy — the work happens on Apify. A separate service would buy nothing. |
| Work unit | **One queue job per site** | Each site is a different actor. A single job retrying would re-pay for sites that already worked. |
| Storage | **One `jobs` collection**, original data stored as-is, cleaned field empty | Cleaning is an in-place update later; no second collection to keep in sync. |
| Provider seam | **Kept from day one** | One interface, one file. Retrofitting it later means touching every call site. |
| Scope | **Phase 1 only** | Resume keywords, live progress, recovery job, data cleanup all deferred — see `arch.md` "Phase 2". |

---

## 2. Blockers

**Which actors to use.** Blocks stages 5–8. Stages 1–4 are unaffected.

The risk is not *which* actor but **whether one exists**. LinkedIn is well covered. Naukri has fewer
options. **Cutshort needs checking before it is promised to anyone** — niche regional boards often
have no maintained actor. If one has nothing, the choices are: drop the board, write our own Apify
actor, or scrape that one board ourselves through the per-site override. Do not reach for a generic
scraper actor plus our own parsing — that is scraper maintenance *and* a bill.

**No Apify account or token yet.** Blocks stage 4 onward.

---

## 3. Invariants — do not break these

These are the rules where a mistake costs money or corrupts data, rather than just failing a test.

1. **Never start a second Apify run for a site that already has a run id.** Check first, always. A
   crashed worker must resume, not re-dispatch. This is the rule that protects the bill.
2. **Save the Apify run id before polling starts**, and only then move the site to `running`. A site
   in `pending` must provably mean nothing was started.
3. **`runIds` is an array, written with `$addToSet`.** Never a single value. See the gotcha in §12.
4. **Every actor run sends a result cap.** No cap means an unbounded bill from one bad query.
5. **Only the service writes to Mongo.** The worker hands rows over; it does not persist.
6. **Above the provider interface, rows are `Record<string, unknown>`.** Only an adapter knows an
   actor's field names. The one exception is the normalised error list, which drives retries.
7. **Reads exclude `raw` unless asked.** A 50-row list that includes it pulls ~1 MB.
8. **A site returning zero postings is a success**, not a failure.
9. **The TTL index is not optional.**
10. **Out of credit and actor-not-found must alert**, not just fail quietly.

---

## 4. Stage 1 — data layer

**Files:** `types.ts`, `dedupe.ts`, `find-job.model.ts`, `repository/find-job.repository.ts`,
`repository/raw-job.repository.ts`

### Shapes

```ts
export type JobSite = string;   // open — the actor map decides which are valid
export type RunStatus = 'scraping' | 'ready' | 'partial' | 'failed';
export type SiteStatus = 'pending' | 'running' | 'done' | 'failed';

export interface SiteEntry {
  site: JobSite;
  status: SiteStatus;
  provider?: string;
  actorId?: string;
  actorBuild?: string;
  apifyRunId?: string;       // the resume handle — see invariant 1
  datasetId?: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  costUsd?: number;
  startedAt?: Date;
  finishedAt?: Date;
  error?: { code: string; message: string; retriable: boolean };
}

export interface ScrapeRunDoc {
  _id: string;                       // runId — also the queue job id prefix
  status: RunStatus;
  searchTerms: string[];
  termSource: 'client';              // becomes a union in phase 2
  query: {
    location?: string;
    isRemote?: boolean;
    resultsWanted: number;
    hoursOld?: number;
    jobType?: string;
  };
  sites: Record<JobSite, SiteEntry>;  // keyed by site name
  totals: { fetched: number; ingested: number; duplicates: number; costUsd: number };
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface JobDoc {
  _id: string;                       // uuid
  runIds: string[];                  // INVARIANT 3 — array, not a single value
  provider: string;
  actorId: string;
  actorBuild: string;
  site: JobSite;
  searchTerm: string;
  sourceJobId: string | null;
  dedupeKey: string;                 // unique index
  fetchedAt: Date;
  raw: Record<string, unknown>;      // Schema.Types.Mixed
  normalized: null;                  // phase 2
  normalizedAt: null;
}
```

### Indexes

```
jobs:              { dedupeKey: 1 } unique
                   { runIds: 1, site: 1 }          (multikey)
                   { fetchedAt: 1 } TTL expireAfterSeconds = RAW_JOB_TTL_DAYS × 86400
                   { normalized: 1 } sparse
job_scrape_runs:   { createdAt: -1 }
                   { status: 1, updatedAt: 1 }
```

### `dedupe.ts`

Two pure functions. `canonicaliseUrl` lowercases the host, drops the query string, drops the trailing
slash, and normalises a protocol-relative URL. `buildDedupeKey` takes the direct employer URL, falls
back to the board URL, and finally falls back to `sha1(site + company + title + location)`.

### Repository notes

- **`rawJobRepository.bulkUpsert(runId, envelopes)`** — one `bulkWrite` of `updateOne` with
  `upsert: true`. Use `$addToSet: { runIds: runId }`, `$set` for `raw` / `fetchedAt` / provenance
  (a posting can change between runs), and `$setOnInsert` for `_id` and `normalized: null`.
  Return `{ ingested, duplicates }` from `upsertedCount` and `modifiedCount`.
- **`rawJobRepository.listByRun(runId, { site, limit, cursor, includeRaw })`** — projects `raw` out
  unless `includeRaw` is true (invariant 7). Cursor-paged on `_id`.

### Acceptance

- [ ] Script: same posting URL with different tracking params, host casing and trailing slashes all
      produce one key; the no-URL fallback fires
- [ ] Script: create a run, bulk-upsert 10 fake postings twice — second pass reports 0 ingested,
      10 duplicates, and the collection still holds 10 documents
- [ ] Script: upsert the same posting under run A then run B — `runIds` has both, and
      `listByRun` returns it for **both** runs
- [ ] `listByRun` with default options returns documents with no `raw` field

---

## 5. Stage 2 — service and API

**Files:** `find-job.schema.ts`, `find-job.service.ts`, `find-job.controller.ts`,
`find-job.routes.ts`; edits to `infra/container.ts` and `src/index.ts`

### Service methods

| Method | Does |
|---|---|
| `createRun(input)` | Write the run document **first**, then queue one job per site. Returns `{ runId, status, siteCount }`. |
| `recordDispatch(runId, site, { apifyRunId, datasetId, actorId, actorBuild })` | Saves the run id and moves the site to `running`. **Invariant 2.** |
| `ingestSite(runId, site, batch)` | Build envelopes, derive dedupe keys, bulk-upsert, update the site entry, recompute totals. |
| `markSiteFailed(runId, site, error)` | Records the error and recomputes totals. |
| `getRun(runId)` | The status endpoint. |
| `listJobs(runId, opts)` | Paged postings. |
| `deleteRun(runId)` | Run plus its postings. |

### Rollup

Recompute run status and totals **from the whole sites map**, not by incrementing counters. Two sites
finishing at once both recompute; because the value is derived, they converge instead of corrupting
each other. Write the site entry atomically (`$set` on `sites.<site>`), then recompute.

### Request validation (`find-job.schema.ts`)

These are spend controls, not politeness:

- `searchTerms` — 1 to `FINDJOB_MAX_SEARCH_TERMS`, each non-empty
- `sites` — optional, must all exist in the actor map, defaults to `FINDJOB_DEFAULT_SITES`
- `resultsWanted` — optional, `1..FINDJOB_MAX_RESULTS_PER_SITE`
- `location`, `isRemote`, `hoursOld`, `jobType` — optional

### Routes

```
POST   /api/v1/find-job/runs              → 202 { runId, status, siteCount }
GET    /api/v1/find-job/runs/:runId       → run document
GET    /api/v1/find-job/runs/:runId/jobs  → { items, nextCursor }
DELETE /api/v1/find-job/runs/:runId
```

Follow the existing controller shape: `safeParse` → 400 with `error.flatten()`, try/catch → 500,
success through `successResponse` from `utils/apiResponse`.

### Acceptance

- [ ] `POST /runs` returns 202 and writes a run document with every site `pending`
- [ ] Queue jobs exist in Redis (nothing consumes them yet)
- [ ] `GET /runs/:runId` returns the sites map
- [ ] A script calling `ingestSite` with hand-written rows moves that site to `done` and updates totals
- [ ] When the last site is marked done, status becomes `ready`; mark one failed instead and it is `partial`
- [ ] Bad requests are rejected: no terms, 4+ terms, unknown site, `resultsWanted: 5000`

Nothing scrapes and nothing is billed at this point.

---

## 6. Stage 3 — env and queue

**Files:** `config/env.ts` (a `findJob` key), `infra/scrapeQueue.ts`, `.env.example`

Queue options: `attempts: 3`, exponential backoff from 10s, `removeOnComplete: { age: 86400 }`,
`removeOnFail: { age: 7 * 86400 }`. Job id `${runId}:${site}`.

### Acceptance

- [ ] Backend boots with the new config, no behaviour change
- [ ] `.env.example` lists every new variable from §13

---

## 7. Stage 4 — provider seam and Apify client

**Files:** `providers/types.ts`, `providers/apify.client.ts`, `providers/index.ts`

```ts
export interface JobSearchQuery {
  searchTerms: string[];
  location?: string;
  isRemote?: boolean;
  resultsWanted: number;
  hoursOld?: number;
  jobType?: string;
}

export interface RawJobBatch {
  site: JobSite;
  provider: string;
  actorId: string;
  actorBuild: string;
  rows: Record<string, unknown>[];   // opaque above this line — invariant 6
  errors: { code: string; message: string; retriable: boolean }[];
  costUsd?: number;
  fetchedAt: Date;
}

export interface ScrapeProvider {
  readonly name: string;
  readonly supportedSites: readonly JobSite[];
  /** Starts a run and returns its handle. Does NOT wait. */
  start(site: JobSite, query: JobSearchQuery): Promise<{ apifyRunId: string; datasetId: string; actorId: string; actorBuild: string }>;
  /** Maps provider state to ours. Called by the poll loop. */
  check(apifyRunId: string): Promise<{ state: 'running' | 'succeeded' | 'failed'; error?: { code: string; message: string; retriable: boolean }; costUsd?: number }>;
  /** Downloads results for a finished run. */
  collect(site: JobSite, datasetId: string): Promise<RawJobBatch>;
}
```

**`start` and `check` are separate on purpose.** A single `scrape()` that dispatched and waited could
not satisfy invariant 1 — a retry would have no way to resume an existing run.

`apify.client.ts` wraps three REST endpoints with Node 22's global `fetch`: start a run, get a run,
list dataset items. **No npm dependency.**

### Acceptance

- [ ] A smoke script starts a run on any cheap actor, polls it to completion, and downloads items
- [ ] A bad token surfaces as a clear, non-retriable error

---

## 8. Stage 5 — choose actors *(BLOCKING)*

Fill in the table in `arch.md` "Actor Selection". For each candidate, run it once from the Apify
console with a realistic query and **save the JSON output** — stage 6 is written against those samples.

### Acceptance

- [ ] An actor id and build recorded per site, or an explicit decision to drop a board
- [ ] Each actor's result-cap input field identified (invariant 4)
- [ ] A saved sample output per actor

---

## 9. Stage 6 — first adapter

**Files:** `providers/<site>.adapter.ts`

Each adapter does three things: build that actor's input from a `JobSearchQuery` (**including the
result cap**), name the fields holding the job URLs so `dedupe.ts` can use them, and map that actor's
failures onto `{ code, message, retriable }`.

Error mapping:

| Condition | retriable | Notes |
|---|---|---|
| Run failed, transient | yes | |
| Run timed out | yes | Retry once with a lower cap |
| Run aborted | no | Someone stopped it |
| HTTP 402 / out of credit | no | **Alert** |
| HTTP 404 / actor gone | no | **Alert** |
| HTTP 400 / bad input | no | Our bug |
| Apify API 429 | yes | |

### Acceptance

- [ ] Smoke script: start → poll → collect for one real site, no queue involved
- [ ] Dedupe keys derived from real rows look sane
- [ ] The result cap is honoured — ask for 10, get at most 10

---

## 10. Stage 7 — worker

**Files:** `find-job.worker.ts`; edits to `src/index.ts`

### Job flow

```
1. read the run document, find this site's entry
2. if entry.apifyRunId exists  → skip to 4        ← INVARIANT 1
3. provider.start(...)         → recordDispatch() ← INVARIANT 2, saves id BEFORE polling
4. poll provider.check() every APIFY_POLL_INTERVAL_MS until terminal
   - our own deadline (see gotcha below); on expiry, fail retriably
5. succeeded → provider.collect() → service.ingestSite()
   failed    → classify; retriable ? throw : UnrecoverableError
```

### Startup and shutdown

`startScrapeWorker()` goes in the existing `start()` callback next to `startQueueEvents()` and
`startSweeper()`. `stopScrapeWorker()` goes in `shutdown()` **before** `disconnectMongo()` — a
polling job killed without draining leaves an Apify run nobody collects.

Worker options: `concurrency: FINDJOB_WORKER_CONCURRENCY` (at least the site count),
`autorun: false`.

### Acceptance

- [ ] `POST /runs` → poll `GET /runs/:runId` → reaches `ready`, postings are in Mongo
- [ ] One site pointed at a bad actor → run reaches `partial`, other sites keep their results
- [ ] **Kill test:** `kill -9` mid-poll, restart, re-queue the job — it resumes the existing Apify
      run and does **not** start a new one. Confirm in the Apify console that the run count did not
      increase. This is the invariant-1 test and the most important one here.
- [ ] `SIGTERM` mid-poll drains instead of abandoning
- [ ] A site returning zero rows ends `done`, not `failed`

---

## 11. Stage 8 — remaining adapters

One per site, each verified with the stage 6 script before being wired in.

---

## 12. Gotchas

**BullMQ v5 has no per-job timeout.** That was Bull v3. `real-time-query-process/plan.md` records
hitting this already. The poll loop must carry its own deadline (`FINDJOB_POLL_DEADLINE_MS`), set
**above** `APIFY_RUN_TIMEOUT_MS` so Apify gives up first and we get a real error rather than
abandoning a run we paid for.

**`runIds` must be an array.** The dedupe key is unique across all runs, so a posting run 2 finds
that run 1 already stored is an update, not an insert. A single `runId` field would either keep run 1
— so run 2's list misses it — or overwrite with run 2, so run 1's list loses it. One run shows wrong
results either way. Fixing this after data exists means a migration.

**Write the run document before queueing.** Otherwise the worker can pick up a job whose run does not
exist yet.

**Partial queue failure.** If queueing throws halfway through the sites, mark the run `failed` rather
than leaving it half-dispatched.

**TTL deletes whole documents.** Original and cleaned data expire together. If phase 2 wants to keep
cleaned records longer, blank the `raw` field on a schedule instead of relying on TTL.

**Recompute the rollup from the sites map**, never by incrementing a counter — two sites finishing at
once would race.

**Apify dataset reads are paged.** Do not assume one request returns everything.

**The `jobs` collection name is not `raw_jobs`.** It holds cleaned data too.

---

## 13. Environment variables

All under a `findJob` key in `backend/src/config/env.ts`.

| Variable | Default | Notes |
|---|---|---|
| `SCRAPE_QUEUE_NAME` | `scrape-queue` | |
| `APIFY_TOKEN` | *required* | Only new secret |
| `APIFY_ACTORS` | *(stage 5)* | Site → actor id |
| `APIFY_POLL_INTERVAL_MS` | `10000` | |
| `APIFY_RUN_TIMEOUT_MS` | `600000` | Sent to Apify, so Apify gives up first |
| `FINDJOB_POLL_DEADLINE_MS` | `900000` | Our own deadline. Must exceed the line above |
| `APIFY_MAX_ITEMS_PER_RUN` | `100` | **Cost guard** — invariant 4 |
| `FINDJOB_WORKER_CONCURRENCY` | `4` | At least the site count |
| `FINDJOB_DEFAULT_SITES` | *(from the actor map)* | |
| `FINDJOB_MAX_SEARCH_TERMS` | `3` | Spend control |
| `FINDJOB_RESULTS_PER_SITE` | `50` | |
| `FINDJOB_MAX_RESULTS_PER_SITE` | `100` | Hard ceiling |
| `FINDJOB_HOURS_OLD` | `168` | 7 days |
| `FINDJOB_SITE_OVERRIDES` | *(empty)* | Unused until a second provider exists |
| `RAW_JOB_TTL_DAYS` | `45` | |

---

## 14. Done when

- [ ] `POST /runs` with search terms returns a `runId` in milliseconds
- [ ] Polling `GET /runs/:runId` shows sites moving `pending → running → done`
- [ ] The run reaches `ready`, or `partial` when one board fails
- [ ] `GET /runs/:runId/jobs` returns postings, paged, with no `raw` field by default
- [ ] Re-running the same search adds no duplicates
- [ ] A posting found by two runs appears in both runs' listings
- [ ] The kill test passes — a retry resumes rather than starting a second Apify run
- [ ] Recorded cost per site is visible on the run document
- [ ] A week of real runs reviewed against the cost estimate in `arch.md`
