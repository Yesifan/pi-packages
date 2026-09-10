import { Theme, type ExtensionUIContext, type ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../util/logger.js";
import type { InteractionPort } from "./ports.js";

export interface WeixinUIContextDeps {
  /** Bridges the dialog promise to the weixin message stream + busy state. */
  interaction: InteractionPort;
  logger: Logger;
}

function parseConfirm(answer: string): boolean {
  const t = answer.trim().toLowerCase();
  if (/^(1|是|确定|确认|yes|y|true|ok)$/.test(t)) return true;
  if (/^(2|否|取消|no|n|false|cancel)$/.test(t)) return false;
  // Anything else counts as confirmation? No: default to cancel for safety.
  return false;
}

function parseSelect(answer: string, options: string[]): string | undefined {
  const t = answer.trim();
  const num = Number(t);
  if (Number.isInteger(num) && num >= 1 && num <= options.length) {
    return options[num - 1];
  }
  const exact = options.find((o) => o === t);
  if (exact) return exact;
  return options.find((o) => o.includes(t) || t.includes(o));
}

/** Options that read as an approval/denial, so the ack can state the ask result. */
const APPROVE_SELECTS = new Set(["yes", "yes, for this session", "是", "确认", "允许", "同意"]);
const DENY_SELECTS = new Set(["no", "no, provide reason", "否", "取消", "拒绝"]);

/** Human summary of what the user picked, used to tell them the ask outcome. */
function describeSelectResult(selected: string | undefined, answer: string): string {
  if (selected === undefined) {
    return `⚠️ 无法识别你的回复「${answer}」，请重新回复选项编号或内容。`;
  }
  const key = selected.toLowerCase();
  if (APPROVE_SELECTS.has(key)) return `✅ 已允许：${selected}`;
  if (DENY_SELECTS.has(key)) return `❌ 已拒绝：${selected}`;
  return `✅ 已收到你的选择：${selected}`;
}

/**
 * Default dialog timeout (ms) when the caller supplies none. Env-configurable via
 * `PI_WEIXIN_UI_TIMEOUT_MS`. When a dialog (e.g. a permission ask) gets no reply
 * in time, we auto-deny/cancel rather than let the turn hang indefinitely.
 */
export const DEFAULT_UI_TIMEOUT_MS = parseUiTimeoutEnv();

function parseUiTimeoutEnv(): number {
  const raw = process.env.PI_WEIXIN_UI_TIMEOUT_MS;
  if (!raw) return 5 * 60 * 1000; // 5 minutes by default
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 5 * 60 * 1000;
}

/** True when the dialog wait was abandoned purely because the user didn't answer. */
function isUiTimeoutError(err: unknown): boolean {
  return err instanceof Error && /timed out|timeout/i.test(err.message);
}

/**
 * ExtensionUIContext implemented over weixin DMs (ADR-0003 D-E).
 *
 * - confirm/select/input: send the dialog to the current turn's account,
 *   enter UI-waiting, resolve with the user's next ordinary message.
 * - notify: fire-and-forget text message.
 * - editor: degraded to the input dialog (prefill hint + next message).
 * - custom: resolves undefined (never rejects) — unsupported over weixin.
 * - All remaining terminal/TUI primitives are no-ops that never throw.
 * - theme: real minimal `Theme` instance (never `{} as Theme`).
 */
export class WeixinUIContext implements ExtensionUIContext {
  constructor(private readonly deps: WeixinUIContextDeps) {}

  private requireTurn() {
    const turn = this.deps.interaction.getCurrentTurn();
    if (!turn) throw new Error("no active turn for weixin UI interaction");
    return turn;
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    const turn = this.requireTurn();
    await this.deps.interaction.sendText(
      turn,
      `🔔 ${title}\n\n${message}\n\n请回复：\n1. 确认\n2. 取消`,
    );
    this.deps.interaction.beginUiInteraction();
    let answer: string;
    try {
      answer = await this.waitForUiAnswer(turn, opts);
    } catch (err) {
      // Timeout is the only auto-cancel; anything else (abort/cancelUiWaiters)
      // still propagates so the turn teardown behaves as before.
      if (isUiTimeoutError(err)) {
        await this.ack(turn, "⏱️ 超时未收到回复，已自动取消。");
        return false;
      }
      throw err;
    } finally {
      this.deps.interaction.endUiInteraction();
    }
    const confirmed = parseConfirm(answer);
    await this.ack(turn, confirmed ? "✅ 已确认。" : "❌ 已取消。");
    return confirmed;
  }

  async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const turn = this.requireTurn();
    const list = options.map((o, i) => `${i + 1}. ${o}`).join("\n");
    await this.deps.interaction.sendText(turn, `🔔 ${title}\n\n${list}\n\n请回复选项编号或内容。`);
    this.deps.interaction.beginUiInteraction();
    let answer: string;
    try {
      answer = await this.waitForUiAnswer(turn, opts);
    } catch (err) {
      // Timeout -> auto-deny (the permission gate reads undefined as a denial).
      if (isUiTimeoutError(err)) {
        await this.ack(turn, "⏱️ 超时未收到回复，已自动拒绝。");
        return undefined;
      }
      throw err;
    } finally {
      this.deps.interaction.endUiInteraction();
    }
    const selected = parseSelect(answer, options);
    await this.ack(turn, describeSelectResult(selected, answer));
    return selected;
  }

  async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    const turn = this.requireTurn();
    const hint = placeholder ? `\n\n（例如：${placeholder}）` : "";
    await this.deps.interaction.sendText(turn, `⌨️ ${title}${hint}\n\n请直接回复内容。`);
    this.deps.interaction.beginUiInteraction();
    let answer: string;
    try {
      answer = await this.waitForUiAnswer(turn, opts);
    } catch (err) {
      if (isUiTimeoutError(err)) {
        await this.ack(turn, "⏱️ 超时未收到回复，已取消。");
        return undefined;
      }
      throw err;
    } finally {
      this.deps.interaction.endUiInteraction();
    }
    await this.ack(turn, `✅ 已收到：${answer}`);
    return answer;
  }

  /**
   * Apply the effective timeout before handing control to the interaction port.
   * The SDK's `ExtensionUIDialogOptions.timeout` (ms) is the caller's value; when
   * absent we fall back to {@link DEFAULT_UI_TIMEOUT_MS}.
   */
  private async waitForUiAnswer(turn: Parameters<InteractionPort["waitForResponse"]>[0], opts?: ExtensionUIDialogOptions): Promise<string> {
    const timeoutMs = opts?.timeout ?? DEFAULT_UI_TIMEOUT_MS;
    return this.deps.interaction.waitForResponse(turn, { timeoutMs, signal: opts?.signal });
  }

  /** Best-effort ack message to the user; a failed ack never breaks the dialog. */
  private async ack(turn: Parameters<InteractionPort["sendText"]>[0], text: string): Promise<void> {
    try {
      await this.deps.interaction.sendText(turn, text);
    } catch (err) {
      this.deps.logger.warn({ err }, "ui ack send failed");
    }
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    const turn = this.deps.interaction.getCurrentTurn();
    if (!turn) return;
    const icon = type === "error" ? "❌" : type === "warning" ? "⚠️" : "ℹ️";
    void this.deps.interaction
      .sendText(turn, `${icon} ${message}`)
      .catch((err: unknown) => this.deps.logger.warn({ err }, "notify send failed"));
  }

  // --- TUI-only primitives: no-ops over weixin (never throw) ---
  // Parameters use loose types on purpose: these are inert stubs for an
  // interface whose TUI types are not exported from the SDK root.

  onTerminalInput(_handler: never): () => void {
    return () => {};
  }
  setStatus(_key: string, _text: string | undefined): void {}
  setWorkingMessage(_message?: string): void {}
  setWorkingVisible(_visible: boolean): void {}
  setWorkingIndicator(_options?: never): void {}
  setHiddenThinkingLabel(_label?: string): void {}
  setWidget(_key: string, _content: never, _options?: never): void {}
  setFooter(_factory: never): void {}
  setHeader(_factory: never): void {}
  setTitle(_title: string): void {}

  /** Unsupported over weixin: resolve undefined (never reject), per D-E. */
  custom<T>(_factory: never, _options?: never): Promise<T> {
    return Promise.resolve(undefined as T);
  }

  pasteToEditor(_text: string): void {}
  setEditorText(_text: string): void {}
  getEditorText(): string {
    return "";
  }

  /** Degraded editor: same as the input dialog (prefill hint + next message). */
  editor(title: string, prefill?: string): Promise<string | undefined> {
    return this.input(title, prefill);
  }

  addAutocompleteProvider(_factory: never): void {}
  setEditorComponent(_factory: never): void {}
  getEditorComponent(): never {
    return undefined as never;
  }
  readonly theme = createMinimalTheme();
  getAllThemes(): { name: string; path: string | undefined }[] {
    return [];
  }
  getTheme(_name: string): Theme | undefined {
    return undefined;
  }
  setTheme(_theme: string | Theme): { success: boolean; error?: string } {
    return { success: false, error: "theme switching is not supported by the weixin UI context" };
  }
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(_expanded: boolean): void {}
}

