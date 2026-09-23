import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderMarkdownTable, toRowObject, type RowObject } from "../format.js";
import { buildQuery, lastMinutesRange } from "../plausible/query-builder.js";
import { ResponseFormatSchema, SiteIdSchema } from "../plausible/schema.js";
import { READ_ONLY_ANNOTATIONS, resolveSiteId, runTool, textResult, type ToolContext } from "./shared.js";

export const REALTIME_TOOL_NAME = "plausible_get_realtime_visitors";

export const DEFAULT_REALTIME_WINDOW_MINUTES = 5;
export const MAX_REALTIME_WINDOW_MINUTES = 60;
export const DEFAULT_REALTIME_TOP_PAGES = 5;
export const MAX_REALTIME_TOP_PAGES = 25;

export const RealtimeInputShape = {
  site_id: SiteIdSchema.optional(),
  window_minutes: z
    .number()
    .int()
    .min(1)
    .max(MAX_REALTIME_WINDOW_MINUTES)
    .default(DEFAULT_REALTIME_WINDOW_MINUTES)
    .describe(`Look-back window in minutes (1-${MAX_REALTIME_WINDOW_MINUTES}). Plausible's dashboard uses 5`),
  top_pages: z
    .number()
    .int()
    .min(0)
    .max(MAX_REALTIME_TOP_PAGES)
    .default(DEFAULT_REALTIME_TOP_PAGES)
    .describe("Also list the N most-visited pages in the window. 0 skips the extra request"),
  response_format: ResponseFormatSchema.default("markdown"),
};

export function registerRealtimeTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    REALTIME_TOOL_NAME,
    {
      title: "Plausible: realtime visitors",
      description: `Get how many unique visitors are on the site right now (last few minutes), optionally with the pages they are viewing.

Examples:
- Current visitors: {"site_id": "example.com"}
- Last 15 minutes, top 10 pages: {"window_minutes": 15, "top_pages": 10}

Implemented with a Stats API v2 query over the last N minutes (UTC). Uses 1 request, or 2 when top_pages > 0.`,
      inputSchema: RealtimeInputShape,
      annotations: { title: "Plausible: realtime visitors", ...READ_ONLY_ANNOTATIONS, idempotentHint: false },
    },
    async (args) =>
      runTool(REALTIME_TOOL_NAME, context, async () => {
        const siteId = resolveSiteId(args.site_id, context);
        const dateRange = lastMinutesRange(context.now(), args.window_minutes);

        const totalQuery = buildQuery({ siteId, metrics: ["visitors"], dateRange });
        const pagesQuery =
          args.top_pages > 0
            ? buildQuery({
                siteId,
                metrics: ["visitors"],
                dateRange,
                dimensions: ["event:page"],
                pagination: { limit: args.top_pages, offset: 0 },
              })
            : undefined;

        const [totalResponse, pagesResponse] = await Promise.all([
          context.client.query(totalQuery),
          pagesQuery === undefined ? Promise.resolve(undefined) : context.client.query(pagesQuery),
        ]);
        const visitorsValue = totalResponse.results[0]?.metrics[0];
        const visitors = typeof visitorsValue === "number" ? visitorsValue : 0;
        const pages: RowObject[] = (pagesResponse?.results ?? []).map((row) => toRowObject(["page"], ["visitors"], row));

        if (args.response_format === "json") {
          return textResult(
            JSON.stringify(
              { site_id: siteId, window_minutes: args.window_minutes, from: dateRange[0], to: dateRange[1], visitors, top_pages: pages },
              null,
              2,
            ),
          );
        }
        const summary = `## ${siteId} — realtime\n\n**${visitors}** unique visitor(s) in the last ${args.window_minutes} minute(s) (${dateRange[0]} → ${dateRange[1]}).`;
        if (args.top_pages === 0) {
          return textResult(summary);
        }
        return textResult(`${summary}\n\n### Top pages\n\n${renderMarkdownTable(["page", "visitors"], pages)}`);
      }),
  );
}
