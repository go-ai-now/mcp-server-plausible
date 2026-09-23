/**
 * Plumbing shared by every tool: dependency context, site resolution,
 * uniform success/error results, and the exception boundary.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "../logger.js";
import type { PlausibleClient } from "../plausible/client.js";
import { PlausibleApiError } from "../plausible/errors.js";
import { findCompatibilityProblems, type CompatibilityInput } from "../plausible/schema.js";

export interface ToolContext {
  client: PlausibleClient;
  logger: Logger;
  defaultSiteId: string | undefined;
  now: () => Date;
}

/** Thrown for input problems detected before any HTTP call is made. */
export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function resolveSiteId(siteId: string | undefined, context: ToolContext): string {
  const resolved = siteId ?? context.defaultSiteId;
  if (resolved === undefined) {
    throw new ToolInputError(
      "site_id is required: pass the site domain (e.g. \"example.com\") or set PLAUSIBLE_DEFAULT_SITE_ID in the server environment.",
    );
  }
  return resolved;
}

export function assertCompatible(input: CompatibilityInput): void {
  const problems = findCompatibilityProblems(input);
  if (problems.length > 0) {
    throw new ToolInputError(`Invalid metric/dimension combination:\n- ${problems.join("\n- ")}`);
  }
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Exception boundary for tool handlers. Known errors become `isError` results the model can
 * act on; unknown errors are logged to stderr and reported generically so internals do not leak.
 */
export async function runTool(
  toolName: string,
  context: ToolContext,
  handler: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ToolInputError) {
      return errorResult(error.message);
    }
    if (error instanceof PlausibleApiError) {
      context.logger.warn("tool failed", { tool: toolName, kind: error.kind, status: error.status });
      return errorResult(error.message);
    }
    context.logger.error("unexpected tool failure", {
      tool: toolName,
      error: error instanceof Error ? error.name : typeof error,
    });
    return errorResult(`Unexpected internal error in ${toolName}. Check the server logs (stderr) for details.`);
  }
}
