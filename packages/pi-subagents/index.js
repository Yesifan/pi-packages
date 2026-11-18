import { fileURLToPath } from "node:url";
import piSubagents from "./dist/index.js";

export default function registerSubagents(pi) {
  piSubagents(pi, fileURLToPath(import.meta.url));
}
