import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatSubagentToolDescription } from "./delegation.js";
import { errorToolResult } from "./errors.js";
import type { AcceptedResult, CallerBinding, ErrorResult, ThinkingLevel } from "./types.js";

const thinkingSchema = StringEnum(
  ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
  { description: "Thinking level for this subagent." },
);

const subagentParameters = Type.Object({
  name: Type.String({ minLength: 1, description: "Display name for the subagent." }),
  prompt: Type.String({ minLength: 1, description: "Task for the subagent." }),
  agent_type: Type.Optional(
    Type.String({
      description:
        'Agent type for this subagent. Defaults to "general". Must be one of the agent types listed in this tool\'s description. ',
    }),
  ),
  thinking: Type.Optional(thinkingSchema),
  cwd: Type.Optional(
    Type.String({
      description:
        "Absolute working directory for the subagent. Omit to use the caller's current cwd. When specified, it must exactly match one of the external cwd paths listed in this tool's description after canonical path resolution. ",
    }),
  ),
});

const askParameters = Type.Object({
  id: Type.String({ minLength: 1, description: "ID of a directly owned subagent." }),
  prompt: Type.String({ minLength: 1, description: "New task or steering input." }),
  isSteer: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "When true, steer the currently executing run instead of creating a new run. The target must be actively streaming.",
    }),
  ),
});

export interface DelegationRuntimeApi {
  createSubagent(
    caller: CallerBinding,
    input: {
      name: string;
      prompt: string;
      agent_type?: string;
      thinking?: ThinkingLevel;
      cwd?: string;
    },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<AcceptedResult>;
  askSubagent(
    caller: CallerBinding,
    input: { id: string; prompt: string; isSteer?: boolean },
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ): Promise<AcceptedResult>;
}

type ToolResult = AgentToolResult<AcceptedResult | ErrorResult>;

export function createDelegationExtension(
  runtime: DelegationRuntimeApi,
  caller: CallerBinding,
): ExtensionFactory {
  return (pi) => {
    pi.registerTool(
      defineTool({
        name: "subagent",
        label: "Subagent",
        description: formatSubagentToolDescription(caller.delegation),
        promptSnippet: "Create a background subagent for delegated work",
        parameters: subagentParameters,
        async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult> {
          try {
            const result = await runtime.createSubagent(caller, params, ctx, signal);
            return {
              content: [
                {
                  type: "text",
                  text: `Started subagent ${result.name} (${result.id}), run ${result.run_id}. Its final report will arrive automatically; do not poll with ask_subagent or shell wait commands. Continue only with independent work, or end your turn.`,
                },
              ],
              details: result,
            };
          } catch (error) {
            return errorToolResult(error);
          }
        },
      }),
    );

    pi.registerTool(
      defineTool({
        name: "ask_subagent",
        label: "Ask Subagent",
        description:
          "Give a new task to a directly owned idle subagent. Set isSteer to true only to steer a directly owned actively executing run.",
        promptSnippet: "Ask an idle subagent again or steer its active run",
        parameters: askParameters,
        async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult> {
          try {
            const result = await runtime.askSubagent(caller, params, ctx, signal);
            return {
              content: [
                {
                  type: "text",
                  text:
                    result.status === "steered"
                      ? `Steered subagent ${result.name} (${result.id}), current run ${result.run_id}. Its final report will arrive automatically; only steer again to provide a substantive correction, not to poll or request completion.`
                      : `Started subagent ${result.name} (${result.id}), run ${result.run_id}. Its final report will arrive automatically; do not poll with ask_subagent or shell wait commands. Continue only with independent work, or end your turn.`,
                },
              ],
              details: result,
            };
          } catch (error) {
            return errorToolResult(error);
          }
        },
      }),
    );
  };
}
