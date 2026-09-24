// Site names are open: the actor map in config decides which ones are valid, so
// adding a board is a config change rather than a code change.
export type JobSite = string;

export type RunStatus = 'scraping' | 'ready' | 'partial' | 'failed';
export type SiteStatus = 'pending' | 'running' | 'done' | 'failed';

/**
 * A failure, normalised so the worker can decide whether to retry without
 * knowing anything about the actor that produced it.
 */
export interface SiteError {
  code: string;
  message: string;
  retriable: boolean;
}

/** One site's progress within a run. Created `pending`: nothing started yet. */
export interface SiteEntry {
  site: JobSite;
  status: SiteStatus;
  fetched: number;
  ingested: number;
  duplicates: number;
}

/** The settings shared by every site in the run. */
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
  termSource: 'client'; // becomes a union in phase 2, when terms come from a resume
  query: RunQuery;
  sites: Record<JobSite, SiteEntry>;
  totals: RunTotals;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/** What the service hands the repository to create a run. */
export interface NewScrapeRun {
  id: string;
  searchTerms: string[];
  query: RunQuery;
  sites: Record<JobSite, SiteEntry>;
}
