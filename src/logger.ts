/**
 * stderr-only structured logger.
 *
 * stdout is reserved for the MCP JSON-RPC stream; writing anything else there corrupts
 * the protocol. Callers must never pass secrets in `fields`.
 */

export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

type Level = "debug" | "info" | "warn" | "error";

export function createStderrLogger(options: { debug: boolean; write?: (line: string) => void }): Logger {
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`));
  const emit = (level: Level, message: string, fields: LogFields | undefined): void => {
    if (level === "debug" && !options.debug) {
      return;
    }
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields }));
  };
  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
