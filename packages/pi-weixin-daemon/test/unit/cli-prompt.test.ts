import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promptCommand } from "../../src/cli/prompt.js";
import { rpcPrompt } from "../../src/cli/rpc-client.js";

vi.mock("../../src/cli/rpc-client.js", () => ({ rpcPrompt: vi.fn() }));
const originalExit = process.exitCode;
beforeEach(() => {
  vi.mocked(rpcPrompt)
    .mockReset()
    .mockResolvedValue({ status: "success", sessionId: "id", text: "answer" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExit;
});

const run = (args: string[]) =>
  promptCommand()
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .parseAsync(args, { from: "user" });

it("parses repeatable targets and session selection, and prints a structured result", async () => {
  await run([
    "hello",
    "--project",
    "foo",
    "--session",
    "abc",
    "--reply",
    "caller",
    "--reply",
    "user:all",
  ]);
  expect(rpcPrompt).toHaveBeenCalledWith({
    name: "foo",
    text: "hello",
    sessionId: "abc",
    newSession: undefined,
    reply: ["caller", "user:all"],
  });
  expect(console.log).toHaveBeenCalledWith(
    JSON.stringify({ status: "success", sessionId: "id", text: "answer" }),
  );
  expect(process.exitCode).toBe(0);
});

it("leaves reply unspecified for the default caller policy and returns interaction questions", async () => {
  vi.mocked(rpcPrompt).mockResolvedValue({
    status: "waiting",
    sessionId: "id",
    messages: ["question"],
  });
  await run(["hello", "--project", "foo"]);
  expect(rpcPrompt).toHaveBeenCalledWith(expect.objectContaining({ reply: undefined }));
  expect(process.exitCode).toBe(0);
});

it("rejects conflicting flags and blank or malformed inputs before RPC", async () => {
  await expect(
    run(["hello", "--project", "foo", "--session", "id", "--new-session"]),
  ).rejects.toThrow("cannot be used");
  for (const args of [
    [" ", "--project", "foo"],
    ["hello", "--project", " "],
    ["hello", "--project", "foo", "--reply", "bad"],
  ]) {
    await run(args);
    expect(process.exitCode).toBe(1);
  }
  expect(rpcPrompt).not.toHaveBeenCalled();
});

it.each([
  { status: "error" as const, error: "model failure" },
  { status: "aborted" as const },
  { status: "success" as const, delivery: { succeeded: 1, skipped: 1, failed: 0 } },
  { status: "success" as const, delivery: { succeeded: 0, skipped: 0, failed: 1 } },
])("returns a failing exit code for $status / incomplete delivery", async (result) => {
  vi.mocked(rpcPrompt).mockResolvedValue(result);
  await run(["hello", "--project", "foo"]);
  expect(process.exitCode).toBe(1);
});

it("reports an unavailable daemon without retry", async () => {
  vi.mocked(rpcPrompt).mockRejectedValue(new Error("Daemon is not running"));
  await run(["hello", "--project", "foo"]);
  expect(process.exitCode).toBe(1);
  expect(rpcPrompt).toHaveBeenCalledTimes(1);
});
