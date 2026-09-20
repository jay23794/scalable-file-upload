# Find Job — Architecture (Phase 1)

A self-contained feature inside `backend/`. The client sends search terms. The backend starts a scraper run on **Apify** for each job board, waits for it, and stores the postings in MongoDB as they came back — **no cleanup or reshaping yet**.

Phase 1 runs everything in one process. Reading keywords from a resume, cleaning up the data, and anything else comes later. The last section lists what changes in phase 2.

This document covers **the design and the reasons behind it**, not the code.

---

## Status: not implemented

Nothing here is built yet. **One decision blocks step 5 of the build order: which Apify actors to use.** See "Actor Selection".

---

## Why Apify

We expect **1–2 runs per day**. At that volume, running our own scrapers is the wrong trade.

Running our own means we own proxies, rate limits, anti-bot handling, and — the part that never ends — **fixing the scraper every time a job board changes its page layout**. That work does not get smaller just because we scrape twice a day. The cost is roughly the same whether we run twice a day or two hundred times.

Apify handles all of it. We pay per result instead:

```
2 runs/day × 4 sites × 50 results = ~400 results/day ≈ 12,000 results/month
monthly cost ≈ 12 × <actor's price per 1,000 results>
```

Fill in the real number once actors are picked. Running our own only starts to win when that figure grows past what proxies plus engineering time would cost. We are far from that point.

**What we give up:** we pay per result, we write one adapter per actor, we depend on whoever maintains each actor, and — most importantly — **retries now cost money**. That last one shapes several decisions below.

---

## Actor Selection — open decision

The design does not care which actors we pick. But the number of adapters, and more importantly **whether an actor exists at all**, does. This is the only thing blocking the build.

| Site | Actor | Price | Multiple queries per run? | Notes |
|---|---|---|---|---|
| LinkedIn | *TBD* | | | Well covered — several good actors |
| Naukri | *TBD* | | | Fewer options; check how recently updated |
| Cutshort | *TBD* | | | **Check one exists before committing** |
| *(others)* | *TBD* | | | |

### Check actor availability first

Apify is worth paying for because someone else maintains the scraper. **That only holds for boards that actually have a maintained actor.** Coverage is uneven. Big international boards have several good ones. Smaller or regional boards may have one old actor, or none.

If a board has no maintained actor, the choices are:

| Option | What it costs |
|---|---|
| **Drop the board** | Free. Worth considering if it is a small share of postings. |
| **Generic scraper actor + our own parsing** | We are back to fixing parsers ourselves, and now we pay for it too. Worst option. |
| **Write our own Apify actor** | Real work, but it runs on Apify and sits behind the same adapter interface. |
| **Scrape that one board ourselves** | The per-site override already allows this. Fine when a board matters and nothing covers it. |

A mixed result is fine, and probably what will happen: good actors for most boards, something else for one or two. The provider seam makes that a per-board choice. What matters is **finding out before step 5**, not during it.

### How to pick, in order of importance

1. **Is it maintained?** Recent updates, lots of runs, issues get answered. An abandoned actor is the same problem as a broken scraper.
2. **Does it return the fields we need?** See "What Gets Stored". This is where the "at least 20 fields" requirement is met or missed.
3. **Can we cap the result count?** Without a cap, a bad query means an unlimited bill. Treat a missing cap as close to disqualifying.
4. **Does it take several queries per run?** Decides whether one run covers all our search terms or just one. Either is fine; the adapter says which.
5. **How is it priced?** Per result is easier to predict than per compute unit.
6. **Official or community?** Community actors are often better and cheaper, but also more likely to be abandoned. Weigh with point 1.

Two rules about how far an actor's choices are allowed to spread:

- **Never build a feature on a field only one actor returns.** Treat those as a bonus. This is the quiet way we end up locked in despite a clean interface.
- **Every stored posting records the actor id and build**, so later cleanup code knows what produced it.

---

## Scope

