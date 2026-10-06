I want to add an OCR file-upload pipeline to this Nx monorepo. Do NOT write any code yet.

First, inspect the workspace and tell me:
- Nx version, package manager, installed plugins (@nx/node, @nx/js, @nx/express,
  @nx/esbuild/webpack, @nx/jest/vitest, @nx/docker?)
- where apps and libs live (apps/, libs/, packages/?), project naming, import path
  aliases in tsconfig.base.json, existing tags and @nx/enforce-module-boundaries rules
- how existing Node apps are built, served and containerised (targets in project.json)
- the existing Postgres setup: connection config/env names, any shared db lib, and the
  migration tool in use (Prisma, TypeORM, Knex, node-pg-migrate, raw SQL?)
- anything reusable: env loading, logger, error classes, docker-compose

Then write docs/ocr-pipeline/PLAN.md following those conventions, containing:
[... same ARCHITECTURE through BUILD STEPS sections as before ...]

NX SPECIFICS
- generate every project with Nx generators (show me the exact commands), never by hand
- projects: ocr-orchestrator, ocr-worker (apps); ocr-contracts, ocr-messaging (libs)
- tags: scope:ocr on all four; type:app on apps; type:contracts on ocr-contracts;
  type:messaging on ocr-messaging. Module-boundary rules: type:contracts depends on nothing
  internal; type:messaging may depend only on type:contracts; type:app may depend on both.
  ocr-worker must not import anything database-related.
- use path aliases from tsconfig.base.json for lib imports

POSTGRES (existing)
- reuse the existing Postgres server; OCR tables live in a dedicated schema "ocr"
- if a shared db lib or pool exists, reuse it; otherwise ocr-orchestrator owns its own
  pg Pool singleton
