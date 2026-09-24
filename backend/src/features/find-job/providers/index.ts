import { env } from '../../../config/env';
import { JobSite } from '../types';
import { ApifyClient } from './apify.client';
import { LinkedInApifyAdapter } from './linkedin.adapter';
import { ScrapeProvider } from './types';

/**
 * The seam, resolved in one place. Moving a board to a different actor -- or
 * off Apify entirely -- is a change here, not at every call site.
 */

/** One client shared by every Apify adapter; they differ by actor, not by HTTP. */
export const apifyClient = new ApifyClient(env.findJob.apifyToken);

const providers: ScrapeProvider[] = [new LinkedInApifyAdapter(apifyClient)];


export class NoProviderForSiteError extends Error {
  constructor(site: JobSite) {
    super(
      `No scrape provider for site "${site}". Registered: ` +
        providers.flatMap((p) => p.supportedSites).join(', '),
    );
    this.name = 'NoProviderForSiteError';
  }
}

export function resolveProvider(site: JobSite): ScrapeProvider {
  const provider = providers.find((p) => p.supportedSites.includes(site));
  if (!provider) throw new NoProviderForSiteError(site);
  return provider;
}

export * from './types';
export { ApifyError } from './apify.client';
