/**
 * End-to-end: a real MCP Client talks to the real server over an in-memory transport.
 * Only `fetch` is stubbed, so this covers schema publishing, argument validation,
 * request building, response rendering and error surfacing together.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { TEST_API_KEY, TEST_BASE_URL, createFetchStub, jsonResponse, queryResponse, type FetchStub, type Responder } from "./helpers.js";

const FIXED_NOW = new Date("2024-05-01T12:00:00Z");
const EXPECTED_TOOLS = [
  "plausible_check_site_access",
  "plausible_get_aggregate",
  "plausible_get_breakdown",
  "plausible_get_realtime_visitors",
  "plausible_get_timeseries",
];

const openClients: Client[] = [];

async function connect(
  responder: Responder | Responder[],
  options: { defaultSiteId?: string } = {},
): Promise<{ client: Client; stub: FetchStub }> {
  const stub = createFetchStub(responder);
  const server = createServer({
    apiKey: TEST_API_KEY,
    baseUrl: TEST_BASE_URL,
    timeoutMs: 1_000,
    fetch: stub.fetch,
    defaultSiteId: options.defaultSiteId,
    now: () => FIXED_NOW,
    retryDelayMs: 0,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  openClients.push(client);
  return { client, stub };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== "text") {
    throw new Error("Expected a text content block");
  }
  return first.text;
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe("MCP server end-to-end", () => {
  it("lists all tools as read-only with input schemas", async () => {
    const { client } = await connect(() => queryResponse([]));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description?.length).toBeGreaterThan(50);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("aggregate: sends the expected query and renders totals", async () => {
    const { client, stub } = await connect(() => queryResponse([{ dimensions: [], metrics: [1234, 56.5] }]));
    const result = await call(client, "plausible_get_aggregate", {
      site_id: "example.com",
      date_range: "7d",
      metrics: ["visitors", "bounce_rate"],
      filters: [{ dimension: "visit:country_name", operator: "is", values: ["Germany"] }],
    });

    expect(result.isError).toBeFalsy();
    expect(stub.requests[0]?.body).toEqual({
      site_id: "example.com",
      metrics: ["visitors", "bounce_rate"],
      date_range: "7d",
      filters: [["is", "visit:country_name", ["Germany"]]],
    });
    expect(stub.requests[0]?.headers.authorization).toBe(`Bearer ${TEST_API_KEY}`);
    expect(textOf(result)).toContain("**visitors**: 1,234");
    expect(textOf(result)).toContain("**bounce_rate**: 56.5%");
  });

  it("aggregate: json format returns parseable named totals", async () => {
    const { client } = await connect(() => queryResponse([{ dimensions: [], metrics: [10, 20] }]));
    const result = await call(client, "plausible_get_aggregate", {
      site_id: "example.com",
      metrics: ["visitors", "pageviews"],
      response_format: "json",
    });
    const parsed = JSON.parse(textOf(result)) as { totals: Record<string, number>; date_range: string };
    expect(parsed.totals).toEqual({ visitors: 10, pageviews: 20 });
    expect(parsed.date_range).toBe("30d");
  });

  it("uses PLAUSIBLE_DEFAULT_SITE_ID when site_id is omitted", async () => {
    const { client, stub } = await connect(() => queryResponse([{ dimensions: [], metrics: [1] }]), { defaultSiteId: "default.io" });
    await call(client, "plausible_get_aggregate", { metrics: ["visitors"] });
    expect(stub.requests[0]?.body.site_id).toBe("default.io");
  });

  it("errors clearly when no site_id is available, without calling the API", async () => {
    const { client, stub } = await connect(() => queryResponse([]));
    const result = await call(client, "plausible_get_aggregate", {});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/site_id is required/);
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects schema-invalid arguments before any HTTP call", async () => {
    const { client, stub } = await connect(() => queryResponse([]));
    const result = await call(client, "plausible_get_breakdown", { site_id: "example.com", dimensions: ["visit:nope"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Unknown dimension/);
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects incompatible metric/dimension combinations before any HTTP call", async () => {
    const { client, stub } = await connect(() => queryResponse([]));
    const result = await call(client, "plausible_get_breakdown", {
      site_id: "example.com",
      dimensions: ["event:goal"],
      metrics: ["bounce_rate"],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Session metrics/);
    expect(stub.requests).toHaveLength(0);
  });

  it("breakdown: paginates with total_rows and suggests next_offset", async () => {
    const { client, stub } = await connect(() =>
      queryResponse(
        [
          { dimensions: ["Google"], metrics: [300] },
          { dimensions: ["Direct / None"], metrics: [200] },
        ],
        { total_rows: 5 },
      ),
    );
    const result = await call(client, "plausible_get_breakdown", {
      site_id: "example.com",
      dimensions: ["visit:source"],
      limit: 2,
      offset: 0,
      response_format: "json",
    });
    expect(stub.requests[0]?.body).toMatchObject({
      dimensions: ["visit:source"],
      include: { total_rows: true },
      pagination: { limit: 2, offset: 0 },
    });
    const parsed = JSON.parse(textOf(result)) as { rows: unknown[]; pagination: Record<string, unknown> };
    expect(parsed.rows).toEqual([
      { "visit:source": "Google", visitors: 300 },
      { "visit:source": "Direct / None", visitors: 200 },
    ]);
    expect(parsed.pagination).toMatchObject({ total_rows: 5, has_more: true, next_offset: 2 });
  });

  it("breakdown: validates order_by references", async () => {
    const { client, stub } = await connect(() => queryResponse([]));
    const result = await call(client, "plausible_get_breakdown", {
      site_id: "example.com",
      dimensions: ["visit:source"],
      order_by: [{ by: "pageviews", direction: "desc" }],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/order_by can only reference/);
    expect(stub.requests).toHaveLength(0);
  });

  it("timeseries: maps interval and fills gaps from time_labels", async () => {
    const { client, stub } = await connect(() =>
      queryResponse([{ dimensions: ["2024-04-02"], metrics: [9] }], { time_labels: ["2024-04-01", "2024-04-02"] }),
    );
    const result = await call(client, "plausible_get_timeseries", {
      site_id: "example.com",
      interval: "day",
      metrics: ["visitors"],
      date_range: { from: "2024-04-01", to: "2024-04-02" },
      response_format: "json",
    });
    expect(stub.requests[0]?.body).toMatchObject({
      dimensions: ["time:day"],
      date_range: ["2024-04-01", "2024-04-02"],
      include: { time_labels: true },
    });
    const parsed = JSON.parse(textOf(result)) as { series: unknown[] };
    expect(parsed.series).toEqual([
      { time: "2024-04-01", visitors: 0 },
      { time: "2024-04-02", visitors: 9 },
    ]);
  });

  it("realtime: queries the last N minutes and top pages", async () => {
    const { client, stub } = await connect((request) =>
      request.body.dimensions === undefined
        ? queryResponse([{ dimensions: [], metrics: [17] }])
        : queryResponse([{ dimensions: ["/pricing"], metrics: [6] }]),
    );
    const result = await call(client, "plausible_get_realtime_visitors", { site_id: "example.com", top_pages: 3 });
    expect(result.isError).toBeFalsy();
    expect(stub.requests).toHaveLength(2);
    for (const request of stub.requests) {
      expect(request.body.date_range).toEqual(["2024-05-01T11:55:00+00:00", "2024-05-01T12:00:00+00:00"]);
    }
    expect(stub.requests.find((request) => request.body.dimensions !== undefined)?.body.pagination).toEqual({ limit: 3, offset: 0 });
    expect(textOf(result)).toContain("**17** unique visitor(s)");
    expect(textOf(result)).toContain("/pricing");
  });

  it("realtime: top_pages=0 makes a single request", async () => {
    const { client, stub } = await connect(() => queryResponse([{ dimensions: [], metrics: [3] }]));
    await call(client, "plausible_get_realtime_visitors", { site_id: "example.com", top_pages: 0 });
    expect(stub.requests).toHaveLength(1);
  });

  it("check_site_access: reports success with today's visitors", async () => {
    const { client, stub } = await connect(() => queryResponse([{ dimensions: [], metrics: [88] }]));
    const result = await call(client, "plausible_check_site_access", { site_id: "example.com" });
    expect(result.isError).toBeFalsy();
    expect(stub.requests[0]?.body).toEqual({ site_id: "example.com", metrics: ["visitors"], date_range: "day" });
    expect(textOf(result)).toMatch(/Access OK/);
    expect(textOf(result)).toContain('"visitors_today": 88');
  });

  it("check_site_access: 401 is a definitive 'no access' answer, not a tool error", async () => {
    const { client } = await connect(() => jsonResponse({ error: "Invalid API key or site ID." }, 401));
    const result = await call(client, "plausible_check_site_access", { site_id: "other.com" });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toMatch(/No access to "other.com"/);
    expect(textOf(result)).toContain('"accessible": false');
  });

  it("check_site_access: 429 means the check could not be completed", async () => {
    const { client } = await connect(() => jsonResponse({ error: "rate limited" }, 429));
    const result = await call(client, "plausible_check_site_access", { site_id: "example.com" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Could not complete the access check/);
  });

  it("surfaces API errors as isError results without leaking the key", async () => {
    const { client } = await connect(() => jsonResponse({ error: `key ${TEST_API_KEY} rejected` }, 401));
    const result = await call(client, "plausible_get_breakdown", { site_id: "example.com", dimensions: ["event:page"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Authentication failed/);
    expect(textOf(result)).not.toContain(TEST_API_KEY);
  });

  it("surfaces persistent 5xx as a retryable-sounding error after one retry", async () => {
    const { client, stub } = await connect(() => new Response("", { status: 500 }));
    const result = await call(client, "plausible_get_timeseries", { site_id: "example.com" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/server error \(HTTP 500\)/);
    expect(stub.requests).toHaveLength(2);
  });
});
