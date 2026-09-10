import { Command } from "commander";
import { Daemon } from "../daemon.js";
import { createLogger } from "../util/logger.js";

/** Install SIGINT/SIGTERM handling: graceful stop, force-exit on second signal. */
export function installSignalHandlers(daemon: Daemon, logger: ReturnType<typeof createLogger>): void {
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      logger.warn({ signal }, "second signal received, forcing exit");
      process.exit(130);
    }
    stopping = true;
    logger.info({ signal }, "signal received, shutting down");
    daemon
      .stop()
      .catch((err: unknown) => {
        logger.error({ err }, "error during shutdown");
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * `pi-wx serve`
 *
 * Foreground daemon — no fork, no self-managed pidfile. Owns the account
 * monitors and the project runtimes, and reconciles desired-state from config.
 * Production is run under `systemd --user` (see `service install`).
 */
export function serveCommand(): Command {
  return new Command("serve")
    .description("Run the daemon in the foreground (manages accounts + projects)")
    .action(async () => {
      const logger = createLogger({ pretty: process.stdout.isTTY });
      const daemon = new Daemon({ logger, startRpc: true });
      installSignalHandlers(daemon, logger);
      try {
        await daemon.start();
        await daemon.waitForShutdown();
      } catch (err) {
        logger.error({ err }, "daemon failed");
        await daemon.stop().catch(() => {});
        process.exitCode = 1;
      }
    });
}
