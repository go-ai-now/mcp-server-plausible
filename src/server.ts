/**
 * Server factory. Kept free of process/env access so it can be wired to stdio in
 * production and to an in-memory transport in tests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import { PlausibleClient, type FetchLike } from "./plausible/client.js";
import { registerAggregateTool } from "./tools/aggregate.js";
import { registerBreakdownTool } from "./tools/breakdown.js";
import { registerRealtimeTool } from "./tools/realtime.js";
import type { ToolContext } from "./tools/shared.js";
import { registerSiteAccessTool } from "./tools/site-access.js";
import { registerTimeseriesTool } from "./tools/timeseries.js";

export const SERVER_NAME = "mcp-server-plausible";
export const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetch: FetchLike;
  defaultSiteId?: string | undefined;
  logger?: Logger;
  now?: () => Date;
  maxRetries?: number;
  retryDelayMs?: number;
}

export function createServer(options: CreateServerOptions): McpServer {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const client = new PlausibleClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    fetch: options.fetch,
    logger,
    now,
    userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only access to Plausible Analytics (Stats API v2). Start with plausible_check_site_access if unsure which site_id to use. " +
        "Use plausible_get_aggregate for totals, plausible_get_timeseries for trends, plausible_get_breakdown for top-N lists, " +
        "and plausible_get_realtime_visitors for current traffic. The API allows about 600 requests per hour per key, so avoid redundant calls.",
    },
  );
  const context: ToolContext = { client, logger, defaultSiteId: options.defaultSiteId, now };

  registerSiteAccessTool(server, context);
  registerAggregateTool(server, context);
  registerTimeseriesTool(server, context);
  registerBreakdownTool(server, context);
  registerRealtimeTool(server, context);
  return server;
}
