/**
 * Minimal HTTP client for the Plausible Stats API v2.
 *
 * `fetch` is injected so tests run without network access and without an API key.
 * Only idempotent reads are performed, so transient failures (5xx, network, timeout)
 * are retried a bounded number of times. 429 is never retried automatically: it would
 * burn more of the hourly budget and the model should decide whether to wait.
 */
import type { Logger } from "../logger.js";
import {
  PlausibleApiError,
  errorFromResponse,
  extractUpstreamMessage,
  parseRetryAfter,
  sanitizeUpstreamMessage,
} from "./errors.js";
import type { PlausibleQuery, PlausibleQueryResponse } from "./types.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const QUERY_PATH = "/api/v2/query";
export const DEFAULT_MAX_RETRIES = 1;
export const DEFAULT_RETRY_DELAY_MS = 500;

export interface PlausibleClientOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetch: FetchLike;
  logger: Logger;
  userAgent: string;
  maxRetries?: number;
  retryDelayMs?: number;
  now?: () => Date;
}

function isQueryResponse(value: unknown): value is PlausibleQueryResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { results?: unknown };
  return Array.isArray(candidate.results);
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlausibleClient {
  private readonly options: Required<Omit<PlausibleClientOptions, "now">> & { now: () => Date };

  constructor(options: PlausibleClientOptions) {
    this.options = {
      maxRetries: DEFAULT_MAX_RETRIES,
      retryDelayMs: DEFAULT_RETRY_DELAY_MS,
      now: () => new Date(),
      ...options,
    };
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async query(body: PlausibleQuery): Promise<PlausibleQueryResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.queryOnce(body, attempt);
      } catch (error) {
        const apiError = this.toApiError(error);
        if (!apiError.isRetryable || attempt >= this.options.maxRetries) {
          throw apiError;
        }
        attempt += 1;
        this.options.logger.warn("retrying transient Plausible failure", {
          kind: apiError.kind,
          status: apiError.status,
          attempt,
        });
        await delay(this.options.retryDelayMs * attempt);
      }
    }
  }

  private async queryOnce(body: PlausibleQuery, attempt: number): Promise<PlausibleQueryResponse> {
    const url = `${this.options.baseUrl}${QUERY_PATH}`;
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": this.options.userAgent,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw this.transportError(error);
    }

    const text = await response.text();
    // Log shape only: site and status, never headers or the key.
    this.options.logger.debug("plausible query", {
      site_id: body.site_id,
      status: response.status,
      duration_ms: Date.now() - startedAt,
      attempt,
    });

    if (!response.ok) {
      const upstream = sanitizeUpstreamMessage(extractUpstreamMessage(text), this.options.apiKey);
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"), this.options.now());
      throw errorFromResponse(response.status, upstream, retryAfter);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PlausibleApiError(
        "invalid_response",
        "Plausible returned a non-JSON response. Check that PLAUSIBLE_BASE_URL points at the Plausible instance itself, not a login page or proxy.",
        { status: response.status },
      );
    }
    if (!isQueryResponse(parsed)) {
      throw new PlausibleApiError("invalid_response", "Plausible returned JSON without a `results` array.", {
        status: response.status,
      });
    }
    return { results: parsed.results, meta: parsed.meta ?? {}, query: parsed.query ?? {} };
  }

  private transportError(error: unknown): PlausibleApiError {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      return new PlausibleApiError(
        "timeout",
        `Plausible did not respond within ${this.options.timeoutMs} ms. Try a shorter date range or fewer dimensions, or raise PLAUSIBLE_TIMEOUT_MS.`,
      );
    }
    const reason = error instanceof Error ? sanitizeUpstreamMessage(error.message, this.options.apiKey) : "unknown error";
    return new PlausibleApiError(
      "network",
      `Could not reach Plausible at ${this.options.baseUrl} (${reason}). Check network access and PLAUSIBLE_BASE_URL.`,
    );
  }

  private toApiError(error: unknown): PlausibleApiError {
    if (error instanceof PlausibleApiError) {
      return error;
    }
    return this.transportError(error);
  }
}
