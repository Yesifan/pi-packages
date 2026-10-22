import type {
  AgentSession,
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectTrust } from "../../src/pi/project-trust.js";
import { createPiRuntimeFactory } from "../../src/pi/runtime-factory.js";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { createLogger } from "../../src/util/logger.js";
import { createTmpProject, type TmpProject } from "../helpers/tmp-project.js";

const sdk = vi.hoisted(() => ({
  createServices: vi.fn(),
  createSession: vi.fn(),
  createRuntime: vi.fn(),
  hasResources: vi.fn(),
  savedTrust: vi.fn(),
  defaultTrust: vi.fn(),
  createSettings: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
  createAgentSessionServices: sdk.createServices,
  createAgentSessionFromServices: sdk.createSession,
  createAgentSessionRuntime: sdk.createRuntime,
  hasTrustRequiringProjectResources: sdk.hasResources,
  ProjectTrustStore: class {
    get = sdk.savedTrust;
  },
  SettingsManager: { create: sdk.createSettings },
}));

// These are SDK return values, not a fake implementation of SDK trust/discovery.
const settings = { getDefaultProjectTrust: sdk.defaultTrust, drainErrors: vi.fn() };
const extensions = { errors: [] as Array<{ path: string; error: string }> };
const services = {
  diagnostics: [] as Array<{ type: "error" | "warning"; message: string }>,
  settingsManager: settings,
  resourceLoader: { getExtensions: () => extensions },
};
const logger = createLogger({ level: "silent" });
let project: TmpProject;

beforeEach(() => {
  vi.resetAllMocks();
  project = createTmpProject("host-adapter");
  services.diagnostics = [];
  extensions.errors = [];
  sdk.hasResources.mockReturnValue(true);
  sdk.savedTrust.mockReturnValue(null);
  sdk.defaultTrust.mockReturnValue("ask");
  settings.drainErrors.mockReturnValue([]);
  sdk.createSettings.mockReturnValue(settings);
  sdk.createServices.mockResolvedValue(services);
  sdk.createSession.mockResolvedValue({ session: {} });
  sdk.dispose.mockResolvedValue(undefined);
});

afterEach(() => project.cleanup());

function mockPromptSession() {
  return {
    prompt: vi.fn<AgentSession["prompt"]>().mockResolvedValue(undefined),
    bindExtensions: vi.fn<AgentSession["bindExtensions"]>().mockResolvedValue(undefined),
    subscribe: vi.fn<AgentSession["subscribe"]>().mockReturnValue(vi.fn()),
  };
}

function createPromptHost() {
  const session = mockPromptSession();
  const runtime = {
    session,
    diagnostics: [],
    setRebindSession: vi.fn<AgentSessionRuntime["setRebindSession"]>(),
    newSession: vi.fn<AgentSessionRuntime["newSession"]>(),
    dispose: sdk.dispose,
  };
  sdk.createRuntime.mockResolvedValue(runtime);
  return { host: new PiSdkHost({ cwd: project.dir, logger }), runtime, session };
}

