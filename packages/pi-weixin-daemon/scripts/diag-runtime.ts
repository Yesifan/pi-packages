// Diagnostic: run one prompt against PiRuntime with full event logging.
import { PiRuntime } from "../src/agent/runtime.js";
import { createLogger } from "../src/util/logger.js";
import { createTmpProject } from "../test/helpers/tmp-project.js";

const logger = createLogger({ level: "debug" });
const project = createTmpProject("diag");
console.log("project:", project.dir, "marker:", project.markerFile);
const runtime = new PiRuntime({ cwd: project.dir, logger });
runtime.onEvent((event) => {
  const brief: Record<string, unknown> = { type: event.type };
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    brief.delta = event.assistantMessageEvent.delta.slice(0, 120);
  }
  if (event.type === "tool_call") {
    brief.toolName = event.toolName;
    brief.input = JSON.stringify(event.input).slice(0, 300);
  }
  if (event.type === "agent_end") {
    brief.messages = event.messages.length;
    brief.willRetry = event.willRetry;
  }
  if (event.type === "agent_error" || event.type === "error") {
    brief.error = String((event as { error?: unknown }).error ?? "").slice(0, 500);
  }
  if (event.type === "tool_result") {
    brief.toolName = event.toolName;
    brief.result = JSON.stringify(event.result).slice(0, 500);
  }
  if (event.type === "queue_update") brief.queue = { steering: event.steering.length, followUp: event.followUp.length };
  console.log("EVENT:", JSON.stringify(brief));
});

await runtime.start();
console.log("STATUS:", JSON.stringify(runtime.getStatus()));

try {
  await runtime.prompt("请调用 mark_test_tool 工具，参数 input 的值为 diag123。只调用这个工具，不要做其他事情。");
  console.log("PROMPT DONE");
} catch (err) {
  console.error("PROMPT ERROR:", err);
}
console.log("marker exists:", (await import("node:fs")).existsSync(project.markerFile));
await runtime.stop();
