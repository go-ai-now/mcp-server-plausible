import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, isInsecureRemoteUrl, loadConfig, normalizeBaseUrl } from "../src/config.js";
import { CHARACTER_LIMIT, formatMetricValue, renderMarkdownTable, renderWithinLimit, toRowObject } from "../src/format.js";
import { computePageInfo } from "../src/tools/breakdown.js";
import { fillTimeGaps } from "../src/tools/timeseries.js";

describe("loadConfig", () => {
  it("requires PLAUSIBLE_API_KEY", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ PLAUSIBLE_API_KEY: "   " })).toThrow(/PLAUSIBLE_API_KEY/);
  });

  it("applies defaults", () => {
    expect(loadConfig({ PLAUSIBLE_API_KEY: "k" })).toEqual({
      apiKey: "k",
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      defaultSiteId: undefined,
      debug: false,
    });
  });

  it("reads overrides for self-hosted instances", () => {
    const config = loadConfig({
      PLAUSIBLE_API_KEY: "k",
      PLAUSIBLE_BASE_URL: "https://stats.example.com/plausible/",
      PLAUSIBLE_TIMEOUT_MS: "5000",
      PLAUSIBLE_DEFAULT_SITE_ID: "example.com",
      PLAUSIBLE_MCP_DEBUG: "1",
    });
    expect(config).toMatchObject({
      baseUrl: "https://stats.example.com/plausible",
      timeoutMs: 5_000,
      defaultSiteId: "example.com",
      debug: true,
    });
  });

  it("rejects bad timeouts and URLs", () => {
    expect(() => loadConfig({ PLAUSIBLE_API_KEY: "k", PLAUSIBLE_TIMEOUT_MS: "10" })).toThrow(/PLAUSIBLE_TIMEOUT_MS/);
    expect(() => loadConfig({ PLAUSIBLE_API_KEY: "k", PLAUSIBLE_BASE_URL: "ftp://x" })).toThrow(/http or https/);
    expect(() => normalizeBaseUrl("not a url")).toThrow(ConfigError);
    expect(() => normalizeBaseUrl("https://user:pass@x.com")).toThrow(/credentials/);
  });

  it("does not echo an invalid base URL, which may embed secrets", () => {
    expect(() => normalizeBaseUrl("secret-token@@not a url")).toThrow(/is not a valid URL/);
    try {
      normalizeBaseUrl("secret-token@@not a url");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-token");
    }
  });

  it("detects plain-http remote hosts", () => {
    expect(isInsecureRemoteUrl("http://stats.example.com")).toBe(true);
    expect(isInsecureRemoteUrl("http://localhost:8000")).toBe(false);
    expect(isInsecureRemoteUrl("https://stats.example.com")).toBe(false);
  });
});

describe("formatting", () => {
  it("zips names with positional values", () => {
    expect(toRowObject(["visit:source"], ["visitors", "bounce_rate"], { dimensions: ["Google"], metrics: [10, 45] })).toEqual({
      "visit:source": "Google",
      visitors: 10,
      bounce_rate: 45,
    });
  });

  it("formats units, revenue and nulls", () => {
    expect(formatMetricValue("bounce_rate", 41)).toBe("41%");
    expect(formatMetricValue("visit_duration", 95)).toBe("95s");
    expect(formatMetricValue("visitors", 12345)).toBe("12,345");
    expect(formatMetricValue("total_revenue", { value: 1, currency: "EUR", short: "€1", long: "€1.00" })).toBe("€1.00");
    expect(formatMetricValue("conversion_rate", null)).toBe("n/a");
  });

  it("escapes pipes in markdown cells", () => {
    expect(renderMarkdownTable(["event:page"], [{ "event:page": "/a|b" }])).toContain("/a\\|b");
    expect(renderMarkdownTable(["x"], [])).toMatch(/No data/);
  });

  it("drops trailing rows to stay under the character limit", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => ({ page: `/page-${index}`, visitors: index }));
    const text = renderWithinLimit(rows, (shown, truncation) => JSON.stringify({ rows: shown, truncated: truncation !== undefined }));
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    const parsed = JSON.parse(text) as { rows: unknown[]; truncated: boolean };
    expect(parsed.truncated).toBe(true);
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.length).toBeLessThan(rows.length);
  });
});

describe("fillTimeGaps", () => {
  it("fills missing buckets with 0 for counts and null for ratios", () => {
    const filled = fillTimeGaps(
      [{ dimensions: ["2024-01-02"], metrics: [5, 40] }],
      ["2024-01-01", "2024-01-02", "2024-01-03"],
      ["visitors", "bounce_rate"],
    );
    expect(filled).toEqual([
      { dimensions: ["2024-01-01"], metrics: [0, null] },
      { dimensions: ["2024-01-02"], metrics: [5, 40] },
      { dimensions: ["2024-01-03"], metrics: [0, null] },
    ]);
  });

  it("returns rows untouched when labels do not match returned buckets", () => {
    const rows = [{ dimensions: ["2024-01-02 00:00:00"], metrics: [5] }];
    expect(fillTimeGaps(rows, ["2024-01-02"], ["visitors"])).toEqual(rows);
  });
});

describe("computePageInfo", () => {
  it("uses total_rows when available", () => {
    expect(computePageInfo(0, 10, 10, 25)).toMatchObject({ has_more: true, next_offset: 10, total_rows: 25 });
    expect(computePageInfo(20, 10, 5, 25)).toMatchObject({ has_more: false, next_offset: null });
  });

  it("falls back to a full-page heuristic without total_rows", () => {
    expect(computePageInfo(0, 10, 10, undefined)).toMatchObject({ has_more: true, next_offset: 10, total_rows: null });
    expect(computePageInfo(0, 10, 3, undefined)).toMatchObject({ has_more: false });
  });
});