| In phase 1 | Later |
|---|---|
| `POST /runs` with search terms sent by the client | Getting search terms from an uploaded resume |
| BullMQ `scrape-queue`, worker **inside `backend`** | Socket.IO live progress |
| Provider seam + one adapter per actor | Scraping a board ourselves, if Apify gets expensive |
| Store postings as-is, with dedupe | Cleaning up and standardising the data |
| `GET /runs/:runId` for status | Recovery job for stuck runs |
| Polling Apify until a run finishes | Apify webhooks instead of polling |

The one thing we build now that is not strictly needed now is the **provider seam**. It costs one interface and one file. It lets us move a single board to a different actor, or scrape it ourselves, with a config change. Adding it later would mean touching every call site.

---

## How it works

```
                    ┌────────────────────┐
                    │  Client            │
                    └─────────┬──────────┘
                              │  1. POST /find-job/runs
                              │     { searchTerms, sites, location, ... }
                              ▼
        ┌──────────────────────────────────────────────────────┐
        │  Backend — Express :3000                             │
        │                                                      │
        │   create run document  (status: scraping)            │
        │   queue one job per site                             │
        │   return runId                            2. 202 ────┼──▶ Client
        └──────────────────────┬───────────────────────────────┘
                               │  3. queue site jobs
                               ▼
                     ┌────────────────────┐
                     │ Redis :6379        │
                     │ scrape-queue       │
                     └─────────┬──────────┘
                               │  4. worker picks up a job
                               ▼
        ┌──────────────────────────────────────────────────────┐
        │  Backend — SAME PROCESS, BullMQ Worker               │
        │  it waits on work happening elsewhere                │
        │                                                      │
        │   pick the adapter for this site      ← the seam     │
        │            │                                         │
        │            ▼                                         │
        │   ┌─ does this site already have a run id? ─┐        │
        │   │    yes → keep polling it, DO NOT start  │        │
        │   │          another                        │        │
        │   │    no  → start one, save the id FIRST   │        │
        │   └──────────────────┬──────────────────────┘        │
        │                      │  5. start the actor           │
        │                      ▼                               │
        │              ┌───────────────────┐                   │
        │              │  Apify            │  runs the scraper │
        │              │  actor run        │  proxies, retries,│
        │              │  → dataset        │  blocking: theirs │
        │              └─────────┬─────────┘                   │
        │                      ▲ │  6. poll until it finishes  │
        │                      └─┘                             │
        │                        │  7. download the results    │
        │                        ▼                             │
        │   pass rows to the service ─────────────────┐        │
        │     add our fields, build the dedupe key,   │        │
        │     upsert, update the site, redo totals    │        │
        └─────────────────────────────────────────────┼────────┘
                                                      ▼
                                            ┌────────────────────┐
                                            │  MongoDB           │
                                            │  job_scrape_runs   │
                                            │  jobs              │
                                            └─────────┬──────────┘
                                                      │
                           8. GET /runs/:runId       → status per site
                              GET /runs/:runId/jobs  → the postings (paged)
                                                      ▼
                                            ┌────────────────────┐
                                            │  Client            │
                                            └────────────────────┘
```

The backend never scrapes. It starts runs, waits, and stores what comes back.

---

## Key Decisions

### 1. The queue job waits on work happening somewhere else

This is different from every other queue in this project. `ocr-queue` and `embed-queue` jobs *do* the work. A `scrape-queue` job **starts work on Apify and waits for it**, for minutes.

Three things follow.

**Save the Apify run id before polling starts.** The site entry records it first, then polling begins. The next point explains why.

**A retry must never start a second Apify run.** Scraping ourselves is free to retry. Starting an actor again is a second bill. So the job always checks first: if this site already has a run id, keep polling that run instead of starting a new one. Without this, one crashed worker quietly doubles the cost.

**Poll inside the job.** At 1–2 runs per day, holding a worker slot for a few minutes costs nothing, and all the logic stays in one place. The alternatives are a delayed follow-up job or an Apify webhook. Both free the slot, but one adds more states and the other needs a public endpoint. Neither is worth it yet. Webhooks are the phase-2 answer.

