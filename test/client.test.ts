import { describe, expect, it } from "vitest";
import { createStderrLogger, silentLogger } from "../src/logger.js";
import { PlausibleClient, QUERY_PATH, type FetchLike } from "../src/plausible/client.js";
import {
  PlausibleApiError,
  errorFromResponse,
  extractUpstreamMessage,
  parseRetryAfter,
  sanitizeUpstreamMessage,
} from "../src/plausible/errors.js";
import { TEST_API_KEY, TEST_BASE_URL, createFetchStub, jsonResponse, queryResponse } from "./helpers.js";

const QUERY = { site_id: "example.com", metrics: ["visitors"], date_range: "7d" };

function makeClient(fetch: FetchLike, overrides: Partial<ConstructorParameters<typeof PlausibleClient>[0]> = {}): PlausibleClient {
  return new PlausibleClient({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    timeoutMs: 1_000,
    fetch,
    logger: silentLogger,
    userAgent: "test/0.0.0",
    retryDelayMs: 0,
    now: () => new Date("2024-05-01T00:00:00Z"),
    ...overrides,
  });
}

async function captureError(promise: Promise<unknown>): Promise<PlausibleApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlausibleApiError) return error;
    throw error;
  }
  throw new Error("Expected the promise to reject");
}

describe("PlausibleClient request building", () => {
  it("POSTs JSON to /api/v2/query with bearer auth", async () => {
    const stub = createFetchStub(() => queryResponse([{ dimensions: [], metrics: [42] }]));
    const response = await makeClient(stub.fetch).query(QUERY);

    expect(response.results[0]?.metrics).toEqual([42]);
    expect(stub.requests).toHaveLength(1);
    const [request] = stub.requests;
    expect(request?.url).toBe(`${TEST_BASE_URL}${QUERY_PATH}`);
    expect(request?.method).toBe("POST");
    expect(request?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers["user-agent"]).toBe("test/0.0.0");
    expect(request?.body).toEqual(QUERY);
  });

  it("defaults missing meta/query to empty objects", async () => {
    const stub = createFetchStub(() => jsonResponse({ results: [] }));
    await expect(makeClient(stub.fetch).query(QUERY)).resolves.toEqual({ results: [], meta: {}, query: {} });
  });
});

describe("PlausibleClient error mapping", () => {
  it("maps 400 and surfaces Plausible's error text", async () => {
    const stub = createFetchStub(() => jsonResponse({ error: "Invalid metric \"foo\"" }, 400));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.kind).toBe("bad_request");
    expect(error.message).toContain('Invalid metric "foo"');
  });

  it("maps 401 to an actionable auth message without retrying", async () => {
    const stub = createFetchStub(() => jsonResponse({ error: "Invalid API key or site ID." }, 401));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.kind).toBe("unauthorized");
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/PLAUSIBLE_API_KEY/);
    expect(stub.requests).toHaveLength(1);
  });

  it("maps 402/403 to a plan/role message", async () => {
    const stub = createFetchStub(() => jsonResponse({ error: "upgrade required" }, 402));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.kind).toBe("forbidden");
    expect(error.message).toMatch(/Business plan/);
  });

  it("maps 429 with Retry-After and does not retry", async () => {
    const stub = createFetchStub(() => jsonResponse({ error: "Too many requests" }, 429, { "Retry-After": "120" }));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.message).toMatch(/600 requests per hour/);
    expect(error.message).toMatch(/Retry after 120 seconds/);
    expect(stub.requests).toHaveLength(1);
  });

  it("retries a 5xx once and then succeeds", async () => {
    const stub = createFetchStub([
      () => new Response("<html>Bad gateway</html>", { status: 502 }),
      () => queryResponse([{ dimensions: [], metrics: [7] }]),
    ]);
    const response = await makeClient(stub.fetch).query(QUERY);
    expect(response.results[0]?.metrics).toEqual([7]);
    expect(stub.requests).toHaveLength(2);
  });

  it("gives up after the retry budget on persistent 5xx and hides HTML bodies", async () => {
    const stub = createFetchStub(() => new Response("<html>oops</html>", { status: 503 }));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.kind).toBe("server_error");
    expect(error.status).toBe(503);
    expect(error.message).not.toContain("<html>");
    expect(stub.requests).toHaveLength(2);
  });

  it("maps timeouts", async () => {
    const fetch: FetchLike = async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const error = await captureError(makeClient(fetch, { maxRetries: 0 }).query(QUERY));
    expect(error.kind).toBe("timeout");
    expect(error.message).toMatch(/PLAUSIBLE_TIMEOUT_MS/);
  });

  it("aborts a hanging request after timeoutMs", async () => {
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const error = await captureError(makeClient(fetch, { maxRetries: 0, timeoutMs: 20 }).query(QUERY));
    expect(error.kind).toBe("timeout");
  });

  it("maps network failures", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    const error = await captureError(makeClient(fetch, { maxRetries: 0 }).query(QUERY));
    expect(error.kind).toBe("network");
    expect(error.message).toContain(TEST_BASE_URL);
  });

  it("rejects non-JSON success bodies (e.g. a login page)", async () => {
    const stub = createFetchStub(() => new Response("<html>login</html>", { status: 200 }));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.kind).toBe("invalid_response");
  });

  it("never echoes the API key, even if upstream does", async () => {
    const stub = createFetchStub(() => jsonResponse({ error: `bad key ${TEST_API_KEY}` }, 401));
    const error = await captureError(makeClient(stub.fetch).query(QUERY));
    expect(error.message).not.toContain(TEST_API_KEY);
    expect(error.message).toContain("[REDACTED]");
  });

  it("does not log the API key or headers", async () => {
    const lines: string[] = [];
    const logger = createStderrLogger({ debug: true, write: (line) => lines.push(line) });
    const stub = createFetchStub([() => new Response("", { status: 500 }), () => queryResponse([])]);
    await makeClient(stub.fetch, { logger }).query(QUERY);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(TEST_API_KEY);
    expect(lines.join("\n")).not.toMatch(/authorization/i);
  });
});

describe("error helpers", () => {
  it("extracts the error field or falls back to text", () => {
    expect(extractUpstreamMessage('{"error":"nope"}')).toBe("nope");
    expect(extractUpstreamMessage("plain text")).toBe("plain text");
    expect(extractUpstreamMessage("<html></html>")).toBe("");
    expect(extractUpstreamMessage("")).toBe("");
  });

  it("parses Retry-After seconds and HTTP dates", () => {
    const now = new Date("2024-05-01T00:00:00Z");
    expect(parseRetryAfter("30", now)).toBe(30);
    expect(parseRetryAfter("Wed, 01 May 2024 00:01:00 GMT", now)).toBe(60);
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });

  it("bounds long upstream messages", () => {
    expect(sanitizeUpstreamMessage("x".repeat(2_000), "k").length).toBeLessThanOrEqual(501);
  });

  it("classifies retryable kinds", () => {
    expect(errorFromResponse(500, "", undefined).isRetryable).toBe(true);
    expect(errorFromResponse(429, "", undefined).isRetryable).toBe(false);
    expect(errorFromResponse(404, "", undefined).kind).toBe("not_found");
  });
});
