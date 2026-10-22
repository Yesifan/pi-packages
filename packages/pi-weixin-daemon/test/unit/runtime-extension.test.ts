import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createWeixinSendFileExtension,
  validateSendFileParams,
} from "../../src/pi/extensions/weixin-send-file.js";
import { createLogger } from "../../src/util/logger.js";
import { sanitizeFilename } from "../../src/util/sanitize.js";
import type { TurnContext } from "../../src/weixin/types.js";
import { FakeWeixinTransport, makeTurn } from "../helpers/fake-transport.js";
import { createTmpProject } from "../helpers/tmp-project.js";

describe("validateSendFileParams (W9: no path boundary)", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(process.cwd(), "test/.tmp", "path-validate-"));
  });

  it("accepts a regular file inside cwd", () => {
    const file = path.join(root, "ok.txt");
    fs.writeFileSync(file, "hi");
    const result = validateSendFileParams(file, root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(file);
      expect(result.basename).toBe("ok.txt");
    }
  });

  it("rejects a missing file", () => {
    const result = validateSendFileParams(path.join(root, "nope.txt"), root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("does not exist");
  });

  it("rejects a directory", () => {
    const dir = path.join(root, "subdir");
    fs.mkdirSync(dir);
    const result = validateSendFileParams(dir, root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not a regular file");
  });

  it("accepts a file outside cwd (permission model = agent process)", () => {
    const outside = path.join(root, "..", "outside.txt");
    fs.writeFileSync(outside, "secret");
    const result = validateSendFileParams(outside, root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolvedPath).toBe(path.resolve(outside));
  });

  it("resolves relative ../ paths against cwd without a boundary check", () => {
    const outside = path.join(root, "..", "outside.txt");
    fs.writeFileSync(outside, "secret");
    const result = validateSendFileParams("../outside.txt", root);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty basename after sanitization", () => {
    const file = path.join(root, " \u0001");
    fs.writeFileSync(file, "x");
    const result = validateSendFileParams(file, root);
    expect(result.ok).toBe(false);
  });
});

it("weixin_send_file reads the current turn at execution time and refuses an absent turn", async () => {
  const project = createTmpProject("send-file-unit");
  const transport = new FakeWeixinTransport();
  let currentTurn: TurnContext | undefined = makeTurn();
  type Execute = (
    id: string,
    params: { path: string; caption?: string },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
  let execute!: Execute;
  createWeixinSendFileExtension({
    fileSender: transport,
    getCurrentTurn: () => currentTurn,
    cwd: project.dir,
    logger: createLogger({ level: "silent" }),
  })({
    registerTool: (tool: { execute: Execute }) => {
      execute = tool.execute;
    },
  } as never);

  try {
    fs.writeFileSync(path.join(project.dir, "report.txt"), "report\n");
    const firstTurn = currentTurn;
    expect(await execute("call-1", { path: "report.txt", caption: "first" })).toEqual({
      content: [{ type: "text", text: 'Sent file "report.txt" to the Weixin conversation.' }],
      details: { basename: "report.txt", succeeded: 1, failed: 0 },
    });
    currentTurn = { ...makeTurn("acct-b", "user-b"), messageId: "m-2", contextToken: "tok-2" };
    expect((await execute("call-2", { path: "report.txt" })).details).toEqual({
      basename: "report.txt",
      succeeded: 1,
      failed: 0,
    });
    expect(transport.sentFiles).toEqual([
      { ctx: firstTurn, path: path.join(project.dir, "report.txt"), caption: "first" },
      { ctx: currentTurn, path: path.join(project.dir, "report.txt"), caption: undefined },
    ]);
    currentTurn = undefined;
    expect((await execute("call-3", { path: "report.txt" })).details).toEqual({
      error: "no active turn",
    });
    expect(transport.sentFiles).toHaveLength(2);
  } finally {
    project.cleanup();
  }
});

describe("sanitizeFilename", () => {
  it("strips control characters and path separators", () => {
    expect(sanitizeFilename("a\u0001b/c\\d.txt")).toBe("ab_c_d.txt");
  });
  it("trims whitespace", () => {
    expect(sanitizeFilename("  file.txt  ")).toBe("file.txt");
  });
});
