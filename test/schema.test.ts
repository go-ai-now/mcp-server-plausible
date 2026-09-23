import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DateRangeSchema,
  DimensionSchema,
  FilterSchema,
  MetricsSchema,
  SiteIdSchema,
  findCompatibilityProblems,
} from "../src/plausible/schema.js";
import { BreakdownInputShape } from "../src/tools/breakdown.js";

describe("DateRangeSchema", () => {
  it("accepts documented presets", () => {
    for (const preset of ["day", "24h", "7d", "28d", "30d", "91d", "month", "6mo", "12mo", "year", "all"]) {
      expect(DateRangeSchema.safeParse(preset).success).toBe(true);
    }
  });

  it("rejects unknown presets", () => {
    expect(DateRangeSchema.safeParse("last_week").success).toBe(false);
  });

  it("accepts custom date and datetime ranges", () => {
    expect(DateRangeSchema.safeParse({ from: "2024-01-01", to: "2024-01-31" }).success).toBe(true);
    expect(
      DateRangeSchema.safeParse({ from: "2024-01-01T12:00:00+02:00", to: "2024-01-01T15:59:59+02:00" }).success,
    ).toBe(true);
  });

  it("rejects mixed date/datetime and reversed ranges", () => {
    expect(DateRangeSchema.safeParse({ from: "2024-01-01", to: "2024-01-01T15:00:00+00:00" }).success).toBe(false);
    expect(DateRangeSchema.safeParse({ from: "2024-02-01", to: "2024-01-01" }).success).toBe(false);
  });

  it("rejects invalid calendar dates and extra keys", () => {
    expect(DateRangeSchema.safeParse({ from: "2024-02-30", to: "2024-03-01" }).success).toBe(false);
    expect(DateRangeSchema.safeParse({ from: "2024-01-01", to: "2024-01-02", tz: "UTC" }).success).toBe(false);
  });
});

describe("DimensionSchema", () => {
  it("accepts documented and custom property dimensions", () => {
    for (const dimension of ["event:page", "visit:source", "visit:utm_campaign", "event:props:plan", "event:props:author_name"]) {
      expect(DimensionSchema.safeParse(dimension).success, dimension).toBe(true);
    }
  });

  it("rejects unknown dimensions and time dimensions", () => {
    for (const dimension of ["visit:unknown", "page", "event:props:", "time:day", "event:props:bad name"]) {
      expect(DimensionSchema.safeParse(dimension).success, dimension).toBe(false);
    }
  });
});

describe("MetricsSchema", () => {
  it("rejects empty, unknown and duplicate metrics", () => {
    expect(MetricsSchema.safeParse([]).success).toBe(false);
    expect(MetricsSchema.safeParse(["sessions"]).success).toBe(false);
    expect(MetricsSchema.safeParse(["visitors", "visitors"]).success).toBe(false);
    expect(MetricsSchema.safeParse(["visitors", "bounce_rate"]).success).toBe(true);
  });
});

describe("SiteIdSchema", () => {
  it("accepts domains and trims whitespace", () => {
    expect(SiteIdSchema.parse(" example.com ")).toBe("example.com");
    expect(SiteIdSchema.safeParse("example.com/blog").success).toBe(true);
  });

  it("rejects empty and whitespace-containing values", () => {
    expect(SiteIdSchema.safeParse("").success).toBe(false);
    expect(SiteIdSchema.safeParse("exa mple.com").success).toBe(false);
  });
});

describe("FilterSchema", () => {
  it("accepts a simple filter", () => {
    const result = FilterSchema.safeParse({ dimension: "visit:country_name", operator: "is", values: ["Germany", "Poland"] });
    expect(result.success).toBe(true);
  });

  it("only allows case_sensitive on is/contains", () => {
    expect(
      FilterSchema.safeParse({ dimension: "event:page", operator: "contains", values: ["/Blog"], case_sensitive: false }).success,
    ).toBe(true);
    expect(
      FilterSchema.safeParse({ dimension: "event:page", operator: "matches", values: ["^/b"], case_sensitive: false }).success,
    ).toBe(false);
  });

  it("restricts event:goal to is/contains", () => {
    expect(FilterSchema.safeParse({ dimension: "event:goal", operator: "is_not", values: ["Signup"] }).success).toBe(false);
    expect(FilterSchema.safeParse({ dimension: "event:goal", operator: "is", values: ["Signup"] }).success).toBe(true);
  });

  it("requires at least one value", () => {
    expect(FilterSchema.safeParse({ dimension: "event:page", operator: "is", values: [] }).success).toBe(false);
  });
});

describe("findCompatibilityProblems", () => {
  it("returns no problems for a valid combination", () => {
    expect(findCompatibilityProblems({ metrics: ["visitors", "bounce_rate"], dimensions: ["event:page"], filters: [] })).toEqual([]);
  });

  it("flags session metrics with non-page event dimensions", () => {
    const problems = findCompatibilityProblems({ metrics: ["bounce_rate"], dimensions: ["event:goal"], filters: [] });
    expect(problems.join()).toMatch(/Session metrics/);
  });

  it("flags event:hostname with session metrics unless event:page is present", () => {
    expect(findCompatibilityProblems({ metrics: ["visit_duration"], dimensions: ["event:hostname"], filters: [] })).toHaveLength(1);
    expect(
      findCompatibilityProblems({ metrics: ["visit_duration"], dimensions: ["event:page", "event:hostname"], filters: [] }),
    ).toEqual([]);
  });

  it("requires event:page for scroll_depth and time_on_page (dimension or filter)", () => {
    expect(findCompatibilityProblems({ metrics: ["scroll_depth"], dimensions: [], filters: [] })).toHaveLength(1);
    expect(
      findCompatibilityProblems({
        metrics: ["time_on_page"],
        dimensions: [],
        filters: [{ dimension: "event:page", operator: "is", values: ["/"] }],
      }),
    ).toEqual([]);
  });

  it("requires event:goal for conversion and revenue metrics", () => {
    expect(findCompatibilityProblems({ metrics: ["conversion_rate", "total_revenue"], dimensions: [], filters: [] })).toHaveLength(2);
  });

  it("requires a dimension for percentage", () => {
    expect(findCompatibilityProblems({ metrics: ["percentage"], dimensions: [], filters: [] })).toHaveLength(1);
    expect(findCompatibilityProblems({ metrics: ["percentage"], dimensions: ["visit:source"], filters: [] })).toEqual([]);
  });
});

describe("breakdown input shape", () => {
  const schema = z.object(BreakdownInputShape);

  it("applies defaults", () => {
    const parsed = schema.parse({ dimensions: ["visit:source"] });
    expect(parsed).toMatchObject({ date_range: "30d", metrics: ["visitors"], limit: 25, offset: 0, filters: [] });
  });

  it("bounds limit and rejects duplicate dimensions", () => {
    expect(schema.safeParse({ dimensions: ["visit:source"], limit: 1001 }).success).toBe(false);
    expect(schema.safeParse({ dimensions: ["visit:source"], limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ dimensions: ["visit:source", "visit:source"] }).success).toBe(false);
    expect(schema.safeParse({ dimensions: [] }).success).toBe(false);
  });
});
