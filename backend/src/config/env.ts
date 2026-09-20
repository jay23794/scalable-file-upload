import 'dotenv/config';

const required = (key: string, value: string | undefined): string => {
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

const num = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Env var ${key} must be a number, got "${raw}"`);
  }
  return parsed;
};

const csv = (key: string, fallback: string[]): string[] => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
};

// Site -> value maps arrive as JSON so a site can be added without a code change.
const jsonMap = (key: string, fallback: Record<string, string>): Record<string, string> => {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Env var ${key} must be valid JSON, got "${raw}"`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Env var ${key} must be a JSON object of site -> string`);
  }
  const out: Record<string, string> = {};
  for (const [site, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Env var ${key}: site "${site}" must map to a non-empty string`);
    }
    // Site names become Mongo field names under `sites.<site>`, so they must not
    // contain dots or start with $.
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(site)) {
      throw new Error(`Env var ${key}: site "${site}" must match /^[a-z0-9][a-z0-9_-]*$/`);
    }
    out[site] = value.trim();
  }
  return out;
};

const apifyActors = jsonMap('APIFY_ACTORS', {});
const apifyRunTimeoutMs = num('APIFY_RUN_TIMEOUT_MS', 600_000);
const findJobPollDeadlineMs = num('FINDJOB_POLL_DEADLINE_MS', 900_000);
const findJobResultsPerSite = num('FINDJOB_RESULTS_PER_SITE', 50);
const findJobMaxResultsPerSite = num('FINDJOB_MAX_RESULTS_PER_SITE', 100);

// Our poll loop must outlive the actor's own timeout, so Apify gives up first and
// hands us a real error instead of us abandoning a run we already paid for.
if (findJobPollDeadlineMs <= apifyRunTimeoutMs) {
  throw new Error(
    `FINDJOB_POLL_DEADLINE_MS (${findJobPollDeadlineMs}) must exceed ` +
      `APIFY_RUN_TIMEOUT_MS (${apifyRunTimeoutMs})`,
  );
}

if (findJobResultsPerSite > findJobMaxResultsPerSite) {
  throw new Error(
    `FINDJOB_RESULTS_PER_SITE (${findJobResultsPerSite}) must not exceed ` +
      `FINDJOB_MAX_RESULTS_PER_SITE (${findJobMaxResultsPerSite})`,
  );
}

export const env = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  supabase: {
    url: required('SUPABASE_URL', process.env.SUPABASE_URL),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
    bucket: required('SUPABASE_BUCKET', process.env.SUPABASE_BUCKET),
  },
  signedUrl: {
    downloadTtlSeconds: 60 * 60,
    chunksDownloadTtlSeconds: process.env.CHUNKS_DOWNLOAD_TTL_SECONDS
      ? Number(process.env.CHUNKS_DOWNLOAD_TTL_SECONDS)
      : 30 * 60,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  ocrQueue: {
    name: process.env.OCR_QUEUE_NAME ?? 'ocr-queue',
  },
  embedQueue: {
    name: process.env.EMBED_QUEUE_NAME ?? 'embed-queue',
  },
  generateQueue: {
    name: process.env.GENERATE_QUEUE_NAME ?? 'generate-queue',
  },
  genStream: {
    // Redis Stream retention for gen:{queryId}. Must agree with the ml service.
    ttlSeconds: process.env.GEN_STREAM_TTL_SEC ? Number(process.env.GEN_STREAM_TTL_SEC) : 3600,
  },
  query: {
    topKDefault: process.env.QUERY_TOPK_DEFAULT ? Number(process.env.QUERY_TOPK_DEFAULT) : 5,
  },
  mongo: {
    uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017/feature',
  },
  findJob: {
    queueName: process.env.SCRAPE_QUEUE_NAME ?? 'scrape-queue',
    // Not `required()` at boot: stages 1-3 of the build run with no Apify
    // account at all. The Apify client raises a clear error if it is asked to
    // make a call without one.
    apifyToken: process.env.APIFY_TOKEN ?? '',
    // Site -> actor id. Empty until actors are chosen; the registry treats the
    // keys of this map as the set of sites that exist.
    actors: apifyActors,
    pollIntervalMs: num('APIFY_POLL_INTERVAL_MS', 10_000),
    runTimeoutMs: apifyRunTimeoutMs,
    pollDeadlineMs: findJobPollDeadlineMs,
    // Cost guard. Every actor run is sent a cap, so one bad query cannot
    // produce an unbounded bill.
    maxItemsPerRun: num('APIFY_MAX_ITEMS_PER_RUN', 100),
    // These jobs wait on Apify rather than compute, so this wants to be at
    // least the number of sites or they run one after another for no reason.
    workerConcurrency: num('FINDJOB_WORKER_CONCURRENCY', 4),
    defaultSites: csv('FINDJOB_DEFAULT_SITES', Object.keys(apifyActors)),
    maxSearchTerms: num('FINDJOB_MAX_SEARCH_TERMS', 3),
    resultsPerSite: findJobResultsPerSite,
    maxResultsPerSite: findJobMaxResultsPerSite,
    hoursOld: num('FINDJOB_HOURS_OLD', 168),
    // Unused until a second provider exists. Site -> provider name.
    siteOverrides: jsonMap('FINDJOB_SITE_OVERRIDES', {}),
    rawJobTtlDays: num('RAW_JOB_TTL_DAYS', 45),
  },
  internalServiceToken: required('INTERNAL_SERVICE_TOKEN', process.env.INTERNAL_SERVICE_TOKEN),
};
