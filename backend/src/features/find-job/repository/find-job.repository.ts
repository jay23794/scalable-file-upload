import { ScrapeRunDoc, ScrapeRunModel, toRunRecord } from '../find-job.model';
import {
  JobSite,
  NewScrapeRun,
  RunStatus,
  RunTotals,
  ScrapeRunRecord,
  SiteEntry,
} from '../types';

/**
 * Run documents. Every write bumps `updatedAt`, which the phase-2 recovery job
 * uses to spot runs that have stopped moving.
 */
export class FindJobRepository {
  async create(run: NewScrapeRun): Promise<ScrapeRunRecord> {
    const now = new Date();
    const doc = await ScrapeRunModel.create({
      _id: run.id,
      status: 'scraping' satisfies RunStatus,
      searchTerms: run.searchTerms,
      termSource: 'client',
      query: run.query,
      sites: run.sites,
      totals: { fetched: 0, ingested: 0, duplicates: 0, costUsd: 0 },
      createdAt: now,
      updatedAt: now,
    });
    return toRunRecord(doc.toObject() as ScrapeRunDoc);
  }

  async findById(runId: string): Promise<ScrapeRunRecord | undefined> {
    const doc = await ScrapeRunModel.findById(runId).lean<ScrapeRunDoc | null>();
    return doc ? toRunRecord(doc) : undefined;
  }

  /**
   * Replace one site's entry wholesale.
   *
   * `$set` on a single `sites.<site>` path so two sites finishing at the same
   * moment cannot overwrite each other's entries.
   */
  async setSiteEntry(
    runId: string,
    site: JobSite,
    entry: SiteEntry,
  ): Promise<ScrapeRunRecord | undefined> {
    const doc = await ScrapeRunModel.findByIdAndUpdate(
      runId,
      { $set: { [`sites.${site}`]: entry, updatedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean<ScrapeRunDoc | null>();
    return doc ? toRunRecord(doc) : undefined;
  }

  /**
   * The rollup write. Status and totals are always recomputed from the whole
   * sites map by the caller and written here as derived values -- never as
   * increments, which two sites finishing at once would race on.
   */
  async applyRollup(
    runId: string,
    status: RunStatus,
    totals: RunTotals,
    completedAt?: Date,
  ): Promise<ScrapeRunRecord | undefined> {
    const doc = await ScrapeRunModel.findByIdAndUpdate(
      runId,
      {
        $set: {
          status,
          totals,
          updatedAt: new Date(),
          ...(completedAt ? { completedAt } : {}),
        },
      },
      { returnDocument: 'after' },
    ).lean<ScrapeRunDoc | null>();
    return doc ? toRunRecord(doc) : undefined;
  }

  async markFailed(runId: string): Promise<ScrapeRunRecord | undefined> {
    const now = new Date();
    const doc = await ScrapeRunModel.findByIdAndUpdate(
      runId,
      { $set: { status: 'failed', updatedAt: now, completedAt: now } },
      { returnDocument: 'after' },
    ).lean<ScrapeRunDoc | null>();
    return doc ? toRunRecord(doc) : undefined;
  }

  async delete(runId: string): Promise<boolean> {
    const res = await ScrapeRunModel.deleteOne({ _id: runId });
    return res.deletedCount === 1;
  }
}