Two settings follow from jobs being long-lived. First, **the polling loop needs its own deadline, written by us** — BullMQ v5 has no per-job timeout (that was Bull v3), a fact already recorded in `real-time-query-process/plan.md`. The loop's deadline must sit above the actor's own timeout, so Apify gives up first and we see a proper failure instead of abandoning a run we paid for. Second, worker concurrency should be at least the number of sites, or sites run one after another for no reason.

### 2. Only the service writes to Mongo

The worker picks an adapter, starts or resumes a run, polls, downloads, and hands the rows over. Everything that touches Mongo lives in service methods.

Both live in the same process, so this is not about boundaries. It is about having one place that owns run state. The polling loop, the failure handler, and a future recovery job then all use the same methods instead of writing their own.

### 3. One job per site

Each site gets its own queue job, because **each site is a different actor with a different input format**. LinkedIn, Naukri and Cutshort are three separate actors, so a run is three API calls no matter how we arrange it. The only question is whether those calls sit in one job or three.

Three, mainly because of cost: **a retry must not pay again for sites that already worked.** If one job handled every site and failed on the last one, BullMQ would retry the whole job and start runs we already paid for. We could avoid that inside a single job by tracking each site's run id and skipping finished ones — but that is rebuilding per-site jobs by hand, with worse visibility and no per-site backoff. Separate jobs give us this for free.

Two smaller reasons. **Failures stay separate**, so a broken LinkedIn actor does not throw away Naukri's results. And **sites run in parallel**, so a run takes as long as the slowest site instead of all of them added up.

Search terms do not add a second dimension. Most actors accept a list of queries, so one run per site covers every term. If an actor only takes one query per run, its adapter says so and we queue one job per site-and-term instead. That is the adapter's business, not something the caller assumes.

Terms are still capped at the API, now for cost rather than rate limits. More terms means more results, and results are what we pay for.

**If one actor covered every board we need, this decision would go away** — one run, one job, no per-site tracking, no partial status. Worth checking while picking actors, because it would be simpler. With LinkedIn, Naukri and Cutshort it does not apply.

### 4. Each site picks its own provider, and each actor gets its own adapter

Same pattern as `LlmProvider` in `ml/src/infra/llm.ts` and `VectorStore` in `ml/src/infra/vectorstore.ts`: one interface, resolved in one place. It lives in the feature folder because nothing outside `find-job` uses it.

The catch is that **`ApifyProvider` is not one implementation. It is one adapter per actor**, because every actor has its own input format and output shape. That is the main extra work this approach brings, and it is worth being clear about the trade: **we write each adapter once, instead of fixing scrapers forever.** An adapter mostly stays written. A scraper we maintain breaks whenever a board changes its pages.

Each adapter does three things: turn our query into that actor's input, say which fields hold the job URLs, and translate that actor's errors into our shared "can we retry this?" answer.

**Above the interface, rows are just untyped objects.** Only the adapter knows an actor's field names.

Because each site resolves separately, moving one board to a different actor — or scraping it ourselves — is a config change, not a code change.

### 5. Store postings as they came back, with our own fields wrapped around them

Each posting is stored with the actor's object untouched, surrounded by a small set of our own fields. Our fields are the contract. The actor's object is whatever it is.

This matters because **every actor returns a different shape**. They are written by different people with no shared format. Storing them as-is, along with a note of which actor and version produced each one, keeps that mess out of the rest of the system.

It also helps when an actor gets worse over time. If a board changes and an actor starts returning empty fields, **postings we already stored keep their data**. Only new ones are affected.

### 6. Dedupe with a unique key and upsert

Every posting gets a key built from its URL. That key has a unique index, and saving uses upsert.

Three things follow. Running the same search twice updates instead of duplicating. The same posting found on two boards collapses into one when the direct URL matches. And saving becomes safe to repeat — which is what makes a failed job safe to retry.

That last one matters more here than usual. **If the job dies after Apify finished but before saving completed**, the retry polls the same run, downloads the same results, and writes over what already landed. No second run, no duplicates, no second bill.

