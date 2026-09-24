import { env } from '../../../config/env';
import { JobSite } from '../types';
import { ApifyClient, ApifyError, classifyRunStatus, errorForRunStatus } from './apify.client';
import {
  JobSearchQuery,
  ProviderRunHandle,
  ProviderRunState,
  RawJobBatch,
  RowFieldMap,
  ScrapeProvider,
} from './types';

/**
 * Adapter for `bebity/linkedin-jobs-scraper`.
 *
 * Everything actor-specific lives here: its input format, its output field
 * names, and nothing else in the codebase knows either.
 */

/** Which output keys hold what we need. Dot paths are supported. */
const FIELDS: RowFieldMap = {
  // `applyUrl` is the employer's own application link when the job is not
  // Easy Apply; `jobUrl` is always LinkedIn's own page.
  employerUrl: ['applyUrl'],
  boardUrl: ['jobUrl'],
  sourceJobId: ['id'],
  company: ['companyName'],
  title: ['title'],
  location: ['location'],
  // The actor tags each row with the input title that produced it, so a
  // posting can be attributed to the term that found it.
  searchTerm: ['scrapingInfo.title'],
};

/**
 * UNVERIFIED -- confirm against the actor's "Date posted" input in the console.
 * LinkedIn's own filter uses r<seconds>; if this actor wants a label instead
 * ("Past week"), only this function changes.
 */
function publishedAtFor(hoursOld: number): string {
  if (hoursOld <= 24) return 'r86400';
  if (hoursOld <= 24 * 7) return 'r604800';
  return 'r2592000';
}

/**
 * `rows` is per SEARCH, and a search is one title x location pair -- so three
 * terms at rows:50 would return 150, not 50. Divide to get the per-search
 * share; `maxItems` on the run enforces the real total.
 *
 * Rounded UP so we do not come back with 48 when 50 was asked for; the hard
 * cap trims the excess.
 *
 * Never 0: for this actor 0 means "all available", which is an unbounded bill.
 */
export function buildLinkedInInput(query: JobSearchQuery): Record<string, unknown> {
  const locations = query.location ? [query.location] : [];
  const searches = query.searchTerms.length * Math.max(1, locations.length);
  const rows = Math.max(1, Math.ceil(query.resultsWanted / searches));

  const input: Record<string, unknown> = {
    titles: query.searchTerms,
    rows,
  };

  if (locations.length > 0) input.locations = locations;
  if (query.isRemote) input.workTypes = ['Remote'];
  if (query.jobType) input.contractTypes = [query.jobType];
  if (query.hoursOld) input.publishedAt = publishedAtFor(query.hoursOld);

  return input;
}

export class LinkedInApifyAdapter implements ScrapeProvider {
  readonly name = 'apify:linkedin';
  readonly supportedSites = ['linkedin'] as const;

  constructor(private _client: ApifyClient) {}

  async start(site: JobSite, query: JobSearchQuery): Promise<ProviderRunHandle> {
    const actorId = env.findJob.actors[site];
    if (!actorId) {
      throw new ApifyError(
        'ACTOR_NOT_CONFIGURED',
        `No actor configured for "${site}". Set it in APIFY_ACTORS.`,
        false,
        true,
      );
    }

    const run = await this._client.startRun({
      actorId,
      input: buildLinkedInInput(query),
      timeoutSecs: Math.floor(env.findJob.runTimeoutMs / 1000),
      // Platform-level cap, independent of the actor's own `rows`. This is the
      // one that cannot be got wrong by misreading the actor's docs.
      maxItems: Math.min(query.resultsWanted, env.findJob.maxItemsPerRun),
    });

    return {
      apifyRunId: run.id,
      datasetId: run.defaultDatasetId,
      actorId,
      actorBuild: run.buildNumber ?? 'unknown',
    };
  }

  async check(apifyRunId: string): Promise<ProviderRunState> {
    const run = await this._client.getRun(apifyRunId);
    const state = classifyRunStatus(run.status);
    return {
      state,
      error: state === 'failed' ? errorForRunStatus(run.status) : undefined,
      costUsd: run.usageTotalUsd,
    };
  }

  async collect(site: JobSite, handle: ProviderRunHandle): Promise<RawJobBatch> {
    const rows = await this._client.listDatasetItems(
      handle.datasetId,
      env.findJob.maxItemsPerRun,
    );

    return {
      site,
      provider: this.name,
      actorId: handle.actorId,
      actorBuild: handle.actorBuild,
      rows,
      fields: FIELDS,
      fetchedAt: new Date(),
    };
  }
}
