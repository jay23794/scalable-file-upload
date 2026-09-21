import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';

import { env } from '../../config/env';
import { ScrapeJobData, scrapeJobId } from '../../infra/scrapeQueue';
import { FindJobRepository } from './repository/find-job.repository';
import { CreateRunInput } from './find-job.schema';
import { JobSite, RunStatus, SiteEntry } from './types';

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

export class FindJobService {
  constructor(
    private _runs: FindJobRepository,
    private _scrapeQueue: Queue<ScrapeJobData>,
  ) {}

  /**
   * Create a run and queue one job per site.
   *
   * The run document is written BEFORE anything is queued, or a worker could
   * pick up a job whose run does not exist yet.
   */
  async createRun(input: CreateRunInput): Promise<CreateRunResult> {
    // The schema rejects unknown sites; it does not fill in the default. That
    // happens here, so the run records the sites actually used.
    const sites = input.sites ?? env.findJob.defaultSites;
    if (sites.length === 0) {
      throw new Error(
        'No sites to scrape: pass `sites`, or set FINDJOB_DEFAULT_SITES / APIFY_ACTORS.',
      );
    }

    const runId = randomUUID();
    // Resolved here rather than in the worker, so changing the default later
    // does not rewrite the history of past runs.
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
      // landing AFTER the catch below marks the run failed.
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
          // Per-job id, so re-queueing one site stays idempotent.
          opts: { jobId: scrapeJobId(runId, site) },
        })),
      );
    } catch (err) {
      // Queueing threw. Leaving the run half-dispatched would strand it in
      // `scraping` forever with no job behind some of its sites.
      await this._runs.markFailed(runId);
      throw err;
    }

    return { runId, status: 'scraping', siteCount: sites.length };
  }
}
