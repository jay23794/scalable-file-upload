import { SiteError } from '../types';

/** Three Apify REST endpoints: start a run, read a run, list dataset items.
 *  Node's global `fetch` -- no npm dependency for three calls. */

const API_BASE = 'https://api.apify.com/v2';

export interface ApifyRun {
  id: string;
  status: string;
  defaultDatasetId: string;
  buildNumber?: string;
  usageTotalUsd?: number;
}

export interface StartRunOptions {
  actorId: string;
  /** The actor's own input format. Only an adapter knows this shape. */
  input: Record<string, unknown>;
  /** Sent to Apify so Apify gives up before our poll loop does. */
  timeoutSecs: number;
  /** Cost guard: Apify aborts the run once the dataset reaches this. */
  maxItems?: number;
  build?: string;
}

export class ApifyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retriable: boolean,
    /** Needs a person, not a retry. */
    readonly alert = false,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApifyError';
  }

  toSiteError(): SiteError {
    return { code: this.code, message: this.message, retriable: this.retriable };
  }
}

// status -> [code, retriable, alert]. The two that alert cannot be fixed by
// retrying and will fail every site until someone acts.
const HTTP_ERRORS: Record<number, [string, boolean, boolean]> = {
  400: ['APIFY_BAD_INPUT', false, false], // our adapter is wrong
  401: ['APIFY_UNAUTHORISED', false, true],
  403: ['APIFY_UNAUTHORISED', false, true],
  402: ['APIFY_OUT_OF_CREDIT', false, true],
  404: ['APIFY_ACTOR_NOT_FOUND', false, true], // removed or renamed
  429: ['APIFY_RATE_LIMITED', true, false],
};

function errorForStatus(status: number, body: string): ApifyError {
  const [code, retriable, alert] = HTTP_ERRORS[status] ?? [
    status >= 500 ? 'APIFY_SERVER_ERROR' : 'APIFY_HTTP_ERROR',
    status >= 500,
    false,
  ];
  return new ApifyError(code, `Apify ${status}. ${body.slice(0, 300)}`, retriable, alert, status);
}

export class ApifyClient {
  constructor(
    private _token: string,
    private _fetch: typeof fetch = fetch,
  ) {}

  private async _request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!this._token.trim()) {
      throw new ApifyError('APIFY_TOKEN_MISSING', 'APIFY_TOKEN is not set.', false, true);
    }
    const sep = path.includes('?') ? '&' : '?';
    const url = `${API_BASE}${path}${sep}token=${encodeURIComponent(this._token)}`;

    let res: Response;
    try {
      res = await this._fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
    } catch (err) {
      // DNS, TLS, socket -- nothing was necessarily charged, so retry.
      throw new ApifyError('APIFY_NETWORK_ERROR', `Cannot reach Apify: ${(err as Error).message}`, true);
    }

    if (!res.ok) throw errorForStatus(res.status, await res.text().catch(() => ''));
    return (await res.json()) as T;
  }

  /** Starts the run and returns immediately -- does NOT wait. The billable call. */
  async startRun(o: StartRunOptions): Promise<ApifyRun> {
    const params = new URLSearchParams({ timeout: String(o.timeoutSecs) });
    if (o.maxItems !== undefined) params.set('maxItems', String(o.maxItems));
    if (o.build) params.set('build', o.build);

    // Actor ids are `user/name` in the console but `user~name` in the path.
    const actor = encodeURIComponent(o.actorId).replace(/%2F/gi, '~');
    const { data } = await this._request<{ data: ApifyRun }>(
      `/acts/${actor}/runs?${params}`,
      { method: 'POST', body: JSON.stringify(o.input) },
    );
    return data;
  }

  async getRun(runId: string): Promise<ApifyRun> {
    const { data } = await this._request<{ data: ApifyRun }>(
      `/actor-runs/${encodeURIComponent(runId)}`,
    );
    return data;
  }

  /** Apify pages datasets, so one request is not the whole thing. `hardLimit`
   *  caps memory even if the actor ignored its own maxItems. */
  async listDatasetItems(
    datasetId: string,
    hardLimit: number,
    pageSize = 1000,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];

    while (items.length < hardLimit) {
      const limit = Math.min(pageSize, hardLimit - items.length);
      const page = await this._request<Record<string, unknown>[]>(
        `/datasets/${encodeURIComponent(datasetId)}/items?offset=${items.length}&limit=${limit}&clean=true&format=json`,
      );
      if (!Array.isArray(page) || page.length === 0) break;
      items.push(...page);
      if (page.length < limit) break; // short page = dataset exhausted
    }

    return items;
  }
}

// Apify's terminal failure states -> [code, retriable].
const RUN_FAILURES: Record<string, [string, boolean]> = {
  FAILED: ['APIFY_RUN_FAILED', true],
  'TIMED-OUT': ['APIFY_RUN_TIMEOUT', true],
  'TIMING-OUT': ['APIFY_RUN_TIMEOUT', true],
  ABORTED: ['APIFY_RUN_ABORTED', false], // someone stopped it on purpose
  ABORTING: ['APIFY_RUN_ABORTED', false],
};

/** Unknown states count as running: keep polling rather than abandon a paid run. */
export function classifyRunStatus(status: string): 'running' | 'succeeded' | 'failed' {
  if (status === 'SUCCEEDED') return 'succeeded';
  return status in RUN_FAILURES ? 'failed' : 'running';
}

export function errorForRunStatus(status: string): SiteError {
  const [code, retriable] = RUN_FAILURES[status] ?? ['APIFY_RUN_FAILED', true];
  return { code, message: `Apify run ended as ${status}`, retriable };
}
