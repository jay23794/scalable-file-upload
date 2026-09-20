import { Schema, model } from 'mongoose';

import { env } from '../../config/env';
import {
  JobRecord,
  JobSite,
  RunStatus,
  RunTotals,
  ScrapeRunRecord,
  SiteEntry,
} from './types';

const RUN_STATUSES: RunStatus[] = ['scraping', 'ready', 'partial', 'failed'];

// ---------------------------------------------------------------------------
// job_scrape_runs -- one small document per run, read on every status poll.
// ---------------------------------------------------------------------------

export interface ScrapeRunDoc extends Omit<ScrapeRunRecord, 'id'> {
  _id: string;
}

const TotalsSchema = new Schema<RunTotals>(
  {
    fetched:    { type: Number, required: true, default: 0 },
    ingested:   { type: Number, required: true, default: 0 },
    duplicates: { type: Number, required: true, default: 0 },
    costUsd:    { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const ScrapeRunSchema = new Schema<ScrapeRunDoc>(
  {
    _id: { type: String, required: true },
    status: { type: String, enum: RUN_STATUSES, required: true, index: true },
    searchTerms: { type: [String], required: true },
    termSource: { type: String, enum: ['client'], required: true },
    query: {
      location:      { type: String,  required: false },
      isRemote:      { type: Boolean, required: false },
      resultsWanted: { type: Number,  required: true },
      hoursOld:      { type: Number,  required: false },
      jobType:       { type: String,  required: false },
    },
    // Mixed rather than a Map of subdocuments: every write goes through the
    // repository as a `$set` on `sites.<site>`, and Mixed keeps that dotted
    // path working without Mongoose re-casting a whole Map on each update.
    // Site names are validated against /^[a-z0-9][a-z0-9_-]*$/ in config, so
    // they are always safe Mongo field names.
    sites: { type: Schema.Types.Mixed, required: true, default: {} },
    totals: { type: TotalsSchema, required: true, default: () => ({}) },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    completedAt: { type: Date, required: false },
  },
  { _id: false, versionKey: false, collection: 'job_scrape_runs', minimize: false },
);

ScrapeRunSchema.index({ createdAt: -1 });
// For the phase-2 recovery job: runs that have sat in a non-terminal state.
ScrapeRunSchema.index({ status: 1, updatedAt: 1 });

export const ScrapeRunModel = model<ScrapeRunDoc>('ScrapeRun', ScrapeRunSchema);

export const toRunRecord = (doc: ScrapeRunDoc): ScrapeRunRecord => ({
  id: doc._id,
  status: doc.status,
  searchTerms: doc.searchTerms,
  termSource: doc.termSource,
  query: doc.query,
  sites: (doc.sites ?? {}) as Record<JobSite, SiteEntry>,
  totals: doc.totals,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  completedAt: doc.completedAt,
});

// ---------------------------------------------------------------------------
// jobs -- the postings. Named `jobs`, not `raw_jobs`: it holds the cleaned
// version too, once phase 2 fills `normalized` in place.
// ---------------------------------------------------------------------------

export interface JobDoc extends Omit<JobRecord, 'id'> {
  _id: string;
}

const JobSchema = new Schema<JobDoc>(
  {
    _id: { type: String, required: true },
    runIds: { type: [String], required: true, default: [] },
    provider: { type: String, required: true },
    actorId: { type: String, required: true },
    actorBuild: { type: String, required: true },
    site: { type: String, required: true },
    searchTerm: { type: String, required: false, default: null },
    sourceJobId: { type: String, required: false, default: null },
    dedupeKey: { type: String, required: true },
    fetchedAt: { type: Date, required: true },
    // The actor's object, untouched. Every actor returns a different shape;
    // storing it as-is keeps that out of the rest of the system.
    raw: { type: Schema.Types.Mixed, required: true },
    normalized: { type: Schema.Types.Mixed, required: false, default: null },
    normalizedAt: { type: Date, required: false, default: null },
  },
  { _id: false, versionKey: false, collection: 'jobs', minimize: false },
);

// Dedupe itself. Unique across ALL runs, which is why `runIds` is an array.
JobSchema.index({ dedupeKey: 1 }, { unique: true });
// Serves GET /runs/:runId/jobs, optionally filtered by site. Multikey on runIds.
JobSchema.index({ runIds: 1, site: 1 });
// Not optional: postings go stale in weeks and these documents are large.
// Without this, `jobs` grows forever.
// NOTE: changing RAW_JOB_TTL_DAYS after the index exists needs a collMod --
// Mongo will not silently rebuild an existing TTL index with a new value.
JobSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: env.findJob.rawJobTtlDays * 86_400 });
// For the phase-2 cleanup pass to find what it has not normalised yet.
JobSchema.index({ normalized: 1 }, { sparse: true });

export const JobModel = model<JobDoc>('Job', JobSchema);

export const toJobRecord = (doc: JobDoc): JobRecord => ({
  id: doc._id,
  runIds: doc.runIds,
  provider: doc.provider,
  actorId: doc.actorId,
  actorBuild: doc.actorBuild,
  site: doc.site,
  searchTerm: doc.searchTerm,
  sourceJobId: doc.sourceJobId,
  dedupeKey: doc.dedupeKey,
  fetchedAt: doc.fetchedAt,
  raw: doc.raw,
  normalized: doc.normalized,
  normalizedAt: doc.normalizedAt,
});
