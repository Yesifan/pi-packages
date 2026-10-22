import fs from "node:fs";
import path from "node:path";
import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectTrust } from "../../src/pi/project-trust.js";
import { createPiRuntimeFactory } from "../../src/pi/runtime-factory.js";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { persistSessionIdentity } from "../../src/pi/session-persistence.js";
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

vi.mock("../../src/pi/extension-host.js", () => ({
  PiExtensionHost: class {
    async bind() {}
  },
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

describe("daemon SDK adapter", () => {
  it.each(["delete", "replace-cwd", "replace-id", "cancel", "append"] as const)(
    "validates the SDK's actual reopened target after before-switch hooks: %s",
    async (change) => {
      const actual = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>(
        "@earendil-works/pi-coding-agent",
      );
      sdk.createRuntime.mockImplementation(actual.createAgentSessionRuntime);
      sdk.createServices.mockImplementation(async (options) => ({
        ...services,
        cwd: options.cwd,
        agentDir: options.agentDir,
      }));
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const dispose = vi.fn();
      sdk.createSession.mockImplementation(async ({ sessionManager }) => ({
        session: {
          sessionManager,
          sessionId: sessionManager.getSessionId(),
          sessionFile: sessionManager.getSessionFile(),
          settingsManager: { isProjectTrusted: () => false },
          subscribe: () => () => {},
          abort: async () => {},
          dispose,
          extensionRunner: {
            hasHandlers: (event: string) => event === "session_before_switch",
            emit: async () => {
              enter();
              await blocked;
              return { cancel: change === "cancel" };
            },
          },
        },
      }));
      const target = SessionManager.create(project.dir);
      persistSessionIdentity(target);
      const targetFile = target.getSessionFile()!;
      const host = new PiSdkHost({ cwd: project.dir, logger });
      try {
        await host.ensureSession();
        const originalId = host.getStatus().sessionId;
        const pending = host.resumeSession(targetFile);
        await entered;
        if (change === "delete" || change === "cancel") fs.unlinkSync(targetFile);
        else if (change === "replace-cwd") {
          const foreignCwd = path.join(project.dir, "foreign");
          fs.mkdirSync(foreignCwd);
          fs.writeFileSync(
            targetFile,
            `${JSON.stringify({ ...target.getHeader(), cwd: foreignCwd })}\n`,
          );
        } else if (change === "replace-id") {
          const other = SessionManager.create(project.dir);
          fs.writeFileSync(targetFile, `${JSON.stringify(other.getHeader())}\n`);
        } else target.appendSessionInfo("updated during hook");
        release();
        if (change === "cancel") {
          await expect(pending).resolves.toEqual({ cancelled: true });
          expect(host.getStatus().sessionId).toBe(originalId);
          expect(dispose).not.toHaveBeenCalled();
        } else if (change === "append") {
          await expect(pending).resolves.toEqual({ cancelled: false });
          expect(host.getStatus().sessionId).toBe(target.getSessionId());
          expect(sdk.createSession.mock.calls.at(-1)![0].sessionManager.getSessionName()).toBe(
            "updated during hook",
          );
        } else {
          await expect(pending).rejects.toThrow("changed during recovery");
          expect(host.hasSession()).toBe(false);
          expect(sdk.createServices).toHaveBeenCalledTimes(1);
          expect(sdk.createSession).toHaveBeenCalledTimes(1);
          expect(dispose).toHaveBeenCalled();
          if (change === "delete") expect(fs.existsSync(targetFile)).toBe(false);
        }
      } finally {
        release();
        await host.stop();
      }
    },
  );
  it("filters colliding session directories by header cwd and refuses foreign recovery", async () => {
    const first = path.join(project.dir, "a", "b");
    const second = path.join(project.dir, "a-b");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second);
    const own = SessionManager.create(first);
    const foreign = SessionManager.create(second);
    expect(own.getSessionDir()).toBe(foreign.getSessionDir());
    persistSessionIdentity(own);
    persistSessionIdentity(foreign);
    const host = new PiSdkHost({ cwd: first, logger });
    expect((await host.listSessions()).map((session) => session.id)).toEqual([own.getSessionId()]);
    await expect(host.resumeSession(foreign.getSessionFile()!)).rejects.toThrow("does not exist");
    vi.spyOn(host, "listSessions").mockResolvedValue([
      {
        id: foreign.getSessionId(),
        path: foreign.getSessionFile()!,
        firstMessage: "",
        modifiedAt: 0,
      },
    ]);
    await expect(host.resumeSession(foreign.getSessionFile()!)).rejects.toThrow("does not belong");
    expect(sdk.createRuntime).not.toHaveBeenCalled();
  });

  it("disposes a locally created runtime when initial persistence fails before publication", async () => {
    sdk.createRuntime.mockImplementation(async (_factory, options) => ({
      diagnostics: [],
      session: { sessionManager: options.sessionManager },
      setRebindSession: vi.fn(),
      dispose: sdk.dispose,
    }));
    const host = new PiSdkHost({ cwd: project.dir, logger });
    const write = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      await expect(host.ensureSession()).rejects.toThrow("disk full");
      expect(sdk.dispose).toHaveBeenCalledOnce();
      expect(host.hasSession()).toBe(false);
      await host.stop();
      expect(sdk.dispose).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it("clears stale session references and disposes runtime after SDK replacement fails", async () => {
    const previous = SessionManager.create(project.dir);
    const target = SessionManager.create(project.dir);
    persistSessionIdentity(target);
    const unsubscribe = vi.fn();
    sdk.createRuntime.mockResolvedValue({
      diagnostics: [],
      session: {
        sessionManager: previous,
        sessionId: previous.getSessionId(),
        sessionFile: previous.getSessionFile(),
        subscribe: () => unsubscribe,
      },
      setRebindSession: vi.fn(),
      switchSession: vi.fn().mockRejectedValue(new Error("failed after old session disposal")),
      dispose: sdk.dispose,
    });
    const host = new PiSdkHost({ cwd: project.dir, logger });
    await host.ensureSession();
    await expect(host.resumeSession(target.getSessionFile()!)).rejects.toThrow(
      "old session disposal",
    );
    expect(host.hasSession()).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(sdk.dispose).toHaveBeenCalledOnce();
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
