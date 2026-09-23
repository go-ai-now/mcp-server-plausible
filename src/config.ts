/**
 * Runtime configuration loaded from environment variables.
 *
 * All values are validated once at startup so that a misconfigured server
 * fails fast with an actionable message instead of failing on the first tool call.
 */

export const DEFAULT_BASE_URL = "https://plausible.io";
export const DEFAULT_TIMEOUT_MS = 15_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 120_000;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface PlausibleConfig {
  /** Stats API key. Never logged or echoed back to the client. */
  apiKey: string;
  /** Origin (plus optional path prefix) of the Plausible instance, without a trailing slash. */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** Optional site used when a tool call omits `site_id`. */
  defaultSiteId: string | undefined;
  /** Emit request-level debug logs to stderr. */
  debug: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Normalizes a base URL: requires http(s), strips query/hash and trailing slashes.
 * A path prefix is kept so reverse-proxied self-hosted instances keep working.
 */
/** The raw value is never echoed in errors: a malformed URL may still embed credentials. */
export function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new ConfigError(
      "PLAUSIBLE_BASE_URL is not a valid URL. Expected something like https://plausible.example.com",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError(
      `PLAUSIBLE_BASE_URL must use http or https, got "${parsed.protocol}"`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError("PLAUSIBLE_BASE_URL must not contain credentials");
  }
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.protocol}//${parsed.host}${path}`;
}

/** True when an API key would travel over plain HTTP to a non-local host. */
export function isInsecureRemoteUrl(baseUrl: string): boolean {
  const parsed = new URL(baseUrl);
  return parsed.protocol === "http:" && !LOCAL_HOSTNAMES.has(parsed.hostname);
}

function parseTimeout(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new ConfigError(
      `PLAUSIBLE_TIMEOUT_MS must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}, got "${raw}"`,
    );
  }
  return value;
}

export function loadConfig(env: EnvSource): PlausibleConfig {
  const apiKey = env.PLAUSIBLE_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    throw new ConfigError(
      "PLAUSIBLE_API_KEY is not set. Create a Stats API key in Plausible (Settings -> API Keys -> New API Key -> Stats API) and pass it via the environment.",
    );
  }
  const rawBaseUrl = env.PLAUSIBLE_BASE_URL?.trim();
  const defaultSiteId = env.PLAUSIBLE_DEFAULT_SITE_ID?.trim();
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(rawBaseUrl === undefined || rawBaseUrl === "" ? DEFAULT_BASE_URL : rawBaseUrl),
    timeoutMs: parseTimeout(env.PLAUSIBLE_TIMEOUT_MS),
    defaultSiteId: defaultSiteId === undefined || defaultSiteId === "" ? undefined : defaultSiteId,
    debug: env.PLAUSIBLE_MCP_DEBUG === "1" || env.PLAUSIBLE_MCP_DEBUG === "true",
  };
}
