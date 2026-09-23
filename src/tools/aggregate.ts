import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { collectWarnings, describeDateRange, formatMetricValue, renderWarnings, toRowObject } from "../format.js";
import { buildQuery } from "../plausible/query-builder.js";
import {
  DateRangeSchema,
  FiltersSchema,
  MetricsSchema,
  ResponseFormatSchema,
  SiteIdSchema,
  type Metric,
} from "../plausible/schema.js";
import { READ_ONLY_ANNOTATIONS, assertCompatible, resolveSiteId, runTool, textResult, type ToolContext } from "./shared.js";

export const AGGREGATE_TOOL_NAME = "plausible_get_aggregate";

export const DEFAULT_AGGREGATE_METRICS: Metric[] = ["visitors", "visits", "pageviews", "bounce_rate", "visit_duration"];

export const AggregateInputShape = {
  site_id: SiteIdSchema.optional(),
  date_range: DateRangeSchema.default("30d"),
  metrics: MetricsSchema.default(DEFAULT_AGGREGATE_METRICS).describe(
    "Metrics to compute. Default: visitors, visits, pageviews, bounce_rate, visit_duration",
  ),
  filters: FiltersSchema.default([]),
  include_imported: z
    .boolean()
    .default(false)
    .describe("Include data imported from Google Analytics / CSV where Plausible supports it"),
  response_format: ResponseFormatSchema.default("markdown"),
};

export function registerAggregateTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    AGGREGATE_TOOL_NAME,
    {
      title: "Plausible: aggregate stats",
      description: `Get headline totals for a site over a date range (one number per metric, no grouping).

Use this for questions like "how many visitors last week?" or "what was the bounce rate in March for /pricing?".
Use plausible_get_timeseries for trends over time and plausible_get_breakdown for top-N lists.

Examples:
- Last 7 days overview: {"site_id": "example.com", "date_range": "7d"}
- Conversions of a goal: {"date_range": "30d", "metrics": ["visitors", "events", "conversion_rate"], "filters": [{"dimension": "event:goal", "operator": "is", "values": ["Signup"]}]}
- Custom range for one page: {"date_range": {"from": "2024-03-01", "to": "2024-03-31"}, "filters": [{"dimension": "event:page", "operator": "is", "values": ["/pricing"]}]}

Notes: scroll_depth/time_on_page need an event:page filter; conversion_rate and revenue metrics need an event:goal filter; percentage is not available here (it needs a dimension).`,
      inputSchema: AggregateInputShape,
      annotations: { title: "Plausible: aggregate stats", ...READ_ONLY_ANNOTATIONS },
    },
    async (args) =>
      runTool(AGGREGATE_TOOL_NAME, context, async () => {
        const siteId = resolveSiteId(args.site_id, context);
        assertCompatible({ metrics: args.metrics, dimensions: [], filters: args.filters });

        const query = buildQuery({
          siteId,
          metrics: args.metrics,
          dateRange: args.date_range,
          filters: args.filters,
          include: { imports: args.include_imported },
        });
        const response = await context.client.query(query);
        const firstRow = response.results[0] ?? { dimensions: [], metrics: [] };
        const totals = toRowObject([], args.metrics, firstRow);
        const warnings = collectWarnings(response.meta);

        if (args.response_format === "json") {
          return textResult(
            JSON.stringify({ site_id: siteId, date_range: query.date_range, filters: query.filters ?? [], totals, warnings }, null, 2),
          );
        }
        const lines = args.metrics.map((metric) => `- **${metric}**: ${formatMetricValue(metric, totals[metric] ?? null)}`);
        const filterNote = args.filters.length > 0 ? ` (${args.filters.length} filter(s) applied)` : "";
        return textResult(
          `## ${siteId} — ${describeDateRange(query.date_range)}${filterNote}\n\n${lines.join("\n")}${renderWarnings(warnings)}`,
        );
      }),
  );
}
