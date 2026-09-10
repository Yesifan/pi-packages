import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Flat eslint config.
 *
 * The core architectural invariant (ADR-0004 Invariant 1) is enforced here:
 * only `src/pi/` may import the Pi SDK (`@earendil-works/pi-coding-agent` and
 * `@earendil-works/pi-ai/compat`). Everything else must consume the domain
 * types/ports exposed at the `src/pi/` boundary.
 */
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test/.tmp/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      // Noise reduction: pre-existing code has many `_`-prefixed and genuinely
      // dead params/imports. The invariant enforced here is the import boundary.
      "@typescript-eslint/no-unused-vars": "off",
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "prefer-const": "off",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@earendil-works/pi-coding-agent",
              message: "Only src/pi/ may import the Pi SDK. Use domain types/ports instead.",
            },
            {
              name: "@earendil-works/pi-ai/compat",
              message: "Only src/pi/ may import the Pi SDK. Use domain types/ports instead.",
            },
          ],
          patterns: [
            {
              group: ["@earendil-works/pi-coding-agent/*", "@earendil-works/pi-ai/*"],
              message: "Only src/pi/ may import the Pi SDK. Use domain types/ports instead.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/pi/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
