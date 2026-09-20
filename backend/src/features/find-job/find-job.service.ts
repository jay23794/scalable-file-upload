import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';

import { env } from '../../config/env';
import { ScrapeJobData, scrapeJobId } from '../../infra/scrapeQueue';
import { buildDedupeKey } from './dedupe';
import { FindJobRepository } from './repository/find-job.repository';
import { RawJobRepository } from './repository/raw-job.repository';
import { CreateRunInput } from './find-job.schema';
import { readRow } from './providers/rows';
import { ProviderRunHandle, RawJobBatch } from './providers/types';
import {
  JobEnvelope,
  JobSite,
  ListJobsOptions,
  ListJobsResult,
  RunNotFoundError,
  RunStatus,
  RunTotals,
  ScrapeRunRecord,
  SiteEntry,
  SiteError,
  SiteNotInRunError,
} from './types';

export interface CreateRunResult {
  runId: string;
  status: RunStatus;
  siteCount: number;
}

/** A fresh site entry: provably nothing has been started for it yet. */
const pendingSite = (site: JobSite): SiteEntry => ({
  site,
  status: 'pending',
  fetched: 0,
  ingested: 0,
  duplicates: 0,
});

/**
 * Derive the run's status and totals from the whole sites map.
 *
 * Never incremented. Two sites finishing at the same moment both recompute
 * from the same derived source, so they converge instead of corrupting each
 * other's counters.
 */
export function rollUp(sites: Record<JobSite, SiteEntry>): {
  status: RunStatus;
  totals: RunTotals;
  completed: boolean;
} {
  const entries = Object.values(sites);
  const totals: RunTotals = { fetched: 0, ingested: 0, duplicates: 0, costUsd: 0 };

  for (const entry of entries) {
    totals.fetched += entry.fetched;
    totals.ingested += entry.ingested;
    totals.duplicates += entry.duplicates;
    totals.costUsd += entry.costUsd ?? 0;
  }
  // Float drift from summing per-site costs would otherwise show up as
  // 0.30000000000000004 on the status endpoint.
  totals.costUsd = Number(totals.costUsd.toFixed(6));

  const done = entries.filter((e) => e.status === 'done').length;
  const failed = entries.filter((e) => e.status === 'failed').length;
  const completed = done + failed === entries.length && entries.length > 0;

  let status: RunStatus = 'scraping';
  if (completed) {
    // One broken actor must not throw away the other boards' results: a run
    // with any successful site is `partial`, not `failed`.
    if (failed === 0) status = 'ready';
    else if (done === 0) status = 'failed';
    else status = 'partial';
  }

  return { status, totals, completed };
}

export class FindJobService {
  constructor(
    private _runs: FindJobRepository,
    private _jobs: RawJobRepository,
    private _scrapeQueue: Queue<ScrapeJobData>,
  ) {}

  /**
   * Create a run and queue one job per site.
   *
   * The run document is written BEFORE anything is queued, or a fast worker
   * could pick up a job whose run does not exist yet.
   */
  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const sites = input.sites ?? env.findJob.defaultSites;
    if (sites.length === 0) {
      throw new Error(
        'No sites to scrape: pass `sites`, or set FINDJOB_DEFAULT_SITES / APIFY_ACTORS.',
      );
    }

    const runId = randomUUID();
    const resultsWanted = input.resultsWanted ?? env.findJob.resultsPerSite;
    const hoursOld = input.hoursOld ?? env.findJob.hoursOld;

    const siteMap: Record<JobSite, SiteEntry> = {};
    for (const site of sites) siteMap[site] = pendingSite(site);

    await this._runs.create({
      id: runId,
      searchTerms: input.searchTerms,
      query: {
        location: input.location,
        isRemote: input.isRemote,
        resultsWanted,
        hoursOld,
        jobType: input.jobType,
      },
      sites: siteMap,
    });

    try {
      // `addBulk`, not N separate `add` calls: it pipelines the whole set into
      // one Redis round trip, so the realistic failure -- Redis unreachable --
      // takes all of them together. N independent adds could leave some jobs
      // landing AFTER the catch below marks the run failed, and a worker
      // picking one of those up would start a paid Apify run for a dead run.
      await this._scrapeQueue.addBulk(
        sites.map((site) => ({
          name: 'scrape-site',
          data: {
            runId,
            site,
            searchTerms: input.searchTerms,
            location: input.location,
            isRemote: input.isRemote,
            resultsWanted,
            hoursOld,
            jobType: input.jobType,
          },
          // Still per-job, so re-queueing one site stays idempotent.
          opts: { jobId: scrapeJobId(runId, site) },
        })),
      );
    } catch (err) {
      // Queueing threw partway through. Leaving the run half-dispatched would
      // strand it in `scraping` forever with no job behind some of its sites.
      await this._runs.markFailed(runId);
      throw err;
    }

