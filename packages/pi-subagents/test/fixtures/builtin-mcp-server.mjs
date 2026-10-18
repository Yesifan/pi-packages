import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

// A dependency-free stdio MCP server. The log proves whether a child connected at all.
const log = process.argv[2];
appendFileSync(log, "started\n");
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  appendFileSync(log, `${request.method}\n`);
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "child-builtin-fixture", version: "1.0.0" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          {
            name: "echo",
            description: "Echo a child integration fixture message",
            inputSchema: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
          },
        ],
      };
      break;
    case "tools/call":
      result = {
        content: [{ type: "text", text: `fixture:${request.params.arguments.message}` }],
      };
      break;
    case "ping":
      result = {};
      break;
    default:
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`,
      );
      return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
