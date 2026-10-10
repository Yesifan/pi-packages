import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChildRecord,
  type ParentSessionRecord,
  PersistentSubagentStore,
  type SessionIdentity,
  sessionKey,
} from "../../src/store.js";

const temporaryDirectories: string[] = [];
const stores: PersistentSubagentStore[] = [];
const execute = promisify(execFile);

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagents-store-"));
  temporaryDirectories.push(directory);
  const agentDir = path.join(directory, "agent");
  await mkdir(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const root = { sessionId: "root", sessionFile: path.join(directory, "root.jsonl") };
  const store = createStore(agentDir, root);
  return { directory, agentDir, root, store };
}

function createStore(agentDir: string, root: SessionIdentity): PersistentSubagentStore {
  const store = new PersistentSubagentStore(agentDir, root);
  stores.push(store);
  return store;
}

function child(directory: string, sessionId = "child", state: ChildRecord["state"] = "opening") {
  return {
    sessionId,
    sessionFile: path.join(directory, `${sessionId}.jsonl`),
    roleSnapshot: {
      id: "general",
      prompt: "saved role prompt",
      description: "role description",
      source: "/agents/general.md",
      contentHash: "saved-hash",
      thinking: "medium",
      disallowedTools: ["write"],
    },
    state,
  } satisfies ChildRecord;
}

function ownerFile(agentDir: string, owner: SessionIdentity): string {
  return path.join(agentDir, "subagents", "sessions", `${sessionKey(owner)}.json`);
}

async function diskRecord(agentDir: string, owner: SessionIdentity): Promise<ParentSessionRecord> {
  return JSON.parse(await readFile(ownerFile(agentDir, owner), "utf8"));
}

