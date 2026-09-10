#!/usr/bin/env node
import { buildProgram } from "./cli/index.js";

async function main(): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error("fatal:", err);
  process.exit(1);
});
