import { ScrapeRunDoc, ScrapeRunModel, toRunRecord } from '../find-job.model';
import { NewScrapeRun, RunStatus, ScrapeRunRecord } from '../types';

/** Run documents. Every write bumps `updatedAt`. */
export class FindJobRepository {
  /** A new run always starts `scraping` with zeroed totals. */
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

  /** Used when queueing throws: a run with no jobs behind it must not sit in
   *  `scraping` forever. */
  async markFailed(runId: string): Promise<ScrapeRunRecord | undefined> {
    const now = new Date();
    const doc = await ScrapeRunModel.findByIdAndUpdate(
      runId,
      { $set: { status: 'failed', updatedAt: now, completedAt: now } },
      { returnDocument: 'after' },
    ).lean<ScrapeRunDoc | null>();
    return doc ? toRunRecord(doc) : undefined;
  }
}
