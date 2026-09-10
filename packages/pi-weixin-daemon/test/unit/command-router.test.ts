import { describe, expect, it } from "vitest";
import { CommandRouter } from "../../src/projects/command-router.js";
import { helpText } from "../../src/sessions/commands.js";

const router = new CommandRouter();

describe("CommandRouter classifier", () => {
  it("classifies daemon commands and preserves arguments", () => {
    for (const cmd of ["help", "status", "abort", "new", "compact", "model", "thinking", "resume", "reload"]) {
      expect(router.classify(`/${cmd}`)).toEqual({ kind: "daemon-command", command: cmd, args: "" });
    }
    expect(router.classify("/help model")).toEqual({ kind: "daemon-command", command: "help", args: "model" });
    expect(router.classify("/resume latest")).toEqual({ kind: "daemon-command", command: "resume", args: "latest" });
  });

  it("formats full help as a Markdown list", () => {
    const help = helpText();
    expect(help).toContain("**可用命令**\n- `/model`");
    expect(help).toContain("\n- `/thinking`");
  });

  it("classifies explicit /p: input as a prompt", () => {
    expect(router.classify("/p:/model fake")).toEqual({ kind: "prompt", text: "/model fake" });
  });

  it("keeps unknown slash input out of Pi", () => {
    expect(router.classify("/bar")).toEqual({ kind: "unknown-command", text: "bar" });
  });

  it("classifies ordinary input as a message", () => {
    expect(router.classify("hello")).toEqual({ kind: "message", text: "hello" });
    expect(router.classify("/STATUS")).toEqual({ kind: "daemon-command", command: "status", args: "" });
  });
});
