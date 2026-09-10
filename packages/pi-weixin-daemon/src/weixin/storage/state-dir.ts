/**
 * State/data/config directory resolution.
 *
 * Now delegates to `src/config/paths.ts` so the whole daemon shares one set of
 * XDG-resolved paths. Re-exported here to avoid touching every weixin import.
 */
import {
  migrateLegacyAccounts,
  resolveAccountsDir,
  resolveConfigDir,
  resolveConfigPath,
  resolveDaemonSocket,
  resolveRuntimeDir,
  resolveStateDir,
  resolveWeixinStateDir,
} from "../../config/paths.js";

export {
  migrateLegacyAccounts,
  resolveAccountsDir,
  resolveConfigDir,
  resolveConfigPath,
  resolveDaemonSocket,
  resolveRuntimeDir,
  resolveStateDir,
  resolveWeixinStateDir,
};
