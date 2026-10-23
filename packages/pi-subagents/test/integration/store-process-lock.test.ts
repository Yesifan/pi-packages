import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { PersistentSubagentStore, sessionKey } from "../../src/store.js";
import { createHarness } from "../helpers/runtime-harness.js";

const workers: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async (worker) => {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }),
  );
});

async function processFixture() {
  const h = await createHarness();
  const directory = path.join(h.root, "process-fixture");
  await mkdir(directory);
  // Transpile the current sources, not possibly stale dist. No model or SDK session
  // runs in these workers; IPC is test control only, not a production request channel.
  const require = createRequire(import.meta.url);
  for (const name of ["store", "errors", "status"]) {
    const source = await readFile(
      fileURLToPath(new URL(`../../src/${name}.ts`, import.meta.url)),
      "utf8",
    );
    const output = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    await writeFile(
      path.join(directory, `${name}.js`),
      output.replace('"proper-lockfile"', JSON.stringify(require.resolve("proper-lockfile"))),
    );
  }
  await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
  const script = path.join(directory, "worker.js");
  await writeFile(
    script,
    `
import { PersistentSubagentStore } from "./store.js";
let store;
process.on("message", async ({ action, agentDir, identity }) => {
  try {
    if (action === "open") {
      store = new PersistentSubagentStore(agentDir, identity);
      await store.open();
    } else await store.close();
    process.send({ ok: true });
  } catch (error) { process.send({ code: error.code }); }
});
`,
  );
  const spawn = () => {
    const worker = fork(script, [], {
      execArgv: [],
      env: { ...process.env, PI_CODING_AGENT_DIR: h.agentDir },
    });
    workers.push(worker);
    return worker;
  };
  const command = async (
    worker: ChildProcess,
    action: "open" | "close",
    identity = h.scope.identity,
  ) => {
    const result = once(worker, "message");
    worker.send({ action, agentDir: h.agentDir, identity });
    return (await result)[0];
  };
  return { h, spawn, command };
}

describe("real process writer-lock exclusion and handoff", () => {
  it("admits only one simultaneous contender, fails without queueing, and allows both handoff directions", async () => {
    const { h, spawn, command } = await processFixture();
    const a = spawn();
    const b = spawn();
    const results = await Promise.all([command(a, "open"), command(b, "open")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.code === "ROOT_SCOPE_IN_USE")).toHaveLength(1);
    const [winner, loser] = results[0].ok ? [a, b] : [b, a];
    // A distinct exact root can progress while the first remains locked.
    const independent = new PersistentSubagentStore(h.agentDir, {
      ...h.scope.identity,
      sessionId: "other-root",
    });
    await independent.open();
    await independent.close();
    await command(winner, "close");
    expect(await command(loser, "open")).toEqual({ ok: true });
    expect(await command(winner, "open")).toEqual({ code: "ROOT_SCOPE_IN_USE" });
    await command(loser, "close");
    expect(await command(winner, "open")).toEqual({ ok: true });
    await command(winner, "close");
  });

  it("does not break a live lock, and reclaims only an expired crashed writer lock", async () => {
    const { h, spawn, command } = await processFixture();
    const writer = spawn();
    const contender = spawn();
    expect(await command(writer, "open")).toEqual({ ok: true });
    expect(await command(contender, "open")).toEqual({ code: "ROOT_SCOPE_IN_USE" });
    const exited = once(writer, "exit");
    writer.kill("SIGKILL");
    await exited;
    expect(await command(contender, "open")).toEqual({ code: "ROOT_SCOPE_IN_USE" });
    // Simulate elapsed stale time only after the writer is provably dead.
    const old = new Date(Date.now() - 60_000);
    await utimes(
      path.join(h.agentDir, "subagents", "locks", sessionKey(h.scope.identity), ".writer"),
      old,
      old,
    );
    expect(await command(contender, "open")).toEqual({ ok: true });
    await command(contender, "close");
  });
});
