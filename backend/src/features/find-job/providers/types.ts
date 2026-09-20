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

/**
 * Which row keys hold the values we need.
 *
 * Rows are opaque above the provider interface -- only an adapter knows an
 * actor's field names. But the dedupe key has to be built from URLs that live
 * inside those rows, so the adapter names the keys and the service applies the
 * map without ever knowing what they mean.
 *
 * Each entry is a list of candidates tried in order, because actors rename
 * fields between builds. Dot paths ("company.name") are supported.
 */
export interface RowFieldMap {
  /** The employer's own posting URL. The best dedupe key. */
  employerUrl?: readonly string[];
  /** The job board's URL for the posting. */
  boardUrl?: readonly string[];
  sourceJobId?: readonly string[];
  company?: readonly string[];
  title?: readonly string[];
  location?: readonly string[];
  /** Set only by actors that say which query matched a row. */
  searchTerm?: readonly string[];
}

export interface RawJobBatch {
  site: JobSite;
  provider: string;
  actorId: string;
  actorBuild: string;
  /** Opaque above this line. Stored exactly as the actor returned them. */
  rows: Record<string, unknown>[];
  /** How to read the rows. The one thing an adapter must expose about shape. */
  fields: RowFieldMap;
  /** Normalised so the worker can decide whether to retry without knowing
   *  anything about the actor. The exception to rows being opaque. */
  errors: SiteError[];
  costUsd?: number;
  fetchedAt: Date;
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

/**
 * `start` and `check` are separate on purpose.
 *
 * A single `scrape()` that dispatched and waited could not satisfy the rule
 * that protects the bill: a retry would have no way to resume a run that was
 * already started and paid for.
 */
export interface ScrapeProvider {
  readonly name: string;
  readonly supportedSites: readonly JobSite[];
  /** Starts a run and returns its handle. Does NOT wait. */
  start(site: JobSite, query: JobSearchQuery): Promise<ProviderRunHandle>;
  /** Maps provider state onto ours. Called by the poll loop. */
  check(apifyRunId: string): Promise<ProviderRunState>;
  /** Downloads the results of a finished run. */
  collect(site: JobSite, datasetId: string, handle: ProviderRunHandle): Promise<RawJobBatch>;
}