// A real `Theme` instance with all-reset colors: valid, styleable no-op theme.
// Never `{} as Theme` (D-E: extensions may safely read `ctx.ui.theme`).
type ThemeCtor = ConstructorParameters<typeof Theme>;

const MINIMAL_FG: ThemeCtor[0] = {
  accent: "",
  border: "",
  borderAccent: "",
  borderMuted: "",
  success: "",
  error: "",
  warning: "",
  muted: "",
  dim: "",
  text: "",
  thinkingText: "",
  userMessageText: "",
  customMessageText: "",
  customMessageLabel: "",
  toolTitle: "",
  toolOutput: "",
  mdHeading: "",
  mdLink: "",
  mdLinkUrl: "",
  mdCode: "",
  mdCodeBlock: "",
  mdCodeBlockBorder: "",
  mdQuote: "",
  mdQuoteBorder: "",
  mdHr: "",
  mdListBullet: "",
  toolDiffAdded: "",
  toolDiffRemoved: "",
  toolDiffContext: "",
  syntaxComment: "",
  syntaxKeyword: "",
  syntaxFunction: "",
  syntaxVariable: "",
  syntaxString: "",
  syntaxNumber: "",
  syntaxType: "",
  syntaxOperator: "",
  syntaxPunctuation: "",
  thinkingOff: "",
  thinkingMinimal: "",
  thinkingLow: "",
  thinkingMedium: "",
  thinkingHigh: "",
  thinkingXhigh: "",
  bashMode: "",
};

const MINIMAL_BG: ThemeCtor[1] = {
  selectedBg: "",
  userMessageBg: "",
  customMessageBg: "",
  toolPendingBg: "",
  toolSuccessBg: "",
  toolErrorBg: "",
};

let minimalTheme: Theme | undefined;
function createMinimalTheme(): Theme {
  if (!minimalTheme) {
    minimalTheme = new Theme(MINIMAL_FG, MINIMAL_BG, "truecolor", { name: "pi-wx" });
  }
  return minimalTheme;
}
