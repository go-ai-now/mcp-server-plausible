/**
 * Zod schemas and domain rules for the Plausible Stats API v2 (`POST /api/v2/query`).
 *
 * The vocabularies below mirror https://plausible.io/docs/stats-api. Cross-field rules
 * that the API documents (e.g. `scroll_depth` requires `event:page`) are checked
 * client-side so the model gets a precise, actionable error before a request is spent
 * against the 600 requests/hour rate limit.
 */
import { z } from "zod";

export const METRICS = [
  "visitors",
  "visits",
  "pageviews",
  "views_per_visit",
  "bounce_rate",
  "visit_duration",
  "events",
  "scroll_depth",
  "percentage",
  "conversion_rate",
  "group_conversion_rate",
  "average_revenue",
  "total_revenue",
  "time_on_page",
] as const;
export type Metric = (typeof METRICS)[number];

export const EVENT_DIMENSIONS = ["event:goal", "event:page", "event:hostname"] as const;

export const VISIT_DIMENSIONS = [
  "visit:entry_page",
  "visit:entry_page_hostname",
  "visit:exit_page",
  "visit:exit_page_hostname",
  "visit:source",
  "visit:referrer",
  "visit:channel",
  "visit:utm_medium",
  "visit:utm_source",
  "visit:utm_campaign",
  "visit:utm_content",
  "visit:utm_term",
  "visit:device",
  "visit:browser",
  "visit:browser_version",
  "visit:os",
  "visit:os_version",
  "visit:country",
  "visit:region",
  "visit:city",
  "visit:country_name",
  "visit:region_name",
  "visit:city_name",
] as const;

export const TIME_DIMENSIONS = ["time", "time:hour", "time:day", "time:week", "time:month"] as const;
export type TimeDimension = (typeof TIME_DIMENSIONS)[number];

export const DATE_RANGE_PRESETS = [
  "day",
  "24h",
  "7d",
  "28d",
  "30d",
  "91d",
  "month",
  "6mo",
  "12mo",
  "year",
  "all",
] as const;

export const FILTER_OPERATORS = [
  "is",
  "is_not",
  "contains",
  "contains_not",
  "matches",
  "matches_not",
] as const;

/** Operators that accept the `case_sensitive` modifier according to the docs. */
const CASE_MODIFIER_OPERATORS: ReadonlySet<string> = new Set(["is", "contains"]);
/** `event:goal` only supports these operators. */
const GOAL_OPERATORS: ReadonlySet<string> = new Set(["is", "contains"]);

const SESSION_METRICS: ReadonlySet<string> = new Set(["bounce_rate", "views_per_visit", "visit_duration"]);
const PAGE_SCOPED_METRICS: ReadonlySet<string> = new Set(["scroll_depth", "time_on_page"]);
const GOAL_SCOPED_METRICS: ReadonlySet<string> = new Set([
  "conversion_rate",
  "group_conversion_rate",
  "average_revenue",
  "total_revenue",
]);
/** Event dimensions that may be mixed with session metrics. */
const SESSION_COMPATIBLE_EVENT_DIMENSIONS: ReadonlySet<string> = new Set(["event:page", "event:hostname"]);

const CUSTOM_PROP_PATTERN = /^event:props:[A-Za-z0-9_\-.:]{1,300}$/;
const MAX_CLAUSES = 50;
const MAX_CLAUSE_LENGTH = 2_000;
const MAX_SITE_ID_LENGTH = 253;

const KNOWN_DIMENSIONS: ReadonlySet<string> = new Set([...EVENT_DIMENSIONS, ...VISIT_DIMENSIONS]);

export function isCustomPropertyDimension(value: string): boolean {
  return CUSTOM_PROP_PATTERN.test(value);
}

/** Non-time dimension: known event/visit dimension or `event:props:<name>`. */
export const DimensionSchema = z
  .string()
  .refine((value) => KNOWN_DIMENSIONS.has(value) || isCustomPropertyDimension(value), {
    message: `Unknown dimension. Use one of ${[...EVENT_DIMENSIONS, ...VISIT_DIMENSIONS].join(", ")} or "event:props:<custom_property>"`,
  })
  .describe(
    'Event/visit dimension such as "visit:source", "event:page", "visit:country_name", or a custom property "event:props:<name>"',
  );

export const MetricSchema = z.enum(METRICS);

export const MetricsSchema = z
  .array(MetricSchema)
  .min(1, "Request at least one metric")
  .max(METRICS.length)
  .refine((metrics) => new Set(metrics).size === metrics.length, { message: "Metrics must not contain duplicates" });

export const SiteIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SITE_ID_LENGTH)
  .regex(/^[^\s/]+(\/[^\s]+)?$/, "site_id must be the site domain as registered in Plausible, e.g. example.com")
  .describe('Site domain exactly as registered in Plausible, e.g. "example.com". Optional when PLAUSIBLE_DEFAULT_SITE_ID is set.');