Building the key: prefer the employer's direct URL, fall back to the board URL, and finally fall back to a hash of site, company, title and location. Cleaning the URL matters most — lowercase the host, drop the query string and trailing slash — because boards add tracking parameters that would otherwise make every copy look different. Actors differ in which URL fields they provide, so the adapter points at the right ones.

This lives in its own file. It is the only pure logic in the feature, it is where small mistakes hide, and it can be tested without Mongo, Redis or the network.

### 7. Record what each run cost

Every site job saves what its run used — how many results, and whatever cost figure Apify reports.

It is one extra field, and it turns "should we scrape this board ourselves?" into something we can measure instead of argue about. We will be able to see which board is expensive and whether it has crossed the line.

Together with a hard result cap on every run, so a bad query cannot produce an unlimited bill.

---

## Data Model

Two collections.

### `jobs` — the postings

One document per posting. It holds **both the original data and, later, the cleaned-up version**. Cleaning is an update in place, not a write to another collection. That means no two copies to keep in sync, no lookup needed to see what a cleaned record came from, and an empty cleaned field is an easy marker for the later cleanup pass.

| Fields | What they are for |
|---|---|
| Identity | Document id, and **`runIds` — every run that found this posting** |
| Where it came from | Provider, **actor id and build**, site, and which search term found it |
| Dedupe | The cleaned URL key (unique index) and the actor's own job id if it gives one |
| Timing | When it was last fetched |
| **Original data** | The actor's object, exactly as returned |
| Cleaned data | Empty for now; filled in later |

Called `jobs` rather than `raw_jobs` because it will hold cleaned data too.

**`runIds` must be an array.** The dedupe key is unique across all runs, so a posting that run 2 finds and run 1 already stored is an update, not a new document. With a single `runId` field, that update would either keep run 1 — so run 2's list misses the posting — or overwrite with run 2, so run 1's list loses it. Either way one run shows wrong results. Adding each run to a list instead means a posting belongs to every run that found it, and both lists are right.

**Reads leave out the original data by default.** One posting's original data is 3–20 KB, so listing 50 of them pulls about a megabyte nobody displays. The repository drops that field unless a caller asks for it. Much cheaper to do now than after the list page gets slow.

### `job_scrape_runs` — run status

| Fields | What they are for |
|---|---|
| Identity and status | Run id (also the prefix of each queue job id) and current status |
| Inputs | Search terms, where they came from, and shared settings (location, remote, how many results, how recent, job type) |
| **Per-site status** | One entry per site: status, which actor, **Apify run id and dataset id**, counts of fetched / saved / duplicate, cost, and any error with its code and whether it can be retried |
| Totals | Run-level totals, added up from the per-site entries |
| Timestamps | Created, updated, finished |

Kept separate from `jobs` because it behaves differently — a few small documents per run instead of hundreds of large ones — and because the status endpoint reads it on every poll.

The per-site map is the heart of the design. It is how partial success is expressed, it is what the status endpoint returns, and it **holds the Apify run id that lets a crashed job resume instead of paying twice**.

### Indexes

| Collection | Index | Why |
|---|---|---|
| `jobs` | dedupe key, **unique** | Dedupe itself |
| `jobs` | **`runIds` + site** | Serves `GET /runs/:runId/jobs` |
| `jobs` | fetched-at, **TTL** | Expiry — see below |
| `jobs` | cleaned flag, sparse | The later cleanup pass |
| `job_scrape_runs` | created-at desc | Listing |
| `job_scrape_runs` | status + updated-at | The later recovery job |

**The TTL index is not optional.** Postings go stale in weeks and the documents are large. Without it, `jobs` grows forever and becomes the most expensive thing in the system. Default 45 days.

One thing to know now: TTL deletes the **whole document**, so original and cleaned data expire together. If we later want to keep cleaned records longer, the answer is to blank the original data on a schedule instead of deleting. That is also what would eventually justify splitting this into two collections.

---

## Run Status

Run level:

```
scraping → ready      (every site worked)
         ↘ partial    (some worked, some failed)
         ↘ failed     (every site failed)
```