describe("daemon SDK adapter", () => {
  it.each([
    { label: "no images", input: { text: "hello" }, options: undefined },
    { label: "empty images", input: { text: "hello", images: [] }, options: undefined },
    {
      label: "multiple images",
      input: {
        text: "hello",
        images: [
          { data: "first", mimeType: "image/png" },
          { data: "second", mimeType: "image/jpeg" },
        ],
      },
      options: {
        images: [
          { type: "image", data: "first", mimeType: "image/png" },
          { type: "image", data: "second", mimeType: "image/jpeg" },
        ],
      },
    },
  ])("forwards a prompt with $label through the lazy host", async ({ input, options }) => {
    const { host, session } = createPromptHost();
    try {
      await host.start();
      expect(sdk.createRuntime).not.toHaveBeenCalled();
      await host.prompt(input);
      expect(sdk.createRuntime).toHaveBeenCalledOnce();
      expect(session.prompt).toHaveBeenCalledExactlyOnceWith("hello", options);
    } finally {
      await host.stop();
    }
  });

  it("propagates the original SDK prompt rejection", async () => {
    const { host, session } = createPromptHost();
    const error = new Error("prompt rejected");
    session.prompt.mockRejectedValue(error);
    try {
      await expect(host.prompt({ text: "hello" })).rejects.toBe(error);
    } finally {
      await host.stop();
    }
  });

  it("prompts the replacement session rather than the original session", async () => {
    const { host, runtime, session } = createPromptHost();
    const replacement = mockPromptSession();
    runtime.newSession.mockImplementation(async () => {
      runtime.session = replacement;
      const rebind = runtime.setRebindSession.mock.calls[0]![0]!;
      await rebind(replacement as unknown as AgentSession);
      return { cancelled: false };
    });
    try {
      await host.prompt({ text: "before" });
      await expect(host.newSession()).resolves.toEqual({ cancelled: false });
      await host.prompt({ text: "after" });
      expect(sdk.createRuntime).toHaveBeenCalledOnce();
      expect(session.prompt).toHaveBeenCalledExactlyOnceWith("before", undefined);
      expect(replacement.prompt).toHaveBeenCalledExactlyOnceWith("after", undefined);
      expect(replacement.bindExtensions).toHaveBeenCalledOnce();
    } finally {
      await host.stop();
    }
  });

  it("uses the factory's effective cwd and forwards injected extensions and trust policy", async () => {
    const extension = vi.fn();
    settings.drainErrors.mockReturnValue([
      { scope: "project", error: new Error("settings warning") },
    ]);
    const factory = createPiRuntimeFactory({ cwd: "/original", extensionFactories: [extension] });
    // No actual session is created: this is only the factory's forwarding contract.
    const sessionManager = {} as Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionManager"];
    const sessionStartEvent = { type: "session_start", reason: "new" } as const;
    const result = await factory({
      cwd: project.dir,
      agentDir: process.env.PI_CODING_AGENT_DIR!,
      sessionManager,
      sessionStartEvent,
    });
    expect(sdk.createSettings).toHaveBeenCalledWith(project.dir, process.env.PI_CODING_AGENT_DIR);
    expect(sdk.createServices).toHaveBeenCalledWith({
      cwd: project.dir,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: settings,
      resourceLoaderOptions: { extensionFactories: [extension] },
      resourceLoaderReloadOptions: { resolveProjectTrust: expect.any(Function) },
    });
    await expect(
      sdk.createServices.mock.calls[0]![0].resourceLoaderReloadOptions.resolveProjectTrust(),
    ).resolves.toBe(false);
    expect(sdk.savedTrust).toHaveBeenCalledWith(project.dir);
    expect(sdk.createSession).toHaveBeenCalledWith({ services, sessionManager, sessionStartEvent });
    expect(result.diagnostics).toEqual([
      { type: "warning", message: "settings error (project): settings warning" },
    ]);
  });

  it.each(["services", "extensions"])("fails closed on fatal %s diagnostics", async (source) => {
    if (source === "services") services.diagnostics = [{ type: "error", message: "fatal service" }];
    else extensions.errors = [{ path: "injected-extension", error: "fatal extension" }];
    sdk.createRuntime.mockImplementation(
      async (factory: CreateAgentSessionRuntimeFactory, options) => {
        const result = await factory(options);
        return { ...result, dispose: sdk.dispose } as unknown as AgentSessionRuntime;
      },
    );
    const host = new PiSdkHost({ cwd: project.dir, logger });
    await host.start();
    expect(sdk.createRuntime).not.toHaveBeenCalled();
    await expect(host.ensureSession()).rejects.toMatchObject({
      name: "PiInitializationError",
      message: expect.stringContaining("fatal"),
    });
    expect(sdk.dispose).toHaveBeenCalledOnce();
    expect(host.hasSession()).toBe(false);
    await host.stop();
  });

  it("prioritizes saved SDK trust decisions; only always is a trusted fallback", () => {
    for (const [saved, fallback, expected] of [
      [true, "never", true],
      [false, "always", false],
      [null, "always", true],
      [null, "ask", false],
      [null, "never", false],
    ] as const) {
      sdk.savedTrust.mockReturnValue(saved);
      sdk.defaultTrust.mockReturnValue(fallback);
      sdk.createSettings.mockClear();
      expect(resolveProjectTrust(project.dir, process.env.PI_CODING_AGENT_DIR!)).toBe(expected);
      expect(sdk.createSettings).toHaveBeenCalledTimes(saved === null ? 1 : 0);
    }
    sdk.hasResources.mockReturnValue(false);
    sdk.savedTrust.mockClear();
    expect(resolveProjectTrust(project.dir, process.env.PI_CODING_AGENT_DIR!)).toBe(true);
    expect(sdk.savedTrust).not.toHaveBeenCalled();
  });
});
