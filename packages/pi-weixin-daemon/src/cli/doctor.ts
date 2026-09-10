import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { z } from "zod";
import { checkModelAvailability, isPiSdkAvailable, piSdkVersion } from "../pi/sdk-info.js";
import { resolveStateDir } from "../weixin/storage/state-dir.js";
import { listIndexedWeixinAccountIds, loadWeixinAccount, resolveWeixinBaseUrl } from "../weixin/auth/accounts.js";

const DoctorArgsSchema = z.object({
  cwd: z.string().min(1).optional(),
  accounts: z.array(z.string().min(1)).optional(),
});

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 19;

/** `pi-wx doctor [--cwd <path>] [--account <id>...]` */
export function doctorCommand(): Command {
  const collect = (value: string, previous: string[]) => [...previous, value];

  return new Command("doctor")
    .description("Check the environment for running the daemon")
    .option("--cwd <path>", "project directory to check")
    .option("--account <id>", "account to check (repeatable)", collect, [] as string[])
    .action(async (opts: { cwd?: string; account?: string[] }) => {
      const parsed = DoctorArgsSchema.safeParse({
        cwd: opts.cwd,
        accounts: opts.account ?? [],
      });
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          console.error(`error: ${issue.path.join(".")}: ${issue.message}`);
        }
        process.exitCode = 1;
        return;
      }
      const args = parsed.data;
      const checks: Check[] = [];

      // --- Node version ---
      const [major, minor] = process.versions.node.split(".").map((p) => parseInt(p, 10));
      const nodeOk = (major ?? 0) > MIN_NODE_MAJOR || ((major ?? 0) === MIN_NODE_MAJOR && (minor ?? 0) >= MIN_NODE_MINOR);
      checks.push({
        name: "node version",
        ok: nodeOk,
        detail: `v${process.versions.node} (requires >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})`,
      });

      // --- Pi SDK ---
      let sdkOk = false;
      let sdkDetail = "";
      try {
        sdkOk = isPiSdkAvailable();
        sdkDetail = `@earendil-works/pi-coding-agent@${piSdkVersion()}`;
      } catch (err) {
        sdkDetail = String(err);
      }
      checks.push({ name: "pi SDK", ok: sdkOk, detail: sdkDetail });

      // --- Model availability (Pi credentials for the default provider/model) ---
      let modelOk = false;
      let modelDetail = "";
      try {
        const agentDir =
          process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
        const settingsPath = path.join(agentDir, "settings.json");
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as {
          defaultProvider?: string;
          defaultModel?: string;
        };
        const result = await checkModelAvailability(settings);
        modelOk = result.ok;
        modelDetail = result.detail;
      } catch (err) {
        modelDetail = `unable to resolve model: ${err instanceof Error ? err.message : String(err)}`;
      }
      checks.push({ name: "model availability", ok: modelOk, detail: modelDetail });

      // --- State dir ---
      const stateDir = resolveStateDir();
      let stateOk = false;
      try {
        fs.mkdirSync(stateDir, { recursive: true });
        const probe = path.join(stateDir, ".doctor-probe");
        fs.writeFileSync(probe, "ok", "utf-8");
        fs.rmSync(probe, { force: true });
        stateOk = true;
      } catch (err) {
        sdkDetail = String(err);
      }
      checks.push({ name: "state dir", ok: stateOk, detail: stateDir });

      // --- cwd ---
      if (args.cwd) {
        const cwd = path.resolve(args.cwd);
        let ok = false;
        try {
          ok = fs.existsSync(cwd) && fs.statSync(cwd).isDirectory();
        } catch {
          ok = false;
        }
        checks.push({ name: "project cwd", ok, detail: cwd });
      }

      // --- Accounts ---
      const accountIds = args.accounts && args.accounts.length > 0 ? args.accounts : listIndexedWeixinAccountIds();
      if (accountIds.length === 0) {
        checks.push({
          name: "weixin accounts",
          ok: false,
          detail: "none logged in; run `pi-wx login`",
        });
      } else {
        for (const accountId of accountIds) {
          const data = loadWeixinAccount(accountId);
          const hasToken = Boolean(data?.token);
          checks.push({
            name: `account ${accountId}`,
            ok: hasToken,
            detail: hasToken
              ? `token ok, baseUrl=${resolveWeixinBaseUrl(accountId)}${data?.userId ? `, user=${data.userId}` : ""}`
              : "missing token; run `pi-wx login`",
          });
        }
      }

      // --- Report ---
      let allOk = true;
      for (const check of checks) {
        if (!check.ok) allOk = false;
        console.log(`${check.ok ? "✓" : "✗"} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
      }
      if (!allOk) {
        console.log("\nSome checks failed; fix them before starting the daemon.");
        process.exitCode = 1;
      } else {
        console.log("\nAll checks passed.");
      }
    });
}
