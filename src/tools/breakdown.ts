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
import { buildQuery, type OrderByInput } from "../plausible/query-builder.js";
import {
  DateRangeSchema,
  DimensionSchema,
  FiltersSchema,
  MetricsSchema,
  ResponseFormatSchema,
  SiteIdSchema,
} from "../plausible/schema.js";
import { READ_ONLY_ANNOTATIONS, ToolInputError, assertCompatible, resolveSiteId, runTool, textResult, type ToolContext } from "./shared.js";

export const BREAKDOWN_TOOL_NAME = "plausible_get_breakdown";

export const DEFAULT_BREAKDOWN_LIMIT = 25;
/** Plausible allows up to 10,000 rows, which is far more than is useful in a model context. */
export const MAX_BREAKDOWN_LIMIT = 1_000;
export const MAX_BREAKDOWN_DIMENSIONS = 3;

export const BreakdownInputShape = {
  site_id: SiteIdSchema.optional(),
  dimensions: z
    .array(DimensionSchema)
    .min(1)
    .max(MAX_BREAKDOWN_DIMENSIONS)
    .refine((dimensions) => new Set(dimensions).size === dimensions.length, { message: "Dimensions must not contain duplicates" })
    .describe('Group by these dimensions (1-3), e.g. ["visit:source"] or ["visit:country_name", "visit:city_name"]'),
  date_range: DateRangeSchema.default("30d"),
  metrics: MetricsSchema.default(["visitors"]).describe('Metrics per group. Default: ["visitors"]'),
  filters: FiltersSchema.default([]),
  order_by: z
    .array(
      z
        .object({
          by: z.string().min(1).describe("A metric or dimension that is part of this query"),
          direction: z.enum(["asc", "desc"]).default("desc"),
        })
        .strict(),
    )
    .max(4)
    .optional()
    .describe("Sort order. Default: first metric descending"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_BREAKDOWN_LIMIT)
    .default(DEFAULT_BREAKDOWN_LIMIT)
    .describe(`Rows per page (1-${MAX_BREAKDOWN_LIMIT}, default ${DEFAULT_BREAKDOWN_LIMIT})`),
  offset: z.number().int().min(0).max(1_000_000).default(0).describe("Rows to skip, for pagination. Use next_offset from the previous page"),
  include_imported: z.boolean().default(false).describe("Include imported (e.g. Google Analytics) data where supported"),
  response_format: ResponseFormatSchema.default("markdown"),
};

export interface PageInfo {
  offset: number;
  limit: number;
  returned: number;
  total_rows: number | null;
  has_more: boolean;
  next_offset: number | null;
}

export function computePageInfo(offset: number, limit: number, returned: number, totalRows: number | undefined): PageInfo {
  // Without total_rows, a full page is the only signal that more rows may exist.
  const hasMore = totalRows === undefined ? returned === limit : offset + returned < totalRows;
  return {
    offset,
    limit,
    returned,
    total_rows: totalRows ?? null,
    has_more: hasMore,
    next_offset: hasMore ? offset + returned : null,
  };
}

export function assertOrderByReferencesQuery(
  orderBy: readonly OrderByInput[] | undefined,
  metrics: readonly string[],
  dimensions: readonly string[],
): void {
  if (orderBy === undefined) {
    return;
  }
  const allowed = new Set([...metrics, ...dimensions]);
  const unknown = orderBy.filter((order) => !allowed.has(order.by)).map((order) => order.by);
  if (unknown.length > 0) {
    throw new ToolInputError(
      `order_by can only reference requested metrics or dimensions. Not in this query: ${unknown.join(", ")}. Allowed: ${[...allowed].join(", ")}`,
    );
  }
}

export function registerBreakdownTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    BREAKDOWN_TOOL_NAME,
    {
      title: "Plausible: breakdown by dimension",
      description: `Rank groups by metrics: top pages, sources, countries, devices, UTM campaigns, goals, custom properties. Paginated.

Examples:
- Top 10 traffic sources this month: {"site_id": "example.com", "dimensions": ["visit:source"], "date_range": "month", "limit": 10}
- Top pages with engagement: {"dimensions": ["event:page"], "metrics": ["visitors", "pageviews", "bounce_rate", "time_on_page"]}
- Goal conversions by campaign: {"dimensions": ["visit:utm_campaign"], "metrics": ["visitors", "conversion_rate"], "filters": [{"dimension": "event:goal", "operator": "is", "values": ["Signup"]}]}
- Next page of results: repeat the call with "offset" set to next_offset from the previous response.

Rules: session metrics (bounce_rate, views_per_visit, visit_duration) cannot be combined with event dimensions other than event:page. "percentage" gives each group's share of the total.`,
      inputSchema: BreakdownInputShape,
      annotations: { title: "Plausible: breakdown by dimension", ...READ_ONLY_ANNOTATIONS },
    },
    async (args) =>
      runTool(BREAKDOWN_TOOL_NAME, context, async () => {
        const siteId = resolveSiteId(args.site_id, context);
        assertCompatible({ metrics: args.metrics, dimensions: args.dimensions, filters: args.filters });
        assertOrderByReferencesQuery(args.order_by, args.metrics, args.dimensions);

        const query = buildQuery({
          siteId,
          metrics: args.metrics,
          dateRange: args.date_range,
          dimensions: args.dimensions,
          filters: args.filters,
          ...(args.order_by === undefined ? {} : { orderBy: args.order_by }),
          include: { imports: args.include_imported, total_rows: true },
          pagination: { limit: args.limit, offset: args.offset },
        });
        const response = await context.client.query(query);
        const rows: RowObject[] = response.results.map((row) => toRowObject(args.dimensions, args.metrics, row));
        const page = computePageInfo(args.offset, args.limit, rows.length, response.meta.total_rows);
        const warnings = collectWarnings(response.meta);
        const hint = "Lower `limit` and page with `offset`.";

        if (args.response_format === "json") {
          return textResult(
            renderWithinLimit(rows, (shown, truncation) =>
              JSON.stringify(
                {
                  site_id: siteId,
                  date_range: query.date_range,
                  rows: shown,
                  // If rows were cut for size, point the next page at the first omitted row.
                  pagination:
                    truncation === undefined
                      ? page
                      : { ...page, returned: shown.length, has_more: true, next_offset: args.offset + shown.length },
                  warnings,
                },
                null,
                2,
              ),
            ),
          );
        }
        const columns = [...args.dimensions, ...args.metrics];
        const heading = `## ${siteId} — ${describeDateRange(query.date_range)} by ${args.dimensions.join(" × ")}`;
        return textResult(
          renderWithinLimit(rows, (shown, truncation) => {
            const nextOffset = truncation === undefined ? page.next_offset : args.offset + shown.length;
            const total = page.total_rows === null ? "unknown" : String(page.total_rows);
            const footer =
              nextOffset === null
                ? `Rows ${args.offset + 1}-${args.offset + shown.length} of ${total}. No more rows.`
                : `Rows ${args.offset + 1}-${args.offset + shown.length} of ${total}. More available: call again with offset=${nextOffset}.`;
            return `${heading}\n\n${renderMarkdownTable(columns, shown)}\n\n${shown.length === 0 ? "No rows." : footer}${renderWarnings(warnings)}${truncationNotice(truncation, hint)}`;
          }),
        );
      }),
  );
}