Site level:

```
pending → running → done
                  ↘ failed
```

A site only moves to `running` **after its Apify run id is saved**. That ordering is what makes "resume, do not restart" possible: a site in `running` has a run id to resume, and a site in `pending` was never started.

There is no keyword step in phase 1. Terms come with the request, so site jobs are queued when the run is created and the run starts at `scraping`.

**`partial` is why sites are tracked separately.** One broken actor must not throw away the other boards' results.

One rule that is easy to get backwards: **a site returning zero postings is a success, not a failure.** An unusual search term can legitimately match nothing. Only an error is an error.

---

## API

| Endpoint | Returns | Notes |
|---|---|---|
| `POST /api/v1/find-job/runs` | `202` + run id, status, site count | Takes search terms, sites, location, remote, result count, recency, job type |
| `GET /api/v1/find-job/runs/:runId` | Run status, per-site status, totals | The polling endpoint |
| `GET /api/v1/find-job/runs/:runId/jobs` | The postings, paged, filterable by site | |
| `DELETE /api/v1/find-job/runs/:runId` | — | Deletes the run and its postings |

**`POST` returns `202 Accepted`, not `201`**, because nothing the client asked for exists yet. The response includes the site count so the caller knows how many things to wait on.

**`GET /runs/:runId` returns status, never the postings.** It is the polling endpoint and the only way to know a run has finished.

**`GET /runs/:runId/jobs` returns the postings**, paged. A run produces hundreds of large documents, so putting them in a status response would make every poll expensive.

Request checks now protect **spend**, not rate limits, so they are strict: empty term lists, too many terms, unknown sites, and result counts above a ceiling are all rejected. Each one is a bill, not just a bad request.

Deliberately missing: **no "list all runs" endpoint.** Nothing needs it yet.

---

## Queue and Worker Settings

| Setting | Value | Why |
|---|---|---|
| Attempts | 3 | A retry here resumes an existing run, and the failures worth retrying are Apify hiccups |
| Backoff | Exponential from ~10s | Nothing to wait out — no board is blocking us |
| Job timeout | Well above the actor timeout | A timeout firing mid-run abandons something we paid for |
| Worker concurrency | At least the number of sites | These jobs wait rather than compute, so a low number makes sites run one at a time |
| Keep completed | 24h | |
| Keep failed | 7d | Long enough to work out why an actor went bad |
| Autorun | Off | Started after Mongo connects |
| Job id | One per run and site | Stops the same site being queued twice, like `jobId = uploadId` in `file-upload-ocr` |

Concurrency here is about waiting, not CPU. That is the clearest sign this queue is a different kind of work from the others.

Startup and shutdown both need wiring. The worker must not pick up a job before Mongo connects, so it starts in the existing after-connect callback next to `startQueueEvents()` and `startSweeper()`. Shutdown needs to drain it — a long-polling job killed without draining leaves an Apify run nobody collects.

---

## What Gets Stored

We store everything an actor returns, so the fields we get are **whatever the actor provides**. That is why field coverage is part of picking actors, not something to find out afterwards.

Check each actor against these:

| Priority | Fields |
|---|---|
| **Must have** | Site, title, company, job URL, posted date, location, description |
| **Want** | Employer's direct URL (best dedupe key), remote flag, job type |
| **Nice** | Salary, seniority, company details, skills |
| **Bonus only** | Anything only one actor returns — use it, never depend on it |

Two things to know before building on this data.

**Salary is unreliable everywhere.** Many boards put pay in the description text rather than a proper field, so actors either skip it or guess. Filtering by salary is a data-cleaning problem, not a field we can read.

**"At least 20 fields" is met by any decent actor.** The list above is around 15 before company details, plus our own fields on top. Field count is not the hard part. Actors returning *different* shapes is, and storing things as-is handles that.

**On the number of boards**, Apify opens this up. It has actors for many boards beyond the ones we start with, so reaching a larger number is now a matter of adding adapters one at a time rather than a different project. Each new board costs one adapter plus its results.

---

