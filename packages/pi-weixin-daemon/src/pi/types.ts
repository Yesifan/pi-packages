/**
 * Domain types exposed by the Pi host layer.
 *
 * The business layer (projects/ / sessions/ / weixin/) only ever sees these
 * SDK-free shapes. Only `src/pi/` may import `@earendil-works/pi-coding-agent`
 * or `@earendil-works/pi-ai/compat`; the translation happens at this boundary.
 */

/** A domain image input (base64 payload + detected mime type). */
export interface HostImage {
  data: string;
  mimeType: string;
}

/** A domain prompt input for one agent turn. */
export interface HostPromptInput {
  text: string;
  images?: HostImage[];
}

/** Domain session status exposed to the business layer. */
export interface HostModelOption {
  provider: string;
  id: string;
  name: string;
}

export interface HostSessionOption {
  path: string;
  id: string;
  modifiedAt: number;
  firstMessage: string;
  name?: string;
}

export interface HostStatus {
  sessionFile: string | undefined;
  sessionId: string | undefined;
  cwd: string;
  model: string;
  thinkingLevel: string;
  /** Live project-trust decision (independent of the session). */
  configuredTrust: boolean;
  /** Trust snapshot locked when the session was created; undefined without a session. */
  activeSessionTrust: boolean | undefined;
}

/** Result of a session replacement (newSession / fork / switchSession). */
export interface SessionSwitchResult {
  cancelled: boolean;
}

/** Extension run mode (mirrors the SDK `ExtensionMode` union). */
export type HostExtensionMode = "tui" | "rpc" | "json" | "print";
