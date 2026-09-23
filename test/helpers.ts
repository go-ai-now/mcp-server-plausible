/**
 * Test doubles for the HTTP layer. No test performs real network I/O.
 */
import type { FetchLike } from "../src/plausible/client.js";
import type { PlausibleQuery, PlausibleQueryResponse } from "../src/plausible/types.js";

export const TEST_API_KEY = "test-key-super-secret-123";
export const TEST_BASE_URL = "https://plausible.test";

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: PlausibleQuery;
}

export type Responder = (request: RecordedRequest, callIndex: number) => Response | Promise<Response>;

export interface FetchStub {
  fetch: FetchLike;
  requests: RecordedRequest[];
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function queryResponse(results: PlausibleQueryResponse["results"], meta: PlausibleQueryResponse["meta"] = {}): Response {
  return jsonResponse({ results, meta, query: {} });
}

/** Records every request and answers with `responder` (a single function or a per-call queue). */
export function createFetchStub(responder: Responder | Responder[]): FetchStub {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const request: RecordedRequest = {
      url: input,
      method: init.method ?? "GET",
      headers,
      body: JSON.parse(String(init.body)) as PlausibleQuery,
    };
    const index = requests.length;
    requests.push(request);
    const handler = Array.isArray(responder) ? responder[Math.min(index, responder.length - 1)] : responder;
    if (handler === undefined) {
      throw new Error("No responder configured");
    }
    return handler(request, index);
  };
  return { fetch, requests };
}
