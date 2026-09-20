# Find Job — Scraping Job Postings (Explanation)

## What it does

Send search terms to one API. It scrapes job postings from several boards through Apify and stores them in MongoDB. The request does not wait. One failing board does not ruin the whole run. And the scraping service can be swapped later without changing anything else.

Phase 1 keeps it all inside `backend/` as one feature, and **pays Apify to scrape rather than doing it ourselves**. Section 12 covers what comes later.

---

## 1. The main decision: pay for scraping, don't build it

The obvious approach is a scraping library running in our own process. We chose not to, because of how little we scrape.

Doing it ourselves means owning proxies, rate limits, anti-bot handling, and — the part that never ends — **fixing the scraper every time a job board changes its pages**. That work costs roughly the same whether we scrape twice a day or two hundred times. It does not get cheaper just because we do it rarely.

Apify handles all of that. We pay per result instead:

```
2 runs/day × 4 sites × 50 results ≈ 12,000 results/month
```

At that size the bill is small and predictable. Doing it ourselves only wins once that bill grows past what proxies plus engineering time would cost, and we are nowhere near that.

**What the decision removes:** rate limiting, proxy management, scraper maintenance, a native dependency that would have forced a change to our Docker image, and heavy HTML parsing competing with the API for CPU. That last one also removed the only reason this feature might have needed its own service.

**What it costs:** we pay per result, we write one adapter per actor, we depend on whoever maintains each actor, and **retries now cost money**. That last one changes several decisions below.

---

## 2. One API call, returns straight away

```
POST /api/v1/find-job/runs
{ "searchTerms": ["backend engineer typescript"],
  "sites": ["linkedin", "naukri"], "location": "Pune" }

→ 202 { "runId": "...", "status": "scraping", "siteCount": 2 }
```

The handler creates a run document, queues one job per site, and returns. A real run takes minutes. The HTTP call takes milliseconds.

It returns `202 Accepted` rather than `201`, because nothing the client asked for exists yet.

Request checks are strict, but the reason changed. They used to prevent rate-limit problems. Now they **prevent spend**. Empty term lists, too many terms, unknown sites, and result counts above a ceiling are all rejected — because each one is a bill, not just a bad request.

---

## 3. The interesting part: a queue job that waits on Apify

This is different from every other queue in the project. `ocr-queue` and `embed-queue` jobs *do* the work. A `scrape-queue` job **starts work on Apify and waits**, for minutes.

The job does this: pick the adapter for this site, start an Apify run, poll until it finishes, download the results, hand them to the service.

Three things follow, and the first is the most important rule in the whole design.

**A retry must never start a second Apify run.** Scraping ourselves is free to repeat. Starting an actor again is a second bill. So the Apify run id is **saved before polling begins**, and the job always checks for one first. If it is there, keep polling that run instead of starting another. Without this, one crashed worker quietly doubles the cost. The status values enforce the order: a site only becomes `running` once its run id is saved, so `pending` definitely means nothing was started.

**Polling happens inside the job.** At 1–2 runs a day, holding a worker slot for a few minutes costs nothing and keeps all the logic in one place. The alternatives are a delayed follow-up job or an Apify webhook. Both free the slot, but one adds more states and the other needs a public endpoint. Neither is worth it yet. Webhooks are the answer later.

**Two settings follow from jobs being long-lived.** First, **we have to write the timeout ourselves.** BullMQ v5 has no per-job timeout — that was Bull v3, and `real-time-query-process/plan.md` already records hitting this. So the polling loop carries its own deadline, set above the actor's own timeout so Apify gives up first and we get a real failure instead of abandoning a run we paid for. Second, worker concurrency should be at least the number of sites, because these jobs *wait* rather than compute — a low number makes sites run one after another for no reason.

---

## 4. One job per site

Each site gets its own queue job, because **each site is a different actor with a different input format**. LinkedIn, Naukri and Cutshort are three separate actors, so a run is three API calls however we arrange it. The only question is whether those three calls sit in one job or three.

Three, and the main reason is money: **a retry must not pay again for sites that already worked.** If one job handled every site and failed on the last one, BullMQ would retry the whole thing and start runs we already paid for. We could avoid that inside a single job by tracking each site's run id and skipping the finished ones — but that is rebuilding per-site jobs by hand, with worse visibility and no per-site backoff. Separate jobs give it to us for free.

Two smaller reasons. **Failures stay separate**, so a broken LinkedIn actor does not throw away Naukri's results. And **sites run in parallel**, so a run takes as long as the slowest site instead of all of them added together.

Search terms do not add a second dimension. Most actors accept a list of queries, so one run per site covers every term. If an actor only takes one query per run, its adapter says so and we queue one job per site-and-term instead. That is the adapter's business.

**One thing worth checking while picking actors:** if a single actor covered every board we need, this whole decision would disappear — one run, one job, no per-site tracking, no partial status. Simpler. With LinkedIn, Naukri and Cutshort it does not apply, since they are three different actors.

