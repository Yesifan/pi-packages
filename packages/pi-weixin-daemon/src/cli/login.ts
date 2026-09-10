import { Command } from "commander";
import {
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
  loadWeixinAccount,
  registerWeixinAccountId,
  resolveWeixinAccountIdByName,
  saveWeixinAccount,
} from "../weixin/auth/accounts.js";
import { displayQRCode, startWeixinLoginWithQr, waitForWeixinLogin } from "../weixin/auth/login-qr.js";
import { redactToken } from "../weixin/util/redact.js";
import { createLogger } from "../util/logger.js";

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/**
 * `pi-wx login --name <label>`
 *
 * QR-code login. Each invocation adds one Weixin account; run it again to add
 * another for a different user. `--name` is a required, globally-unique label;
 * the account **id remains `ilink_bot_id`** (the Project routing key). A WeChat
 * user may only be scanned once: re-login of the same user replaces the old
 * account (dedup by `ilink_user_id`).
 */
export function loginCommand(): Command {
  return new Command("login")
    .description("QR-code login to add a Weixin account (repeat to add more)")
    .option("--timeout <ms>", "login timeout in milliseconds", "480000")
    .requiredOption("--name <label>", "account label (globally unique)")
    .action(async (opts: { timeout: string; name: string }) => {
      const logger = createLogger({ pretty: true });
      const timeoutMs = Number(opts.timeout) || 480_000;
      const name = (opts.name ?? "").trim();
      if (!NAME_RE.test(name)) {
        console.error(`error: --name must be letters/digits/._- only: "${name}"`);
        process.exitCode = 1;
        return;
      }

      logger.info("starting weixin QR login");
      const start = await startWeixinLoginWithQr({
        apiBaseUrl: DEFAULT_BASE_URL,
        verbose: true,
      });
      if (!start.qrcodeUrl) {
        logger.error({ message: start.message }, "failed to start login");
        console.error(`登录失败：${start.message}`);
        process.exitCode = 1;
        return;
      }

      console.log(start.message);
      await displayQRCode(start.qrcodeUrl);

      const result = await waitForWeixinLogin({
        sessionKey: start.sessionKey,
        apiBaseUrl: DEFAULT_BASE_URL,
        timeoutMs,
      });

      if (result.connected && result.accountId) {
        const accountId = result.accountId; // ilink_bot_id, unique per login session

        // Name collisions: reject if `name` belongs to a *different* user's
        // account. Re-login of the same user is allowed (old account cleaned
        // below by clearStaleAccountsForUserId).
        const existingByName = resolveWeixinAccountIdByName(name);
        if (existingByName && existingByName !== accountId) {
          const existingUser = loadWeixinAccount(existingByName)?.userId;
          if (result.userId && existingUser && existingUser !== result.userId) {
            console.error(`error: --name "${name}" is already used by account ${existingByName}`);
            process.exitCode = 1;
            return;
          }
        }

        registerWeixinAccountId(accountId);
        saveWeixinAccount(accountId, {
          token: result.botToken,
          baseUrl: result.baseUrl,
          userId: result.userId,
          name,
        });
        clearStaleAccountsForUserId(accountId, result.userId ?? "");
        logger.info(
          { accountId, name, userId: redactToken(result.userId) },
          "account saved",
        );
        console.log(`\n✅ 微信账号已保存: ${name} (${accountId})`);
        // Best-effort: ask a running daemon to pick up the new account now.
        try {
          await import("./rpc-client.js").then(({ rpcCall }) => rpcCall("account.reload"));
          console.log(`运行 \`pi-wx accounts\` 查看全部账号。`);
        } catch {
          console.log(`Daemon 未运行；账号已保存，下次启动时自动加载。`);
        }
      } else {
        console.log(result.message);
        if (!result.alreadyConnected) {
          process.exitCode = 1;
        }
      }
    });
}