- migrations: use the repo's existing migration tool. Only if there is none, use the
  sql/*.sql + schema_migrations + advisory-lock runner described above.

Show me the workspace findings and PLAN.md, then stop.

---------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 2 only: the two libs.

- generate ocr-contracts and ocr-messaging with the Nx library generator the workspace
  already uses (show the commands), with the tags from the plan
- add the module-boundary rules from the plan to the ESLint config and prove they work
  (e.g. show that importing ocr-messaging from ocr-contracts fails lint)

ocr-contracts: [same as before]
ocr-messaging: [same as before]

Add unit tests for the zod schemas. Run nx lint/test for both libs.
Show me the public API of both libs, then stop.


-----------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 3 only: ocr-orchestrator skeleton.

- generate the app with the same Nx generator/bundler existing Node apps use (show the
  command), tags scope:ocr, type:app
- config/env.ts (zod-validated, fail fast)
- infra/db.ts: reuse the existing shared db lib/pool if there is one, otherwise a pg Pool
  singleton; set search_path or fully qualify tables in schema "ocr"
- migration for ocr.uploads using the repo's existing migration tool; wire it the same
  way existing apps run migrations
- infra/s3.ts, infra/storage.ts, common/errors.ts + error middleware, app.ts with
  GET /health (pg), infra/container.ts, index.ts with graceful shutdown [same as before]
- Docker build following how existing apps are containerised in this workspace

No uploads feature, no RabbitMQ yet. Show me the project.json targets, folder tree and
how to run it with nx serve, then stop.

-----------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 4 only: features/uploads in
ocr-orchestrator, WITHOUT RabbitMQ.

- types, zod request schemas, repository (raw SQL, row->camelCase mapping,
  forward-only transition method: transition(id, to, allowedFrom, patch)),
  service, controller + routes via factory functions
- POST /uploads: validate type and size, server-generated key
  uploads/<uuid>/<sanitized-filename>, insert awaiting_upload, return presigned PUT
  (ContentType signed in, 15 min expiry)
- POST /uploads/:id/complete: HeadObject, check exists + actual size + content type,
  transition awaiting_upload->queued; idempotent (already queued or later -> 200 with
  current state). For now do NOT publish anything.
- GET /uploads/:id, GET /uploads (limit/cursor), DELETE /uploads/:id (409 if processing)
- Service tests with a fake StorageService and repository

Give me a curl walkthrough (presign -> PUT file -> complete -> get), then stop.
Run nx lint, test and typecheck for the affected projects before stopping.


-----------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 5 only: publishing jobs from the orchestrator.

- infra/rabbitmq.ts: connection + one confirm channel (publishing) + one consumer channel
  as shared objects, assertTopology on startup, added to /health and graceful shutdown
- features/uploads/uploads.publisher.ts: JobPublisher interface + RabbitJobPublisher
  using ocr-messaging publishJson (routing key ocr.job, messageId = uploadId, x-attempt 1)
- complete(): after transition to queued, publish, then set published_at. If publish
  throws, keep the row queued with published_at null and still return 202 (sweeper will
  retry later; explain this outbox-lite trade-off in a comment)

Tell me how to see the message sitting in ocr.jobs in the RabbitMQ UI, then stop.


-----------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 6 only: apps/ocr-worker with a FAKE OCR engine.

- generate ocr-worker with the same Nx generator as ocr-orchestrator (show the command), tags scope:ocr, type:app; then the   same layered + shared-object structure
- features/ocr/ocr.engine.ts: OcrEngine interface + FakeOcrEngine (returns
  "fake text, N bytes", reports progress 0..100)
- features/ocr/ocr.events.publisher.ts: publishes started/progress/completed/failed
- features/ocr/ocr.service.ts: started -> download -> recognize (throttled progress) ->
  put results/<uploadId>.txt -> completed
- features/ocr/ocr.consumer.ts: prefetch 1 on ocr.jobs, ack only after completed is
  confirmed. Errors: for now, publish failed + nack(requeue=false). Retries come later.
- Dockerfile, graceful shutdown (cancel consumer, finish in-flight job, close)

Show me how to watch events land in orchestrator.ocr-events, then stop.

-----------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 7 only: features/uploads/uploads.consumer.ts
in ocr-orchestrator.

- consume orchestrator.ocr-events (prefetch 20) via factory receiving the service
- started: queued -> processing; progress: update progress + updated_at only while
  processing; completed: queued|processing -> completed with result fields + completed_at;
  failed: queued|processing -> failed with error
- all transitions forward-only so duplicate/late events are no-ops (log at debug)
- unknown uploadId -> ack and warn
- DB error -> wait 2s then nack(requeue=true)
- GET /uploads/:id returns presigned textUrl when completed
- tests for out-of-order and duplicate events

Show me an end-to-end run with the fake engine, then stop.

-----------

Read docs/ocr-pipeline/PLAN.md. Implement step 8 only: TesseractOcrEngine in ocr-worker.

- tesseract.js with one long-lived worker per process (concurrency comes from replicas,
  prefetch stays 1); bundle English language data so it works offline in Docker
  (e.g. @tesseract.js-data/eng) and explain the choice
- map tesseract progress to OcrProgress; return text, charCount, mean confidence,
  first 500 chars as preview
- corrupt/unreadable image -> NonRetryableError
- OCR_ENGINE=fake|tesseract env switch in the container
- terminate the tesseract worker on shutdown

Give me a sample image test and expected result, then stop.

--------------------------------------------------------

Read docs/ocr-pipeline/PLAN.md. Implement step 9 only: reliability.

Worker:
- RetryableError (or unknown error) with x-attempt < 3: publish the same job to
  ocr.jobs.retry with x-attempt+1 (confirmed), then ack the original
- NonRetryableError or attempts exhausted: publish OcrFailed, then nack(requeue=false) -> DLQ
- note in comments how x-delivery-limit protects against crash loops that never reach
  the catch block

Orchestrator: features/uploads/uploads.sweeper.ts, every 30s, under pg_try_advisory_lock:
- queued + published_at null + updated_at older than 30s -> publish, set published_at
- processing + updated_at older than PROCESSING_TIMEOUT (default 30 min) -> failed "timed out"
- log only when it did something; unref timer; stopped on shutdown

Add a "break it on purpose" section to docs/ocr-pipeline/README.md: kill the worker
mid-job, stop RabbitMQ during complete, upload a corrupt file, and what to observe
in each case. Then stop.

-----------------------------------------
Read docs/ocr-pipeline/PLAN.md. Step 10: review and polish, no new features.

- check both apps against the PLAN's layering rules (no upward imports, no container
  imports outside index/app), list violations and fix them
- graceful shutdown order on both apps: stop intake -> finish in-flight -> close channels
  -> connection -> pool
- consistent structured logging with uploadId on every line
- docs/ocr-pipeline/README.md: architecture diagram (text), how to run, curl walkthrough,
  RabbitMQ UI tour, env vars table, known limitations (no PDFs, no auth, polling only)
- run nx affected -t lint test typecheck build and report results; show nx graph for the four ocr projects and confirm the dependency directions match the plan.
