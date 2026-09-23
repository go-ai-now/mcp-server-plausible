#!/usr/bin/env node
/**
 * stdio entry point: reads configuration from the environment and serves MCP over stdin/stdout.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, isInsecureRemoteUrl, loadConfig } from "./config.js";
import { createStderrLogger } from "./logger.js";
import { SERVER_NAME, SERVER_VERSION, createServer } from "./server.js";

async function main(): Promise<void> {
  const bootLogger = createStderrLogger({ debug: false });
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      bootLogger.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createStderrLogger({ debug: config.debug });
  if (isInsecureRemoteUrl(config.baseUrl)) {
    logger.warn("PLAUSIBLE_BASE_URL uses plain http to a non-local host; the API key will be sent unencrypted", {
      base_url: config.baseUrl,
    });
  }

  const server = createServer({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    defaultSiteId: config.defaultSiteId,
    fetch: (input, init) => fetch(input, init),
    logger,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("shutting down", { signal });
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  logger.info("server started", {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    base_url: config.baseUrl,
    default_site_id: config.defaultSiteId,
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
