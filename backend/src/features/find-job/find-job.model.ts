import { Schema, model } from 'mongoose';

import { JobSite, RunStatus, RunTotals, ScrapeRunRecord, SiteEntry } from './types';

const RUN_STATUSES: RunStatus[] = ['scraping', 'ready', 'partial', 'failed'];

/** One small document per run. Read on every status poll, so it never holds
 *  the postings themselves. */
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
    // Mixed, so a later write can target one site with `$set: sites.<site>`
    // without Mongoose re-casting the whole map. Site names are validated in
    // config, so they are always safe Mongo field names.
    sites: { type: Schema.Types.Mixed, required: true, default: {} },
    totals: { type: TotalsSchema, required: true, default: () => ({}) },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    completedAt: { type: Date, required: false },
  },
  { _id: false, versionKey: false, collection: 'job_scrape_runs', minimize: false },
);

ScrapeRunSchema.index({ createdAt: -1 });

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
