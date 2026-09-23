/**
 * Maps HTTP / transport failures to typed errors with messages written for an LLM:
 * each message says what went wrong and what to do next. Secrets are never included.
 */

export type PlausibleErrorKind =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server_error"
  | "timeout"
  | "network"
  | "invalid_response";

export const HOURLY_RATE_LIMIT = 600;
const MAX_UPSTREAM_MESSAGE_LENGTH = 500;

export class PlausibleApiError extends Error {
  readonly kind: PlausibleErrorKind;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    kind: PlausibleErrorKind,
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "PlausibleApiError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }

  /** Transient failures that are safe to retry for an idempotent read. */
  get isRetryable(): boolean {
    return this.kind === "server_error" || this.kind === "network" || this.kind === "timeout";
  }
}

/** Removes any occurrence of the secret and bounds length before surfacing upstream text. */
export function sanitizeUpstreamMessage(message: string, secret: string): string {
  const redacted = secret === "" ? message : message.split(secret).join("[REDACTED]");
  const singleLine = redacted.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_UPSTREAM_MESSAGE_LENGTH
    ? `${singleLine.slice(0, MAX_UPSTREAM_MESSAGE_LENGTH)}…`
    : singleLine;
}

/** Extracts `{"error": "..."}` from a Plausible error body, falling back to raw text. */
export function extractUpstreamMessage(bodyText: string): string {
  if (bodyText.trim() === "") {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === "string") {
        return error;
      }
      return JSON.stringify(error);
    }
  } catch {
    // Not JSON (e.g. an HTML error page from a proxy); fall through to raw text.
  }
  return bodyText.trimStart().startsWith("<") ? "" : bodyText;
}

/** Parses Retry-After as delta-seconds or HTTP-date. */
export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null || header.trim() === "") {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds);
  }
  const date = Date.parse(header);
  if (Number.isNaN(date)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((date - now.getTime()) / 1_000));
}

export function errorFromResponse(
  status: number,
  upstreamMessage: string,
  retryAfterSeconds: number | undefined,
): PlausibleApiError {
  const detail = upstreamMessage === "" ? "" : ` Plausible said: "${upstreamMessage}"`;
  if (status === 400 || status === 422) {
    return new PlausibleApiError(
      "bad_request",
      `Plausible rejected the query (HTTP ${status}).${detail} Adjust the metrics, dimensions, filters or date range and try again.`,
      { status },
    );
  }
  if (status === 401) {
    return new PlausibleApiError(
      "unauthorized",
      `Authentication failed (HTTP 401): the API key is invalid, revoked, or cannot access this site_id.${detail} Check PLAUSIBLE_API_KEY and that the site belongs to the team the key was created for.`,
      { status },
    );
  }
  if (status === 402 || status === 403) {
    return new PlausibleApiError(
      "forbidden",
      `Access denied (HTTP ${status}).${detail} The Stats API requires a Plausible Business plan (or a self-hosted instance), and the key must be a "Stats API" key created by an Owner, Admin, Editor or Billing member.`,
      { status },
    );
  }
  if (status === 404) {
    return new PlausibleApiError(
      "not_found",
      `Not found (HTTP 404).${detail} Verify site_id is the exact domain registered in Plausible and PLAUSIBLE_BASE_URL points at a Plausible instance that supports /api/v2/query.`,
      { status },
    );
  }
  if (status === 429) {
    const wait =
      retryAfterSeconds === undefined ? "Wait before retrying." : `Retry after ${retryAfterSeconds} seconds.`;
    const options = retryAfterSeconds === undefined ? { status } : { status, retryAfterSeconds };
    return new PlausibleApiError(
      "rate_limited",
      `Rate limit exceeded (HTTP 429). Stats API keys allow ${HOURLY_RATE_LIMIT} requests per hour by default. ${wait}`,
      options,
    );
  }
  if (status >= 500) {
    return new PlausibleApiError(
      "server_error",
      `Plausible returned a server error (HTTP ${status}).${detail} This is usually transient; try again shortly.`,
      { status },
    );
  }
  return new PlausibleApiError("invalid_response", `Unexpected HTTP ${status} from Plausible.${detail}`, { status });
}