const IsoDate = z.iso.date();
const IsoDateTime = z.iso.datetime({ offset: true });

export const CustomDateRangeSchema = z
  .object({
    from: z.union([IsoDate, IsoDateTime]).describe('Start, ISO8601 date "2024-01-01" or datetime "2024-01-01T12:00:00+02:00"'),
    to: z.union([IsoDate, IsoDateTime]).describe("End (inclusive), same format as `from`"),
  })
  .strict()
  .superRefine((range, ctx) => {
    const fromIsDate = IsoDate.safeParse(range.from).success;
    const toIsDate = IsoDate.safeParse(range.to).success;
    if (fromIsDate !== toIsDate) {
      ctx.addIssue({ code: "custom", message: "`from` and `to` must both be dates or both be datetimes" });
      return;
    }
    if (Date.parse(range.from) > Date.parse(range.to)) {
      ctx.addIssue({ code: "custom", message: "`from` must not be after `to`" });
    }
  });

export const DateRangeSchema = z
  .union([z.enum(DATE_RANGE_PRESETS), CustomDateRangeSchema])
  .describe(
    'Either a preset ("day", "24h", "7d", "28d", "30d", "91d", "month", "6mo", "12mo", "year", "all") or a custom range {"from": "2024-01-01", "to": "2024-01-31"}',
  );
export type DateRangeInput = z.infer<typeof DateRangeSchema>;

export const FilterSchema = z
  .object({
    dimension: DimensionSchema,
    operator: z.enum(FILTER_OPERATORS).describe("is | is_not | contains | contains_not | matches | matches_not (regex, re2 syntax)"),
    values: z
      .array(z.string().max(MAX_CLAUSE_LENGTH))
      .min(1)
      .max(MAX_CLAUSES)
      .describe("A row matches when ANY value matches (logical OR within one filter)"),
    case_sensitive: z
      .boolean()
      .optional()
      .describe("Only for `is` and `contains`. Set false for case-insensitive matching"),
  })
  .strict()
  .superRefine((filter, ctx) => {
    if (filter.case_sensitive !== undefined && !CASE_MODIFIER_OPERATORS.has(filter.operator)) {
      ctx.addIssue({
        code: "custom",
        path: ["case_sensitive"],
        message: `case_sensitive is only supported with "is" and "contains", not "${filter.operator}"`,
      });
    }
    if (filter.dimension === "event:goal" && !GOAL_OPERATORS.has(filter.operator)) {
      ctx.addIssue({
        code: "custom",
        path: ["operator"],
        message: 'event:goal only supports the "is" and "contains" operators',
      });
    }
  });
export type FilterInput = z.infer<typeof FilterSchema>;

export const FiltersSchema = z
  .array(FilterSchema)
  .max(20)
  .describe("Filters combined with logical AND. Each filter matches if any of its values match.");

export const ResponseFormatSchema = z
  .enum(["markdown", "json"])
  .describe('"markdown" (default) for a readable table, "json" for machine-readable rows');
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

export interface CompatibilityInput {
  metrics: readonly string[];
  dimensions: readonly string[];
  filters: readonly FilterInput[];
}

/**
 * Checks documented cross-field constraints. Returns human-readable problems;
 * an empty list means the combination is valid as far as the client can tell.
 */
export function findCompatibilityProblems(input: CompatibilityInput): string[] {
  const problems: string[] = [];
  const filterDimensions = new Set(input.filters.map((filter) => filter.dimension));
  const dimensions = new Set(input.dimensions);
  const touches = (dimension: string): boolean => dimensions.has(dimension) || filterDimensions.has(dimension);

  const sessionMetrics = input.metrics.filter((metric) => SESSION_METRICS.has(metric));
  const conflictingEventDimensions = input.dimensions.filter(
    (dimension) => dimension.startsWith("event:") && !SESSION_COMPATIBLE_EVENT_DIMENSIONS.has(dimension),
  );
  if (sessionMetrics.length > 0 && conflictingEventDimensions.length > 0) {
    problems.push(
      `Session metrics (${sessionMetrics.join(", ")}) cannot be combined with event dimensions (${conflictingEventDimensions.join(", ")}). Only event:page (optionally with event:hostname) is allowed.`,
    );
  }
  if (dimensions.has("event:hostname") && sessionMetrics.length > 0 && !dimensions.has("event:page")) {
    problems.push("Session metrics with event:hostname require event:page as a dimension as well.");
  }

  for (const metric of input.metrics) {
    if (PAGE_SCOPED_METRICS.has(metric) && !touches("event:page")) {
      problems.push(`Metric "${metric}" requires an event:page filter or dimension.`);
    }
    if (GOAL_SCOPED_METRICS.has(metric) && !touches("event:goal")) {
      problems.push(`Metric "${metric}" requires an event:goal filter or dimension.`);
    }
    if (metric === "percentage" && input.dimensions.length === 0) {
      problems.push('Metric "percentage" requires at least one dimension (use the breakdown tool).');
    }
  }
  return problems;
}
