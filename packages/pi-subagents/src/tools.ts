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
import { formatDelegationStatus } from "./status.js";
import type {
  AcceptedResult,
  CallerBinding,
  DelegationStatusSnapshot,
  ErrorResult,
  ThinkingLevel,
} from "./types.js";

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
        "Absolute working directory for the subagent. Omit to use the caller's current cwd. When specified, it must exactly match the current cwd or one of the external cwd paths listed in this tool's description after canonical path resolution. Relative paths, ~, $HOME, and $" +
        "{HOME} are not accepted here.",
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
  getMaxLiveAgents(): number | undefined;
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

function statusContent(status: DelegationStatusSnapshot): Array<{
  type: "text";
  text: string;
}> {
  return [{ type: "text", text: formatDelegationStatus(status) }];
}

function completionGuidance(): string {
  return "Its report will arrive automatically. Do not poll, redo, or re-delegate its task. Until all relevant reports arrive, give only a brief progress update that identifies the active subagents, then end your turn.";
}

export function createDelegationExtension(
  runtime: DelegationRuntimeApi,
  caller: CallerBinding,
): ExtensionFactory {
  return (pi) => {
    const maxLiveAgents = runtime.getMaxLiveAgents();
    pi.registerTool(
      defineTool({
        name: "subagent",
        label: "Subagent",
        description: formatSubagentToolDescription(caller.delegation, maxLiveAgents),
        promptSnippet: "Create independent background subagents; parallel calls are allowed",
        parameters: subagentParameters,
        async execute(_toolCallId, params, signal, _onUpdate, ctx): Promise<ToolResult> {
          try {
            const result = await runtime.createSubagent(caller, params, ctx, signal);
            return {
              content: [
                {
                  type: "text",
                  text: `Started background subagent ${result.name} (${result.id}).`,
                },
                { type: "text", text: completionGuidance() },
                ...statusContent(result.delegation_status),
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
          "Give a new task to a directly owned idle subagent, or set isSteer to true to steer its active run. Normal asks run asynchronously and report back automatically. This is not a status or result-polling tool.",
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
                      ? `Steered background subagent ${result.name} (${result.id}).`
                      : `Started background subagent ${result.name} (${result.id}).`,
                },
                { type: "text", text: completionGuidance() },
                ...statusContent(result.delegation_status),
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