    return { runId, status: 'scraping', siteCount: sites.length };
  }

  /**
   * Save the Apify run id and move the site to `running`.
   *
   * The ordering is the point: a site in `running` has a run id to resume, and
   * a site in `pending` provably had nothing started. Called before polling
   * begins, never after.
   */
  async recordDispatch(
    runId: string,
    site: JobSite,
    handle: ProviderRunHandle & { provider: string },
  ): Promise<SiteEntry> {
    const entry = await this._requireSite(runId, site);

    // Defence in depth for the rule that protects the bill. The worker checks
    // for an existing run id before starting one; if that check is ever missed,
    // refusing to overwrite here means the second run id cannot be recorded and
    // the mistake is loud rather than silent.
    if (entry.apifyRunId && entry.apifyRunId !== handle.apifyRunId) {
      throw new Error(
        `Refusing to overwrite Apify run id for ${runId}/${site}: ` +
          `already ${entry.apifyRunId}, got ${handle.apifyRunId}`,
      );
    }

    const updated: SiteEntry = {
      ...entry,
      status: 'running',
      provider: handle.provider,
      actorId: handle.actorId,
      actorBuild: handle.actorBuild,
      apifyRunId: handle.apifyRunId,
      datasetId: handle.datasetId,
      startedAt: entry.startedAt ?? new Date(),
    };

    await this._runs.setSiteEntry(runId, site, updated);
    return updated;
  }

  /**
   * Store a finished site's postings and roll the run up.
   *
   * A site that returned zero rows lands here too, and ends `done`: an unusual
   * search term can legitimately match nothing. Only an error is an error.
   */
  async ingestSite(runId: string, site: JobSite, batch: RawJobBatch): Promise<SiteEntry> {
    const entry = await this._requireSite(runId, site);

    const fetchedAt = batch.fetchedAt ?? new Date();
    const envelopes: JobEnvelope[] = batch.rows.map((row) => {
      const read = readRow(row, batch.fields);
      return {
        provider: batch.provider,
        actorId: batch.actorId,
        actorBuild: batch.actorBuild,
        site,
        searchTerm: read.searchTerm,
        sourceJobId: read.sourceJobId,
        dedupeKey: buildDedupeKey({
          site,
          employerUrl: read.employerUrl,
          boardUrl: read.boardUrl,
          company: read.company,
          title: read.title,
          location: read.location,
        }),
        fetchedAt,
        raw: row,
      };
    });

    const { ingested, duplicates } = await this._jobs.bulkUpsert(runId, envelopes);

    const updated: SiteEntry = {
      ...entry,
      status: 'done',
      provider: batch.provider,
      actorId: batch.actorId,
      actorBuild: batch.actorBuild,
      fetched: batch.rows.length,
      ingested,
      duplicates,
      costUsd: batch.costUsd ?? entry.costUsd,
      finishedAt: new Date(),
      // A previous attempt's error is stale once this one succeeded.
      error: undefined,
    };

    await this._runs.setSiteEntry(runId, site, updated);
    await this._recomputeRun(runId);
    return updated;
  }

  async markSiteFailed(runId: string, site: JobSite, error: SiteError): Promise<SiteEntry> {
    const entry = await this._requireSite(runId, site);

    const updated: SiteEntry = { ...entry, status: 'failed', error, finishedAt: new Date() };

    await this._runs.setSiteEntry(runId, site, updated);
    await this._recomputeRun(runId);
    return updated;
  }

  async getRun(runId: string): Promise<ScrapeRunRecord | undefined> {
    return this._runs.findById(runId);
  }

  async listJobs(runId: string, options: ListJobsOptions = {}): Promise<ListJobsResult> {
    return this._jobs.listByRun(runId, options);
  }

  /** The run and its postings. A posting another run also found is detached
   *  rather than deleted, so that run keeps it. */
  async deleteRun(runId: string): Promise<boolean> {
    const existing = await this._runs.findById(runId);
    if (!existing) return false;
    await this._jobs.deleteByRun(runId);
    return this._runs.delete(runId);
  }

  /** Re-read the run and write back a status and totals derived from its whole
   *  sites map. Safe to run concurrently -- see `rollUp`. */
  private async _recomputeRun(runId: string): Promise<ScrapeRunRecord | undefined> {
    const run = await this._runs.findById(runId);
    if (!run) throw new RunNotFoundError(runId);

    const { status, totals, completed } = rollUp(run.sites);
    return this._runs.applyRollup(
      runId,
      status,
      totals,
      completed ? (run.completedAt ?? new Date()) : undefined,
    );
  }

  private async _requireSite(runId: string, site: JobSite): Promise<SiteEntry> {
    const run = await this._runs.findById(runId);
    if (!run) throw new RunNotFoundError(runId);
    const entry = run.sites[site];
    if (!entry) throw new SiteNotInRunError(runId, site);
    return entry;
  }
}
