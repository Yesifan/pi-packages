import { createRequire } from "node:module";
import { pino, type Logger } from "pino";

export type { Logger } from "pino";

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

const require = createRequire(import.meta.url);

/** True when `pino-pretty` is resolvable (devDependency; absent in global installs). */
function canUsePinoPretty(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the daemon logger. JSON is the production mode (systemd/journald).
 * `pretty` is for interactive CLI use; it silently falls back to JSON when
 * `pino-pretty` is not installed (e.g. a global `pnpm install -g` that only
 * ships `dependencies`, never devDeps), so the CLI/daemon never crash.
 */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? process.env.PI_WEIXIN_LOG_LEVEL ?? "info";
  if (opts.pretty && canUsePinoPretty()) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
      },
    });
  }
  return pino({ level });
}
