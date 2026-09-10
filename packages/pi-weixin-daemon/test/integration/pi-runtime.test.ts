import { describe, it, expect, afterEach } from "vitest";
import { getAgentDir, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { PiSdkHost } from "../../src/pi/sdk-host.js";
import { createLogger } from "../../src/util/logger.js";
import { createTmpProject, waitForMarker, type TmpProject } from "../helpers/tmp-project.js";

const logger = createLogger({ level: "warn" });

const TIMEOUT = 120_000;

async function promptAndExpectMarker(runtime: PiSdkHost, input: string, markerFile: string): Promise<string> {
  await runtime.prompt({
    text: `请调用 mark_test_tool 工具，参数 input 的值为 ${input}。只调用这个工具，不要做其他事情。`,
  });
  const marker = await waitForMarker(markerFile, TIMEOUT);
  expect(marker).toContain(`input=${input}`);
  return marker;
}

describe("M2: Pi SDK runtime integration (real SDK + real model)", () => {
  let project: TmpProject | undefined;
  const runtimes: PiSdkHost[] = [];

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      await r.stop().catch(() => {});
    }
  });

  it(
    "loads project .pi/extensions and executes its tool in a daemon-created session",
    async () => {
      project = createTmpProject("m2-ext-load");
      const runtime = new PiSdkHost({ cwd: project.dir, logger });
      runtimes.push(runtime);

      await runtime.start();

      // Lazy start: no session until the first prompt.
      expect(runtime.getStatus().sessionId).toBeUndefined();

      await promptAndExpectMarker(runtime, "hello123", project.markerFile);
      const status = runtime.getStatus();
      expect(status.sessionFile).toBeTruthy();
      expect(status.sessionId).toBeTruthy();
      expect(status.model).not.toBe("unknown");

      // Second prompt in the same session must still work (same bound session).
      await promptAndExpectMarker(runtime, "again456", project.markerFile);
    },
    TIMEOUT + 30_000,
  );

  it(
    "resolves project trust from the shared trust store (project scope honored)",
    async () => {
      project = createTmpProject("m2-trusted");
      const runtime = new PiSdkHost({ cwd: project.dir, logger });
      runtimes.push(runtime);

      await runtime.start();
      // The tmp project sits under the tested repo root, which is trusted.
      // Trust is resolved independently of the (lazy) session, so it is
      // visible even before the first prompt creates one.
      expect(runtime.getStatus().configuredTrust).toBe(true);
      // With trust, the project .pi/extensions tool is available (proves
      // project-scoped resources are loaded, not just the global defaults).
      await promptAndExpectMarker(runtime, "trusted789", project.markerFile);
      expect(runtime.getStatus().activeSessionTrust).toBe(true);
    },
    TIMEOUT + 30_000,
  );

  it(
    "withholds project-scoped resources when the project is explicitly untrusted",
    async () => {
      project = createTmpProject("m2-untrusted");
      // Force an explicit untrusted decision for this exact path (overrides
      // the trusted inheritance from the repo root).
      new ProjectTrustStore(getAgentDir()).set(project.dir, false);
      const runtime = new PiSdkHost({ cwd: project.dir, logger });
      runtimes.push(runtime);

      try {
        await runtime.start();
        // Lazy: no session yet, but trust is reported directly from the store.
        expect(runtime.getStatus().configuredTrust).toBe(false);
      } finally {
        // Restore the inherited trust state so later runs behave the same.
        new ProjectTrustStore(getAgentDir()).set(project.dir, null);
      }
    },
    TIMEOUT + 30_000,
  );

  it(
    "keeps project extension tools after newSession (session replacement + rebind)",
    async () => {
      project = createTmpProject("m2-new-session");
      const runtime = new PiSdkHost({ cwd: project.dir, logger });
      runtimes.push(runtime);

      await runtime.start();
      // First prompt creates the session lazily (no session before this).
      await promptAndExpectMarker(runtime, "first999", project.markerFile);
      const firstFile = runtime.getStatus().sessionFile;

      await runtime.newSession();
      const secondFile = runtime.getStatus().sessionFile;
      expect(secondFile).toBeTruthy();
      expect(secondFile).not.toBe(firstFile);

      await promptAndExpectMarker(runtime, "afternew789", project.markerFile);
    },
    TIMEOUT + 30_000,
  );
});
