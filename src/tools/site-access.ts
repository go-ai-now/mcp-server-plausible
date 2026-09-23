import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildQuery } from "../plausible/query-builder.js";
import { PlausibleApiError, type PlausibleErrorKind } from "../plausible/errors.js";
import { SiteIdSchema } from "../plausible/schema.js";
import { READ_ONLY_ANNOTATIONS, errorResult, resolveSiteId, runTool, textResult, type ToolContext } from "./shared.js";

export const SITE_ACCESS_TOOL_NAME = "plausible_check_site_access";

/**
 * Error kinds that are a definitive "no access" answer. Anything else (429, 5xx, timeout)
 * means the check itself could not be completed and is reported as a tool error.
 */
const DEFINITIVE_DENIAL_KINDS: ReadonlySet<PlausibleErrorKind> = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
  "bad_request",
]);

export const SiteAccessInputShape = {
  site_id: SiteIdSchema.optional(),
};

export interface SiteAccessReport {
  site_id: string;
  base_url: string;
  accessible: boolean;
  visitors_today: number | null;
  reason: string | null;
}

export function registerSiteAccessTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    SITE_ACCESS_TOOL_NAME,
    {
      title: "Plausible: check site access",
      description: `Verify that the configured API key can query a site, and show today's visitor count as a smoke test.

Call this first when a user mentions a new site, or when other tools return authentication or "not found" errors.
The Stats API has no "list sites" endpoint (that is the separate Sites API with a different key type), so this checks one site at a time.

Example: {"site_id": "example.com"}`,
      inputSchema: SiteAccessInputShape,
      annotations: { title: "Plausible: check site access", ...READ_ONLY_ANNOTATIONS },
    },
    async (args) =>
      runTool(SITE_ACCESS_TOOL_NAME, context, async () => {
        const siteId = resolveSiteId(args.site_id, context);
        const base = { site_id: siteId, base_url: context.client.baseUrl };
        let report: SiteAccessReport;
        try {
          const response = await context.client.query(buildQuery({ siteId, metrics: ["visitors"], dateRange: "day" }));
          const value = response.results[0]?.metrics[0];
          report = { ...base, accessible: true, visitors_today: typeof value === "number" ? value : 0, reason: null };
        } catch (error) {
          if (error instanceof PlausibleApiError && DEFINITIVE_DENIAL_KINDS.has(error.kind)) {
            report = { ...base, accessible: false, visitors_today: null, reason: error.message };
          } else if (error instanceof PlausibleApiError) {
            return errorResult(`Could not complete the access check: ${error.message}`);
          } else {
            throw error;
          }
        }
        const headline = report.accessible
          ? `Access OK: the API key can query "${siteId}" on ${report.base_url}. Visitors today: ${report.visitors_today}.`
          : `No access to "${siteId}" on ${report.base_url}. ${report.reason}`;
        return textResult(`${headline}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``);
      }),
  );
}
