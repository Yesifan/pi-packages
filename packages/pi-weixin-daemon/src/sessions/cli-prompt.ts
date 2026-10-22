export interface CliPromptRequest {
  text: string;
  sessionId?: string;
  newSession?: boolean;
  reply?: string[];
}

export interface PromptDeliveryResult {
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface CliPromptResult {
  sessionId?: string;
  status: "success" | "error" | "aborted" | "waiting";
  /** Successful final text is included only when caller is selected. */
  text?: string;
  error?: string;
  messages?: string[];
  delivery?: PromptDeliveryResult;
}

/** Boundary validation runs before any session mutation, including UI answers. */
export function validateCliPrompt(request: CliPromptRequest): void {
  if (typeof request.text !== "string" || !request.text.trim())
    throw new Error("prompt text must not be blank");
  if (
    request.sessionId !== undefined &&
    (typeof request.sessionId !== "string" || !request.sessionId.trim())
  )
    throw new Error("session ID must not be blank");
  if (request.newSession !== undefined && typeof request.newSession !== "boolean")
    throw new Error("newSession must be boolean");
  if (request.newSession && request.sessionId !== undefined)
    throw new Error("--session and --new-session are mutually exclusive");
  if (
    request.reply !== undefined &&
    (!Array.isArray(request.reply) ||
      request.reply.length === 0 ||
      request.reply.some(
        (target) =>
          typeof target !== "string" || (target !== "caller" && !/^user:.+$/.test(target)),
      ))
  )
    throw new Error("reply must select caller, user:all or user:<id>");
}