function childOf(record: ParentSessionRecord, name: string): ChildRecord {
  const child = record.children[name];
  if (!child) throw new Error(`Missing test child: ${name}`);
  return child;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => undefined)));
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("PersistentSubagentStore", () => {
  it("derives exact normalized ID+file keys, never names or cwd", async () => {
    const { root } = await fixture();
    const expected = createHash("sha256")
      .update(`${root.sessionId}\0${root.sessionFile}`)
      .digest("hex")
      .slice(0, 32);
    expect(sessionKey(root)).toBe(expected);
    expect(
      sessionKey({
        ...root,
        sessionFile: path.join(path.dirname(root.sessionFile), "nested", "..", "root.jsonl"),
      }),
    ).toBe(expected);
    expect(sessionKey({ ...root, sessionId: "copy" })).not.toBe(expected);
    expect(sessionKey({ ...root, sessionFile: `${root.sessionFile}.copy` })).not.toBe(expected);
    expect(() => sessionKey({ ...root, sessionFile: "relative.jsonl" })).toThrow();
  });

  it("starts empty without creating root metadata and persists only direct children", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await expect(store.open()).resolves.toBeUndefined();
    expect(await readdir(path.dirname(ownerFile(agentDir, root)))).toEqual([]);
    const b = child(directory, "B", "running");
    const c = child(directory, "C", "idle");
    const d = child(directory, "D", "interrupted");
    await store.setChild(root, null, "B", { ...b, hasChildren: true });
    await store.setChild(root, null, "C", c);
    await store.setChild(b, root, "D", d);
    expect(await diskRecord(agentDir, root)).toEqual({
      schemaVersion: 1,
      root,
      owner: root,
      parent: null,
      children: { B: { ...b, hasChildren: true }, C: c },
    });
    expect(await diskRecord(agentDir, b)).toEqual({
      schemaVersion: 1,
      root,
      owner: { sessionId: b.sessionId, sessionFile: b.sessionFile },
      parent: root,
      children: { D: d },
    });
    await expect(store.readOwner(c, root)).resolves.toBeUndefined();
    await expect(store.readOwner(b, root, true)).resolves.toMatchObject({ children: { D: d } });
    await expect(store.readOwner(c, root, true)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await store.close();
    const resumed = createStore(agentDir, root);
    // Store preserves latest facts; runtime performs running/opening recovery, never the store.
    await expect(resumed.open()).resolves.toMatchObject({ children: { B: { state: "running" } } });
    await expect(resumed.readOwner(b, root)).resolves.toMatchObject({ children: { D: d } });
    expect((await readdir(path.dirname(ownerFile(agentDir, root)))).sort()).toEqual(
      [path.basename(ownerFile(agentDir, root)), path.basename(ownerFile(agentDir, b))].sort(),
    );
  });

  it("publishes an empty owner, then marker, then child opening as independent durable steps", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const b = child(directory, "B", "running");
    await store.setChild(root, null, "B", b);
    await store.ensureOwner(b, root);
    expect(await diskRecord(agentDir, b)).toEqual({
      schemaVersion: 1,
      root,
      owner: { sessionId: b.sessionId, sessionFile: b.sessionFile },
      parent: root,
      children: {},
    });
    expect(childOf(await diskRecord(agentDir, root), "B").hasChildren).toBeUndefined();
    await store.close();
    const afterOwner = createStore(agentDir, root);
    await afterOwner.open();
    await expect(afterOwner.readOwner(b, root, true)).resolves.toMatchObject({ children: {} });
    await afterOwner.markHasChildren(root, null, "B");
    expect(childOf(await diskRecord(agentDir, root), "B")).toMatchObject({
      state: "running",
      hasChildren: true,
    });
    await afterOwner.close();
    const afterMarker = createStore(agentDir, root);
    await afterMarker.open();
    await expect(afterMarker.readOwner(b, root, true)).resolves.toMatchObject({ children: {} });
    await afterMarker.setChild(b, root, "D", child(directory, "D"));
    expect(childOf(await diskRecord(agentDir, b), "D").state).toBe("opening");
    await afterMarker.ensureOwner(b, root);
    expect(Object.keys((await diskRecord(agentDir, b)).children)).toEqual(["D"]);
  });

  it("merges a queued marker into the latest child after synchronous acceptance, preserving subsequent state writes", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const b = child(directory, "B");
    await store.setChild(root, null, "B", b);
    await store.ensureOwner(b, root);
    const marker = store.markHasChildren(root, null, "B");
    store.setChildSync(root, null, "B", { ...b, state: "running" });
    const idle = store.setChild(root, null, "B", { ...b, state: "idle" });
    const sibling = store.setChild(root, null, "sibling", child(directory, "sibling"));
    await Promise.all([marker, idle, sibling]);
    expect(childOf(await diskRecord(agentDir, root), "B")).toMatchObject({
      state: "idle",
      hasChildren: true,
    });
    expect(childOf(await diskRecord(agentDir, root), "sibling").state).toBe("opening");
    await store.markHasChildren(root, null, "B");
    expect(childOf(await diskRecord(agentDir, root), "B")).toMatchObject({
      state: "idle",
      hasChildren: true,
    });
  });

  it("fails closed for missing marker targets, mismatched owner headers and disappeared loaded owners", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    await expect(store.markHasChildren(root, null, "missing")).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    const b = child(directory, "B");
    await store.setChild(root, null, "B", b);
    await expect(store.markHasChildren(root, null, "missing")).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await store.ensureOwner(b, root);
    const before = await readFile(ownerFile(agentDir, b), "utf8");
    await expect(store.ensureOwner(b, { ...root, sessionId: "wrong" })).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await expect(
      store.markHasChildren(b, { ...root, sessionId: "wrong" }, "D"),
    ).rejects.toMatchObject({ code: "STORE_ERROR" });
    expect(await readFile(ownerFile(agentDir, b), "utf8")).toBe(before);
    await rm(ownerFile(agentDir, b));
    await expect(store.ensureOwner(b, root)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(store.markHasChildren(root, null, "B")).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    expect(childOf(await diskRecord(agentDir, root), "B").hasChildren).toBeUndefined();
    await expect(store.markHasChildren(b, root, "D")).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await expect(stat(ownerFile(agentDir, b))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(ownerFile(agentDir, root));
    await expect(store.ensureOwner(root, null)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(store.markHasChildren(root, null, "B")).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await expect(stat(ownerFile(agentDir, root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each(["owner", "marker"] as const)(
    "failed %s publication preserves the prior crash-recoverable records",
    async (step) => {
      const { agentDir, directory, root, store } = await fixture();
      await store.open();
      const b = child(directory, "B", "running");
      await store.setChild(root, null, "B", b);
      if (step === "marker") await store.ensureOwner(b, root);
      const sessions = path.dirname(ownerFile(agentDir, root));
      await chmod(sessions, 0o500);
      try {
        await expect(
          step === "owner" ? store.ensureOwner(b, root) : store.markHasChildren(root, null, "B"),
        ).rejects.toMatchObject({ code: "STORE_ERROR" });
      } finally {
        await chmod(sessions, 0o700);
      }
      expect(childOf(await diskRecord(agentDir, root), "B")).toEqual(b);
      expect(await readdir(sessions)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/\.tmp$/)]),
      );
      await store.close();
      const reopened = createStore(agentDir, root);
      await reopened.open();
      if (step === "owner") await expect(reopened.readOwner(b, root)).resolves.toBeUndefined();
      else await expect(reopened.readOwner(b, root, true)).resolves.toMatchObject({ children: {} });
      await reopened.ensureOwner(b, root);
      await reopened.markHasChildren(root, null, "B");
      expect(childOf(await diskRecord(agentDir, root), "B")).toMatchObject({
        state: "running",
        hasChildren: true,
      });
    },
  );

  it.each([undefined, [], ["read"]])(
    "roundtrips role policy %j without mutable aliases",
    async (tools) => {
      const { agentDir, directory, root, store } = await fixture();
      await store.open();
      const record = child(directory);
      delete (record.roleSnapshot as { disallowedTools?: string[] }).disallowedTools;
      if (tools !== undefined) Object.assign(record.roleSnapshot, { tools });
      const expected = structuredClone(record);
      const saved = store.setChild(root, null, "worker", record);
      record.roleSnapshot.prompt = "mutated before queued write";
      await saved;
      expect((await diskRecord(agentDir, root)).children.worker).toEqual(expected);
      const loaded = await store.readOwner(root, null);
      if (!loaded) throw new Error("missing record");
      childOf(loaded, "worker").roleSnapshot.prompt = "mutated read result";
      expect((await store.readOwner(root, null))?.children.worker).toEqual(expected);
    },
  );

  it("keeps arbitrary own names safe and never uses them as paths", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const names = [
      "__proto__",
      "constructor",
      "toString",
      "../../escape",
      "a/b",
      "A",
      "a",
      "multi\nline",
    ];
    await Promise.all(
      names.map((name, index) => store.setChild(root, null, name, child(directory, `c${index}`))),
    );
    const loaded = await store.readOwner(root, null);
    expect(Object.keys(loaded?.children ?? {})).toEqual(names);
    expect(Object.getPrototypeOf(loaded?.children)).toBeNull();
    expect(Object.hasOwn(loaded?.children ?? {}, "__proto__")).toBe(true);
    expect(childOf(await diskRecord(agentDir, root), "__proto__").sessionId).toBe("c0");
    await store.removeChild(root, null, "__proto__");
    expect(Object.hasOwn((await diskRecord(agentDir, root)).children, "__proto__")).toBe(false);
    expect(await readdir(path.dirname(ownerFile(agentDir, root)))).toEqual([
      path.basename(ownerFile(agentDir, root)),
    ]);
  });

  it("serializes concurrent sibling updates atomically from latest state", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        store.setChild(root, null, `worker${index}`, child(directory, `c${index}`)),
      ),
    );
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        index % 2
          ? store.setChild(root, null, `worker${index}`, child(directory, `c${index}`, "idle"))
          : store.removeChild(root, null, `worker${index}`),
      ),
    );
    const record = await diskRecord(agentDir, root);
    expect(Object.keys(record.children)).toHaveLength(20);
    expect(Object.values(record.children).every((entry) => entry.state === "idle")).toBe(true);
  });

  it("sync preflight overtakes stale queued writes/removes without losing sibling writes", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const opening = child(directory);
    await store.setChild(root, null, "worker", opening);
    const staleWrite = store.setChild(root, null, "worker", opening);
    const staleRemoval = store.removeChild(root, null, "worker");
    const sibling = store.setChild(root, null, "sibling", child(directory, "sibling"));
    store.setChildSync(root, null, "worker", { ...opening, state: "running" });
    expect(childOf(await diskRecord(agentDir, root), "worker").state).toBe("running");
    await Promise.all([staleWrite, staleRemoval, sibling]);
    expect((await diskRecord(agentDir, root)).children).toMatchObject({
      worker: { state: "running" },
      sibling: { state: "opening" },
    });
    await store.setChild(root, null, "worker", { ...opening, state: "idle" });
    expect(childOf(await diskRecord(agentDir, root), "worker").state).toBe("idle");
  });

  it("sync acceptance requires the same child's already durable opening record", async () => {
    const { directory, root, store } = await fixture();
    await store.open();
    const opening = child(directory);
    expect(() =>
      store.setChildSync(root, null, "worker", { ...opening, state: "running" }),
    ).toThrow();
    const pending = store.setChild(root, null, "worker", opening);
    expect(() =>
      store.setChildSync(root, null, "worker", { ...opening, state: "running" }),
    ).toThrow();
    await pending;
    expect(() => store.setChildSync(root, null, "worker", opening)).toThrow();
    expect(() =>
      store.setChildSync(root, null, "worker", child(directory, "other", "running")),
    ).toThrow();
    store.setChildSync(root, null, "worker", { ...opening, state: "running" });
    expect(() =>
      store.setChildSync(root, null, "worker", { ...opening, state: "running" }),
    ).toThrow();
  });

  it("rollback retains siblings and an empty branch owner instead of deleting identities or histories", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const b = child(directory, "B", "idle");
    await writeFile(b.sessionFile, "SDK history untouched\n");
    await store.setChild(root, null, "B", { ...b, hasChildren: true });
    await store.setChild(root, null, "sibling", child(directory, "sibling"));
    await store.setChild(b, root, "prepared", child(directory, "D"));
    await store.removeChild(b, root, "prepared");
    expect((await diskRecord(agentDir, b)).children).toEqual({});
    expect(childOf(await diskRecord(agentDir, root), "B").hasChildren).toBe(true);
    await store.setChild(root, null, "B", { ...b, state: "opening" });
    store.setChildSync(root, null, "B", { ...b, state: "running" });
    expect(childOf(await diskRecord(agentDir, root), "B").hasChildren).toBe(true);
    await store.removeChild(root, null, "B");
    expect(Object.keys((await diskRecord(agentDir, root)).children)).toEqual(["sibling"]);
    expect(await readFile(b.sessionFile, "utf8")).toBe("SDK history untouched\n");
  });

  it("rejects same-root writers but permits independent original/copy/file roots", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    await expect(createStore(agentDir, root).open()).rejects.toMatchObject({
      code: "ROOT_SCOPE_IN_USE",
    });
    const other = createStore(agentDir, { ...root, sessionId: "other" });
    const copy = createStore(agentDir, { ...root, sessionFile: `${root.sessionFile}.copy` });
    await Promise.all([other.open(), copy.open()]);
    await store.setChild(root, null, "worker", child(directory));
    await expect(other.readOwner({ ...root, sessionId: "other" }, null)).resolves.toBeUndefined();
    await expect(
      copy.readOwner({ ...root, sessionFile: `${root.sessionFile}.copy` }, null),
    ).resolves.toBeUndefined();
    await store.close();
    await expect(createStore(agentDir, root).open()).resolves.toMatchObject({
      children: { worker: { state: "opening" } },
    });
  });

  it("holds a real interprocess proper-lockfile lock until close", async () => {
    const { agentDir, store } = await fixture();
    await store.open();
    const require = createRequire(import.meta.url);
    const target = path.join(agentDir, "subagents", "locks", store.rootKey);
    const script = `
      const lockfile = require(${JSON.stringify(require.resolve("proper-lockfile"))});
      lockfile.lock(${JSON.stringify(target)}, {
        realpath: false, lockfilePath: ${JSON.stringify(path.join(target, ".writer"))}, retries: 0
      }).then(async release => { console.log("acquired"); await release(); })
        .catch(error => { console.log(error.code); });
    `;
    expect((await execute(process.execPath, ["-e", script])).stdout.trim()).toBe("ELOCKED");
    await store.close();
    expect((await execute(process.execPath, ["-e", script])).stdout.trim()).toBe("acquired");
  });

  it("never accesses legacy/project stores, initializes Git ignores, or copies SDK history", async () => {
    const { agentDir, directory, root, store } = await fixture();
    const project = path.join(directory, "project");
    const legacy = path.join(project, ".pi", "subagents");
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "setting.json"), "not parsed by store");
    await writeFile(path.join(legacy, ".gitignore"), "old ignore contents");
    await symlink("/does-not-exist", path.join(legacy, "sessions"));
    await symlink("/does-not-exist", path.join(agentDir, ".bykwp-pi-subagents"));
    const record = child(project);
    await writeFile(root.sessionFile, "root SDK history");
    await writeFile(record.sessionFile, "child SDK history");
    await store.open();
    await store.setChild(root, null, "worker", record);
    expect(await readdir(legacy)).toEqual([".gitignore", "sessions", "setting.json"]);
    expect(await readFile(path.join(legacy, ".gitignore"), "utf8")).toBe("old ignore contents");
    expect(await readFile(path.join(legacy, "setting.json"), "utf8")).toBe("not parsed by store");
    expect(await readFile(root.sessionFile, "utf8")).toBe("root SDK history");
    expect(await readFile(record.sessionFile, "utf8")).toBe("child SDK history");
    expect(await readdir(path.join(agentDir, "subagents"))).toEqual(["locks", "sessions"]);
  });

  it.each(["root", "owner", "parent", "schemaVersion"])(
    "rejects mismatched %s headers on read, async write, and sync commit",
    async (field) => {
      const { agentDir, directory, root, store } = await fixture();
      await store.open();
      const opening = child(directory);
      await store.setChild(root, null, "worker", opening);
      const corrupted = await diskRecord(agentDir, root);
      Object.assign(corrupted, {
        [field]:
          field === "schemaVersion" ? 2 : { sessionId: "wrong", sessionFile: root.sessionFile },
      });
      const contents = JSON.stringify(corrupted);
      await writeFile(ownerFile(agentDir, root), contents);
      await expect(store.readOwner(root, null)).rejects.toMatchObject({ code: "STORE_ERROR" });
      await expect(store.setChild(root, null, "sibling", opening)).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      expect(() =>
        store.setChildSync(root, null, "worker", { ...opening, state: "running" }),
      ).toThrow();
      expect(await readFile(ownerFile(agentDir, root), "utf8")).toBe(contents);
      await store.close();
      await expect(createStore(agentDir, root).open()).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
    },
  );

  it("checks descendant ownership and root header on every descendant write", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const b = child(directory, "B");
    const d = child(directory, "D");
    await store.setChild(root, null, "B", b);
    await store.setChild(b, root, "D", d);
    const otherRoot = { ...root, sessionId: "other-root" };
    const other = createStore(agentDir, otherRoot);
    await other.open();
    await other.setChild(otherRoot, null, "B", b);
    await expect(other.readOwner(b, otherRoot)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(other.setChild(b, otherRoot, "D", d)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    const wrongParent = { ...root, sessionId: "wrong-parent" };
    await expect(store.setChild(b, wrongParent, "D", d)).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    const corrupted = await diskRecord(agentDir, root);
    corrupted.root = wrongParent;
    await writeFile(ownerFile(agentDir, root), JSON.stringify(corrupted));
    await expect(store.setChild(b, root, "D", d)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(store.removeChild(b, root, "D")).rejects.toMatchObject({ code: "STORE_ERROR" });
    expect(() => store.setChildSync(b, root, "D", { ...d, state: "running" })).toThrow();
    expect(childOf(await diskRecord(agentDir, b), "D").state).toBe("opening");
  });

  it.each([
    "invalid JSON",
    "unknown state",
    "legacy fields",
    "invalid snapshot",
    "wrong policy",
    "relative history",
    "false marker",
  ])("rejects corrupt schema: %s", async (kind) => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    await store.setChild(root, null, "worker", child(directory));
    const record = await diskRecord(agentDir, root);
    const worker = childOf(record, "worker");
    if (kind === "unknown state") Object.assign(worker, { state: "accepted" });
    if (kind === "legacy fields") Object.assign(worker, { cwd: directory, result: "old result" });
    if (kind === "invalid snapshot") Object.assign(worker.roleSnapshot, { prompt: null });
    if (kind === "wrong policy") Object.assign(worker.roleSnapshot, { tools: [] });
    if (kind === "relative history") worker.sessionFile = "relative.jsonl";
    if (kind === "false marker") Object.assign(worker, { hasChildren: false });
    await writeFile(
      ownerFile(agentDir, root),
      kind === "invalid JSON" ? "{" : JSON.stringify(record),
    );
    await expect(store.readOwner(root, null)).rejects.toMatchObject({ code: "STORE_ERROR" });
  });

  it.each(["", " ", " not-trimmed "])(
    "rejects unnormalized names %j without queuing writes",
    async (name) => {
      const { agentDir, directory, root, store } = await fixture();
      await store.open();
      await expect(store.setChild(root, null, name, child(directory))).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      await expect(store.removeChild(root, null, name)).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      expect(await readdir(path.dirname(ownerFile(agentDir, root)))).toEqual([]);
    },
  );

  it.each(["subagents", "sessions", "locks", "lock target", "active lock"])(
    "fails closed after %s directory disappears",
    async (kind) => {
      const { agentDir, directory, root, store } = await fixture();
      await store.open();
      const target =
        kind === "subagents"
          ? path.join(agentDir, "subagents")
          : kind === "sessions" || kind === "locks"
            ? path.join(agentDir, "subagents", kind)
            : path.join(
                agentDir,
                "subagents",
                "locks",
                store.rootKey,
                ...(kind === "active lock" ? [".writer"] : []),
              );
      await rm(target, { recursive: true });
      await expect(store.setChild(root, null, "worker", child(directory))).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      await expect(store.readOwner(root, null)).rejects.toMatchObject({ code: "STORE_ERROR" });
      await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("fails closed on previously loaded root/branch disappearance and required missing branch", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const b = child(directory, "B");
    await store.setChild(root, null, "B", { ...b, hasChildren: true });
    await expect(store.readOwner(b, root, true)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await store.setChild(b, root, "D", child(directory, "D"));
    await rm(ownerFile(agentDir, b));
    await expect(store.readOwner(b, root)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(store.setChild(b, root, "D", child(directory, "D"))).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await rm(ownerFile(agentDir, root));
    await expect(store.readOwner(root, null)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await expect(store.setChild(root, null, "B", b)).rejects.toMatchObject({ code: "STORE_ERROR" });
    await store.close();
    // The minimal schema cannot diagnose a root file deleted between processes.
    await expect(createStore(agentDir, root).open()).resolves.toBeUndefined();
  });

  it.each(["subagents", "sessions", "locks", "lock target", "owner"])(
    "rejects existing symlink %s paths without modifying their targets",
    async (kind) => {
      const { agentDir, directory, root, store } = await fixture();
      const outside = path.join(directory, "outside");
      await mkdir(outside);
      await writeFile(path.join(outside, "untouched"), "unchanged");
      await store.open();
      await store.setChild(root, null, "worker", child(directory));
      await store.close();
      const target =
        kind === "owner"
          ? ownerFile(agentDir, root)
          : kind === "lock target"
            ? path.join(agentDir, "subagents", "locks", store.rootKey)
            : kind === "subagents"
              ? path.join(agentDir, "subagents")
              : path.join(agentDir, "subagents", kind);
      await rm(target, { recursive: true });
      await symlink(outside, target);
      await expect(createStore(agentDir, root).open()).rejects.toMatchObject({
        code: "STORE_ERROR",
      });
      expect(await readdir(outside)).toEqual(["untouched"]);
      expect(await readFile(path.join(outside, "untouched"), "utf8")).toBe("unchanged");
    },
  );

  it("rejects unsafe agentDir ancestors, regular-file directories, and directory owner records", async () => {
    const { agentDir, directory, root, store } = await fixture();
    const link = path.join(directory, "linked-agent");
    await symlink(agentDir, link);
    await expect(createStore(link, root).open()).rejects.toMatchObject({ code: "STORE_ERROR" });
    await writeFile(path.join(agentDir, "subagents"), "not a directory");
    await expect(store.open()).rejects.toMatchObject({ code: "STORE_ERROR" });
    await rm(path.join(agentDir, "subagents"));
    const valid = createStore(agentDir, root);
    await valid.open();
    await mkdir(ownerFile(agentDir, root));
    await expect(valid.readOwner(root, null)).rejects.toMatchObject({ code: "STORE_ERROR" });
  });

  it("releases a lock acquired concurrently with close instead of leaking a writer", async () => {
    const { agentDir, root, store } = await fixture();
    const opening = store.open();
    const closing = store.close();
    await expect(opening).rejects.toMatchObject({ code: "STORE_ERROR" });
    await closing;
    await expect(createStore(agentDir, root).open()).resolves.toBeUndefined();
  });

  it("creates private directories/files and drains pending writes before idempotent close", async () => {
    const { agentDir, directory, root, store } = await fixture();
    await store.open();
    const pending = store.setChild(root, null, "worker", child(directory));
    const closing = store.close();
    expect(store.close()).toBe(closing);
    await expect(store.setChild(root, null, "late", child(directory))).rejects.toMatchObject({
      code: "STORE_ERROR",
    });
    await Promise.all([pending, closing]);
    const storage = path.join(agentDir, "subagents");
    for (const target of [
      storage,
      path.join(storage, "sessions"),
      path.join(storage, "locks"),
      path.join(storage, "locks", store.rootKey),
    ]) {
      expect((await stat(target)).mode & 0o777).toBe(0o700);
    }
    expect((await stat(ownerFile(agentDir, root))).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(ownerFile(agentDir, root)))).toEqual([
      path.basename(ownerFile(agentDir, root)),
    ]);
    const reopened = createStore(agentDir, root);
    await reopened.open();
    expect(
      (await stat(path.join(storage, "locks", reopened.rootKey, ".writer"))).mode & 0o777,
    ).toBe(0o700);
    await expect(reopened.open()).rejects.toMatchObject({ code: "STORE_ERROR" });
  });
});
