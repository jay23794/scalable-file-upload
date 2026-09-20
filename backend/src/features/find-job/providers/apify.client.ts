import { SiteError } from '../types';

/**
 * A thin wrapper over the three Apify REST endpoints this feature needs:
 * start a run, read a run, list dataset items.
 *
 * No npm dependency -- Node 22's global `fetch` covers it, and the Apify SDK
 * would be a large dependency for three calls.
 */

const API_BASE = 'https://api.apify.com/v2';

/** Apify's run states. Anything not listed is treated as still running. */
const TERMINAL_OK = ['SUCCEEDED'];
const TERMINAL_BAD = ['FAILED', 'ABORTED', 'TIMED-OUT', 'TIMING-OUT', 'ABORTING'];

export interface ApifyRun {
  id: string;
  actId: string;
  buildNumber?: string;
  status: string;
  defaultDatasetId: string;
  /** Apify reports this in "compute units"; the caller converts to dollars. */
  usageTotalUsd?: number;
  stats?: { computeUnits?: number };
}

/** An Apify failure, already carrying our retry decision. */
export class ApifyError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  /** Billing problems and missing actors need a person, not a retry. */
  readonly alert: boolean;

  constructor(init: { code: string; message: string; retriable: boolean; status?: number; alert?: boolean }) {
    super(init.message);
    this.name = 'ApifyError';
    this.code = init.code;
    this.retriable = init.retriable;
    this.status = init.status;
    this.alert = init.alert ?? false;
  }

  toSiteError(): SiteError {
    return { code: this.code, message: this.message, retriable: this.retriable };
  }
}

/**
 * Map an HTTP failure onto our shared answer.
 *
 * The two that must alert are the ones a retry can never fix and that will
 * fail every site until a person acts: no credit, and a missing actor.
 */
function errorForStatus(status: number, body: string): ApifyError {
  const detail = body.slice(0, 300);
  switch (status) {
    case 401:
    case 403:
      return new ApifyError({
        code: 'APIFY_UNAUTHORISED',
        message: `Apify rejected our token (${status}). ${detail}`,
        retriable: false,
        status,
        alert: true,
      });
    case 402:
      return new ApifyError({
        code: 'APIFY_OUT_OF_CREDIT',
        message: `Apify is out of credit or payment failed (402). ${detail}`,
        retriable: false,
        status,
        alert: true,
      });
    case 404:
      return new ApifyError({
        code: 'APIFY_ACTOR_NOT_FOUND',
        message: `Actor or run not found (404) -- removed or renamed? ${detail}`,
        retriable: false,
        status,
        alert: true,
      });
    case 400:
      return new ApifyError({
        code: 'APIFY_BAD_INPUT',
        message: `Apify rejected our input (400) -- our bug. ${detail}`,
        retriable: false,
        status,
      });
    case 429:
      return new ApifyError({
        code: 'APIFY_RATE_LIMITED',
        message: `Apify rate-limited us (429). ${detail}`,
        retriable: true,
        status,
      });
    default:
      return new ApifyError({
        code: status >= 500 ? 'APIFY_SERVER_ERROR' : 'APIFY_HTTP_ERROR',
        message: `Apify returned ${status}. ${detail}`,
        // 5xx is Apify having a moment; retry resumes rather than restarts.
        retriable: status >= 500,
        status,
      });
  }
}

export interface StartRunOptions {
  actorId: string;
  input: Record<string, unknown>;
  /** Sent to Apify so Apify gives up before our own poll deadline does. */
  timeoutSecs: number;
  /** Cost guard. Apify aborts the run once the dataset reaches this. */
  maxItems?: number;
  build?: string;
}

export class ApifyClient {
  constructor(
    private _token: string,
    private _fetch: typeof fetch = fetch,
  ) {}

  private _requireToken(): string {
    if (!this._token || this._token.trim() === '') {
      throw new ApifyError({
        code: 'APIFY_TOKEN_MISSING',
        message: 'APIFY_TOKEN is not set -- nothing can be scraped without it.',
        retriable: false,
        alert: true,
      });
    }
    return this._token;
  }

  private async _request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = this._requireToken();
    const url = `${API_BASE}${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;

    let res: Response;
    try {
      res = await this._fetch(url, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      });
    } catch (err) {
      // DNS, TLS, socket. Worth retrying: nothing was necessarily charged.
      throw new ApifyError({
        code: 'APIFY_NETWORK_ERROR',
        message: `Could not reach Apify: ${(err as Error).message}`,
        retriable: true,
      });
    }

    if (!res.ok) throw errorForStatus(res.status, await res.text().catch(() => ''));

    return (await res.json()) as T;
  }

  /** Start a run and return immediately. Never waits -- see the note on the
   *  provider interface about why start and check are separate. */
  async startRun(options: StartRunOptions): Promise<ApifyRun> {
    const params = new URLSearchParams({ timeout: String(options.timeoutSecs) });
    if (options.maxItems !== undefined) params.set('maxItems', String(options.maxItems));
    if (options.build) params.set('build', options.build);

    // `acts/<id>/runs` starts without waiting. The actor id uses `~` in the
    // REST path where the console shows `/`.
    const actorPath = encodeURIComponent(options.actorId).replace(/%2F/gi, '~');
    const body = await this._request<{ data: ApifyRun }>(
      `/acts/${actorPath}/runs?${params.toString()}`,
      { method: 'POST', body: JSON.stringify(options.input) },
    );
    return body.data;
  }

  async getRun(runId: string): Promise<ApifyRun> {
    const body = await this._request<{ data: ApifyRun }>(`/actor-runs/${encodeURIComponent(runId)}`);
    return body.data;
  }

  /**
   * Every item in a dataset.
   *
   * Apify pages these, so a single request is not the whole dataset. Stops at
   * `hardLimit` so a runaway dataset cannot be pulled into memory even if the
   * actor ignored its cap.
   */
  async listDatasetItems(
    datasetId: string,
    hardLimit: number,
    pageSize = 1000,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let offset = 0;

    while (items.length < hardLimit) {
      const limit = Math.min(pageSize, hardLimit - items.length);
      const page = await this._request<Record<string, unknown>[]>(
        `/datasets/${encodeURIComponent(datasetId)}/items?offset=${offset}&limit=${limit}&clean=true&format=json`,
      );
      if (!Array.isArray(page) || page.length === 0) break;
      items.push(...page);
      // A short page means the dataset is exhausted.
      if (page.length < limit) break;
      offset += page.length;
    }

    return items;
  }
}

/** Apify's run status -> ours. Unknown states count as still running, so we
 *  keep polling rather than abandoning a run we paid for. */
export function classifyRunStatus(status: string): 'running' | 'succeeded' | 'failed' {
  if (TERMINAL_OK.includes(status)) return 'succeeded';
  if (TERMINAL_BAD.includes(status)) return 'failed';
  return 'running';
}

/** A finished-but-unsuccessful run, translated. */
export function errorForRunStatus(status: string): SiteError {
  switch (status) {
    case 'ABORTED':
    case 'ABORTING':
      // Someone stopped it on purpose. Retrying would override that.
      return { code: 'APIFY_RUN_ABORTED', message: 'Apify run was aborted', retriable: false };
    case 'TIMED-OUT':
    case 'TIMING-OUT':
      return { code: 'APIFY_RUN_TIMEOUT', message: 'Apify run timed out', retriable: true };
    default:
      return { code: 'APIFY_RUN_FAILED', message: `Apify run ended as ${status}`, retriable: true };
  }
}
