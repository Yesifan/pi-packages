import { defineConfig } from "vitest/config";
import offlineConfig from "./vitest.config.js";

export default defineConfig({
  ...offlineConfig,
  test: {
    ...offlineConfig.test,
    include: ["test/model/**/*.test.ts"],
  },
});
