import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";

/**
 * M2 acceptance fixture: a project extension that registers a custom tool.
 * Copied into <tmp-project>/.pi/extensions/ by the integration test.
 *
 * The tool writes its input to $MARKER_FILE so the test can verify that the
 * project extension was discovered and executed by the daemon-created session.
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "mark_test_tool",
    label: "Mark Test Tool",
    description: "Writes the input value to the marker file for integration testing",
    parameters: Type.Object({
      input: Type.String(),
    }),
    execute: async (_toolCallId, params: { input: string }, _signal, _onUpdate, _ctx) => {
      const marker = process.env.MARKER_FILE;
      if (!marker) return { content: [{ type: "text", text: "MARKER_FILE not set" }], details: {} };
      fs.writeFileSync(marker, `input=${params.input}\n`, "utf-8");
      return { content: [{ type: "text", text: `marked: ${params.input}` }], details: {} };
    },
  });
}
