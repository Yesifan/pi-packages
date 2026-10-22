import { Command, Option } from "commander";
import { validateCliPrompt } from "../sessions/cli-prompt.js";
import { rpcPrompt } from "./rpc-client.js";

export function promptCommand(): Command {
  return new Command("prompt")
    .description(
      "Prompt the project's shared Pi session; wait for completion or an interactive question",
    )
    .argument("<text>", "prompt text or answer to a pending CLI question")
    .requiredOption("--project <name>", "enabled project name")
    .addOption(new Option("--session <id>", "select a session").conflicts("newSession"))
    .addOption(new Option("--new-session", "create and select a new session").conflicts("session"))
    .addOption(
      new Option("--reply <target>", "repeatable: caller, user:all or user:<id>")
        .argParser((value: string, previous: string[]) => [...previous, value])
        .default([], "caller"),
    )
    .action(
      async (
        text: string,
        opts: { project: string; session?: string; newSession?: boolean; reply: string[] },
      ) => {
        try {
          if (!opts.project.trim()) throw new Error("--project must not be blank");
          const input = {
            text,
            sessionId: opts.session,
            newSession: opts.newSession,
            reply: opts.reply.length ? opts.reply : undefined,
          };
          validateCliPrompt(input);
          const result = await rpcPrompt({ name: opts.project, ...input });
          // A stable JSON result carries status, session ID, UI questions and delivery counts.
          console.log(JSON.stringify(result));
          process.exitCode =
            result.status === "error" ||
            result.status === "aborted" ||
            (result.delivery && (result.delivery.failed > 0 || result.delivery.skipped > 0))
              ? 1
              : 0;
        } catch (err) {
          console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      },
    );
}
