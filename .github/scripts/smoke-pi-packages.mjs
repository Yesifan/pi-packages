import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const { PI_CODING_AGENT_DIR: agentDir } = process.env;
assert.ok(agentDir, "Set PI_CODING_AGENT_DIR to an isolated installation");
const cwd = process.cwd();
const packages = ["pi-session", "pi-subagents", "pi-system-prompt"];
await mkdir(agentDir, { recursive: true });
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    packages: packages.map((name) => `npm:@yesifan/${name}`),
    quietStartup: false,
  }),
);
const settingsManager = SettingsManager.create(cwd, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await resourceLoader.reload();
const { session } = await createAgentSession({
  cwd,
  agentDir,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.create(cwd),
  sessionStartEvent: { type: "session_start", reason: "startup" },
});
const errors = [];
function assertLoaded() {
  const { errors: loadErrors, extensions } = resourceLoader.getExtensions();
  assert.deepEqual(loadErrors, []);
  assert.deepEqual(errors, []);
  for (const name of packages) {
    const source = `npm:@yesifan/${name}`;
    const entries = extensions.filter((extension) => extension.sourceInfo.source === source);
    assert.equal(entries.length, 1, source);
    assert.equal(
      entries[0].resolvedPath,
      join(agentDir, "npm", "node_modules", "@yesifan", name, "index.js"),
    );
  }
  const names = session.getAllTools().map((tool) => tool.name);
  for (const name of ["search-session", "ask-session", "subagent", "ask_subagent"]) {
    assert.equal(names.filter((candidate) => candidate === name).length, 1, name);
  }
  assert.ok(session.extensionRunner.getCommand("system-prompt"));
}

try {
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  assertLoaded();
  await session.reload();
  assertLoaded();
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