---

## 5. The provider seam

The worker picks a provider **per site** behind one interface — the same pattern as `LlmProvider` in `ml/src/infra/llm.ts` and `VectorStore` in `ml/src/infra/vectorstore.ts`.

The seam was originally there in case our own scraper broke and we needed to escape to a paid service. Starting on Apify **flips it around**: now it is there in case Apify gets expensive and we want to scrape a board ourselves. Same interface, opposite direction, same small cost.

And because each site resolves separately, that move is **one board at a time**. When the recorded cost shows LinkedIn is too expensive, we scrape that one board ourselves and leave the rest — a config change plus one adapter.

The honest catch: **`ApifyProvider` is not one implementation, it is one adapter per actor**, because each actor has its own input format and output shape. That is the main extra work this approach brings, and it is a real trade: **we write each adapter once instead of fixing scrapers forever.** An adapter mostly stays written. A scraper we maintain breaks whenever a board changes its pages.

Each adapter does three things: turn our query into that actor's input, say which fields hold the job URLs, and translate that actor's errors into our shared "can we retry this?" answer. Above the interface, rows are just untyped objects — only the adapter knows an actor's field names.

---

## 6. Storage — one collection, original and cleaned data together

Each posting is one document in a `jobs` collection, holding **both the original data and, later, the cleaned-up version**. Cleaning is an update in place, not a write to a second collection. So there are no two copies to keep in sync, no lookup needed to see what a cleaned record came from, and an empty cleaned field is an easy marker for the cleanup pass later.

Around the original data sits a small set of our own fields. Those are the contract. The actor's object is whatever it is.

**That matters because every actor returns a different shape.** They are written by different people with no shared format. Storing things as-is, plus a note of which actor and version produced each posting, keeps that mess out of the rest of the system. It also means later cleanup code can handle several actor shapes side by side without reprocessing anything.

**One field deserves calling out: `runIds` is a list, not a single value.** The dedupe key is unique across all runs, so a posting that run 2 finds and run 1 already saved is an *update*, not a new document. With a single `runId` field, that update would either keep run 1 — so run 2's list misses the posting — or overwrite with run 2, so run 1's list loses it. Either way one run shows wrong results. Adding each run to a list instead means a posting belongs to every run that found it, and both lists are right. Easy to get wrong, and expensive to fix once data exists.

**Dedupe** is that unique key plus upsert. Running the same search twice updates instead of duplicating, and the same posting found on two boards collapses into one when the direct URL matches. It earns extra keep here: **it makes re-downloading results safe.** If the job dies after Apify finished but before saving completed, the retry polls the same run, downloads the same results, and writes over what already landed. No second run, no duplicates, no second bill.

Cleaning the URL is the part that matters most — lowercase the host, drop the query string — because boards add tracking parameters that would otherwise make every copy look different. Actors differ in which URL fields they provide, so the adapter points at the right ones. This lives in its own file: it is the only pure logic here, it is where small mistakes hide, and it can be tested with no Mongo, Redis or network.

**Reads leave out the original data by default.** One posting's original data is 3–20 KB, so listing 50 of them pulls about a megabyte nobody displays. The repository drops it unless a caller asks — much cheaper to do now than after the list page gets slow.

**Expiry:** a TTL index on the fetch date (45 days) is not optional, or this collection becomes the most expensive thing we have. Worth knowing that TTL deletes the *whole document*, so original and cleaned data expire together. If we later want to keep cleaned records longer, the answer is blanking the original data on a schedule instead — which is also what would eventually justify splitting the collection.

---

## 7. Recording what each run costs

Every site job saves what its run used — how many results, and whatever cost figure Apify reports.

It is one extra field, and it turns "should we scrape this board ourselves?" into something we can measure rather than argue about. We will see which board is expensive and whether it has crossed the line.

Alongside a hard result cap on every run, so a bad query cannot produce an unlimited bill.

---

## 8. Handling errors

Adapters translate each actor's failures into a shared answer, and that drives BullMQ:

- **Temporary run failures** → retry, resuming the existing run
- **Timeouts** → retry *once* with a lower result cap. If it happens again the query is too broad, and more retries will not help
- **Aborted runs** → someone stopped it on purpose; do not retry
- **Bad input** → our bug, in the adapter or the request checks; do not retry
- **Download fails after a successful run** → retry, and it is safe, because we re-download rather than re-run

Two get special treatment because they are quiet and expensive.

**Out of credit** is a billing problem that looks like a technical one. It cannot be retried away and it will fail every site until a person fixes it, so it stops the job *and* alerts.

**Actor not found** means it was removed or renamed. This is the main risk we still carry. Also stops the job, also alerts.

And one rule that is easy to get backwards: **a site returning zero postings is a success.** An unusual search term can legitimately match nothing. Only an error is an error.

---

## 9. Getting the results back

Because `POST` returns immediately, there has to be a way to find out what happened:

