import { z } from 'zod';

import { env } from '../../config/env';

/**
 * These checks protect spend, not politeness. Every term and every result is a
 * bill, so an over-broad request is rejected rather than trimmed.
 */

/** The sites that exist are the keys of the actor map: adding a board is a
 *  config change. Read at module load, same as every other env-derived value. */
const knownSites = Object.keys(env.findJob.actors);

export const CreateRunSchema = z.object({
  searchTerms: z
    .array(z.string().trim().min(1, { message: 'search terms must not be empty' }))
    .min(1, { message: 'at least one search term is required' })
    .max(env.findJob.maxSearchTerms, {
      message: `at most ${env.findJob.maxSearchTerms} search terms (each one costs results)`,
    }),

  sites: z
    .array(z.string())
    .min(1, { message: 'sites must not be an empty list' })
    .optional()
    .superRefine((sites, ctx) => {
      if (!sites) return;
      if (knownSites.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'no sites are configured: set APIFY_ACTORS before starting a run',
        });
        return;
      }
      const unknown = sites.filter((site) => !knownSites.includes(site));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown site(s): ${unknown.join(', ')}. Known: ${knownSites.join(', ')}`,
        });
      }
    }),

  // The hard ceiling. Without it one request can order an unbounded number of
  // billed results.
  resultsWanted: z
    .number()
    .int()
    .min(1)
    .max(env.findJob.maxResultsPerSite, {
      message: `resultsWanted must not exceed ${env.findJob.maxResultsPerSite}`,
    })
    .optional(),

  location: z.string().trim().min(1).optional(),
  isRemote: z.boolean().optional(),
  hoursOld: z.number().int().min(1).optional(),
  jobType: z.string().trim().min(1).optional(),
});
export type CreateRunInput = z.infer<typeof CreateRunSchema>;

export const ListJobsQuerySchema = z.object({
  site: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().trim().min(1).optional(),
  // Off by default: one posting's raw object is 3-20 KB.
  includeRaw: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
