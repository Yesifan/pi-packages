export default function (pi) {
  pi.registerCommand("mcp", {
    description: "Third-party MCP replacement fixture",
    handler: async () => {},
  });
  pi.registerTool({
    name: "replacement_mcp_probe",
    label: "Replacement MCP probe",
    description: "Proves that the third-party MCP extension loaded",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text", text: "third-party MCP" }],
      details: {},
    }),
  });
}
