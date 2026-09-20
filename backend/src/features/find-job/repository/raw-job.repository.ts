import { randomUUID } from 'crypto';
import { AnyBulkWriteOperation } from 'mongoose';

import { JobDoc, JobModel, toJobRecord } from '../find-job.model';
import {
  BulkUpsertResult,
  JobEnvelope,
  JobListItem,
  ListJobsOptions,
  ListJobsResult,
} from '../types';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/** Mongo's duplicate-key error, however it is wrapped. */
function isDuplicateKeyError(err: unknown): boolean {
  const e = err as { code?: number; writeErrors?: Array<{ code?: number }> } | null;
  if (!e) return false;
  if (e.code === 11000) return true;
  return Array.isArray(e.writeErrors) && e.writeErrors.some((w) => w?.code === 11000);
}

/** How many inserts a (possibly failed) bulkWrite managed before stopping. */
function upsertedFrom(resultLike: unknown): number {
  const r = resultLike as { upsertedCount?: number } | null;
  return typeof r?.upsertedCount === 'number' ? r.upsertedCount : 0;
}

/**
 * The postings.
 *
 * Saving is an upsert on the dedupe key, which is what makes a failed job safe
 * to retry: a retry re-downloads the same finished Apify run and writes over
 * what already landed, rather than paying for a second run.
 */
export class RawJobRepository {
  /**
   * Upsert a batch of postings and attribute them to this run.
   *
   * `$addToSet` on runIds rather than `$set`, because the dedupe key is unique
   * across all runs: a posting run 2 finds that run 1 already stored is an
   * update, and both runs must keep it in their listings.
   *
   * `$set` covers the posting's own data -- a posting can genuinely change
   * between runs -- while `$setOnInsert` covers what must never be rewritten.
   */
  async bulkUpsert(runId: string, envelopes: JobEnvelope[]): Promise<BulkUpsertResult> {
    if (envelopes.length === 0) return { ingested: 0, duplicates: 0 };

    // One actor batch can contain the same posting twice. Two upserts of one
    // key in a single bulkWrite can collide, so collapse them here first and
    // count the collisions as the duplicates they are. Last one wins.
    const byKey = new Map<string, JobEnvelope>();
    for (const envelope of envelopes) byKey.set(envelope.dedupeKey, envelope);
    const unique = [...byKey.values()];
    const inBatchDuplicates = envelopes.length - unique.length;

    const ops: AnyBulkWriteOperation<JobDoc>[] = unique.map((e) => ({
      updateOne: {
        filter: { dedupeKey: e.dedupeKey },
        update: {
          $addToSet: { runIds: runId },
          $set: {
            provider: e.provider,
            actorId: e.actorId,
            actorBuild: e.actorBuild,
            site: e.site,
            searchTerm: e.searchTerm,
            sourceJobId: e.sourceJobId,
            raw: e.raw,
            fetchedAt: e.fetchedAt,
          },
          // The id is minted here because an upsert filtered on dedupeKey has
          // no _id to work from, and the schema's _id is a string.
          // `normalized` is never reset: re-fetching a posting must not throw
          // away work the phase-2 cleanup pass already did.
          $setOnInsert: { _id: randomUUID(), normalized: null, normalizedAt: null },
        },
        upsert: true,
      },
    }));

    let ingested = 0;
    try {
      const res = await JobModel.bulkWrite(ops, { ordered: false });
      ingested = res.upsertedCount;
    } catch (err) {
      if (!isDuplicateKeyError(err)) throw err;
      // Two workers upserted the same key at the same instant. The loser's
      // document now exists, so replaying the batch turns those inserts into
      // plain updates. Safe to repeat -- that is the point of the upsert.
      ingested = upsertedFrom((err as { result?: unknown }).result);
      const retry = await JobModel.bulkWrite(ops, { ordered: false });
      ingested += retry.upsertedCount;
    }

    // Derived rather than read from matchedCount: a posting whose data did not
    // change still counts as a duplicate, and modifiedCount would miss it.
    return { ingested, duplicates: unique.length - ingested + inBatchDuplicates };
  }

  /**
   * One page of a run's postings.
   *
   * `raw` is projected out unless asked for: one posting's raw object is
   * 3-20 KB, so a 50-row page would otherwise pull about a megabyte nobody
   * displays. Paged on _id, which is stable under concurrent writes in a way
   * that skip/limit is not.
   */
  async listByRun(runId: string, options: ListJobsOptions = {}): Promise<ListJobsResult> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

    const filter: Record<string, unknown> = { runIds: runId };
    if (options.site) filter.site = options.site;
    if (options.cursor) filter._id = { $gt: options.cursor };

    const docs = await JobModel.find(filter, options.includeRaw ? undefined : { raw: 0 })
      .sort({ _id: 1 })
      // One extra row answers "is there another page?" without a count query.
      .limit(limit + 1)
      .lean<JobDoc[]>();

    const hasMore = docs.length > limit;
    const page = hasMore ? docs.slice(0, limit) : docs;

    const items: JobListItem[] = page.map((doc) => {
      const record = toJobRecord(doc);
      if (options.includeRaw) return record;
      const { raw: _raw, ...rest } = record;
      return rest;
    });

    return {
      items,
      nextCursor: hasMore ? page[page.length - 1]._id : null,
    };
  }

  async countByRun(runId: string): Promise<number> {
    return JobModel.countDocuments({ runIds: runId });
  }

  /**
   * Detach a run from its postings, deleting only the ones no other run found.
   *
   * A straight delete would take postings out from under a second run that also
   * found them -- the same reason runIds is an array in the first place.
   */
  async deleteByRun(runId: string): Promise<{ detached: number; deleted: number }> {
    const detached = await JobModel.updateMany({ runIds: runId }, { $pull: { runIds: runId } });
    const deleted = await JobModel.deleteMany({ runIds: { $size: 0 } });
    return {
      detached: detached.modifiedCount,
      deleted: deleted.deletedCount,
    };
  }
}
