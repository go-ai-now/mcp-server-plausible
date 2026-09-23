import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  collectWarnings,
  describeDateRange,
  renderMarkdownTable,
  renderWarnings,
  renderWithinLimit,
  toRowObject,
  truncationNotice,
  type RowObject,
} from "../format.js";
import { buildQuery } from "../plausible/query-builder.js";
import {
  DateRangeSchema,
  FiltersSchema,
  MetricsSchema,
  ResponseFormatSchema,
  SiteIdSchema,
  type TimeDimension,
} from "../plausible/schema.js";
import type { PlausibleResultRow } from "../plausible/types.js";
import { READ_ONLY_ANNOTATIONS, assertCompatible, resolveSiteId, runTool, textResult, type ToolContext } from "./shared.js";

export const TIMESERIES_TOOL_NAME = "plausible_get_timeseries";

/** Count metrics are genuinely 0 in an empty bucket; ratios/averages are undefined there. */
const ZERO_FILL_METRICS: ReadonlySet<string> = new Set(["visitors", "visits", "pageviews", "events"]);

export const INTERVAL_TO_DIMENSION: Record<"auto" | "hour" | "day" | "week" | "month", TimeDimension> = {
  auto: "time",
  hour: "time:hour",
  day: "time:day",
  week: "time:week",
  month: "time:month",
};

export const TimeseriesInputShape = {
  site_id: SiteIdSchema.optional(),
  date_range: DateRangeSchema.default("30d"),
  interval: z
    .enum(["auto", "hour", "day", "week", "month"])
    .default("auto")
    .describe('Bucket size. "auto" lets Plausible pick one that suits the date range'),
  metrics: MetricsSchema.default(["visitors", "pageviews"]).describe("Metrics per bucket. Default: visitors, pageviews"),
  filters: FiltersSchema.default([]),
  fill_gaps: z
    .boolean()
    .default(true)
    .describe("Return every bucket in the range, including empty ones (counts become 0, ratios null)"),
  include_imported: z.boolean().default(false).describe("Include imported (e.g. Google Analytics) data where supported"),
  response_format: ResponseFormatSchema.default("markdown"),
};

/** Adds empty buckets for labels Plausible reported in meta.time_labels but returned no rows for. */
export function fillTimeGaps(
  rows: readonly PlausibleResultRow[],
  labels: readonly string[] | undefined,
  metrics: readonly string[],
): PlausibleResultRow[] {
  if (labels === undefined || labels.length === 0) {
    return [...rows];
  }
  const byLabel = new Map(rows.map((row) => [row.dimensions[0] ?? "", row]));
  const labelSet = new Set(labels);
  // Never drop real data: if any returned bucket is not among the labels (format drift),
  // return the rows untouched instead of guessing.
  if ([...byLabel.keys()].some((key) => !labelSet.has(key))) {
    return [...rows];
  }
  return labels.map(
    (label) =>
      byLabel.get(label) ?? {
        dimensions: [label],
        metrics: metrics.map((metric) => (ZERO_FILL_METRICS.has(metric) ? 0 : null)),
      },
  );
}

export function registerTimeseriesTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    TIMESERIES_TOOL_NAME,
    {
      title: "Plausible: timeseries",
      description: `Get metrics bucketed over time (hour/day/week/month) to see trends, spikes and drops.

Examples:
- Daily visitors for the last 30 days: {"site_id": "example.com", "date_range": "30d", "interval": "day"}
- Hourly traffic today from one country: {"date_range": "day", "interval": "hour", "filters": [{"dimension": "visit:country_name", "operator": "is", "values": ["Germany"]}]}
- Monthly signups this year: {"date_range": "year", "interval": "month", "metrics": ["visitors", "events"], "filters": [{"dimension": "event:goal", "operator": "is", "values": ["Signup"]}]}

Dates/times are in the site's reporting timezone. Hourly buckets over long ranges produce many rows; prefer day/week for ranges over a few days.`,
      inputSchema: TimeseriesInputShape,
      annotations: { title: "Plausible: timeseries", ...READ_ONLY_ANNOTATIONS },
    },
    async (args) =>
      runTool(TIMESERIES_TOOL_NAME, context, async () => {
        const siteId = resolveSiteId(args.site_id, context);
        const timeDimension = INTERVAL_TO_DIMENSION[args.interval];
        assertCompatible({ metrics: args.metrics, dimensions: [timeDimension], filters: args.filters });

        const query = buildQuery({
          siteId,
          metrics: args.metrics,
          dateRange: args.date_range,
          dimensions: [timeDimension],
          filters: args.filters,
          include: { imports: args.include_imported, time_labels: args.fill_gaps },
        });
        const response = await context.client.query(query);
        const rows = args.fill_gaps ? fillTimeGaps(response.results, response.meta.time_labels, args.metrics) : response.results;
        const series: RowObject[] = rows.map((row) => toRowObject(["time"], args.metrics, row));
        const warnings = collectWarnings(response.meta);
        const hint = "Use a coarser interval or a shorter date_range.";

        if (args.response_format === "json") {
          return textResult(
            renderWithinLimit(series, (shown, truncation) =>
              JSON.stringify(
                {
                  site_id: siteId,
                  date_range: query.date_range,
                  interval: timeDimension,
                  series: shown,
                  warnings,
                  truncated: truncation !== undefined,
                },
                null,
                2,
              ),
            ),
          );
        }
        const heading = `## ${siteId} — ${describeDateRange(query.date_range)} by ${args.interval}`;
        return textResult(
          renderWithinLimit(
            series,
            (shown, truncation) =>
              `${heading}\n\n${renderMarkdownTable(["time", ...args.metrics], shown)}${renderWarnings(warnings)}${truncationNotice(truncation, hint)}`,
          ),
        );
      }),
  );
}
