import { JobSite, SiteError } from '../types';

/** What the caller asked for, in our terms. Each adapter turns this into its
 *  own actor's input format. */
export interface JobSearchQuery {
  searchTerms: string[];
  location?: string;
  isRemote?: boolean;
  /** Always set, and always passed to the actor as its result cap. */
  resultsWanted: number;
  hoursOld?: number;
  jobType?: string;
}

/** Which row keys hold the values we need. Rows are opaque above this layer,
 *  so the adapter names the keys and the service applies the map blindly.
 *  Each entry is tried in order; dot paths ("company.name") work. */
export interface RowFieldMap {
  employerUrl?: readonly string[];
  boardUrl?: readonly string[];
  sourceJobId?: readonly string[];
  company?: readonly string[];
  title?: readonly string[];
  location?: readonly string[];
  searchTerm?: readonly string[];
}

/** What a started run needs for a later attempt to find it again. */
export interface ProviderRunHandle {
  apifyRunId: string;
  datasetId: string;
  actorId: string;
  actorBuild: string;
}

export interface ProviderRunState {
  state: 'running' | 'succeeded' | 'failed';
  error?: SiteError;
  costUsd?: number;
}

export interface RawJobBatch {
  site: JobSite;
  provider: string;
  actorId: string;
  actorBuild: string;
  /** Stored exactly as the actor returned them. */
  rows: Record<string, unknown>[];
  fields: RowFieldMap;
  costUsd?: number;
  fetchedAt: Date;
}

/**
 * `start` and `check` are separate on purpose: a single `scrape()` that
 * dispatched and waited could not resume a run that was already started and
 * paid for.
 */
export interface ScrapeProvider {
  readonly name: string;
  readonly supportedSites: readonly JobSite[];
  /** Starts a run and returns its handle. Does NOT wait. */
  start(site: JobSite, query: JobSearchQuery): Promise<ProviderRunHandle>;
  /** Called by the poll loop. */
  check(apifyRunId: string): Promise<ProviderRunState>;
  /** Downloads the results of a finished run. */
  collect(site: JobSite, handle: ProviderRunHandle): Promise<RawJobBatch>;
}