```
GET /api/v1/find-job/runs/:runId        → status, per-site status, totals
GET /api/v1/find-job/runs/:runId/jobs   → the postings (paged)
```

**`/runs/:runId` is the polling endpoint** and the only way to know a run finished. It returns status: `scraping` / `ready` / `partial` / `failed`, plus per-site counts, cost and errors.

**It does not return the postings.** Those come from `/runs/:runId/jobs`, paged. A run produces hundreds of large documents, so putting them in a status response would make every poll expensive.

There is deliberately **no "list all runs" endpoint** — nothing needs it yet.

---

## 10. Status values

```
run:   scraping → ready | partial | failed
site:  pending  → running → done | failed
```

A site only becomes `running` **after its run id is saved**, which is what makes "resume, do not restart" possible — `pending` definitely means nothing was started.

`partial` is why sites are tracked separately: one broken actor must not throw away the other boards' results.

---

## 11. What we left out on purpose

**There is no recovery job in phase 1.** In `file-upload-ocr`, status lives in Mongo while the real state lives in BullMQ, and a recovery job reconciles them every 5 minutes. Here, a hard kill (SIGKILL, OOM) while polling leaves a site stuck at `running` with nothing to fix it.

Two things make that manageable. Normal restarts are covered by draining the worker on shutdown. And because the Apify run id is saved, a future recovery job **resumes** the run we already paid for instead of paying twice.

Naming this now is better than finding it later.

**Which actors to use is still open**, and it is the one thing blocking the build — but the risk is not *which* actor, it is **whether one exists**.

Apify is worth paying for because someone else maintains the scraper. That only holds for boards that have a maintained actor, and coverage is uneven. LinkedIn has several good ones. Smaller or regional boards may have one old actor, or none. For a board with nothing maintained, the choices are: drop it, write our own Apify actor, scrape that one board ourselves through the per-site override — or use a generic scraper actor with our own parsing, which is the worst option, since we are back to fixing parsers *and* paying for it.

A mixed result is fine and probably what will happen: good actors where they exist, something else for one or two boards. The seam makes it a per-board choice. What matters is finding out before we start writing adapters.

Beyond availability, how to pick: is it maintained, does it return the fields we need, can we cap the result count (without that, a bad query means an unlimited bill), does it take several queries per run, and how is it priced.

One rule that keeps the seam useful: **never build a feature on a field only one actor returns.** Treat those as a bonus. That is the quiet way we end up locked in despite a clean interface.

---

## 12. What comes later

| Change | What it touches |
|---|---|
| **Search terms from a resume** | `POST /runs` takes an upload id instead of terms. A job in `ml` reads the resume's chunks — already stored by `file-upload-ocr` — and returns search terms using the existing Gemini setup. Adds one status step at the front. Needs one addition to `ml`: a way to read all chunks for one upload, which `VectorStore` does not have. |
| **Webhooks instead of polling** | Apify calls us when a run finishes. Frees worker slots and removes the polling loop, but needs a public endpoint with signature checks. Worth it when runs get frequent. |
| **Recovery job** | Based on the `file-upload-ocr` one. Cheaper here, because a stuck site has a run id to resume rather than re-run. |
| **Live progress** | A Socket.IO room per run, like `ocr:progress` / `ocr:completed`. The service already has the data. |
| **Scraping a board ourselves** | The flipped seam. When the recorded cost shows a board is too expensive, add our own adapter for that board and point the override at it. |
| **More boards** | One adapter per new actor. Nothing else changes, so growing the list is incremental. |
| **Cleaning up the data** | A job that finds postings with no cleaned version, works out how to read them from the actor id and build, and fills it in. The original is never changed. The real work is reading salary out of description text, working out seniority, and making company names consistent. |

None of this is a rewrite, because the provider seam, per-site jobs, the stored-as-is format and service-owned writes are all there from the start. Later work changes **who calls the save method** and **where the search terms come from**, not what happens inside.

---

## Summary

- **Pay for scraping, don't run it.** At 1–2 runs a day, proxies and scraper maintenance cost more than per-result billing
- `POST /find-job/runs { searchTerms }` → run document + one job per site → `202` with a `runId`, immediately
- **One job per site**, because each site is a different Apify actor
- The queue job **waits on Apify**: start → poll → download → save. Concurrency is about waiting, not CPU
- **Retries resume, never restart.** The run id is saved before polling begins, because a second start is a second bill
- Each site picks its provider **separately**, one adapter per actor, and the seam now points *toward* scraping things ourselves rather than away from it
- Postings are stored as they came back, tagged with the actor id and build, with the cleaned field empty for now
- Dedupe by unique URL key plus upsert, which also makes re-downloading safe
- Cost is recorded per site, so the "scrape it ourselves" decision is a measurement
- Sites add up to `ready` / `partial` / `failed`; `GET /runs/:runId` polls status, `GET /runs/:runId/jobs` returns postings
- Left out on purpose: recovery job, live progress, resume parsing, data cleanup — and the actor choice is still open
