import { describe, expect, it } from "vitest";
import { buildQuery, lastMinutesRange, toIsoSeconds, toPlausibleFilter } from "../src/plausible/query-builder.js";

describe("buildQuery", () => {
  it("builds a minimal aggregate query without empty optional keys", () => {
    expect(buildQuery({ siteId: "example.com", metrics: ["visitors"], dateRange: "7d", filters: [], include: { imports: false } })).toEqual({
      site_id: "example.com",
      metrics: ["visitors"],
      date_range: "7d",
    });
  });

  it("converts custom date ranges to a tuple", () => {
    const query = buildQuery({ siteId: "a.com", metrics: ["visitors"], dateRange: { from: "2024-01-01", to: "2024-01-31" } });
    expect(query.date_range).toEqual(["2024-01-01", "2024-01-31"]);
  });

  it("maps filters, order_by, include and pagination to Plausible's wire format", () => {
    const query = buildQuery({
      siteId: "a.com",
      metrics: ["visitors", "pageviews"],
      dateRange: "30d",
      dimensions: ["visit:country_name"],
      filters: [
        { dimension: "event:page", operator: "contains", values: ["/blog"], case_sensitive: false },
        { dimension: "visit:device", operator: "is", values: ["Mobile"] },
      ],
      orderBy: [{ by: "pageviews", direction: "desc" }],
      include: { total_rows: true, imports: true, time_labels: false },
      pagination: { limit: 10, offset: 20 },
    });
    expect(query).toEqual({
      site_id: "a.com",
      metrics: ["visitors", "pageviews"],
      date_range: "30d",
      dimensions: ["visit:country_name"],
      filters: [
        ["contains", "event:page", ["/blog"], { case_sensitive: false }],
        ["is", "visit:device", ["Mobile"]],
      ],
      order_by: [["pageviews", "desc"]],
      include: { imports: true, total_rows: true },
      pagination: { limit: 10, offset: 20 },
    });
  });

  it("does not share array references with the input", () => {
    const metrics = ["visitors"];
    const query = buildQuery({ siteId: "a.com", metrics, dateRange: "7d" });
    metrics.push("visits");
    expect(query.metrics).toEqual(["visitors"]);
  });
});

describe("toPlausibleFilter", () => {
  it("keeps case_sensitive: true explicitly", () => {
    expect(toPlausibleFilter({ dimension: "event:page", operator: "is", values: ["/"], case_sensitive: true })).toEqual([
      "is",
      "event:page",
      ["/"],
      { case_sensitive: true },
    ]);
  });
});

describe("realtime date range", () => {
  it("formats with second precision and an explicit +00:00 offset", () => {
    expect(toIsoSeconds(new Date("2024-05-01T10:20:30.456Z"))).toBe("2024-05-01T10:20:30+00:00");
  });

  it("covers the last N minutes up to now", () => {
    expect(lastMinutesRange(new Date("2024-05-01T10:00:00Z"), 5)).toEqual([
      "2024-05-01T09:55:00+00:00",
      "2024-05-01T10:00:00+00:00",
    ]);
  });
});
