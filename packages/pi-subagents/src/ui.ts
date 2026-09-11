import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";

type QueueItem<T> = {
  ownerId: string;
  fallback: T;
  controller: AbortController;
  run(signal: AbortSignal): Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
  cleanup(): void;
};

export class RootUiBroker {
  private queue: QueueItem<unknown>[] = [];
  private active?: QueueItem<unknown>;
  private closing = false;

  constructor(
    private readonly rootUi: ExtensionUIContext,
    private readonly hasUi: boolean,
    private readonly defaultTimeoutMs: number,
  ) {}

  proxy(agentId: string, name: string): SubagentUiProxy {
    return new SubagentUiProxy(this, this.rootUi, this.hasUi, agentId, name);
  }

  enqueue<T>(
    ownerId: string,
    fallback: T,
    options: ExtensionUIDialogOptions | undefined,
    run: (options: ExtensionUIDialogOptions) => Promise<T>,
  ): Promise<T> {
    if (this.closing || !this.hasUi) return Promise.resolve(fallback);
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const signals = [controller.signal, ...(options?.signal ? [options.signal] : [])];
      const signal = AbortSignal.any(signals);
      const onAbort = () => {
        controller.abort();
        settle(fallback);
      };
      const settle = (value: T) => {
        if (item.settled) return;
        item.settled = true;
        item.cleanup();
        resolve(value);
      };
      const item: QueueItem<T> = {
        ownerId,
        fallback,
        controller,
        settled: false,
        run: () =>
          run({
            signal,
            timeout: options?.timeout ?? this.defaultTimeoutMs,
          }),
        resolve: settle,
        reject: (error) => {
          if (item.settled) return;
          item.settled = true;
          item.cleanup();
          reject(error);
        },
        cleanup: () => options?.signal?.removeEventListener("abort", onAbort),
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      this.queue.push(item as QueueItem<unknown>);
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.active || this.closing) return;
    while (!this.active && this.queue.length > 0 && !this.closing) {
      const item = this.queue.shift();
      if (!item || item.settled) continue;
      this.active = item;
      try {
        const aborted = new Promise<unknown>((resolve) => {
          if (item.controller.signal.aborted) resolve(item.fallback);
          else
            item.controller.signal.addEventListener("abort", () => resolve(item.fallback), {
              once: true,
            });
        });
        item.resolve(await Promise.race([item.run(item.controller.signal), aborted]));
      } catch (error) {
        if (item.controller.signal.aborted) item.resolve(item.fallback);
        else item.reject(error);
      } finally {
        if (this.active === item) this.active = undefined;
      }
    }
  }

  cancelOwner(ownerId: string): void {
    for (const item of this.queue) {
      if (item.ownerId === ownerId) {
        item.controller.abort();
        item.resolve(item.fallback);
      }
    }
    if (this.active?.ownerId === ownerId) {
      this.active.controller.abort();
      this.active.resolve(this.active.fallback);
    }
  }

  shutdown(): void {
    this.closing = true;
    this.active?.controller.abort();
    if (this.active) this.active.resolve(this.active.fallback);
    for (const item of this.queue.splice(0)) {
      item.controller.abort();
      item.resolve(item.fallback);
    }
  }
}

export class SubagentUiProxy implements ExtensionUIContext {
  private readonly statusKeys = new Set<string>();

  constructor(
    private readonly broker: RootUiBroker,
    private readonly rootUi: ExtensionUIContext,
    private readonly hasUi: boolean,
    private readonly agentId: string,
    private readonly name: string,
  ) {}

  private title(title: string): string {
    return `[subagent: ${this.name} / ${this.agentId}] ${title}`;
  }

  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return this.broker.enqueue(this.agentId, undefined, opts, (effective) =>
      this.rootUi.select(this.title(title), options, effective),
    );
  }

  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.broker.enqueue(this.agentId, false, opts, (effective) =>
      this.rootUi.confirm(this.title(title), message, effective),
    );
  }

  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined> {
    return this.broker.enqueue(this.agentId, undefined, opts, (effective) =>
      this.rootUi.input(this.title(title), placeholder, effective),
    );
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    if (this.hasUi)
      this.rootUi.notify(`[subagent: ${this.name} / ${this.agentId}] ${message}`, type);
  }

  setStatus(key: string, text: string | undefined): void {
    const scoped = `pi-subagents:${this.agentId}:${key}`;
    if (text === undefined) this.statusKeys.delete(scoped);
    else this.statusKeys.add(scoped);
    this.rootUi.setStatus(scoped, text);
  }

  dispose(): void {
    this.broker.cancelOwner(this.agentId);
    for (const key of this.statusKeys) this.rootUi.setStatus(key, undefined);
    this.statusKeys.clear();
  }

  onTerminalInput(): () => void {
    return () => {};
  }
  setWorkingMessage(): void {}
  setWorkingVisible(): void {}
  setWorkingIndicator(): void {}
  setHiddenThinkingLabel(): void {}
  setWidget(_key: string, _content: never, _options?: never): void {}
  setFooter(): void {}
  setHeader(): void {}
  setTitle(): void {}
  custom<T>(): Promise<T> {
    return Promise.reject(new Error("Subagent UI custom components are not supported"));
  }
  pasteToEditor(): void {}
  setEditorText(): void {}
  getEditorText(): string {
    return "";
  }
  editor(): Promise<string | undefined> {
    return Promise.resolve(undefined);
  }
  addAutocompleteProvider(): void {}
  setEditorComponent(): void {}
  getEditorComponent(): never {
    return undefined as never;
  }
  get theme() {
    return this.rootUi.theme;
  }
  getAllThemes(): { name: string; path: string | undefined }[] {
    return this.rootUi.getAllThemes();
  }
  getTheme(name: string) {
    return this.rootUi.getTheme(name);
  }
  setTheme(): { success: boolean; error?: string } {
    return { success: false, error: "Subagents cannot change the root theme" };
  }
  getToolsExpanded(): boolean {
    return false;
  }
  setToolsExpanded(): void {}
}
