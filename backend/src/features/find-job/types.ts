// Site names are open: the actor map in config decides which ones are valid, so
// adding a board is a config change rather than a code change.
export type JobSite = string;

export type RunStatus = 'scraping' | 'ready' | 'partial' | 'failed';
export type SiteStatus = 'pending' | 'running' | 'done' | 'failed';

/** The shared "can we retry this?" answer every adapter maps its failures onto. */
export interface SiteError {
  code: string;
  message: string;
  retriable: boolean;
}

export interface SiteEntry {
  site: JobSite;
  status: SiteStatus;
  provider?: string;
  actorId?: string;
  actorBuild?: string;
  // The resume handle. Its presence is what stops a retry paying twice, so it
  // is saved BEFORE polling starts and before the site moves to `running`.
  apifyRunId?: string;
  datasetId?: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  costUsd?: number;
  startedAt?: Date;
  finishedAt?: Date;
  error?: SiteError;
}

export interface RunQuery {
  location?: string;
  isRemote?: boolean;
  resultsWanted: number;
  hoursOld?: number;
  jobType?: string;
}

export interface RunTotals {
  fetched: number;
  ingested: number;
  duplicates: number;
  costUsd: number;
}

export interface ScrapeRunRecord {
  id: string; // also the prefix of each queue job id
  status: RunStatus;
  searchTerms: string[];
  termSource: 'client'; // becomes a union in phase 2, when terms can come from a resume
  query: RunQuery;
  sites: Record<JobSite, SiteEntry>;
  totals: RunTotals;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface NewScrapeRun {
  id: string;
  searchTerms: string[];
  query: RunQuery;
  sites: Record<JobSite, SiteEntry>;
}

/**
 * One posting, ready to be written. `raw` is the actor's object exactly as it
 * came back; every other field is ours and is the part the rest of the system
 * is allowed to depend on.
 */
export interface JobEnvelope {
  provider: string;
  actorId: string;
  actorBuild: string;
  site: JobSite;
  // null when the actor does not say which of our terms matched this row, which
  // is the common case for actors that take a list of queries in one run.
  searchTerm: string | null;
  sourceJobId: string | null;
  dedupeKey: string;
  fetchedAt: Date;
  raw: Record<string, unknown>;
}

export interface JobRecord extends JobEnvelope {
  id: string;
  // Every run that found this posting. An array, not a single value -- see the
  // note in plan.md 12. A posting belongs to every run that saw it.
  runIds: string[];
  normalized: Record<string, unknown> | null;
  normalizedAt: Date | null;
}

/** A posting as listed, with `raw` dropped unless the caller asked for it. */
export type JobListItem = Omit<JobRecord, 'raw'> & { raw?: Record<string, unknown> };

export interface ListJobsOptions {
  site?: JobSite;
  limit?: number;
  cursor?: string;
  includeRaw?: boolean;
}

export interface ListJobsResult {
  items: JobListItem[];
  nextCursor: string | null;
}

export interface BulkUpsertResult {
  ingested: number;
  duplicates: number;
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`Scrape run not found: ${runId}`);
    this.name = 'RunNotFoundError';
  }
}

export class SiteNotInRunError extends Error {
  constructor(runId: string, site: JobSite) {
    super(`Site "${site}" is not part of run ${runId}`);
    this.name = 'SiteNotInRunError';
  }
}

export const TERMINAL_SITE_STATUSES: SiteStatus[] = ['done', 'failed'];
