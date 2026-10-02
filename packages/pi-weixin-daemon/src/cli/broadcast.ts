import { Command } from "commander";
import { rpcBroadcast } from "./rpc-client.js";

export function broadcastCommand(): Command {
  return new Command("broadcast")
    .description("Send a notification to a project's bound Weixin users without invoking Pi")
    .requiredOption("--project <name>", "enabled project name")
    .requiredOption("--message <text>", "notification text")
    .action(async (opts: { project: string; message: string }) => {
      try {
        if (!opts.project.trim()) throw new Error("--project must not be blank");
        if (!opts.message.trim()) throw new Error("--message must not be blank");
        const result = await rpcBroadcast({ name: opts.project, text: opts.message });
        const succeeded = result.succeeded > 0 && result.skipped === 0 && result.failed === 0;
        console.log(
          `Broadcast ${succeeded ? "succeeded" : "not fully successful"}. See daemon logs: pi-wx logs`,
        );
        process.exitCode = succeeded ? 0 : 1;
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