## What Can Go Wrong

| Problem | What happens |
|---|---|
| Apify run fails for a temporary reason | Retry, resuming the existing run. After the attempt limit the site fails and the run becomes `partial`. |
| Apify run times out | Retry **once** with a lower result cap. If it happens again, the query is too broad and more retries will not help. |
| Someone aborts the run | Do not retry automatically. |
| **Out of credit / payment failed** | Cannot be fixed by retrying, and **must alert**. This is a billing problem that looks like a technical one, and it will fail every site until a person fixes it. |
| Actor not found | It was removed or renamed. Cannot be retried, and **must alert**. This is the main risk we still carry. |
| Actor rejects our input | Our bug — the adapter or the request checks are wrong. Do not retry. |
| Download fails after a successful run | Retry, and it is **safe**: the run already finished, so we re-download rather than re-run. No second charge. |
| Apify rate-limits our API calls | Retry. Rare at this volume. |
| Job dies while polling | The retry **resumes the saved run id**. It never starts another. This is the rule that protects the bill. |
| Mongo write fails partway | Retry re-downloads and re-saves. Dedupe makes that safe. |
| A site returns zero postings | **Success.** An unusual term can legitimately match nothing. |
| Backend restarts normally | Running jobs finish first, as long as shutdown drains the worker. |
| Process killed hard (SIGKILL, OOM) | The site stays `running` — **phase 1 has no recovery job.** But the run id is saved, so fixing it means resuming, not re-running. |
| Redis down | Creating a run fails with a 500. Nothing lost, nothing charged. |
| An actor quietly gets worse | Fields come back empty or counts drop. **Postings already stored are unaffected.** Comparing result counts between runs will show it. |

**The known gap: there is no recovery job in phase 1.** A hard kill leaves a site stuck at `running` with nothing to fix it. Two things make this manageable. Normal restarts are covered by draining on shutdown. And because the Apify run id is saved, a future recovery job **resumes** the run we already paid for instead of paying again. `file-upload-ocr.sweeper.ts` is the template, and the index it needs is already listed.

---

## Safe to Repeat

| Action | Why it is safe |
|---|---|
| Queue a site job again | The job id is fixed per run and site, so BullMQ rejects a duplicate while the first is still running |
| Retry a site job | It resumes the saved Apify run id instead of starting a new one. **This is what keeps retries free.** |
| Download results again | Read-only, and already paid for |
| Save postings again | Unique dedupe key plus upsert means update, never duplicate |

Here, being safe to repeat is not just tidiness. It is a cost control.

---

## Environment Variables

All under a `findJob` key in `backend/src/config/env.ts`, following the existing `ocrQueue` / `embedQueue` pattern.

| Variable | Default | Notes |
|---|---|---|
| `SCRAPE_QUEUE_NAME` | `scrape-queue` | |
| `APIFY_TOKEN` | *required* | The only new secret |
| `APIFY_ACTORS` | *(the open decision)* | Which actor to use for each site |
| `APIFY_POLL_INTERVAL_MS` | `10000` | How often a job checks its Apify run |
| `APIFY_RUN_TIMEOUT_MS` | `600000` | Sent to Apify, so Apify gives up first |
| `FINDJOB_POLL_DEADLINE_MS` | `900000` | Our own polling deadline. Must exceed `APIFY_RUN_TIMEOUT_MS`. BullMQ has no per-job timeout |
| `APIFY_MAX_ITEMS_PER_RUN` | `100` | **Cost guard.** Hard cap on results per run |
| `FINDJOB_WORKER_CONCURRENCY` | `4` | These jobs wait, so at least the number of sites |
| `FINDJOB_DEFAULT_SITES` | *(from the actor list)* | Used when the request does not say |
| `FINDJOB_MAX_SEARCH_TERMS` | `3` | Limits how wide a run gets — a spend control |
| `FINDJOB_RESULTS_PER_SITE` | `50` | Default results per site |
| `FINDJOB_MAX_RESULTS_PER_SITE` | `100` | Hard ceiling, enforced on the request |
| `FINDJOB_HOURS_OLD` | `168` | 7 days |
| `FINDJOB_SITE_OVERRIDES` | *(empty)* | Send one site to a different provider; unused until there is a second one |
| `RAW_JOB_TTL_DAYS` | `45` | How long postings are kept |

