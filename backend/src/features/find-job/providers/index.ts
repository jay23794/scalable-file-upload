import { env } from '../../../config/env';
import { JobSite } from '../types';
import { ApifyClient } from './apify.client';
import { ScrapeProvider } from './types';

/**
 * The seam. One interface, resolved in one place.
 *
 * Moving a board to a different actor -- or off Apify entirely -- is a config
 * change rather than a change at every call site. It lives in the feature
 * folder because nothing outside find-job uses it.
 */

/** Shared by every Apify adapter; adapters differ by actor, not by client. */
export const apifyClient = new ApifyClient(env.findJob.apifyToken);

/** Adapters register here as they are written, one per actor. Empty until
 *  actors are chosen -- that decision is what blocks the rest of the build. */
const providers = new Map<string, ScrapeProvider>();

export function registerProvider(provider: ScrapeProvider): void {
  providers.set(provider.name, provider);
}

export class NoProviderForSiteError extends Error {
  constructor(site: JobSite, detail: string) {
    super(`No scrape provider for site "${site}": ${detail}`);
    this.name = 'NoProviderForSiteError';
  }
}

/**
 * Which provider handles this site.
 *
 * An explicit override wins; otherwise the site falls to whichever registered
 * provider claims it. The override map is the escape hatch for a board that
 * ends up being scraped some other way.
 */
export function resolveProvider(site: JobSite): ScrapeProvider {
  const overrideName = env.findJob.siteOverrides[site];
  if (overrideName) {
    const provider = providers.get(overrideName);
    if (!provider) {
      throw new NoProviderForSiteError(
        site,
        `FINDJOB_SITE_OVERRIDES names "${overrideName}", which is not registered`,
      );
    }
    return provider;
  }

  for (const provider of providers.values()) {
    if (provider.supportedSites.includes(site)) return provider;
  }

  throw new NoProviderForSiteError(
    site,
    providers.size === 0
      ? 'no providers are registered yet (no actors chosen)'
      : `registered providers cover: ${[...providers.values()].flatMap((p) => p.supportedSites).join(', ')}`,
  );
}

export function registeredProviderNames(): string[] {
  return [...providers.keys()];
}

export * from './types';
export { ApifyClient, ApifyError, classifyRunStatus, errorForRunStatus } from './apify.client';