---

## What Each Module Owns

Standard feature layout under `backend/src/features/find-job/`, plus one queue file in `src/infra/` next to `embedQueue` and `generateQueue`.

| Module | Owns |
|---|---|
| `routes` / `controller` | HTTP layer, request checks, response shape |
| `schema` | Request rules — including the term and result caps, which are spend controls |
| `service` | **Every Mongo write.** Creating runs, saving run ids, saving postings, marking failures, totals, reads |
| `worker` | Queue handling, picking the adapter, the **resume-or-start** decision, the polling loop, error handling, start/stop |
| `providers/` | The seam: the interface, one adapter per actor, per-site resolution. **The only place an actor's field names appear** |
| `dedupe` | URL cleaning and key building. Pure, no I/O, easy to test |
| `model/` + `repository/` | Mongoose schemas, indexes, and data access for both collections |
| `infra/scrapeQueue` | Queue setup and job options |

The worker starting and stopping itself follows `ml/src/features/embeddings/embeddings.worker.ts` — the feature owns its background work, and `index.ts` only decides when to start it.

---

## Build Order

1. **Data layer.** Dedupe, models, repositories. Pure logic and schemas, testable with nothing running.
2. **Service and API.** Creating runs, saving postings, reads, request checks, routes, container wiring. Test saving with made-up rows. Nothing scrapes and nothing is charged.
3. **Env and queue.** Config, the queue file, `.env.example`. Backend boots.
4. **Provider seam and Apify client.** The interface, an HTTP wrapper for three Apify endpoints, and per-site resolution. Test against any cheap actor just to prove the calls work.
5. **Choose actors** *(blocking)*. Fill in the table above. Run each candidate once from the Apify console with a realistic query and **keep the output** — step 6 is written against it.
6. **First adapter.** One actor, driven from a throwaway script next to `scripts/smoke-path-a.ts`. Prove start, poll and download work before the queue is involved.
7. **Worker.** Resume-or-start, polling, error handling, startup and shutdown. End to end for one site.
8. **Remaining adapters**, one per site.
9. **Review** after a week: check the cost, confirm no list query pulls the original data, test shutdown draining.

Steps 1–3 need no Apify account and cost nothing.

---

## Phase 2

All of this is additive. None of it changes the data model, the provider seam, the per-site jobs, or the API.

| Change | What it touches |
|---|---|
| **Search terms from a resume** | `POST /runs` takes an upload id instead of terms. A job in `ml` reads the resume's chunks — already stored by `file-upload-ocr` — and returns search terms using the existing Gemini setup. Adds one status step at the front. Needs one addition to `ml`: a way to read all chunks for one upload, which `VectorStore` does not have. |
| **Webhooks instead of polling** | Apify calls us when a run finishes. Frees worker slots and removes the polling loop, but needs a public endpoint with signature checks. Worth it when runs get frequent. |
| **Recovery job** | Based on `file-upload-ocr.sweeper.ts`; the index is already listed. Cheaper here because a stuck site has a run id to resume rather than re-run. |
| **Live progress** | A Socket.IO room per run, like `ocr:progress` / `ocr:completed`. The service already has the data. |
| **Scraping a board ourselves** | When the recorded cost shows a board is too expensive, add our own adapter for that board and point the override at it. One board at a time. |
| **More boards** | One adapter per new actor. Nothing else changes. |
| **Cleaning up the data** | A job that finds postings with no cleaned version, works out how to read them from the actor id and build, and fills it in. The original is never changed. The real work is reading salary out of description text, working out seniority, and making company names consistent. |

None of this is a rewrite because the provider seam, per-site jobs, the stored-as-is format and service-owned writes are all in place from the start. Phase 2 changes **who calls the save method** and **where the search terms come from**, not what happens inside.
